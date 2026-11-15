import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProductRecord } from '../../shared/types.js';
import { aiConfigService } from '../src/services/ai-config-service.js';
import { batchService } from '../src/services/batch-service.js';
import { productService } from '../src/services/product-service.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const previewPath = path.resolve(scriptDir, '../data/asos-title-optimization-preview.json');
const apply = process.argv.includes('--apply');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number.parseInt(limitArg.split('=')[1] || '', 10) : undefined;
const offsetArg = process.argv.find((arg) => arg.startsWith('--offset='));
const startOffset = offsetArg ? Number.parseInt(offsetArg.split('=')[1] || '', 10) : 0;
const BATCH_SIZE = 12;
const CONCURRENCY = 3;
const BANNED = /free shipping|hot sale|best seller|dropship|wholesale|factory price|limited time|cheap\b/i;

interface TitleInput {
  id: string;
  originalTitle: string;
  brand?: string;
  gender?: string;
  productType?: string;
  fit?: string;
  color?: string;
  description?: string;
}

interface GeneratedItem {
  id: string;
  title: string;
  tags: string[];
}

interface PreviewItem extends GeneratedItem {
  originalTitle: string;
}

function selectedProducts(): ProductRecord[] {
  const products = productService
    .list('collected')
    .filter((record) => record.collected.source === 'asos');
  return limit && limit > 0 ? products.slice(startOffset, startOffset + limit) : products.slice(startOffset);
}

function toInput(record: ProductRecord): TitleInput {
  const attributes = record.collected.attributes ?? {};
  return {
    id: record.id,
    originalTitle: record.collected.title,
    brand: attributes.Brand,
    gender: attributes.Gender,
    productType: attributes['Product Type'],
    fit: attributes.Fit,
    color: attributes.Color,
    description: record.collected.description?.slice(0, 500),
  };
}

function promptFor(items: TitleInput[]): string {
  return `You optimize English product titles and hidden search tags for Joom shoppers in Europe, CIS and Latin America.

Merchant-confirmed fact for every item in this batch: the actual item being sold is made of cotton. The ASOS source material may describe a reference garment and must not override this merchant-confirmed fact.

Rewrite each title for search relevance and purchase intent.

Rules:
- English only. Target 55-110 characters; hard maximum 130 characters.
- Preserve every real brand, team, artist, character, collection, graphic theme and season identifier from the original title. Correct obvious spelling mistakes.
- Lead with the strongest identifying search terms: brand/team/theme, then audience, product type, fit/design feature and color.
- Use standard buyer terms such as Men's T-Shirt, Unisex Tee, Polo Shirt or Football Jersey.
- Use exactly one primary product type. Never append Shirt or T-Shirt after Football Jersey, and avoid redundant combinations such as Jersey Shirt, T-Shirt Tee or Polo Shirt Tee.
- For team football products, prefer this concise order: [Brand] [Team] [Season] Men's [Home/Third/Training/Stadium] Football Jersey [Color].
- Add the word Cotton to ordinary t-shirt/tee/polo titles when it reads naturally. It may be omitted for football jerseys or already long titles when team, season and jersey type are stronger search terms.
- Never say 100% Cotton because the merchant confirmed cotton material but did not confirm a percentage.
- Keep fit, neckline, sleeve length, print placement and color only when supported by the supplied facts.
- Do not invent performance claims, style details or audiences.
- No promotional language, keyword stuffing, repeated words, emoji, HTML or supplier terms.
- Generate 6-10 concise lowercase English tags per item. Tags must be truthful, useful search phrases and complementary to the title.
- Return every input id exactly once.

Return strict JSON only in this shape:
{"items":[{"id":"...","title":"...","tags":["..."]}]}

INPUT:
${JSON.stringify(items)}`;
}

function parseResponse(content: string): GeneratedItem[] {
  const cleaned = content
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/, '')
    .trim();
  const parsed = JSON.parse(cleaned) as { items?: unknown };
  if (!Array.isArray(parsed.items)) throw new Error('AI response does not contain an items array');
  return parsed.items.map((value) => {
    const item = value as { id?: unknown; title?: unknown; tags?: unknown };
    return {
      id: String(item.id ?? ''),
      title: String(item.title ?? '').replace(/\s+/g, ' ').trim(),
      tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag).toLowerCase().replace(/[#\[\]]/g, '').replace(/\s+/g, ' ').trim()) : [],
    };
  });
}

function validateBatch(inputs: TitleInput[], generated: GeneratedItem[]): GeneratedItem[] {
  const expected = new Map(inputs.map((item) => [item.id, item]));
  const seen = new Set<string>();
  for (const item of generated) {
    if (!expected.has(item.id)) throw new Error(`AI returned an unexpected id: ${item.id}`);
    if (seen.has(item.id)) throw new Error(`AI returned duplicate id: ${item.id}`);
    seen.add(item.id);
    if (!item.title || item.title.length > 130) throw new Error(`Invalid title length for ${item.id}: ${item.title.length}`);
    if (BANNED.test(item.title)) throw new Error(`Promotional wording in title for ${item.id}`);
    if (/100\s*%\s* cotton/i.test(item.title)) throw new Error(`Unsupported cotton percentage for ${item.id}`);
    if (!/(t-?shirt|tee|polo|jersey|shirt)/i.test(item.title)) throw new Error(`Missing product type for ${item.id}`);
    item.tags = [...new Set(item.tags.filter(Boolean))].slice(0, 10);
  }
  if (seen.size !== expected.size) throw new Error(`AI returned ${seen.size}/${expected.size} items`);
  return generated;
}

async function generateBatch(inputs: TitleInput[], retries = 2): Promise<GeneratedItem[]> {
  const secret = aiConfigService.getSecret();
  if (!secret.apiKey) throw new Error('DeepSeek API key is not configured');
  const response = await fetch(`${secret.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: secret.model,
      temperature: 0.25,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a precise ecommerce listing editor. Follow the user rules and return valid JSON only.' },
        { role: 'user', content: promptFor(inputs) },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if ((response.status === 429 || response.status >= 500) && retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return generateBatch(inputs, retries - 1);
    }
    throw new Error(`DeepSeek request failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? '';
  try {
    return validateBatch(inputs, parseResponse(content));
  } catch (error) {
    if (retries > 0) return generateBatch(inputs, retries - 1);
    throw error;
  }
}

async function main() {
  const products = selectedProducts();
  if (!products.length) throw new Error('No collected ASOS products found');
  const batches: ProductRecord[][] = [];
  for (let offset = 0; offset < products.length; offset += BATCH_SIZE) batches.push(products.slice(offset, offset + BATCH_SIZE));
  const previewsByBatch: PreviewItem[][] = new Array(batches.length);
  let nextBatch = 0;
  let generatedCount = 0;
  async function worker() {
    while (nextBatch < batches.length) {
      const index = nextBatch++;
      const inputs = batches[index].map(toInput);
      const generated = await generateBatch(inputs);
      const originals = new Map(inputs.map((item) => [item.id, item.originalTitle]));
      previewsByBatch[index] = generated.map((item) => ({ ...item, originalTitle: originals.get(item.id) || '' }));
      generatedCount += generated.length;
      console.log(`generated ${generatedCount}/${products.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()));
  const previews = previewsByBatch.flat();

  fs.writeFileSync(previewPath, `${JSON.stringify(previews, null, 2)}\n`);
  let applied = 0;
  if (apply) {
    const results = batchService.run(
      previews.map((item) => item.id),
      {
        type: 'title',
        items: previews.map(({ id, title, tags }) => ({ id, title, tags })),
      },
    );
    const failed = results.filter((item) => !item.ok);
    if (failed.length) throw new Error(`Failed to apply ${failed.length} titles: ${JSON.stringify(failed.slice(0, 5))}`);
    applied = results.length;
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', generated: previews.length, applied, previewPath, samples: previews.slice(0, 8) }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

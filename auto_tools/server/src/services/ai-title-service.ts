import type { AiTitleMaterial, AiTitlePreviewItem, EditableProduct } from '@shared/types';
import { aiConfigService } from './ai-config-service.js';
import { TITLE_SYSTEM_PROMPT } from './ai-title-prompts.js';
import { productService } from './product-service.js';
import { logger } from '../util/logger.js';

const TITLE_MAX = 150;
const TITLE_SOFT_MIN = 40;
const TITLE_SOFT_MAX = 130;
const CONCURRENCY = 3;
const BANNED = [
  /free\s*shipping/gi,
  /drop\s*ship(?:ping)?/gi,
  /hot\s*sale/gi,
  /best\s*sellers?/gi,
  /wholesale/gi,
  /100\s*%/gi,
  /factory\s*price/gi,
  /aliexpress/gi,
  /oem\b/gi,
  /limited\s*time/gi,
];

export class AiNotConfiguredError extends Error {
  constructor() {
    super('未配置 DeepSeek API Key。请到「采集预设」页填写，或在 server/.env 设置 DEEPSEEK_API_KEY。');
    this.name = 'AiNotConfiguredError';
  }
}

export interface GenerateTitlesInput {
  ids: string[];
  material: AiTitleMaterial;
  extraPrompt?: string;
  includeTags?: boolean;
}

export class AiTitleService {
  async generate(input: GenerateTitlesInput): Promise<AiTitlePreviewItem[]> {
    const secret = aiConfigService.getSecret();
    if (!secret.apiKey) throw new AiNotConfiguredError();

    const materialPrompt = aiConfigService.resolvePrompt(input.material);
    return mapPool(input.ids, CONCURRENCY, async (id) => {
      const record = productService.get(id);
      if (!record) return { id, ok: false, original: '', error: '商品不存在' };
      const editable = productService.getEditable(record);
      const original = editable.title?.trim() || record.collected.title;
      try {
        const raw = await callDeepSeek({
          apiKey: secret.apiKey,
          model: secret.model,
          baseUrl: secret.baseUrl,
          stylePrompt: materialPrompt,
          extraPrompt: input.extraPrompt,
          product: editable,
        });
        const title = sanitizeTitle(raw.title);
        const tags = input.includeTags === false ? undefined : sanitizeTags(raw.tags);
        if (!title) return { id, ok: false, original, image: editable.images[0], error: '模型未返回有效标题' };
        return {
          id,
          ok: true,
          original,
          title,
          tags,
          image: editable.images[0],
          warning: titleWarning(title, original),
        };
      } catch (e) {
        logger.warn('AI 改标题失败', { id, error: (e as Error).message });
        return { id, ok: false, original, image: editable.images[0], error: (e as Error).message };
      }
    });
  }
}

async function callDeepSeek(opts: {
  apiKey: string;
  model: string;
  baseUrl: string;
  stylePrompt: string;
  extraPrompt?: string;
  product: EditableProduct;
}): Promise<{ title: string; tags: string[] }> {
  const user = buildUserPrompt(opts.product, opts.stylePrompt, opts.extraPrompt);
  const body = {
    model: opts.model,
    temperature: 0.35,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: TITLE_SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
  };

  const res = await fetchWithRetry(`${opts.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(formatDeepSeekError(res.status, text));
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? '';
  return parseModelJson(content);
}

function buildUserPrompt(p: EditableProduct, stylePrompt: string, extraPrompt?: string): string {
  const attrs = Object.entries(p.attributes ?? {})
    .filter(([, v]) => v?.trim())
    .slice(0, 12)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
  const colors = unique(p.variants.map((v) => v.colors).filter(Boolean) as string[]).slice(0, 8);
  const sizes = unique(p.variants.map((v) => v.size).filter(Boolean) as string[]).slice(0, 8);
  const lines = [
    `Style: ${stylePrompt}`,
    extraPrompt?.trim() ? `Extra merchant instruction: ${extraPrompt.trim()}` : '',
    `Original title: ${p.title}`,
    p.brand ? `Brand: ${p.brand}` : '',
    attrs ? `Attributes: ${attrs}` : '',
    colors.length ? `Variant colors (do not list in title): ${colors.join(', ')}` : '',
    sizes.length ? `Variant sizes (do not list in title): ${sizes.join(', ')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function parseModelJson(content: string): { title: string; tags: string[] } {
  const cleaned = content
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed: { title?: unknown; tags?: unknown };
  try {
    parsed = JSON.parse(cleaned) as { title?: unknown; tags?: unknown };
  } catch {
    throw new Error('模型返回了无法解析的内容');
  }
  const title = typeof parsed.title === 'string' ? parsed.title : '';
  const tags = Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t)) : [];
  return { title, tags };
}

function sanitizeTitle(input: string): string {
  let title = input.replace(/\s+/g, ' ').replace(/^["'`]+|["'`]+$/g, '').trim();
  title = title.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
  for (const re of BANNED) title = title.replace(re, '').replace(/\s+/g, ' ').trim();
  if (title.length > TITLE_MAX) {
    const cut = title.slice(0, TITLE_MAX);
    const sp = cut.lastIndexOf(' ');
    title = (sp > 80 ? cut.slice(0, sp) : cut).trim();
  }
  return title;
}

function sanitizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.toLowerCase().replace(/[#\[\]]/g, '').replace(/\s+/g, ' ').trim();
    if (!tag || tag.length > 40 || seen.has(tag)) continue;
    if (BANNED.some((re) => re.test(tag))) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 10) break;
  }
  return out;
}

function titleWarning(title: string, original: string): string | undefined {
  if (title === original) return '标题几乎没有变化';
  if (title.length < TITLE_SOFT_MIN) return `标题偏短（${title.length} 字），搜索覆盖可能不足`;
  if (title.length > TITLE_SOFT_MAX) return `标题偏长（${title.length} 字），列表页可能被截断`;
  return undefined;
}

function formatDeepSeekError(status: number, body: string): string {
  if (status === 401) return 'DeepSeek API Key 无效，请到采集预设页重新填写';
  if (status === 402) return 'DeepSeek 余额不足';
  if (status === 429) return 'DeepSeek 请求过于频繁，请稍后再试';
  try {
    const json = JSON.parse(body) as { error?: { message?: string } };
    if (json.error?.message) return `DeepSeek: ${json.error.message}`;
  } catch {
    /* ignore */
  }
  return `DeepSeek 请求失败 (${status})`;
}

async function fetchWithRetry(url: string, init: RequestInit, retries = 1): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status === 429 && retries > 0) {
    await sleep(1200);
    return fetchWithRetry(url, init, retries - 1);
  }
  return res;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const ret: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      ret[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return ret;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const aiTitleService = new AiTitleService();

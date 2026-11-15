import type { CollectedProduct, EditableProduct, ProductRecord } from '@shared/types';
import { mapColorValue } from '@shared/listing-language';
import { getDb } from '../db/index.js';
import { auditService } from '../services/audit-service.js';
import { productService } from '../services/product-service.js';
import { productRepository } from '../repositories/product-repository.js';

const TARGET_COUNT = 300;

interface ThemeRule {
  id: string;
  label: string;
  pattern: RegExp;
}

const THEME_RULES: ThemeRule[] = [
  { id: 'birthday', label: 'Birthday', pattern: /urodzin|birthday|mam\s+\d{2}\s+lat/ },
  { id: 'cat', label: 'Cat', pattern: /\b(kot|kotek|kocur|koci|kociar|cat|kitten)\b/ },
  { id: 'dog', label: 'Dog', pattern: /\b(pies|psa|psi|dog|puppy)\b/ },
  { id: 'wolf', label: 'Wolf', pattern: /\b(wilk|wilka|wolf)\b/ },
  { id: 'bear', label: 'Bear', pattern: /\b(niedzwiedz|mis|bear)\b/ },
  { id: 'eagle', label: 'Eagle', pattern: /\b(orzel|eagle)\b/ },
  { id: 'skull', label: 'Skull', pattern: /czasz|czach|skull|skeleton|szkielet|kostuch|grim\s*reaper|kosciotrup/ },
  { id: 'animal', label: 'Wild Animal', pattern: /\b(pantera?|puma|lew|lion|tygrys|tiger|los|deer|jelen)\b/ },
  { id: 'fishing', label: 'Fishing', pattern: /wedkar|wedkow|ryb|fish|karp|szczupak/ },
  { id: 'beer', label: 'Beer Humor', pattern: /\b(piwo|piwosz|piwowar|beer|whisky|wodka|alkohol|drink|kufel|browar)\b/ },
  { id: 'coffee', label: 'Coffee Humor', pattern: /\b(kawa|kawe|coffee)\b/ },
  { id: 'motorcycle', label: 'Motorcycle Biker', pattern: /motocykl|motor\b|chopper|biker|motocyklist/ },
  { id: 'car', label: 'Classic Car', pattern: /samochod|auto\b|car\b|garaz|kierowc|mechanik/ },
  { id: 'rock', label: 'Rock Guitar', pattern: /rock|gitara|guitar|woodstock|hendrix|metal\b|punk/ },
  { id: 'music', label: 'Music', pattern: /muzyk|music|dj\b|techno|rave|winyl|vinyl|perkus/ },
  { id: 'space', label: 'Retro Space', pattern: /kosmos|kosmicz|space|astronaut|galakty|rakiet|planet|kosmit|alien|ufo|nasa/ },
  { id: 'fantasy', label: 'Fantasy', pattern: /fantasy|smok|dragon|magicz|magic|wiking|viking|runy|rune/ },
  { id: 'gaming', label: 'Gaming', pattern: /gaming|gamer|gra\b|gry\b|kontroler|gamepad|pixel/ },
  { id: 'mountain', label: 'Mountain Adventure', pattern: /gor\b|gory|mountain|hiking|turyst|camping/ },
  { id: 'forest', label: 'Forest Nature', pattern: /las\b|lesn|forest|nature|drzew|outdoor/ },
  { id: 'sailing', label: 'Sailing Ocean', pattern: /zeglar|zaglow|marynar|morze|morsk|ocean|jacht|statek|sailing/ },
  { id: 'surfing', label: 'Surfing Beach', pattern: /surf|kitesurf|windsurf|plaza|beach|fala|wave/ },
  { id: 'football', label: 'Football', pattern: /pilka\s*nozna|futbol|football|soccer/ },
  { id: 'fitness', label: 'Fitness Gym', pattern: /silown|fitness|gym\b|kulturyst|trening/ },
  { id: 'programmer', label: 'Programmer', pattern: /programist|informatyk|computer|komputer|developer|code\b/ },
  { id: 'cooking', label: 'Cooking BBQ', pattern: /kuchar|gotow|grill|bbq|barbecue|chef\b/ },
  { id: 'patriotic', label: 'Patriotic Eagle', pattern: /polsk|patriot|godlo|flaga|orzel/ },
  { id: 'halloween', label: 'Halloween', pattern: /halloween|dynia|pumpkin|witch|wiedzma|duch\b|ghost/ },
  { id: 'christmas', label: 'Christmas', pattern: /swieta|swiatecz|christmas|mikolaj|santa|renifer/ },
  { id: 'retro', label: 'Retro Vintage', pattern: /retro|vintage|oldschool|old\s*school/ },
  { id: 'art', label: 'Abstract Street Art', pattern: /abstrakc|geometr|graffiti|sztuk|street\s*art|artystycz/ },
  { id: 'funny', label: 'Funny Quote', pattern: /smieszn|zabaw|funny|humor|napis|quote|tekst/ },
  { id: 'family', label: 'Dad Gift', pattern: /\b(tat|ojciec|dziadek|maz|meza|chlopak|brat|wujek)\b/ },
];

const CUSTOM_PRINT_RE = /wlasn(?:y|ym)\s+nadruk|twoj\s+nadruk|logo\s+grafika\s+zdjecie|personaliz|na\s+zamowienie/;

const POLISH_COLORS = new Map<string, string>([
  ['czarny', 'Black'], ['czarna', 'Black'], ['czarne', 'Black'],
  ['bialy', 'White'], ['biala', 'White'], ['biale', 'White'],
  ['szary', 'Grey'], ['szara', 'Grey'], ['szare', 'Grey'], ['grafitowy', 'Grey'], ['grafitowa', 'Grey'],
  ['czerwony', 'Red'], ['czerwona', 'Red'], ['czerwone', 'Red'],
  ['niebieski', 'Blue'], ['niebieska', 'Blue'], ['niebieskie', 'Blue'], ['blekitny', 'Blue'],
  ['granatowy', 'Navy'], ['granatowa', 'Navy'], ['granatowe', 'Navy'],
  ['zielony', 'Green'], ['zielona', 'Green'], ['zielone', 'Green'],
  ['khaki', 'Khaki'], ['oliwkowy', 'Khaki'], ['oliwkowa', 'Khaki'],
  ['zolty', 'Yellow'], ['zolta', 'Yellow'], ['zolte', 'Yellow'],
  ['pomaranczowy', 'Orange'], ['pomaranczowa', 'Orange'],
  ['rozowy', 'Pink'], ['rozowa', 'Pink'], ['rozowe', 'Pink'],
  ['fioletowy', 'Purple'], ['fioletowa', 'Purple'],
  ['brazowy', 'Brown'], ['brazowa', 'Brown'],
  ['bezowy', 'Beige'], ['bezowa', 'Beige'], ['kremowy', 'Beige'], ['kremowa', 'Beige'],
  ['bordowy', 'Burgundy'], ['bordowa', 'Burgundy'],
  ['turkusowy', 'Turquoise'], ['turkusowa', 'Turquoise'],
  ['zloty', 'Gold'], ['zlota', 'Gold'], ['srebrny', 'Silver'], ['srebrna', 'Silver'],
  ['wielokolorowy', 'Multicolor'], ['wielokolorowa', 'Multicolor'],
  ['wielobarwny', 'Multicolor'], ['wielobarwna', 'Multicolor'], ['kolorowy', 'Multicolor'],
]);

function fold(value: string): string {
  return value
    .replace(/[łŁ]/g, 'l')
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'"`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
}

function styleKey(product: CollectedProduct): string {
  return fold(product.title)
    .replace(/\b(?:rozmiar\s*)?(?:xs|s|m|l|xl|xxl|[2-9]xl)\b/g, ' ')
    .replace(/\b(?:r|size)\s*(?:xs|s|m|l|xl|xxl|[2-9]xl)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceText(product: CollectedProduct): string {
  return fold(product.title);
}

function matchingThemes(product: CollectedProduct): ThemeRule[] {
  const text = sourceText(product);
  return THEME_RULES.filter((rule) => rule.pattern.test(text));
}

function isEligiblePrintedGarment(product: CollectedProduct): boolean {
  const title = fold(product.title);
  if (CUSTOM_PRINT_RE.test(title)) return false;
  const pattern = fold(product.attributes?.['Wzór dominujący'] ?? product.attributes?.['Wzor dominujacy'] ?? '');
  const printed = pattern.includes('print') || pattern.includes('nadruk') || title.includes('nadruk') || title.includes('grafik');
  return printed;
}

function materialName(product: CollectedProduct): string {
  const material = fold(product.attributes?.['Materiał dominujący'] ?? product.attributes?.['Material dominujacy'] ?? '');
  if (material.includes('poliester')) return 'Polyester';
  if (material.includes('bawelna')) return 'Cotton';
  if (material.includes('wiskoza')) return 'Viscose';
  return '';
}

function birthdayAge(text: string): string | undefined {
  const patterns = [
    /(?:mam\s+)?(\d{2})\s+lat\b/,
    /(\d{2})\.?\s*urodzin/,
    /urodzin\S*\s+(?:na\s+)?(\d{2})\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const age = match?.[1];
    if (age && Number(age) >= 18 && Number(age) <= 99) return age;
  }
  return undefined;
}

function garmentAudience(product: CollectedProduct): string {
  const title = sourceText(product);
  if (/\b(?:dzieciec\w*|dzieci\w*|chlopiec\w*|dziewczyn\w*|junior|kids?|children|boys?|girls?)\b/.test(title)) return "Kids'";
  if (/\b(?:damsk\w*|kobiet\w*|dla niej|womens?|ladies|female|girl)\b/.test(title)) return "Women's";
  return "Men's";
}

function optimizeTitle(product: CollectedProduct): string {
  const text = sourceText(product);
  const themes = matchingThemes(product);
  const primary: string[] = [];
  const age = birthdayAge(text);
  if (age) primary.push(`Age ${age} Birthday`);

  for (const theme of themes) {
    if (theme.id === 'birthday' && age) continue;
    if (primary.some((label) => label.includes(theme.label) || theme.label.includes(label))) continue;
    primary.push(theme.label);
    if (primary.length >= 3) break;
  }
  if (!primary.length) primary.push('Graphic Print');

  const material = materialName(product);
  const subject = primary.join(' ');
  const fabric = material ? `${material} ` : '';
  const audience = garmentAudience(product);
  let title = compact(`${subject} ${audience} ${fabric}Graphic Print T-Shirt`);
  if (title.length > 118) title = compact(`${primary.slice(0, 2).join(' ')} ${audience} ${fabric}Printed T-Shirt`);
  return title.slice(0, 120).replace(/[,:;\s]+$/, '');
}

function normalizeColor(raw: string | undefined): string {
  if (!raw?.trim()) return 'Multicolor';
  const parts = raw.split(/\s*(?:&|,|\/|\+|\bi\b|\band\b)\s*/i).filter(Boolean);
  const mapped = parts.map((part) => {
    const key = fold(part);
    return POLISH_COLORS.get(key) ?? mapColorValue(part)?.trim() ?? 'Multicolor';
  });
  const safe = mapped.map((value) => /[^\x00-\x7F]/.test(value) ? 'Multicolor' : value);
  return Array.from(new Set(safe)).join(' & ') || 'Multicolor';
}

function colorSnapshot(product: EditableProduct): string[] {
  return product.variants.map((variant) => variant.colors ?? '');
}

function selectDiverse(records: ProductRecord[], count: number): ProductRecord[] {
  const buckets = new Map<string, ProductRecord[]>();
  for (const record of records) {
    const key = matchingThemes(record.collected)[0]?.id ?? 'other';
    const bucket = buckets.get(key) ?? [];
    bucket.push(record);
    buckets.set(key, bucket);
  }
  const selected: ProductRecord[] = [];
  const keys = Array.from(buckets.keys()).sort();
  while (selected.length < count) {
    let added = 0;
    for (const key of keys) {
      const next = buckets.get(key)?.shift();
      if (!next) continue;
      selected.push(next);
      added += 1;
      if (selected.length === count) break;
    }
    if (!added) break;
  }
  return selected;
}

function loadCandidates(): { eligible: ProductRecord[]; ineligible: ProductRecord[]; duplicates: ProductRecord[] } {
  const ids = getDb().prepare(`
    SELECT id FROM products
    WHERE json_extract(collected, '$.source') = 'allegro' AND status != 'discarded'
    ORDER BY created_at ASC, id ASC
  `).all() as Array<{ id: string }>;
  const unique = new Map<string, ProductRecord>();
  const seenStyles = new Set<string>();
  const duplicates: ProductRecord[] = [];
  for (const { id } of ids) {
    const record = productRepository.get(id);
    if (!record) continue;
    const sourceId = record.collected.sourceProductId || record.collected.sourceUrl || record.id;
    const style = styleKey(record.collected);
    if (unique.has(sourceId) || seenStyles.has(style)) duplicates.push(record);
    else {
      unique.set(sourceId, record);
      seenStyles.add(style);
    }
  }
  const eligible: ProductRecord[] = [];
  const ineligible: ProductRecord[] = [];
  for (const record of unique.values()) {
    (isEligiblePrintedGarment(record.collected) ? eligible : ineligible).push(record);
  }
  return { eligible, ineligible, duplicates };
}

function main(): void {
  const apply = process.argv.includes('--apply');
  const requested = Number(process.argv.find((arg) => arg.startsWith('--count='))?.split('=')[1] ?? TARGET_COUNT);
  if (!Number.isInteger(requested) || requested < 1) throw new Error('Invalid --count value');

  const { eligible, ineligible, duplicates } = loadCandidates();
  const selected = selectDiverse(eligible, Math.min(requested, eligible.length));
  const selectedIds = new Set(selected.map((record) => record.id));
  const extras = eligible.filter((record) => !selectedIds.has(record.id));

  const preview = selected.slice(0, 12).map((record) => {
    const editable = productService.getEditable(record);
    return {
      id: record.id,
      original: record.collected.title,
      optimized: optimizeTitle(record.collected),
      colorsBefore: colorSnapshot(editable),
      colorsAfter: editable.variants.map((variant) => normalizeColor(variant.colors)),
      variants: editable.variants.length,
      theme: matchingThemes(record.collected)[0]?.id ?? 'other',
    };
  });

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'preview',
    requested,
    eligible: eligible.length,
    ineligible: ineligible.length,
    duplicates: duplicates.length,
    selected: selected.length,
    extras: extras.length,
    preview,
  }, null, 2));

  if (!apply) return;
  if (eligible.length < requested) throw new Error(`Need ${requested} eligible unique Allegro products, found ${eligible.length}`);

  const transaction = getDb().transaction(() => {
    for (const record of selected) {
      const before = productService.getEditable(record);
      const beforeCount = before.variants.length;
      const edited: EditableProduct = {
        ...before,
        title: optimizeTitle(record.collected),
        variants: before.variants.map((variant) => ({ ...variant, colors: normalizeColor(variant.colors) })),
      };
      if (edited.variants.length !== beforeCount) throw new Error(`Variant count changed for ${record.id}`);
      const saved = productRepository.update(record.id, { edited, status: 'edited' });
      if (!saved) throw new Error(`Could not update ${record.id}`);
      auditService.record({
        productId: record.id,
        action: 'batch.optimizeJoomEnglish',
        summary: 'Allegro 印花款：优化英文标题并规范色号',
        before: { title: before.title, colors: colorSnapshot(before), variantCount: beforeCount, collectedVariantSnapshotCount: record.collected.variants.length || 1 },
        after: { title: edited.title, colors: colorSnapshot(edited), variantCount: edited.variants.length },
      });
    }

    const discarded = [...duplicates, ...ineligible, ...extras];
    for (const record of discarded) {
      const saved = productRepository.update(record.id, { status: 'discarded' });
      if (!saved) throw new Error(`Could not discard extra ${record.id}`);
      auditService.record({
        productId: record.id,
        action: 'product.discard',
        summary: '排除重复、非成品印花款或超出 300 款配额',
        before: { status: record.status },
        after: { status: 'discarded' },
      });
    }
  });
  transaction();

  const finalRows = getDb().prepare(`
    SELECT edited FROM products
    WHERE json_extract(collected, '$.source') = 'allegro' AND status != 'discarded'
  `).all() as Array<{ edited: string | null }>;
  if (finalRows.length !== requested) throw new Error(`Expected ${requested} active Allegro rows, found ${finalRows.length}`);
  const invalid = finalRows.filter((row) => {
    if (!row.edited) return true;
    const edited = JSON.parse(row.edited) as EditableProduct;
    return !edited.title || /[^\x00-\x7F]/.test(edited.title) || edited.variants.some((variant) => !variant.colors || /[^\x00-\x7F]/.test(variant.colors));
  });
  if (invalid.length) throw new Error(`${invalid.length} optimized drafts still contain non-English title/color text`);
  console.log(JSON.stringify({ applied: requested, discarded: duplicates.length + ineligible.length + extras.length, validation: 'passed' }));
}

main();

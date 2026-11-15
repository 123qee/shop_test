/**
 * Joom 上架语言规范化：颜色词典、西里尔/非拉丁检测、色名映射。
 * web / server 共用，保证编辑器提示与采集/发布逻辑一致。
 */
import type { EditableProduct, EditableVariant } from './types';

/** 西里尔、汉字、假名、韩文、阿拉伯文等 Joom 上架不允许的文字。 */
const NON_LATIN_RE =
  /[\u0400-\u04FF\u0500-\u052F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0600-\u06FF]/;

/** 来源平台没有颜色时使用的安全兜底色名。该名称属于 Joom 常用英文色名。 */
export const DEFAULT_JOOM_COLOR = 'Multicolor';

export function hasNonLatinListingText(value: string | undefined): boolean {
  return Boolean(value && NON_LATIN_RE.test(value));
}

/** 折叠色名以便匹配：小写、ё→е、去标点、压缩空白。 */
export function foldColorKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[._]+/g, ' ')
    .replace(/[-–—]/g, ' ')
    .replace(/[()[\]{}'"`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitColorParts(raw: string): string[] {
  return raw
    .split(/\s*(?:&|,|\/|\+|and)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function joinColorParts(parts: string[]): string {
  return parts.join(' & ');
}

/** [别名…] → Joom 风格英文色名。别名入库前会 fold。 */
const COLOR_GROUPS: Array<{ target: string; aliases: string[] }> = [
  { target: 'Black', aliases: ['black', 'czarny', 'czarna', 'czarne', 'чёрный', 'черный', 'черная', 'черное', 'черные', 'чёрная', 'чёрное', 'чёрные', 'чернь', 'черный цвет', '黑色', '黑', 'blk'] },
  { target: 'White', aliases: ['white', 'biały', 'bialy', 'biała', 'biala', 'białe', 'biale', 'белый', 'белая', 'белое', 'белые', 'белоснежный', 'молочный', 'молочно белый', 'белый цвет', '白色', '白', 'off white', 'off-white'] },
  { target: 'Grey', aliases: ['grey', 'gray', 'szary', 'szara', 'szare', 'серый', 'серая', 'серое', 'серые', 'графит', 'графитовый', 'антрацит', 'антрацитовый', 'меланж', 'серый меланж', 'светло серый', 'темно серый', 'тёмно серый', '灰色', '灰', '浅灰', '深灰'] },
  { target: 'Red', aliases: ['red', 'czerwony', 'czerwona', 'czerwone', 'красный', 'красная', 'красное', 'красные', 'алый', 'scarlet', '红色', '红'] },
  { target: 'Blue', aliases: ['blue', 'niebieski', 'niebieska', 'niebieskie', 'синий', 'синяя', 'синее', 'синие', 'голубой', 'голубая', 'голубое', 'васильковый', 'светло голубой', '蓝色', '蓝', '浅蓝'] },
  { target: 'Navy', aliases: ['navy', 'navy blue', 'темно синий', 'тёмно синий', 'темно-синий', 'тёмно-синий', 'морской', 'морской волны', '藏青', '深蓝', '藏青色'] },
  { target: 'Green', aliases: ['green', 'zielony', 'zielona', 'zielone', 'зелёный', 'зеленый', 'зелёная', 'зеленая', 'зелёное', 'зеленое', 'зелёные', 'зеленые', 'салатовый', 'светло зеленый', 'темно зеленый', 'тёмно зеленый', 'изумрудный', '绿色', '绿', '浅绿', '深绿'] },
  { target: 'Khaki', aliases: ['khaki', 'хаки', 'army green', 'оливковый', 'олива', '卡其', '卡其色', '军绿'] },
  { target: 'Yellow', aliases: ['yellow', 'жёлтый', 'желтый', 'жёлтая', 'желтая', 'жёлтое', 'желтое', 'горчичный', 'mustard', '黄色', '黄'] },
  { target: 'Orange', aliases: ['orange', 'pomarańczowy', 'pomaranczowy', 'pomarańczowa', 'pomaranczowa', 'оранжевый', 'оранжевая', 'оранжевое', '橙色', '橘色', '橘', '橙'] },
  {
    target: 'Pink',
    aliases: [
      'pink',
      'розовый',
      'розовая',
      'розовое',
      'розовые',
      'пудра',
      'пудровый',
      'light pink',
      'hot pink',
      'lotus color',
      'lotus colour',
      '粉色',
      '粉红色',
      '粉',
    ],
  },
  { target: 'Purple', aliases: ['purple', 'фиолетовый', 'фиолетовая', 'фиолетовое', 'сиреневый', 'лиловый', 'лавандовый', 'indigo', 'индиго', '紫色', '紫'] },
  { target: 'Brown', aliases: ['brown', 'коричневый', 'коричневая', 'коричневое', 'кофейный', 'шоколадный', 'шоколад', 'темно коричневый', 'тёмно коричневый', '棕色', '褐色', '咖啡', '棕'] },
  { target: 'Beige', aliases: ['beige', 'beżowy', 'bezowy', 'beżowa', 'bezowa', 'бежевый', 'бежевая', 'бежевое', 'кремовый', 'cream', 'песочный', 'светло бежевый', 'nude', 'camel', '米色', '米', '杏色', '杏', '裸', '裸色', '卡其米'] },
  { target: 'Ivory', aliases: ['ivory', 'слоновая кость', 'ivory white', '象牙白'] },
  { target: 'Burgundy', aliases: ['burgundy', 'бордовый', 'бордовая', 'бордо', 'вишнёвый', 'вишневый', 'wine', 'maroon', 'кирпичный', 'терракотовый', '酒红', '酒红', '酒红色'] },
  { target: 'Turquoise', aliases: ['turquoise', 'бирюзовый', 'бирюза', 'teal', 'cyan', '青色', '青绿'] },
  { target: 'Coral', aliases: ['coral', 'коралловый', 'персиковый', 'peach', 'coral pink', '珊瑚色', '桃'] },
  { target: 'Gold', aliases: ['gold', 'golden', 'золотой', 'золотая', 'золото', 'champagne', '金色', '金'] },
  { target: 'Silver', aliases: ['silver', 'серебряный', 'серебряная', 'серебро', 'жемчужный', 'pearl', '银色', '银'] },
  { target: 'Bronze', aliases: ['bronze', 'бронзовый', 'медный', 'copper', '铜色', '青铜'] },
  {
    target: 'Multicolor',
    aliases: [
      'multicolor',
      'multicolour',
      'multi color',
      'multi colour',
      'colorful',
      'colourful',
      'multi',
      'разноцветный',
      'мультиколор',
      'цветной',
      'mix',
      'mixed',
      'wielokolorowy',
      'wielokolorowa',
      'wielokolorowe',
      '彩色',
      '多色',
      '彩',
    ],
  },
  { target: 'Transparent', aliases: ['transparent', 'clear', 'прозрачный', 'прозрачная', '透明'] },
  { target: 'Camouflage', aliases: ['camouflage', 'camo', 'камуфляж', 'камуфляжный', '迷彩'] },
  { target: 'Mint', aliases: ['mint', 'мятный', 'мята', '薄荷绿'] },
  { target: 'Fuchsia', aliases: ['fuchsia', 'фуксия', 'magenta', 'малиновый', '玫红'] },
  { target: 'Black & White', aliases: ['black white', 'black and white', 'черно белый', 'чёрно белый', 'бело черный', 'бело чёрный', '黑白'] },
];

const BUILTIN_COLOR_LOOKUP = new Map<string, string>();
for (const group of COLOR_GROUPS) {
  for (const alias of group.aliases) {
    BUILTIN_COLOR_LOOKUP.set(foldColorKey(alias), group.target);
  }
  BUILTIN_COLOR_LOOKUP.set(foldColorKey(group.target), group.target);
}

export interface ColorNormalizeOptions {
  colorMap?: Record<string, string>;
  officialColors?: string[];
}

function lookupInRecord(folded: string, map: Record<string, string> | undefined): string | undefined {
  if (!map) return undefined;
  const exact = Object.entries(map).find(([key]) => foldColorKey(key) === folded);
  return exact?.[1]?.trim() || undefined;
}

function canonicalOfficial(value: string, official: string[] | undefined): string | undefined {
  if (!official?.length) return undefined;
  const folded = foldColorKey(value);
  return official.find((name) => foldColorKey(name) === folded);
}

function mapOnePart(part: string, opts: ColorNormalizeOptions | undefined): string {
  const trimmed = part.trim();
  if (!trimmed) return trimmed;
  const folded = foldColorKey(trimmed);
  const fromUser = lookupInRecord(folded, opts?.colorMap);
  const fromBuiltin = BUILTIN_COLOR_LOOKUP.get(folded);
  const candidate = fromUser || fromBuiltin || trimmed;
  return canonicalOfficial(candidate, opts?.officialColors) ?? candidate;
}

/** 把单个颜色值映射为 Joom 英文色名；无法识别则原样返回。 */
export function mapColorValue(raw: string | undefined, opts?: ColorNormalizeOptions): string | undefined {
  if (!raw?.trim()) return raw;
  const parts = splitColorParts(raw);
  if (!parts.length) return raw.trim();
  const mapped = parts.map((part) => mapOnePart(part, opts));
  const joined = mapped.length === 1 ? mapped[0] : joinColorParts(mapped);
  return canonicalOfficial(joined, opts?.officialColors) ?? joined;
}

/** 若映射结果与原文不同则返回建议值，否则 undefined。 */
export function suggestMappedColor(raw: string | undefined, opts?: ColorNormalizeOptions): string | undefined {
  const mapped = mapColorValue(raw, opts);
  if (!mapped || !raw) return undefined;
  return foldColorKey(mapped) === foldColorKey(raw) ? undefined : mapped;
}

export function isOfficialColor(raw: string | undefined, officialColors: string[] | undefined): boolean {
  if (!raw?.trim()) return true;
  if (!officialColors?.length) return true;
  return splitColorParts(raw).every((part) => Boolean(canonicalOfficial(part, officialColors)));
}

export function colorStillUnresolved(raw: string | undefined, opts?: ColorNormalizeOptions): boolean {
  if (!raw?.trim()) return false;
  const mapped = mapColorValue(raw, opts) ?? raw;
  if (hasNonLatinListingText(mapped)) return true;
  if (opts?.officialColors?.length && !isOfficialColor(mapped, opts.officialColors)) return true;
  return false;
}

export interface ColorNormalizeResult {
  product: EditableProduct;
  mappedCount: number;
  defaultedCount: number;
  unresolved: string[];
}

function uniqueUnresolved(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = foldColorKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function normalizeProductColors(product: EditableProduct, opts?: ColorNormalizeOptions): ColorNormalizeResult {
  const unresolved: string[] = [];
  let mappedCount = 0;
  let defaultedCount = 0;
  const variants: EditableVariant[] = product.variants.map((variant) => {
    const original = variant.colors?.trim();
    if (!original) {
      defaultedCount += 1;
      const fallback = canonicalOfficial(DEFAULT_JOOM_COLOR, opts?.officialColors) || opts?.officialColors?.[0] || DEFAULT_JOOM_COLOR;
      return { ...variant, colors: fallback };
    }
    const mapped = mapColorValue(original, opts) ?? original;
    if (foldColorKey(mapped) !== foldColorKey(original)) mappedCount += 1;
    if (colorStillUnresolved(mapped, opts) || (hasNonLatinListingText(original) && foldColorKey(mapped) === foldColorKey(original))) {
      unresolved.push(original);
    }
    return mapped === variant.colors ? variant : { ...variant, colors: mapped };
  });
  return {
    product: variants === product.variants ? product : { ...product, variants },
    mappedCount,
    defaultedCount,
    unresolved: uniqueUnresolved(unresolved),
  };
}

export function listingHasLanguageRisk(product: EditableProduct): boolean {
  if (hasNonLatinListingText(product.title) || hasNonLatinListingText(product.description)) return true;
  return product.variants.some(
    (variant) =>
      hasNonLatinListingText(variant.colors) ||
      hasNonLatinListingText(variant.size) ||
      Object.values(variant.attributes ?? {}).some((value) => hasNonLatinListingText(value)),
  );
}

export function languageRiskHints(product: EditableProduct): string[] {
  const hints: string[] = [];
  if (hasNonLatinListingText(product.title)) hints.push('标题含非英文字符');
  if (hasNonLatinListingText(product.description)) hints.push('描述含非英文字符');
  product.variants.forEach((variant, i) => {
    if (hasNonLatinListingText(variant.colors)) hints.push(`变体 ${i + 1} 颜色含非英文字符`);
    if (hasNonLatinListingText(variant.size)) hints.push(`变体 ${i + 1} 尺码含非英文字符`);
    for (const [key, value] of Object.entries(variant.attributes ?? {})) {
      if (hasNonLatinListingText(key) || hasNonLatinListingText(value)) {
        hints.push(`变体 ${i + 1} 规格含非英文字符`);
        break;
      }
    }
  });
  return hints;
}

/** 兼容 Joom /productColors 的多种返回结构。 */
export function normalizeJoomColorList(data: unknown): string[] {
  const arr: unknown[] = Array.isArray(data)
    ? data
    : (((data as { colors?: unknown[]; items?: unknown[]; data?: unknown[] } | null)?.colors ??
        (data as { items?: unknown[] } | null)?.items ??
        (data as { data?: unknown[] } | null)?.data ??
        []) as unknown[]);
  const names = arr
    .map((item) => (typeof item === 'string' ? item : String((item as { name?: string; value?: string } | null)?.name ?? (item as { value?: string } | null)?.value ?? '')))
    .map((name) => name.trim())
    .filter(Boolean);
  return Array.from(new Set(names));
}

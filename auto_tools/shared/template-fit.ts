import type { CollectedProduct, GroupTemplateBinding, PresetTemplate, ProductGroupId, ProductGrouping } from './types';
import { findGroupTemplateBinding, inferProductGrouping, SWEAT_PATTERN } from './product-grouping';

/**
 * 预设模板的「核对 + 推荐」规则：
 * - 入库：采集栏主动选了模板，核对没有矛盾就直接算已确认；有矛盾留在待确认，并写明原因。
 * - 分拣：给待确认商品推荐模板，并说明依据。
 *
 * 两处共用这一份规则。只读取来源信息（标题、属性、变体尺码）和模板设置，不依赖存储或界面。
 */

export type FitAudience = 'adult' | 'kids';
export type FitKind = 'short' | 'sweat';
export type FitMaterial = 'cotton' | 'polyester';
export type ProductKind = FitKind | 'top' | 'pants' | 'dress' | 'shoes' | 'home' | 'other';
export type FitDimension = 'audience' | 'kind' | 'material' | 'zip' | 'set';

/** 模板代表的商品类型；推断不出的维度留空，不参与核对。 */
export interface TemplateTraits {
  audience?: FitAudience;
  kind?: FitKind;
  material?: FitMaterial;
  zip?: boolean;
  set?: boolean;
}

/** strong 证据足以判定矛盾；弱证据只影响推荐排序。label 用于向用户解释依据。 */
export interface FitEvidence<T> {
  value: T;
  strong: boolean;
  label: string;
}

export interface ProductTraits {
  audience?: FitEvidence<FitAudience>;
  kind?: FitEvidence<ProductKind>;
  material?: FitEvidence<FitMaterial>;
  zip?: FitEvidence<boolean>;
  set?: FitEvidence<boolean>;
}

export interface FitIssue {
  dimension: FitDimension;
  message: string;
}

export interface TemplateFit {
  templateId: string;
  /** 与商品的矛盾；非空时不能自动确认，也不会被推荐。 */
  issues: FitIssue[];
  /** 对上的依据，用来解释推荐理由。 */
  reasons: string[];
  score: number;
}

export interface TemplateSuggestion {
  templateId: string;
  /** high：人群和品类都有可靠依据，且没有得分接近的候选；low：需要看图确认。 */
  confidence: 'high' | 'low';
  reasons: string[];
  /** 同样没有矛盾、得分接近的其他模板。 */
  alternatives: string[];
  /** 需要人工看图判断的地方，例如有没有拉链。 */
  note?: string;
}

export interface TemplateReview {
  traits: ProductTraits;
  /** 与传入的 templates 同序。 */
  fits: TemplateFit[];
  /** 所有模板都有矛盾时为空。 */
  suggestion?: TemplateSuggestion;
}

export type TemplateLike = Pick<PresetTemplate, 'id' | 'name' | 'defaults'>;

export interface TemplateReviewOptions {
  /** 商品分组；人工纠正过的分组优先于自动推断。 */
  grouping?: ProductGrouping;
  /** 分组常用预设，只在没有矛盾的候选之间做加权。 */
  bindings?: GroupTemplateBinding[];
  /** 当前模板，得分相同时优先保留，避免无谓切换。 */
  preferredId?: string;
}

export const AUDIENCE_LABEL: Record<FitAudience, string> = { adult: '成人款', kids: '童装' };
export const KIND_LABEL: Record<ProductKind, string> = {
  short: '短袖 T 恤', sweat: '卫衣', top: '其他上衣', pants: '裤装', dress: '裙装', shoes: '鞋类', home: '家居用品', other: '其他商品',
};
export const MATERIAL_LABEL: Record<FitMaterial, string> = { cotton: '棉', polyester: '聚酯' };

const KIND_BY_GROUP: Partial<Record<ProductGroupId, ProductKind>> = {
  'men-short': 'short', 'women-short': 'short', 'kids-short': 'short', short: 'short',
  'men-sweat': 'sweat', 'women-sweat': 'sweat', 'kids-sweat': 'sweat', sweat: 'sweat',
  'men-top': 'top', 'women-top': 'top', 'kids-top': 'top', top: 'top',
  pants: 'pants', dress: 'dress', shoes: 'shoes', home: 'home', other: 'other',
};

/** 人群和品类决定模板大类，对不上一定是矛盾；材质、拉链、套装只在有更合适的模板可选时才算矛盾。 */
const PRIMARY_DIMENSIONS: FitDimension[] = ['audience', 'kind'];

function norm(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// ---- 尺码判断人群 ----

const SIZE_KEY = /size|尺码|尺寸|размер|talla|talle|tama|rozmiar|taglia|taille|gro(?:ss|ß)e|\bage\b|возраст|рост|edad|wiek|年龄|身高|height/iu;
const KID_SIZE_KEY = /kid|child|baby|детск|\bnin[oa]s?\b|infant|\bage\b|возраст|рост|edad|wiek|年龄|身高|height|童/iu;
const LETTER_SIZE = /^(?:[1-9]|1[0-2])?X{0,6}(?:S|M|L)$/u;
const BRAZIL_SIZE = /^(?:P{1,2}|G{1,2}|XG{1,2}|EG{1,2}|[1-9]G)$/u;
const KID_ANNOTATION = /(?:^|[^A-Z0-9.])\d{1,2}\s*(?:[-–~/]\s*\d{1,2}\s*)?(?:T|Y|YRS?|YEARS?|ЛЕТ|ГОДА?|AÑOS|ANOS|LAT)(?![A-Z0-9])|岁|个月|(?:^|[^A-Z0-9.])\d{1,2}\s*(?:M|MONTHS?|МЕС)(?![A-Z0-9])/u;

type SizeVote = 'kids' | 'kids-weak' | 'adult';

function sizeVote(key: string, raw: string): { vote?: SizeVote; display: string } {
  const value = raw.normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim();
  const display = value.replace(/\s*[（(\[【].*$/u, '').replace(/\s*RECOMMEND.*$/u, '').trim() || value;
  if (!value) return { display };
  if (KID_SIZE_KEY.test(norm(key))) return { vote: 'kids', display };
  if (KID_ANNOTATION.test(value)) return { vote: 'kids', display };
  if (display.split('/').every((part) => LETTER_SIZE.test(part.trim()) || BRAZIL_SIZE.test(part.trim()))) return { vote: 'adult', display };
  const numeric = display.match(/^(\d{1,3})(\s*(?:CM|СМ))?(?:\s*[-/]\s*\d{1,3}(?:\s*(?:CM|СМ))?)?$/u);
  if (!numeric) return { display };
  const size = Number(numeric[1]);
  // 带 cm 的只可能是身高；不带单位时，小数字是年龄，38-66 是欧码/俄码，68-164 是童装身高。
  if (numeric[2]) return { vote: size >= 50 && size <= 164 ? 'kids' : size >= 165 && size <= 200 ? 'adult' : undefined, display };
  if (size >= 1 && size <= 16) return { vote: 'kids-weak', display };
  if (size >= 38 && size <= 66) return { vote: 'adult', display };
  if (size >= 68 && size <= 164) return { vote: 'kids', display };
  if (size >= 165 && size <= 200) return { vote: 'adult', display };
  return { display };
}

function sizeRange(values: string[]): string {
  const unique = [...new Set(values)];
  return unique.length <= 3 ? unique.join('/') : `${unique[0]}–${unique[unique.length - 1]}`;
}

/**
 * 按尺码投票判断人群：一方票数至少是另一方的 2 倍，并且占全部尺码的四成以上，才算可靠。
 * 有些商品把「8cm / 40cm / M」这类非服装规格放在尺码里，零星一个 M 不能说明是成人款。
 */
export function audienceFromSizes(entries: Array<{ key: string; value: string }>): FitEvidence<FitAudience> | undefined {
  let kids = 0;
  let solidKids = 0;
  let adult = 0;
  const kidValues: string[] = [];
  const adultValues: string[] = [];
  for (const entry of entries) {
    const { vote, display } = sizeVote(entry.key, entry.value);
    if (vote === 'adult') { adult += 1; adultValues.push(display); }
    else if (vote === 'kids') { kids += 1; solidKids += 1; kidValues.push(display); }
    else if (vote === 'kids-weak') { kids += 0.5; kidValues.push(display); }
  }
  const enough = (votes: number) => votes >= Math.max(1, entries.length * 0.4);
  if (kids > 0 && kids >= adult * 2) {
    return { value: 'kids', strong: solidKids > 0 && enough(kids), label: `尺码 ${sizeRange(kidValues)}` };
  }
  if (adult > 0 && adult >= kids * 2) return { value: 'adult', strong: enough(adult), label: `尺码 ${sizeRange(adultValues)}` };
  return undefined;
}

/** 变体里的尺码类规格（去重，保持原顺序）。 */
export function productSizeEntries(product: CollectedProduct): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [];
  const seen = new Set<string>();
  for (const variant of product.variants ?? []) {
    for (const [key, value] of Object.entries(variant.options ?? {})) {
      if (!SIZE_KEY.test(norm(key)) || !value?.trim()) continue;
      const id = `${key}\u0000${value.trim()}`;
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({ key, value: value.trim() });
    }
  }
  return entries;
}

// ---- 模板与商品特征 ----

/** 从模板名称和预设字段推断模板代表的商品类型。 */
export function templateTraits(template: Pick<PresetTemplate, 'name' | 'defaults'>): TemplateTraits {
  const name = norm(template.name);
  const attributes = Object.fromEntries(
    Object.entries(template.defaults?.attributes ?? {}).map(([key, value]) => [key.toLowerCase(), String(value).toLowerCase()]),
  );
  const traits: TemplateTraits = {};
  if (/童|儿童|宝宝|婴|\b(?:kids?|child(?:ren)?|boys?|girls?|baby)\b/u.test(name)) traits.audience = 'kids';
  else if (/成人|男|女|\b(?:adults?|mens?|womens?|unisex)\b/u.test(name)) traits.audience = 'adult';
  else traits.audience = audienceFromSizes((template.defaults?.targetSizes ?? []).map((value) => ({ key: 'size', value })))?.value;

  if (/卫衣|连帽|\b(?:hoodies?|sweatshirts?)\b|толстовк|худи/u.test(name)) traits.kind = 'sweat';
  else if (/短袖|t恤|\b(?:t-?shirts?|tees?)\b|футболк/u.test(name)) traits.kind = 'short';

  const material = attributes.material ?? '';
  if (/聚酯|涤纶|\bpolyester\b/u.test(name) || /^poly/u.test(material)) traits.material = 'polyester';
  else if (/棉|\bcotton\b/u.test(name) || /cotton|棉/u.test(material)) traits.material = 'cotton';

  if (/无拉链|不带拉链|套头|\bpullover\b|\bno[\s-]?zip/u.test(name)) traits.zip = false;
  else if (/拉链|\bzip/u.test(name)) traits.zip = true;

  if (/套装|\bsets?\b/u.test(name) || Number(attributes.piecesquantityperset) >= 2) traits.set = true;
  else if (traits.kind) traits.set = false;
  return traits;
}

const THREE_D = /(?<!\d)3d(?![a-z0-9])|\bsublimat|сублимац|all[\s-]?over[\s-]?print/iu;
const ZIP = /\bzip(?:per|pered|ped)?\b|\bzip[\s-]?up\b|full[\s-]?zip|\bziper\b|молни|cremallera|\bzamek\b|拉链/iu;
const NO_ZIP = /без\s+молни|sin\s+cremallera|套头|\bno[\s-]?zip|\bwithout\s+zip/iu;
/** 卖家常把带拉链的卫衣也写成 pullover，只作参考。 */
const PULLOVER = /\bpullovers?\b/iu;
const SET = /\b(?:sets?|tracksuits?|two[\s-]?pieces?|2\s*(?:pcs|pieces?))\b|комплект|костюм|\bconjuntos?\b|\bzestaw\b|套装|两件套/iu;

function evidenceSource(grouping: ProductGrouping): string {
  if (grouping.reason.includes('类别')) return '类别';
  if (grouping.reason.includes('描述')) return '描述';
  return '标题';
}

/** 从来源信息提取商品特征。尺码判断人群最可靠，标题只作参考。 */
export function productTraits(product: CollectedProduct, grouping: ProductGrouping = inferProductGrouping(product)): ProductTraits {
  const title = norm(product.title ?? '');
  const traits: ProductTraits = {};
  const manual = grouping.source === 'manual';

  const sized = audienceFromSizes(productSizeEntries(product));
  if (sized) traits.audience = sized;
  else if (grouping.groupId.startsWith('kids-')) traits.audience = { value: 'kids', strong: manual, label: manual ? '已手动分组为童装' : '标题像童装' };
  else if (grouping.groupId.startsWith('men-') || grouping.groupId.startsWith('women-')) {
    traits.audience = { value: 'adult', strong: manual, label: manual ? '已手动分组为成人款' : '标题像成人款' };
  }

  const kind = KIND_BY_GROUP[grouping.groupId];
  if (kind) {
    traits.kind = { value: kind, strong: kind !== 'top', label: manual ? `已手动分组为${KIND_LABEL[kind]}` : `${evidenceSource(grouping)}像${KIND_LABEL[kind]}` };
  } else if (SWEAT_PATTERN.test(title)) {
    // 标题同时提到卫衣和裤子（常见于套装）时分组待判断，但仍可按卫衣推荐。
    traits.kind = { value: 'sweat', strong: false, label: '标题提到卫衣' };
  }

  if (grouping.material === 'cotton' || grouping.material === 'polyester') {
    traits.material = {
      value: grouping.material,
      strong: true,
      label: manual ? `已确认材质为${MATERIAL_LABEL[grouping.material]}` : `材质写的是${MATERIAL_LABEL[grouping.material]}`,
    };
  } else if (THREE_D.test(title)) {
    traits.material = { value: 'polyester', strong: true, label: '标题有 3D 印花，多半是聚酯' };
  } else if (grouping.material === 'unknown') {
    traits.material = { value: 'cotton', strong: false, label: '标题没提 3D，按棉处理' };
  }

  if (ZIP.test(title)) traits.zip = { value: true, strong: true, label: '标题提到拉链' };
  else if (NO_ZIP.test(title)) traits.zip = { value: false, strong: true, label: '标题写的是套头/无拉链' };
  else if (PULLOVER.test(title)) traits.zip = { value: false, strong: false, label: '标题写的是 pullover' };

  if (SET.test(title)) traits.set = { value: true, strong: false, label: '标题像套装' };
  return traits;
}

// ---- 核对与推荐 ----

function evaluateFit(template: TemplateLike, wanted: TemplateTraits, traits: ProductTraits): TemplateFit {
  const issues: FitIssue[] = [];
  const reasons: string[] = [];
  let score = 0;

  if (wanted.audience && traits.audience) {
    const { value, strong, label } = traits.audience;
    if (wanted.audience === value) { score += strong ? 4 : 1.5; reasons.push(`${label} → ${AUDIENCE_LABEL[value]}`); }
    else if (strong) issues.push({ dimension: 'audience', message: `模板是${AUDIENCE_LABEL[wanted.audience]}，但${label}，像${AUDIENCE_LABEL[value]}` });
    else score -= 1.5;
  }

  if (wanted.kind && traits.kind) {
    const { value, strong, label } = traits.kind;
    if (wanted.kind === value) { score += strong ? 4 : 1.5; reasons.push(label); }
    else if (value === 'top') score -= 0.5;
    else if (strong) issues.push({ dimension: 'kind', message: `模板是${KIND_LABEL[wanted.kind]}，但${label}` });
    else score -= 1.5;
  }

  if (wanted.material && traits.material) {
    const { value, strong, label } = traits.material;
    if (wanted.material === value) { score += strong ? 2 : 0.5; reasons.push(label); }
    else if (strong) issues.push({ dimension: 'material', message: `模板是${MATERIAL_LABEL[wanted.material]}，但${label}` });
    else score -= 0.5;
  }

  if (wanted.zip !== undefined && traits.zip) {
    const { value, strong, label } = traits.zip;
    if (wanted.zip === value) { score += strong ? 2 : 0.5; reasons.push(label); }
    else if (strong) issues.push({ dimension: 'zip', message: `模板是${wanted.zip ? '有拉链' : '无拉链'}，但${label}` });
    else score -= 0.5;
  }

  if (wanted.set !== undefined) {
    const isSet = traits.set?.value ?? false;
    if (wanted.set && isSet) { score += 2; reasons.push(traits.set!.label); }
    else if (wanted.set) score -= 1.5;
    else if (isSet) {
      if (traits.set!.strong) issues.push({ dimension: 'set', message: `模板是单件，但${traits.set!.label}` });
      else score -= 2;
    }
  }

  return { templateId: template.id, issues, reasons, score };
}

/**
 * 细分维度（材质、拉链、套装）的矛盾只在「有更合适的模板」时才算。
 * 例如所有卫衣模板都是棉，3D 卫衣就不该因为材质被拦下。
 */
function keepActionableIssues(fits: TemplateFit[], wanted: TemplateTraits[]): TemplateFit[] {
  return fits.map((fit, index) => {
    const softened = fit.issues.filter((issue) => {
      if (PRIMARY_DIMENSIONS.includes(issue.dimension)) return false;
      return !fits.some((other, otherIndex) => otherIndex !== index
        && !other.issues.some((x) => PRIMARY_DIMENSIONS.includes(x.dimension) || x.dimension === issue.dimension)
        && wanted[otherIndex][issue.dimension] !== undefined
        && wanted[otherIndex][issue.dimension] !== wanted[index][issue.dimension]);
    });
    if (!softened.length) return fit;
    return { ...fit, issues: fit.issues.filter((issue) => !softened.includes(issue)), score: fit.score - softened.length };
  });
}

/** 提示需要看图判断的地方，从大类到细节，最多两条。 */
function noteFor(best: TemplateTraits, close: TemplateTraits[]): string | undefined {
  const notes: string[] = [];
  if (close.some((t) => t.kind !== best.kind)) notes.push('品类拿不准，看图确认');
  if (close.some((t) => t.audience !== best.audience)) notes.push('人群拿不准，看尺码');
  if (close.some((t) => t.material !== best.material)) notes.push('材质没写清楚，看图或详情确认');
  if (close.some((t) => t.set !== best.set)) notes.push('是不是套装要看图');
  if (close.some((t) => t.zip !== best.zip)) notes.push('有没有拉链要看图');
  return notes.length ? notes.slice(0, 2).join('；') : undefined;
}

/** 逐个核对模板，并给出推荐（得分最高且没有矛盾的模板）。 */
export function reviewTemplates(product: CollectedProduct, templates: TemplateLike[], options: TemplateReviewOptions = {}): TemplateReview {
  const grouping = options.grouping ?? inferProductGrouping(product);
  const traits = productTraits(product, grouping);
  const wanted = templates.map((template) => templateTraits(template));
  const fits = keepActionableIssues(templates.map((template, index) => evaluateFit(template, wanted[index], traits)), wanted);
  const binding = options.bindings?.length ? findGroupTemplateBinding(options.bindings, grouping.groupId, grouping.material) : undefined;
  const ranked = fits
    .map((fit, index) => ({
      fit,
      index,
      total: fit.score + (fit.templateId === binding?.templateId ? 0.3 : 0) + (fit.templateId === options.preferredId ? 0.2 : 0),
    }))
    .filter((entry) => !entry.fit.issues.length)
    .sort((a, b) => b.total - a.total || a.index - b.index);
  const best = ranked[0];
  if (!best) return { traits, fits };
  // 常用预设和当前模板只用来打破平局；有没有把握只看商品本身的证据。
  const close = ranked.slice(1).filter((entry) => entry.fit.score >= best.fit.score - 1);
  const bestTraits = wanted[best.index];
  const audienceSure = Boolean(traits.audience?.strong && bestTraits.audience === traits.audience.value);
  const kindSure = Boolean(traits.kind?.strong && bestTraits.kind === traits.kind.value);
  return {
    traits,
    fits,
    suggestion: {
      templateId: best.fit.templateId,
      confidence: audienceSure && kindSure && !close.length ? 'high' : 'low',
      reasons: best.fit.reasons,
      alternatives: close.map((entry) => entry.fit.templateId),
      note: noteFor(bestTraits, close.map((entry) => wanted[entry.index])),
    },
  };
}

/** 核对一个模板与商品是否矛盾；templates 用于判断材质等细分维度是否有更合适的选择。 */
export function checkTemplateFit(
  product: CollectedProduct,
  templateId: string,
  templates: TemplateLike[],
  grouping?: ProductGrouping,
): FitIssue[] {
  return reviewTemplates(product, templates, { grouping }).fits.find((fit) => fit.templateId === templateId)?.issues ?? [];
}

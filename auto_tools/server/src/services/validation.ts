import type { EditableProduct, ValidationIssue } from '@shared/types';
import { hasNonLatinListingText, isOfficialColor } from '@shared/listing-language';
import { editableVariantKey } from './variant-dedupe.js';

/** 发布校验未通过时抛出,errorHandler 转 400 并透传 issues。 */
export class PublishValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super('发布校验未通过');
    this.name = 'PublishValidationError';
  }
}

// 图片代理首次处理远端图片时可能超过 8 秒；留足生成时间再判定不可访问。
const IMG_TIMEOUT_MS = 30000;
const DANGER_KIND_VALUES = new Set([
  'adult',
  'aerosoleAndGases',
  'battery',
  'dangerousChemicals',
  'flammable',
  'hair',
  'highDensity',
  'liquid',
  'lookAlikeWeapon',
  'magnets',
  'perfumes',
  'plants',
  'powder',
  'semiLiquid',
  'sharp',
  'teaLeafs',
  'weaponAccessories',
  'withBattery',
]);

/** 检查图片 URL 是否可访问且是图片(HEAD 失败则退回 Range GET,兼容拒绝 HEAD 的 CDN)。 */
async function checkImageReachable(url: string): Promise<boolean> {
  const attempt = async (init: RequestInit) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IMG_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      const ct = res.headers.get('content-type') || '';
      return res.ok && (ct.startsWith('image/') || ct === '');
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  if (!/^https?:\/\//i.test(url)) return false;
  if (await attempt({ method: 'HEAD' })) return true;
  return attempt({ method: 'GET', headers: { Range: 'bytes=0-0' } });
}

export interface ValidateOptions {
  /** 类目要求的必填属性 id 列表(缺失则报 error) */
  requiredAttributeIds?: Array<{ id: string; name: string }>;
  /** 是否检查图片可达性(默认 true;可关闭以加快纯字段校验) */
  checkImages?: boolean;
  /** Joom 官方色名;有值时变体颜色必须命中,拉不到则只拦非英文 */
  allowedColors?: string[];
}

/**
 * 发布前校验:必填字段 + 变体 + 图片可达性 + 类目必填属性。
 * 返回 issues 列表;error 级存在即不可发布。前后端共用同一逻辑。
 */
export async function validateForPublish(
  p: EditableProduct,
  opts: ValidateOptions = {},
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const err = (field: string, message: string) => issues.push({ field, message, severity: 'error' });
  const warn = (field: string, message: string) => issues.push({ field, message, severity: 'warning' });

  if (!p.title?.trim()) err('title', '商品名(name)必填');
  else if (hasNonLatinListingText(p.title)) err('title', '商品名含非英文字符,Joom 审核会拒绝');
  if (!p.sku?.trim()) err('sku', '商品 SKU 必填');
  if (!p.currency?.trim()) err('currency', '币种(currency)必填');
  else if (!/^[A-Z]{3}$/.test(p.currency)) warn('currency', '币种应为 3 位大写 ISO 代码,如 USD');
  if (hasNonLatinListingText(p.description)) warn('description', '描述含非英文字符,建议改成英文或使用预设描述');

  if (p.dangerInfo?.isDangerous && !p.dangerInfo.dangerKinds?.length) {
    err('dangerInfo.dangerKinds', '危险品必须至少选择一种 dangerKinds');
  }
  for (const kind of p.dangerInfo?.dangerKinds ?? []) {
    if (!DANGER_KIND_VALUES.has(kind)) err('dangerInfo.dangerKinds', `不支持的危险品类型:${kind}`);
  }

  if (!p.images?.length || !p.images[0]?.trim()) err('mainImage', '主图必填(图片列表第一张)');
  if (p.images && p.images.length > 21) warn('images', 'Joom 最多 1 主图 + 20 附图,超出部分会被截断');

  if (!p.variants?.length) err('variants', '至少需要一个变体');
  const skuSet = new Set<string>();
  const variantSet = new Set<string>();
  p.variants?.forEach((v, i) => {
    if (!v.sku?.trim()) err(`variants.${i}.sku`, `变体 ${i + 1}:SKU 必填`);
    else if (skuSet.has(v.sku)) err(`variants.${i}.sku`, `变体 ${i + 1}:SKU 重复(${v.sku})`);
    else skuSet.add(v.sku);
    const variantKey = editableVariantKey(v);
    if (variantSet.has(variantKey)) err(`variants.${i}`, `变体 ${i + 1}:颜色、尺码和其他规格重复`);
    else variantSet.add(variantKey);
    if (!(typeof v.price === 'number' && v.price > 0)) err(`variants.${i}.price`, `变体 ${i + 1}:价格需大于 0`);
    if (v.salePrice != null && v.price != null && v.salePrice >= v.price)
      warn(`variants.${i}.salePrice`, `变体 ${i + 1}:促销价应低于原价`);
    if (v.gtin && !/^\d{8,14}$/.test(v.gtin)) err(`variants.${i}.gtin`, `变体 ${i + 1}:GTIN 应为 8~14 位数字`);
    if (hasNonLatinListingText(v.colors)) {
      err(`variants.${i}.colors`, `变体 ${i + 1}:颜色含非英文字符,请映射为 Joom 英文色名`);
    } else if (v.colors?.trim() && !isOfficialColor(v.colors, opts.allowedColors)) {
      err(`variants.${i}.colors`, `变体 ${i + 1}:颜色不是 Joom 允许的色名(${v.colors})`);
    }
    if (hasNonLatinListingText(v.size)) warn(`variants.${i}.size`, `变体 ${i + 1}:尺码含非英文字符`);
    for (const [key, value] of Object.entries(v.attributes ?? {})) {
      if (hasNonLatinListingText(key) || hasNonLatinListingText(value)) {
        warn(`variants.${i}.attributes`, `变体 ${i + 1}:规格含非英文字符`);
        break;
      }
    }
  });

  // 类目必填属性
  for (const attr of opts.requiredAttributeIds ?? []) {
    if (!p.attributes?.[attr.id]?.trim()) err(`attributes.${attr.id}`, `类目必填属性缺失:${attr.name}`);
  }

  // 图片可达性(默认开启;主图不可达为 error,附图为 warning)
  if (opts.checkImages !== false && p.images?.length) {
    const imgs = p.images.slice(0, 6);
    const results = await Promise.all(imgs.map((u) => (u?.trim() ? checkImageReachable(u) : Promise.resolve(false))));
    results.forEach((ok, i) => {
      if (ok) return;
      const msg = `图片无法访问或不是图片:${imgs[i]}`;
      if (i === 0) err('mainImage', msg);
      else warn(`images.${i}`, msg);
    });
  }

  return issues;
}

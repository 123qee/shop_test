import type { ProductGroupId, ProductMaterial, SourcePlatform } from './types';

export const MIAOSHOU_SITES = ['CL', 'MX', 'CO', 'BR'] as const;
export type MiaoshouSite = typeof MIAOSHOU_SITES[number];
export const MIAOSHOU_SITE_NAMES: Record<MiaoshouSite, string> = { CL: '智利', MX: '墨西哥', CO: '哥伦比亚', BR: '巴西' };
export type MiaoshouStatus = 'pending' | 'skipped' | 'ready' | 'queued' | 'submitting' | 'submitted' | 'failed' | 'needs_review';
export const MIAOSHOU_STATUS_NAMES: Record<MiaoshouStatus, string> = { pending: '待分拣', skipped: '暂时跳过', ready: '待提交', queued: '排队中', submitting: '提交中', submitted: '已入妙手采集箱', failed: '提交失败', needs_review: '结果待核对' };

export interface MiaoshouAttribute { name: string; values: { name: string }[] }
export interface MiaoshouAttributeRule {
  id: string; name: string; displayName?: string; valueType?: string;
  tags?: Record<string, unknown>; values?: { id?: string; name: string; displayName?: string }[];
}
export interface MiaoshouRules { productAttributeRules: MiaoshouAttributeRule[]; saleAttributeRules: MiaoshouAttributeRule[]; skuAttributeRules: MiaoshouAttributeRule[] }
export interface MiaoshouFields {
  shopId: string; sites: MiaoshouSite[]; categoryId: string;
  /** 金额始终为 USD 净收益，不从采集价格换算。 */
  netProceeds: number | null; sitePrices: Partial<Record<MiaoshouSite, number>>;
  siteTitles: Partial<Record<MiaoshouSite, string>>; attributes: MiaoshouAttribute[];
  description: string; warrantyType: '' | 'sellerWarranty' | 'factoryWarranty' | 'noWarranty';
  warrantyTime: number | null; warrantyTimeUnit: 'days' | 'months' | 'years';
  stock: number | null; weightKg: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null;
  /** 采集规格名 -> 妙手销售属性 name；尺码转换显式配置，不生成笛卡尔积。 */
  optionMappings: Record<string, string>; sizeMap: Record<string, string>;
}
export interface MiaoshouTemplate extends MiaoshouFields {
  id: string; name: string; groupId: ProductGroupId | ''; material: ProductMaterial | '';
}
export interface MiaoshouVariant {
  sku: string; options: Record<string, string>; images: string[]; stock: number | null;
  /** 来源价格只记录，不作为净收益。 */
  sourcePrice: number | null; sizeGridRowId: string;
}
export interface MiaoshouDraft extends MiaoshouFields {
  id: string; productId: string; templateId: string; title: string; images: string[];
  variants: MiaoshouVariant[]; source: SourcePlatform; sourceUrl: string; sourceProductId: string;
  status: MiaoshouStatus; version: number; remoteId?: string; lastError?: string;
  createdAt: string; updatedAt: string;
}
export interface MiaoshouSummary {
  id: string; productId: string; title: string; image?: string; templateId: string; source: SourcePlatform;
  shopId: string; sites: MiaoshouSite[]; netProceeds: number | null; status: MiaoshouStatus;
  remoteId?: string; lastError?: string; version: number; updatedAt: string; issues: string[];
}
export interface MiaoshouConfigPublic { configured: boolean; appKey: string; secretConfigured: boolean; defaultShopId: string; defaultSites: MiaoshouSite[] }
export interface MiaoshouShop { shopId: string; name: string; site: string; status?: string }
export interface MiaoshouWorkspace { drafts: MiaoshouSummary[]; templates: MiaoshouTemplate[]; config: MiaoshouConfigPublic; undoId?: string }
export interface MiaoshouCategory { id: string; label: string }
export interface MiaoshouCandidate { remoteId: string; title: string; shopId: string }

export function emptyMiaoshouFields(): MiaoshouFields {
  return { shopId: '', sites: [...MIAOSHOU_SITES], categoryId: '', netProceeds: null, sitePrices: {}, siteTitles: {}, attributes: [], description: '', warrantyType: '', warrantyTime: null, warrantyTimeUnit: 'days', stock: null, weightKg: null, lengthCm: null, widthCm: null, heightCm: null, optionMappings: {}, sizeMap: {} };
}

export function miaoshouDraftIssues(draft: MiaoshouDraft): string[] {
  const issues: string[] = [];
  if (!draft.shopId) issues.push('选择妙手店铺');
  if (!draft.sites.length) issues.push('选择至少一个站点');
  if (!draft.categoryId) issues.push('选择产品类目');
  if (!draft.title.trim() || Array.from(draft.title).length > 60 || /[\u3400-\u9fff]/.test(draft.title)) issues.push('填写不超过 60 字符的英文基础标题');
  if (!draft.description.trim() || /[\u3400-\u9fff]/.test(draft.description)) issues.push('填写英文产品描述');
  if (draft.netProceeds == null || draft.netProceeds <= 0) issues.push('填写大于零的全球净收益（USD）');
  if (draft.sites.some(site => draft.sitePrices[site] !== undefined && draft.sitePrices[site]! <= 0)) issues.push('站点净收益需大于零');
  if (draft.sites.some(site => { const title = draft.siteTitles[site]; return title && (Array.from(title).length > 60 || /[\u3400-\u9fff]/.test(title)); })) issues.push('站点标题不能含中文且不能超过 60 字符');
  if (!draft.images.length || draft.images.some(url => !/^https?:\/\//i.test(url))) issues.push('至少保留一张公网商品图片');
  if (!draft.warrantyType) issues.push('选择保修类型');
  if (draft.warrantyType && draft.warrantyType !== 'noWarranty' && (draft.warrantyTime == null || draft.warrantyTime <= 0)) issues.push('填写保修时长');
  if (!draft.variants.length || draft.variants.length > 100) issues.push('SKU 数量应为 1–100 个，请调整保留的 SKU');
  if (new Set(draft.variants.map(v => v.sku)).size !== draft.variants.length || draft.variants.some(v => !v.sku.trim())) issues.push('SKU 编码不能为空或重复');
  if (draft.variants.some(v => (draft.stock ?? v.stock) == null)) issues.push('填写默认库存或逐 SKU 库存');
  if ([draft.weightKg, draft.lengthCm, draft.widthCm, draft.heightCm].some(n => n == null || n <= 0)) issues.push('填写包裹重量与长宽高');
  return issues;
}

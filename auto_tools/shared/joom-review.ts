import type { JoomIssueDetail } from './types';

export type JoomReviewReasonKey =
  | 'intellectualProperty'
  | 'restrictedProduct'
  | 'image'
  | 'content'
  | 'category'
  | 'categoryPermission'
  | 'variant'
  | 'duplicate'
  | 'priceOrShipping'
  | 'compliance'
  | 'unknown';

export interface JoomReviewReasonMeta {
  label: string;
  advice: string;
  tone: 'danger' | 'warning';
}

export const JOOM_REVIEW_REASON_META: Record<JoomReviewReasonKey, JoomReviewReasonMeta> = {
  intellectualProperty: { label: '疑似侵权 / 品牌风险', advice: '检查标题、描述、图片中的品牌名、Logo 和受保护图案；没有授权时建议删除。', tone: 'danger' },
  restrictedProduct: { label: '商品可能受限或禁售', advice: '确认商品不属于 Joom 禁售/限制销售品，并补充必要的安全或合规信息。', tone: 'danger' },
  image: { label: '图片不符合要求', advice: '检查主图和附图是否清晰、可访问，是否包含水印、Logo、违规内容或与商品不一致。', tone: 'danger' },
  content: { label: '商品信息不完整或不合规', advice: '检查标题、描述、标签和文字内容，删除夸大、敏感或无法证明的表述。', tone: 'danger' },
  category: { label: '类目或属性不正确', advice: '重新确认商品类目，并补齐该类目要求的必填属性。', tone: 'danger' },
  categoryPermission: { label: '当前店铺没有该类目权限', advice: '当前店铺暂时不能销售这个类目；请更换有权限的类目，或联系 Joom 申请该类目销售权限。', tone: 'danger' },
  variant: { label: '变体信息有问题', advice: '检查变体 SKU、颜色、尺码、GTIN 及变体图片，确保每个变体信息一致。', tone: 'danger' },
  duplicate: { label: '商品重复', advice: '检查是否已存在相同商品或相同 SKU，必要时合并或下架重复商品。', tone: 'warning' },
  priceOrShipping: { label: '价格或物流信息有问题', advice: '检查价格、库存、重量、尺寸、运费和履约时效是否完整且合理。', tone: 'danger' },
  compliance: { label: '缺少合规资料', advice: '确认是否需要许可证、认证或其他合规文件，并按 Joom 要求补充。', tone: 'danger' },
  unknown: { label: 'Joom 审核未通过', advice: '先查看具体问题；如果原因仍不明确，可携带商品 ID 和原始信息联系 Joom 客服。', tone: 'danger' },
};

const RULES: Array<{ key: JoomReviewReasonKey; words: string[] }> = [
  { key: 'categoryPermission', words: ['category not permitted', 'category is not permitted', 'authorized merchants can sell', '类目权限', '无权销售'] },
  { key: 'intellectualProperty', words: ['intellectual', 'copyright', 'trademark', 'counterfeit', 'brand', 'logo', 'infring', '知识产权', '侵权', '品牌', '商标', '版权'] },
  { key: 'restrictedProduct', words: ['prohibited', 'restricted', 'dangerous', 'weapon', 'adult', 'illegal', 'flammable', 'battery', '禁售', '限制销售', '危险品', '违禁'] },
  { key: 'image', words: ['image', 'images', 'photo', 'picture', 'blockedimage', 'mainimage', '图片', '主图', '附图', '图像'] },
  { key: 'category', words: ['category', 'categor', 'attribute', '类目', '属性'] },
  { key: 'variant', words: ['variant', 'sku', 'color', 'colour', 'size', 'gtin', '变体', '颜色', '尺码'] },
  { key: 'duplicate', words: ['duplicate', 'already exists', '重复', '已存在'] },
  { key: 'priceOrShipping', words: ['price', 'shipping', 'delivery', 'weight', 'dimension', 'inventory', 'stock', '运费', '价格', '库存', '物流'] },
  { key: 'compliance', words: ['certificate', 'license', 'compliance', 'safety', 'document', '认证', '许可证', '合规', '安全'] },
  { key: 'content', words: ['title', 'name', 'description', 'content', 'tag', 'keyword', 'language', '文字', '标题', '描述', '标签', '语言'] },
];

export function classifyJoomIssue(issue: Pick<JoomIssueDetail, 'code' | 'title' | 'message' | 'field' | 'kind'>): JoomReviewReasonKey {
  const text = [issue.code, issue.title, issue.message, issue.field, issue.kind].filter(Boolean).join(' ').toLowerCase();
  for (const rule of RULES) {
    if (rule.words.some((word) => text.includes(word.toLowerCase()))) return rule.key;
  }
  return 'unknown';
}

export function summarizeJoomIssues(details: JoomIssueDetail[] | undefined, fallback?: string) {
  const source = details?.length ? details : fallback?.trim() ? [{ message: fallback }] : [];
  const grouped = new Map<JoomReviewReasonKey, JoomIssueDetail[]>();
  for (const detail of source) {
    const key = classifyJoomIssue(detail);
    grouped.set(key, [...(grouped.get(key) ?? []), detail]);
  }
  return [...grouped.entries()].map(([key, items]) => ({ key, meta: JOOM_REVIEW_REASON_META[key], items }));
}

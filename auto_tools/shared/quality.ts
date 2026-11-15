import type { EditableProduct, ProductQualityScore, ProductRecord } from './types';
import { languageRiskHints } from './listing-language';

/**
 * 可解释的商品质量评分。web / server 共用，保证列表、看板、编辑器口径一致。
 */
export function scoreProduct(p: EditableProduct, record?: ProductRecord): ProductQualityScore {
  const breakdown: ProductQualityScore['breakdown'] = [];
  const add = (key: string, label: string, score: number, max: number, hint?: string) =>
    breakdown.push({ key, label, score: Math.max(0, Math.min(score, max)), max, hint });

  add('basics', '基础信息', [p.title, p.sku, p.description].filter((x) => x?.trim()).length * 4, 12);
  add(
    'images',
    '图片质量',
    p.images.length ? Math.min(18, 6 + Math.min(p.images.length - 1, 6) * 2) : 0,
    18,
    p.images.length < 2 ? '建议至少准备主图和 1 张附图' : undefined,
  );
  const validVariants = p.variants.filter((v) => v.sku && v.price > 0);
  add('variants', '变体完整度', p.variants.length ? Math.round((validVariants.length / p.variants.length) * 18) : 0, 18);
  const attrCount = Object.keys(p.attributes ?? {}).filter((k) => p.attributes?.[k]?.trim()).length;
  add('attributes', '类目属性', Math.min(16, attrCount * 4), 16, attrCount ? undefined : '建议填写类目属性');
  add(
    'logistics',
    '物流信息',
    Math.min(14, p.variants.filter((v) => v.shippingWeight && v.shippingPrice != null).length * 4),
    14,
    '建议填写重量和运费',
  );
  add('compliance', '合规声明', p.dangerInfo ? 10 : 4, 10, p.dangerInfo ? undefined : '请明确填写普通货/危险品声明');
  const langHints = languageRiskHints(p);
  add('language', '语言合规', langHints.length ? 0 : 12, 12, langHints[0]);
  if (record?.joomState === 'rejected') add('review', '审核状态', 0, 2, 'Joom 审核未通过，请查看错误原因');
  const raw = breakdown.reduce((s, b) => s + b.score, 0);
  const score = Math.round((raw / breakdown.reduce((s, b) => s + b.max, 0)) * 100);
  const grade = score >= 85 ? 'excellent' : score >= 70 ? 'good' : score >= 50 ? 'attention' : 'risk';
  return { score, grade, breakdown };
}

export const QUALITY_GRADE_META: Record<ProductQualityScore['grade'], { label: string }> = {
  excellent: { label: '优秀' },
  good: { label: '良好' },
  attention: { label: '需完善' },
  risk: { label: '高风险' },
};

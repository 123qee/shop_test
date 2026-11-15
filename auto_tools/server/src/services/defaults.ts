import type { CollectDefaults, EditableProduct, EditableVariant } from '@shared/types';
import { randomVariantSku } from '../util/sku.js';
import { DEFAULT_JOOM_COLOR, mapColorValue } from './listing-language.js';

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

/** 按价格规则算出目标价(采集价为来源站数值)。 */
function computePrice(sourcePrice: number | undefined, d: CollectDefaults): number {
  if (d.priceMode === 'fixed') return round2(d.fixedPrice);
  return round2((sourcePrice ?? 0) * (d.priceMultiplier || 1));
}

function mappedSize(size: string | undefined, sizeMap: Record<string, string> | undefined): string | undefined {
  if (!size || !sizeMap) return size;
  const exact = sizeMap[size];
  if (exact) return exact;
  const key = Object.keys(sizeMap).find((k) => k.toLowerCase() === size.toLowerCase());
  return key ? sizeMap[key] : size;
}

function variantGroupKey(v: EditableVariant): string {
  const attributes = Object.entries(v.attributes ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    v.colors?.trim().toLowerCase() ?? '',
    attributes,
  ]);
}

function sizeKey(size: string | undefined): string {
  return size?.trim().toLowerCase() ?? '';
}

function uniqueGeneratedSku(used: Set<string>): string {
  return randomVariantSku(used);
}

/**
 * 将变体整理成目标尺码矩阵。每个颜色 + 其他属性组合视为一组：
 * 删除模板外尺码，缺失项复制该组现有变体，并生成唯一 SKU。
 */
export function reconcileTargetSizes(
  variants: EditableVariant[],
  targetSizes: string[] | undefined,
): EditableVariant[] {
  const targets = Array.from(new Map((targetSizes ?? []).map((s) => [sizeKey(s), s.trim()])).values()).filter(Boolean);
  if (!targets.length) return variants;

  const groups = new Map<string, EditableVariant[]>();
  for (const variant of variants) {
    const key = variantGroupKey(variant);
    const group = groups.get(key) ?? [];
    group.push(variant);
    groups.set(key, group);
  }

  const usedSkus = new Set(variants.map((v) => v.sku));
  const output: EditableVariant[] = [];
  for (const group of groups.values()) {
    const base = group[0];
    const bySize = new Map<string, EditableVariant>();
    for (const variant of group) {
      const key = sizeKey(variant.size);
      if (key && !bySize.has(key)) bySize.set(key, variant);
    }
    for (const target of targets) {
      const existing = bySize.get(sizeKey(target));
      if (existing) {
        output.push({ ...existing, size: target });
      } else {
        output.push({
          ...base,
          sku: uniqueGeneratedSku(usedSkus),
          size: target,
        });
      }
    }
  }
  return output;
}

/**
 * 把预设套用到「采集派生」的草稿:统一币种、按规则算价、覆盖库存、
 * 尺码映射、填充运费/履约天数、补默认店铺/类目。
 * 仅用于尚未被用户编辑保存的草稿。
 */
export function applyDefaults(editable: EditableProduct, d: CollectDefaults): EditableProduct {
  // 类目属性默认:预设提供默认值,已有编辑值优先
  const mergedAttrs = { ...(d.attributes ?? {}), ...(editable.attributes ?? {}) };
  const mappedVariants = editable.variants.map((v) => ({
    ...v,
    size: mappedSize(v.size, d.sizeMap),
    colors: mapColorValue(v.colors, { colorMap: d.colorMap }) ?? v.colors ?? DEFAULT_JOOM_COLOR,
  }));
  const sizedVariants = reconcileTargetSizes(mappedVariants, d.targetSizes);
  return {
    ...editable,
    currency: d.currency, // 关键:变体币种必须等于账户币种
    description: d.description?.trim() ? d.description : editable.description, // 预设描述覆盖
    dangerInfo: editable.dangerInfo ?? d.dangerInfo ?? { isDangerous: false },
    attributes: Object.keys(mergedAttrs).length ? mergedAttrs : editable.attributes,
    storeId: editable.storeId ?? d.storeId,
    categoryId: editable.categoryId ?? d.categoryId,
    variants: sizedVariants.map((v) => ({
      ...v,
      price: computePrice(v.price, d),
      salePrice: v.salePrice != null ? computePrice(v.salePrice, d) : undefined,
      msrPrice: d.msrPrice ?? v.msrPrice,
      inventory: d.inventory,
      size: v.size,
      shippingPrice: v.shippingPrice ?? d.shippingPrice,
      shippingWeight: v.shippingWeight ?? d.shippingWeight,
      shippingLength: v.shippingLength ?? d.shippingLength,
      shippingWidth: v.shippingWidth ?? d.shippingWidth,
      shippingHeight: v.shippingHeight ?? d.shippingHeight,
      committedFulfillmentDays: v.committedFulfillmentDays ?? d.committedFulfillmentDays,
    })),
  };
}

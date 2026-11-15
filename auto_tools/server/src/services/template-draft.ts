import type { CollectedProduct, EditableProduct, ProductRecord } from '@shared/types';
import { settingsService } from './settings-service.js';
import { applyDefaults } from './defaults.js';
import { deriveEditable, preserveVariantSkus } from './product-service.js';
import { normalizeProductColors } from './listing-language.js';
import { dedupeEditableProduct } from './variant-dedupe.js';

/** 批量操作和分拣使用的当前草稿：已编辑优先，否则按商品模板从采集数据派生。 */
export function currentDraft(record: Pick<ProductRecord, 'collected' | 'edited' | 'templateId'>): EditableProduct {
  const value = record.edited ?? applyDefaults(deriveEditable(record.collected), settingsService.getDefaultsFor(record.templateId));
  return dedupeEditableProduct(normalizeProductColors(value).product);
}

/**
 * 换模板时重建草稿：类目、属性、尺码、价格、描述等预设字段取新模板；
 * 标题、SKU、品牌、标签、图片和已有变体 SKU 保持不变。
 */
export function rebuildDraftForTemplate(collected: CollectedProduct, current: EditableProduct, templateId: string): EditableProduct {
  const fresh = applyDefaults(deriveEditable(collected), settingsService.getDefaultsFor(templateId));
  return {
    ...fresh,
    title: current.title,
    sku: current.sku,
    brand: current.brand,
    tags: current.tags,
    images: current.images,
    variants: preserveVariantSkus(fresh.variants, current.variants),
  };
}

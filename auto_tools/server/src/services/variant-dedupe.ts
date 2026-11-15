import type { CollectedProduct, EditableProduct, EditableVariant, Variant } from '@shared/types';
import { mapColorValue } from '@shared/listing-language';

export interface VariantDedupeResult<T> {
  variants: T[];
  removed: number;
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function optionsKey(options: Record<string, string> | undefined): string {
  return Object.entries(options ?? {})
    .map(([key, value]) => [normalizedText(key), normalizedText(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function attributesKey(attributes: Record<string, string> | undefined): string {
  return optionsKey(attributes);
}

function isColorOptionKey(key: string): boolean {
  const normalized = normalizedText(key);
  return ['color', 'colour', '颜色', '色', 'цвет'].some((name) => normalized.includes(name));
}

function canonicalColor(value: string): string {
  return normalizedText(mapColorValue(value) ?? value);
}

function collectedOptionsKey(options: Record<string, string> | undefined): string {
  return Object.entries(options ?? {})
    .map(([key, value]) => [normalizedText(key), isColorOptionKey(key) ? canonicalColor(value) : normalizedText(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

/** 采集变体的业务唯一键：可见来源规格，不包含图片或来源 SKU。 */
export function collectedVariantKey(variant: Variant): string {
  return collectedOptionsKey(variant.options);
}

/** Joom 变体的业务唯一键：颜色 + 尺码 + 其他规格，不包含图片或 Joom SKU。 */
export function editableVariantKey(variant: EditableVariant): string {
  return [
    canonicalColor(variant.colors ?? ''),
    normalizedText(variant.size),
    attributesKey(variant.attributes),
  ].join('|');
}

function collectedCompleteness(variant: Variant): number {
  return Number(Boolean(variant.sourceSkuId)) + Number(Boolean(variant.image)) +
    Number(variant.price != null) + Number(variant.stock != null);
}

function editableCompleteness(variant: EditableVariant): number {
  return [
    variant.sku,
    variant.colors,
    variant.size,
    variant.image,
    variant.salePrice,
    variant.msrPrice,
    variant.declaredValue,
    variant.shippingPrice,
    variant.shippingWeight,
    variant.shippingLength,
    variant.shippingWidth,
    variant.shippingHeight,
    variant.gtin,
    variant.hsCode,
    variant.committedFulfillmentDays,
  ].filter((value) => value != null && String(value).trim() !== '').length;
}

function preferCollected(current: Variant, candidate: Variant): Variant {
  if (collectedCompleteness(candidate) > collectedCompleteness(current)) return candidate;
  if ((candidate.stock ?? -1) > (current.stock ?? -1)) return candidate;
  if (candidate.price != null && current.price != null && candidate.price > 0 && candidate.price < current.price) return candidate;
  return current;
}

function preferEditable(current: EditableVariant, candidate: EditableVariant): EditableVariant {
  if (editableCompleteness(candidate) > editableCompleteness(current)) return candidate;
  if (candidate.inventory > current.inventory) return candidate;
  if (candidate.price > 0 && candidate.price < current.price) return candidate;
  return current;
}

function dedupe<T>(variants: T[], keyOf: (variant: T) => string, prefer: (current: T, candidate: T) => T): VariantDedupeResult<T> {
  const positions = new Map<string, number>();
  const output: T[] = [];
  for (const variant of variants) {
    const key = keyOf(variant);
    const position = positions.get(key);
    if (position == null) {
      positions.set(key, output.length);
      output.push(variant);
    } else {
      output[position] = prefer(output[position], variant);
    }
  }
  return { variants: output, removed: variants.length - output.length };
}

export function dedupeCollectedVariants(variants: Variant[]): VariantDedupeResult<Variant> {
  return dedupe(variants, collectedVariantKey, preferCollected);
}

export function dedupeEditableVariants(variants: EditableVariant[]): VariantDedupeResult<EditableVariant> {
  return dedupe(variants, editableVariantKey, preferEditable);
}

export function dedupeCollectedProduct(product: CollectedProduct): CollectedProduct {
  return { ...product, variants: dedupeCollectedVariants(product.variants).variants };
}

export function dedupeEditableProduct(product: EditableProduct): EditableProduct {
  return { ...product, variants: dedupeEditableVariants(product.variants).variants };
}

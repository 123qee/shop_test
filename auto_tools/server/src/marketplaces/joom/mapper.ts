import type { EditableProduct } from '@shared/types';

/** 创建商品接口路径(相对 API v3 base)。 */
export const JOOM_CREATE_PRODUCT_PATH = '/products/create';
/** 更新已存在商品(Joom 通过 query 的 id 或 sku 定位)。 */
export const JOOM_UPDATE_PRODUCT_PATH = '/products/update';
/** 永久删除商品及全部变体(Joom 通过 query 的 id 或 sku 定位)。 */
export const JOOM_REMOVE_PRODUCT_PATH = '/products/remove';
/** 永久删除 Joom 商品中的指定变体。 */
export const JOOM_REMOVE_VARIANTS_PATH = '/products/removeVariations';

/**
 * EditableProduct -> Joom API v3 `POST /products/create` 请求体。
 * 严格对齐官方 schema:
 *  - 商品级必填:name、sku、mainImage、variants
 *  - 价格为字符串、且在变体级;currency 也在变体级(不含 VAT)
 *  - 颜色/尺码为 variant.colors / variant.size;其他规格进 attributes[{key,value}]
 *  - 无仓库字段(默认仓库)
 * 与真实 API 有出入时只改本文件。
 */
export function mapToJoomCreatePayload(p: EditableProduct): Record<string, unknown> {
  const currency = (p.currency || 'USD').toUpperCase();

  const source = p.variants.length ? p.variants : [defaultVariant(p)];
  const variants = source.map((v) => {
    const attrs = toAttributeArray(v.attributes);
    return {
      sku: v.sku,
      currency,
      price: priceString(v.price),
      inventory: Math.max(0, Math.floor(v.inventory ?? 0)),
      enabled: true,
      ...(v.salePrice != null ? { salePrice: priceString(v.salePrice) } : {}),
      ...(v.msrPrice != null ? { msrPrice: priceString(v.msrPrice) } : {}),
      ...(v.declaredValue != null ? { declaredValue: priceString(v.declaredValue) } : {}),
      ...(v.shippingPrice != null ? { shippingPrice: priceString(v.shippingPrice) } : {}),
      ...(v.shippingWeight != null ? { shippingWeight: v.shippingWeight } : {}),
      ...(v.shippingLength != null ? { shippingLength: v.shippingLength } : {}),
      ...(v.shippingWidth != null ? { shippingWidth: v.shippingWidth } : {}),
      ...(v.shippingHeight != null ? { shippingHeight: v.shippingHeight } : {}),
      ...(v.gtin ? { gtin: v.gtin } : {}),
      ...(v.hsCode ? { hsCode: v.hsCode } : {}),
      ...(v.committedFulfillmentDays != null
        ? { committedFulfillmentDays: Math.round(v.committedFulfillmentDays) }
        : {}),
      ...(v.colors ? { colors: v.colors } : {}),
      ...(v.size ? { size: v.size } : {}),
      ...(v.image ? { mainImage: v.image } : {}),
      ...(attrs.length ? { attributes: attrs } : {}),
    };
  });

  const productAttrs = toAttributeArray(p.attributes);
  // dangerInfo 创建必需:默认声明为普通货(非危险品),危险品才带 dangerKinds
  const dangerInfo =
    p.dangerInfo?.isDangerous
      ? { isDangerous: true, ...(p.dangerInfo.dangerKinds?.length ? { dangerKinds: p.dangerInfo.dangerKinds } : {}) }
      : { isDangerous: false };
  return {
    name: p.title,
    sku: p.sku,
    mainImage: p.images[0],
    enabled: true,
    dangerInfo,
    ...(productAttrs.length ? { attributes: productAttrs } : {}),
    ...(p.description ? { description: p.description } : {}),
    ...(p.images.length > 1 ? { extraImages: p.images.slice(1, 21) } : {}),
    ...(p.storeId ? { storeId: p.storeId } : {}),
    ...(p.categoryId ? { categoryId: p.categoryId } : {}),
    ...(p.brand ? { brand: p.brand } : {}),
    ...(p.tags?.length ? { tags: p.tags } : {}),
    variants,
  };
}

/**
 * EditableProduct -> Joom API v3 `POST /products/update` 请求体。
 *
 * Update Product 是 PATCH-like 接口：未传字段不会改变；显式传 null
 * 用于清空支持清空的可选字段。因此这里不能复用 create mapper，
 * 也不能把 storeId / sku 放进 body（它们不是 update body 字段）。
 */
export function mapToJoomUpdatePayload(p: EditableProduct): Record<string, unknown> {
  const currency = (p.currency || 'USD').toUpperCase();
  const payload: Record<string, unknown> = {
    name: p.title,
    mainImage: p.images[0],
    dangerInfo: mapDangerInfo(p.dangerInfo),
    variants: p.variants.map((v) => mapVariant(v, currency)),
  };

  if (p.attributes !== undefined) {
    payload.attributes = toAttributeArray(p.attributes).length ? toAttributeArray(p.attributes) : null;
  }
  if (p.brand !== undefined) payload.brand = p.brand.trim() || null;
  if (p.categoryId) payload.categoryId = p.categoryId;
  if (p.description !== undefined) payload.description = p.description.trim() || null;
  if (p.images.length > 1) payload.extraImages = p.images.slice(1, 21);
  else payload.extraImages = null;
  if (p.tags !== undefined) payload.tags = p.tags.length ? p.tags : null;

  return payload;
}

/** 金额转字符串(Joom 要求字符串、两位小数)。 */
function priceString(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

function toAttributeArray(attrs?: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(attrs ?? {}).map(([key, value]) => ({ key, value }));
}

function mapDangerInfo(dangerInfo: EditableProduct['dangerInfo']): Record<string, unknown> {
  return dangerInfo?.isDangerous
    ? {
        isDangerous: true,
        ...(dangerInfo.dangerKinds?.length ? { dangerKinds: dangerInfo.dangerKinds } : {}),
      }
    : { isDangerous: false };
}

function mapVariant(v: EditableProduct['variants'][number], currency: string): Record<string, unknown> {
  const attrs = toAttributeArray(v.attributes);
  return {
    sku: v.sku,
    currency,
    price: priceString(v.price),
    inventory: Math.max(0, Math.floor(v.inventory ?? 0)),
    enabled: true,
    ...(v.salePrice != null ? { salePrice: priceString(v.salePrice) } : {}),
    ...(v.msrPrice != null ? { msrPrice: priceString(v.msrPrice) } : {}),
    ...(v.declaredValue != null ? { declaredValue: priceString(v.declaredValue) } : {}),
    ...(v.shippingPrice != null ? { shippingPrice: priceString(v.shippingPrice) } : {}),
    ...(v.shippingWeight != null ? { shippingWeight: v.shippingWeight } : {}),
    ...(v.shippingLength != null ? { shippingLength: v.shippingLength } : {}),
    ...(v.shippingWidth != null ? { shippingWidth: v.shippingWidth } : {}),
    ...(v.shippingHeight != null ? { shippingHeight: v.shippingHeight } : {}),
    ...(v.gtin ? { gtin: v.gtin } : {}),
    ...(v.hsCode ? { hsCode: v.hsCode } : {}),
    ...(v.committedFulfillmentDays != null
      ? { committedFulfillmentDays: Math.round(v.committedFulfillmentDays) }
      : {}),
    ...(v.colors ? { colors: v.colors } : {}),
    ...(v.size ? { size: v.size } : {}),
    ...(v.image ? { mainImage: v.image } : {}),
    ...(attrs.length ? { attributes: attrs } : {}),
  };
}

/** 无变体时用商品信息合成一个默认变体(price 由调用方保证已在商品数据里)。 */
function defaultVariant(p: EditableProduct): EditableProduct['variants'][number] {
  return { sku: `${p.sku}-default`, price: 0, inventory: 999 };
}

/** 从创建响应 data 中取 Joom 商品 id(response.data.id)。 */
export function extractJoomProductId(data: unknown): string {
  const d = data as { id?: string } | undefined;
  return String(d?.id ?? '');
}

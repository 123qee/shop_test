import type { ProductIndexItem } from '@shared/product-catalog';

export const ID_LOOKUP_LIMIT = 100;

export type IdMatchVia = 'joomId' | 'sku';

export type IdLookupHit = {
  product: ProductIndexItem;
  via: IdMatchVia;
  token: string;
  collision: boolean;
};

export type IdLookupResult = {
  matched: IdLookupHit[];
  missed: string[];
};

/** 切开逗号、分号、竖线、空白，忽略大小写去重，保留首次出现顺序。 */
export function parseProductIds(raw: string): { ids: string[]; truncated: boolean } {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of raw.split(/[\s,，;；|]+/)) {
    const id = part.trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  return {
    ids: ids.slice(0, ID_LOOKUP_LIMIT),
    truncated: ids.length > ID_LOOKUP_LIMIT,
  };
}

function pushIndex(map: Map<string, ProductIndexItem[]>, key: string | undefined, product: ProductIndexItem) {
  const normalized = key?.trim().toLowerCase();
  if (!normalized) return;
  const list = map.get(normalized);
  if (list) list.push(product);
  else map.set(normalized, [product]);
}

/** 先精确匹配 Joom 商品 ID，未中再精确匹配商品级 SKU。 */
export function lookupProductsByIds(items: ProductIndexItem[], ids: string[]): IdLookupResult {
  const byJoom = new Map<string, ProductIndexItem[]>();
  const bySku = new Map<string, ProductIndexItem[]>();
  for (const product of items) {
    pushIndex(byJoom, product.joomProductId, product);
    pushIndex(bySku, product.edited?.sku, product);
  }

  const matched: IdLookupHit[] = [];
  const missed: string[] = [];
  const seenProduct = new Set<string>();

  for (const token of ids) {
    const key = token.toLowerCase();
    const joomHits = byJoom.get(key) ?? [];
    const skuHits = joomHits.length ? [] : (bySku.get(key) ?? []);
    const via: IdMatchVia = joomHits.length ? 'joomId' : 'sku';
    const hits = joomHits.length ? joomHits : skuHits;
    if (!hits.length) {
      missed.push(token);
      continue;
    }
    const collision = hits.length > 1;
    for (const product of hits) {
      if (seenProduct.has(product.id)) continue;
      seenProduct.add(product.id);
      matched.push({ product, via, token, collision });
    }
  }

  return { matched, missed };
}

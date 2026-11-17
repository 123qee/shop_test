import type { CollectedProduct, EditableProduct } from '@shared/types';
import { getDb } from '../db/index.js';
import type { StoredOrderLine } from '../repositories/order-repository.js';
import { orderSourceRegistry } from './registry.js';

/** 每次预览只读一次同款素材；旧订单也能直接使用商品库中的图片。 */
export function createOrderImageResolver() {
  const cache = new Map<string, string[]>();
  return (line: StoredOrderLine): string[] => {
    const key = JSON.stringify([line.platform, line.shopId, line.productId, line.productSku]);
    if (!cache.has(key)) {
      const id = orderSourceRegistry.get(line.platform)?.findCatalogProductId?.(line, line.shopId);
      const row = id ? getDb().prepare('SELECT edited, collected FROM products WHERE id = ?').get(id) as
        { edited: string | null; collected: string } | undefined : undefined;
      let images: string[] = [];
      if (row) {
        try {
          const edited = row.edited ? JSON.parse(row.edited) as EditableProduct : undefined;
          const collected = JSON.parse(row.collected) as CollectedProduct;
          images = edited?.images?.length ? edited.images : collected.images ?? [];
        } catch { /* 素材损坏时仍可用订单图片 */ }
      }
      cache.set(key, images);
    }
    return [...new Set([line.imageUrl, ...(line.imageUrls ?? []), ...cache.get(key)!])]
      .filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url));
  };
}

import { randomInt } from 'node:crypto';

/** 生成 16 位数字商品 SKU，并避开已有商品 SKU。 */
export function randomProductSku(isUsed: (sku: string) => boolean): string {
  let sku: string;
  do {
    sku = `${randomInt(10_000_000, 100_000_000)}${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
  } while (isUsed(sku));
  return sku;
}

/** 生成 11 位数字变体 SKU（Joom 上限 50，且不与已用集合重复）。 */
export function randomVariantSku(used: Set<string> = new Set()): string {
  let sku: string;
  do {
    sku = String(Math.floor(1e10 + Math.random() * 9e10));
  } while (used.has(sku));
  used.add(sku);
  return sku;
}

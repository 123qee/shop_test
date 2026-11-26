import type { ProductIndexItem } from '@shared/product-catalog';
import type { MercadoLibreListingIndexItem, MercadoLibreValidationResponse } from '@shared/types';

export const WORKSPACE_PAGE_SIZE = 30;
export const BULK_CONCURRENCY = 3;
export type BulkAction = 'validate' | 'publish';
export interface ListingBatchResult {
  listing: MercadoLibreListingIndexItem;
  ok: boolean;
  error?: string;
}

export function productSearchText(product: ProductIndexItem): string {
  return [product.collected.title, product.collected.sourceProductId, product.collected.store?.name,
    product.collected.generatedSku, product.edited?.sku, product.edited?.title, product.sourceSkuSearchText]
    .filter(Boolean).join(' ').toLowerCase();
}

/** Selection belongs to products, independently of the currently displayed page or filters. */
export function selectedListingTargets(listings: MercadoLibreListingIndexItem[], productIds: Set<string>) {
  return listings.filter((listing) => productIds.has(listing.productId));
}

export function remainingSelectedProducts(selected: Set<string>, results: ListingBatchResult[]) {
  const submitted = new Set(results.map((result) => result.listing.productId));
  const failed = new Set(results.filter((result) => !result.ok).map((result) => result.listing.productId));
  return new Set([...selected].filter((id) => !submitted.has(id) || failed.has(id)));
}

/** No automatic retry: a failed publish response may still represent a successful remote write. */
export async function runListingBatch(
  action: BulkAction,
  targets: MercadoLibreListingIndexItem[],
  client: {
    validateMercadoLibreListing(id: string): Promise<MercadoLibreValidationResponse>;
    publishMercadoLibreListing(id: string): Promise<unknown>;
  },
  onProgress?: (completed: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ListingBatchResult[]> {
  const results = new Array<ListingBatchResult>(targets.length);
  let next = 0;
  let completed = 0;
  async function worker() {
    while (next < targets.length && !signal?.aborted) {
      const index = next++;
      const listing = targets[index];
      try {
        if (action === 'validate') {
          const response = await client.validateMercadoLibreListing(listing.id);
          results[index] = response.ok ? { listing, ok: true } : {
            listing, ok: false,
            error: response.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message).join('；') || '校验未通过',
          };
        } else {
          await client.publishMercadoLibreListing(listing.id);
          results[index] = { listing, ok: true };
        }
      } catch (error) {
        results[index] = { listing, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      onProgress?.(++completed, targets.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, targets.length) }, worker));
  return targets.map((listing, index) => results[index] ?? { listing, ok: false, error: '未执行：已离开批量处理页面' });
}

import type { SourcePlatform } from './types';

export type CollectBatchItemStatus = 'pending' | 'collected' | 'duplicate' | 'failed';

export interface CollectBatchSummary {
  id: string;
  source: SourcePlatform;
  createdAt: string;
  templateId: string | null;
  total: number;
  collected: number;
  duplicate: number;
  failed: number;
  pending: number;
}

export interface CollectBatchItem {
  url: string;
  status: CollectBatchItemStatus;
  reason: string | null;
  productId: string | null;
}

export interface CollectBatchDetail extends CollectBatchSummary {
  items: CollectBatchItem[];
}

// Only ordinary product site URLs can be reopened by the extension from a saved batch.
const batchHosts: Record<SourcePlatform, string[]> = {
  aliexpress: ['aliexpress.com', 'aliexpress.us'], allegro: ['allegro.pl'], amazon: ['amazon.de'],
  asos: ['asos.com'], george: ['asda.com'], joom: ['joom.com'], mercadolibre: ['mercadolibre.cl'],
  ozon: ['ozon.ru'], wildberries: ['wildberries.ru', 'wb.ru'],
};

export function isBatchProductUrl(source: SourcePlatform, raw: string): boolean {
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password &&
      batchHosts[source].some(host => url.hostname === host || url.hostname.endsWith('.' + host));
  } catch {
    return false;
  }
}

export function collectionSourceForUrl(raw: string): SourcePlatform | undefined {
  return (Object.keys(batchHosts) as SourcePlatform[]).find(source => isBatchProductUrl(source, raw));
}

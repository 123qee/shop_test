import type { CollectBatchDetail, CollectBatchSummary } from '@shared/collect-batches';
import type { SourcePlatform } from '@shared/types';
import { getConfig } from './config.js';

async function request<T>(path: string, body?: unknown): Promise<T> {
  const { backendUrl } = await getConfig();
  const response = await fetch(`${backendUrl}/api/collect/batches${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `读取采集批次失败 (HTTP ${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export const collectBatchApi = {
  create: (source: SourcePlatform, urls: string[], templateId?: string) => request<{ id: string }>('', { source, urls, templateId }),
  list: (offset = 0) => request<CollectBatchSummary[]>(`?offset=${offset}`),
  detail: (id: string) => request<CollectBatchDetail>('/' + encodeURIComponent(id)),
  fail: (id: string, urls: string[], reason: string) => request<void>('/' + encodeURIComponent(id) + '/failures', { urls, reason: reason.slice(0, 1000) }),
};

export function sortBatchUrl(backendUrl: string, id: string) {
  const url = new URL('/joom', backendUrl);
  url.searchParams.set('sort', '1');
  url.searchParams.set('batch', id);
  return url.href;
}

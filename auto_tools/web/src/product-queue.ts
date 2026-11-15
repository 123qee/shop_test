import type { ProductRecord } from '@shared/types';

/** 2 小时内保存过内容，视为「刚编辑」，方便回到列表立刻勾选发布。 */
export const RECENT_EDIT_MS = 2 * 60 * 60 * 1000;

export function isUnpublished(status: ProductRecord['status']) {
  return status !== 'published' && status !== 'discarded';
}

export function queueTime(p: ProductRecord): string {
  return p.editedAt || p.createdAt;
}

export function isRecentlyEdited(p: ProductRecord, now = Date.now()): boolean {
  return Boolean(p.editedAt && isUnpublished(p.status) && now - Date.parse(p.editedAt) < RECENT_EDIT_MS);
}

/** 未发布按最近编辑(无编辑则采集时间)；已发布/废弃仍按采集时间，避免店铺同步打乱队列。 */
export function compareProductQueue(a: ProductRecord, b: ProductRecord): number {
  const group = (status: ProductRecord['status']) => (status === 'published' ? 2 : status === 'discarded' ? 1 : 0);
  const byGroup = group(a.status) - group(b.status);
  if (byGroup) return byGroup;
  if (group(a.status) === 0) return queueTime(b).localeCompare(queueTime(a));
  return b.createdAt.localeCompare(a.createdAt);
}

export function productTitle(p: ProductRecord): string {
  return p.edited?.title ?? p.collected.title;
}

export function productSku(p: ProductRecord): string {
  return p.edited?.sku ?? p.collected.generatedSku ?? p.collected.sourceProductId ?? '';
}

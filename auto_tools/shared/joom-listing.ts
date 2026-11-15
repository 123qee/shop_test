/**
 * 把 Joom API 的 state / 库存 映射成卖家后台同款运营分桶。
 * web / server 共用，保证列表看板、卡片徽章、经营看板口径一致。
 */

export type JoomListingBucket = 'active' | 'oos' | 'error' | 'optimize' | 'pending' | 'offline';

export const PRIMARY_JOOM_BUCKETS: JoomListingBucket[] = ['active', 'oos', 'error', 'optimize'];

export const JOOM_BUCKET_META: Record<JoomListingBucket, { label: string; hint: string }> = {
  active: { label: '活性', hint: '正在售卖，且可售库存大于 0' },
  oos: { label: '缺货', hint: '仍有可售版本，但库存为 0' },
  error: { label: '出错', hint: '审核拒绝或被 Joom 下架，需要处理' },
  optimize: { label: '待优化', hint: '仍在售，但 Joom 提示需要优化' },
  pending: { label: '审核中', hint: '当前版本在等 Joom 审核' },
  offline: { label: '已下架', hint: '商家下架、归档，或店铺中找不到' },
};

export interface JoomListingInput {
  joomState?: string | null;
  joomInventory?: number | null;
  joomHasActiveVersion?: boolean | null;
}

/** 未同步过（没有 state）时返回 undefined，不进入四个运营分桶。 */
export function classifyJoomListing(input: JoomListingInput): JoomListingBucket | undefined {
  const state = String(input.joomState ?? '').trim();
  if (!state) return undefined;

  const inventory = Number(input.joomInventory ?? 0);
  const hasActiveVersion = Boolean(input.joomHasActiveVersion);

  if (state === 'rejected' || state === 'disabledByJoom') return 'error';
  if (state === 'warning') return 'optimize';
  if (state === 'archived' || state === 'disabledByMerchant' || state === 'notFound') return 'offline';
  if (state === 'pending' && !hasActiveVersion) return 'pending';

  const live = hasActiveVersion || state === 'active' || state === 'locked' || (state === 'pending' && hasActiveVersion);
  if (live || state === 'active' || state === 'locked' || state === 'pending') {
    return inventory > 0 ? 'active' : 'oos';
  }

  return 'offline';
}

export function joomListingLabel(bucket?: JoomListingBucket | string): string {
  if (!bucket) return '未同步';
  return JOOM_BUCKET_META[bucket as JoomListingBucket]?.label ?? bucket;
}

import {
  EXPORT_MATERIALS,
  formatChinaDateTime,
  ORDER_STATUS_LABELS,
  type ExportMaterial,
  type OrderExportProfile,
  type OrderShopRef,
  type OrderStatus,
} from '@shared/orders';
import { materialLabel } from '@shared/product-grouping';

/** 导出页选中的方案。设置页保存方案时也写这里，回到导出页直接用上刚保存的方案。 */
export const PROFILE_STORAGE_KEY = 'auto_tools.orders.profileId';

export function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 本地存储不可用时只保留本次选择 */
  }
}

/** 店铺在页面里的唯一 key（平台 id 不含 ::）。 */
export const shopRefKey = (ref: OrderShopRef) => `${ref.platform}::${ref.shopId}`;

export function parseShopKey(key: string): OrderShopRef {
  const index = key.indexOf('::');
  return { platform: key.slice(0, index), shopId: key.slice(index + 2) };
}

export const MATERIAL_OPTIONS: Array<{ id: ExportMaterial; label: string }> = EXPORT_MATERIALS.map((id) => ({ id, label: materialLabel(id) }));

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '从未同步';
  const diff = now - Date.parse(iso);
  if (Number.isNaN(diff)) return '';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return formatChinaDateTime(iso);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function statusText(statuses: OrderStatus[]): string {
  return statuses.map((status) => ORDER_STATUS_LABELS[status] ?? status).join('、');
}

export function rangeText(from?: string, to?: string): string {
  if (!from && !to) return '下单时间不限';
  if (from && from === to) return `${from} 下单`;
  return `${from ?? '最早'} 至 ${to ?? '今天'} 下单`;
}

/** 方案一句话说明，显示在导出页的方案选择旁。 */
export function describeProfile(profile: OrderExportProfile): string {
  const layout = profile.layout === 'sheet-per-material' ? '一个文件，每种材质一个工作表' : '每种材质一个文件';
  const materials = profile.buckets.map((bucket) => bucket.label).join(' / ');
  const unknown = '未确定材质不导出';
  return `${layout} · ${materials} · ${unknown}`;
}

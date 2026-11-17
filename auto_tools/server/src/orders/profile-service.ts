import {
  createDefaultOrderExportProfile,
  DEFAULT_ORDER_COLUMNS,
  EXPORT_MATERIALS,
  ORDER_COLUMN_KEYS,
  isOrderStatus,
  orderExportColumns,
  type ExportMaterial,
  type OrderColumnKey,
  type OrderExportProfile,
  type OrderShopRef,
  type OrderStatus,
} from '@shared/orders';
import { materialLabel } from '@shared/product-grouping';
import { settingsRepository, type SettingsRepository } from '../repositories/settings-repository.js';
import { OrderInputError } from './errors.js';

const SETTINGS_KEY = 'order_export_profiles';
const MAX_PROFILES = 20;

function isExportMaterial(value: unknown): value is ExportMaterial {
  return (EXPORT_MATERIALS as readonly string[]).includes(value as string);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 补齐旧版本或手工编辑留下的缺失字段，保证下游拿到完整结构。 */
function normalizeProfile(input: Partial<OrderExportProfile> | null | undefined): OrderExportProfile | null {
  if (!input || typeof input.id !== 'string' || !input.id) return null;
  const base = createDefaultOrderExportProfile();
  const seen = new Set<string>();
  const buckets = (Array.isArray(input.buckets) ? input.buckets : base.buckets)
    .filter((bucket) => isExportMaterial(bucket?.material) && !seen.has(bucket.material) && seen.add(bucket.material))
    .map((bucket) => ({
      material: bucket.material,
      label: optionalText(bucket.label) ?? materialLabel(bucket.material),
      ...(optionalText(bucket.fileName) ? { fileName: optionalText(bucket.fileName) } : {}),
    }));
  const columns = (Array.isArray(input.columns) ? input.columns : base.columns)
    .filter((key): key is OrderColumnKey => ORDER_COLUMN_KEYS.includes(key as OrderColumnKey));
  const statuses = (Array.isArray(input.defaults?.statuses) ? input.defaults!.statuses : []).filter(isOrderStatus);
  const shops = (Array.isArray(input.defaults?.shops) ? input.defaults!.shops : [])
    .filter((shop) => typeof shop?.platform === 'string' && typeof shop?.shopId === 'string')
    .map(({ platform, shopId }) => ({ platform, shopId }));
  return {
    id: input.id,
    name: optionalText(input.name) ?? base.name,
    layout: input.layout === 'sheet-per-material' ? 'sheet-per-material' : 'file-per-material',
    fileName: optionalText(input.fileName) ?? base.fileName,
    buckets: buckets.length ? buckets : base.buckets,
    unknown: {
      handling: 'skip',
      label: optionalText(input.unknown?.label) ?? base.unknown.label,
      ...(optionalText(input.unknown?.fileName) ? { fileName: optionalText(input.unknown?.fileName) } : {}),
    },
    columns: orderExportColumns(columns.length ? columns : DEFAULT_ORDER_COLUMNS),
    defaults: {
      shops,
      statuses: statuses.length ? [...new Set(statuses)] : base.defaults.statuses,
      onlyNew: typeof input.defaults?.onlyNew === 'boolean' ? input.defaults.onlyNew : true,
    },
    updatedAt: optionalText(input.updatedAt) ?? new Date().toISOString(),
  };
}

/** 导出方案存在 settings 表里（与店铺、预设配置一致）。 */
export class OrderProfileService {
  constructor(private readonly repo: SettingsRepository = settingsRepository) {}

  list(): OrderExportProfile[] {
    const stored = this.repo.get<Array<Partial<OrderExportProfile>>>(SETTINGS_KEY);
    const profiles = (Array.isArray(stored) ? stored : []).map(normalizeProfile).filter((p): p is OrderExportProfile => Boolean(p));
    if (profiles.length) return profiles;
    const seeded = [createDefaultOrderExportProfile()];
    this.repo.set(SETTINGS_KEY, seeded);
    return seeded;
  }

  get(id: string): OrderExportProfile | undefined {
    return this.list().find((profile) => profile.id === id);
  }

  require(id: string): OrderExportProfile {
    const profile = this.get(id);
    if (!profile) throw new OrderInputError('导出方案不存在，请刷新页面后重新选择', 404);
    return profile;
  }

  save(input: OrderExportProfile): OrderExportProfile[] {
    const profile = normalizeProfile({ ...input, updatedAt: new Date().toISOString() });
    if (!profile) throw new OrderInputError('导出方案缺少 id');
    const labels = [...profile.buckets.map((bucket) => bucket.label), profile.unknown.label].map((label) => label.toLowerCase());
    if (new Set(labels).size !== labels.length) throw new OrderInputError('材质显示名不能重复（含「待确认」的名称）');
    const profiles = this.list();
    if (profiles.some((p) => p.id !== profile.id && p.name.trim() === profile.name.trim())) {
      throw new OrderInputError(`已经有名为「${profile.name}」的方案`);
    }
    const index = profiles.findIndex((p) => p.id === profile.id);
    if (index >= 0) profiles[index] = profile;
    else {
      if (profiles.length >= MAX_PROFILES) throw new OrderInputError(`最多保存 ${MAX_PROFILES} 个导出方案`);
      profiles.push(profile);
    }
    this.repo.set(SETTINGS_KEY, profiles);
    return profiles;
  }

  remove(id: string): OrderExportProfile[] {
    const profiles = this.list();
    if (!profiles.some((p) => p.id === id)) throw new OrderInputError('导出方案不存在', 404);
    if (profiles.length <= 1) throw new OrderInputError('至少保留一个导出方案');
    const next = profiles.filter((p) => p.id !== id);
    this.repo.set(SETTINGS_KEY, next);
    return next;
  }

  /** 导出成功后记住这次勾选的店铺和条件，下次打开直接沿用。 */
  rememberDefaults(id: string, defaults: { shops: OrderShopRef[]; statuses: OrderStatus[]; onlyNew: boolean }): void {
    const profiles = this.list();
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;
    profile.defaults = {
      shops: defaults.shops.map(({ platform, shopId }) => ({ platform, shopId })),
      statuses: [...defaults.statuses],
      onlyNew: defaults.onlyNew,
    };
    this.repo.set(SETTINGS_KEY, profiles);
  }
}

export const orderProfileService = new OrderProfileService();

/**
 * 订单导出：前后端共用的类型、导出列、文件名模板与北京时间工具。
 * 平台订单先映射成 UnifiedOrder，下游（材质判定、拆分、写文件、命名）不感知具体平台。
 */
import type { ProductMaterial } from './types';
import { addDays } from './planner';

// ---- 订单状态 ----

export const ORDER_STATUSES = ['to_ship', 'shipped', 'cancelled', 'refunded', 'returned', 'other'] as const;
export type OrderStatus = typeof ORDER_STATUSES[number];
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  to_ship: '待发货',
  shipped: '已发货',
  cancelled: '已取消',
  refunded: '已退款',
  returned: '退货',
  other: '其他',
};
export const isOrderStatus = (value: unknown): value is OrderStatus =>
  (ORDER_STATUSES as readonly string[]).includes(value as string);

// ---- 统一订单模型 ----

export interface OrderAddress {
  name?: string;
  phone?: string;
  email?: string;
  country?: string;
  state?: string;
  city?: string;
  zipCode?: string;
  line1?: string;
  line2?: string;
  taxNumber?: string;
}

export interface OrderTracking {
  carrier?: string;
  number?: string;
}

export interface OrderLine {
  /** 订单内稳定的行标识（如 main / gift），重复同步时据此覆盖。 */
  lineId: string;
  productId?: string;
  productSku?: string;
  variantId?: string;
  variantSku?: string;
  title?: string;
  color?: string;
  size?: string;
  imageUrl?: string;
  /** 可供看图选择的商品图片；订单图优先。 */
  imageUrls?: string[];
  quantity: number;
  unitPrice?: number;
  /** 本行金额（平台口径；Joom 为折后订单价）。 */
  amount?: number;
  /** 平台商品上的材质原文，如 "90% cotton, 10% polyester"。 */
  materialHint?: string;
  isGift?: boolean;
}

export interface UnifiedOrder {
  platform: string;
  shopId: string;
  shopName: string;
  orderId: string;
  status: OrderStatus;
  /** 平台原始状态，如 Joom 的 approved / fulfilledOnline。 */
  rawStatus: string;
  /** ISO 时间（UTC）。 */
  orderedAt: string;
  updatedAt: string;
  currency?: string;
  address?: OrderAddress;
  tracking?: OrderTracking;
  lines: OrderLine[];
  /** 平台原始返回；映射漏了字段时可以直接补，不用重新拉。 */
  raw?: unknown;
}

// ---- 导出材质 ----

/** 可以单独成文件的材质；unknown 只能进「待确认」。 */
export const EXPORT_MATERIALS = ['cotton', 'polyester', 'blend', 'other'] as const;
export type ExportMaterial = typeof EXPORT_MATERIALS[number];

// ---- 导出列 ----

export interface OrderColumnDef {
  key: string;
  label: string;
  /** Excel 列宽（字符数） */
  width: number;
  numeric?: boolean;
  group: 'order' | 'product' | 'recipient' | 'other';
}

export const ORDER_COLUMN_GROUPS: Array<{ id: OrderColumnDef['group']; label: string }> = [
  { id: 'order', label: '订单' },
  { id: 'product', label: '商品' },
  { id: 'recipient', label: '收件人' },
  { id: 'other', label: '物流与其他' },
];

export const ORDER_COLUMNS = [
  { key: 'platform', label: '平台', width: 8, group: 'order' },
  { key: 'shop', label: '店铺', width: 14, group: 'order' },
  { key: 'orderId', label: '订单号', width: 13, group: 'order' },
  { key: 'orderedAt', label: '下单时间', width: 17, group: 'order' },
  { key: 'status', label: '订单状态', width: 9, group: 'order' },
  { key: 'rawStatus', label: '平台状态', width: 14, group: 'order' },
  { key: 'material', label: '材质', width: 10, group: 'product' },
  { key: 'productSku', label: '商品 SKU', width: 18, group: 'product' },
  { key: 'variantSku', label: '变体 SKU', width: 22, group: 'product' },
  { key: 'title', label: '商品名称', width: 42, group: 'product' },
  { key: 'color', label: '颜色', width: 12, group: 'product' },
  { key: 'size', label: '尺码', width: 8, group: 'product' },
  { key: 'quantity', label: '数量', width: 6, numeric: true, group: 'product' },
  { key: 'unitPrice', label: '单价', width: 8, numeric: true, group: 'product' },
  { key: 'amount', label: '订单金额', width: 10, numeric: true, group: 'product' },
  { key: 'currency', label: '币种', width: 6, group: 'product' },
  { key: 'imageUrl', label: '图片', width: 22, group: 'product' },
  { key: 'recipient', label: '收件人', width: 16, group: 'recipient' },
  { key: 'phone', label: '电话', width: 16, group: 'recipient' },
  { key: 'email', label: '邮箱', width: 22, group: 'recipient' },
  { key: 'country', label: '国家', width: 6, group: 'recipient' },
  { key: 'state', label: '省/州', width: 14, group: 'recipient' },
  { key: 'city', label: '城市', width: 14, group: 'recipient' },
  { key: 'address', label: '地址', width: 42, group: 'recipient' },
  { key: 'zipCode', label: '邮编', width: 10, group: 'recipient' },
  { key: 'taxNumber', label: '税号', width: 14, group: 'recipient' },
  { key: 'carrier', label: '物流商', width: 14, group: 'other' },
  { key: 'trackingNumber', label: '运单号', width: 20, group: 'other' },
  { key: 'materialEvidence', label: '材质判定依据', width: 26, group: 'other' },
  { key: 'note', label: '备注', width: 10, group: 'other' },
] as const satisfies readonly OrderColumnDef[];

export type OrderColumnKey = typeof ORDER_COLUMNS[number]['key'];
export const ORDER_COLUMN_KEYS = ORDER_COLUMNS.map((column) => column.key) as OrderColumnKey[];

/** 发厂时最关心的字段始终在前，兼容已保存的旧方案。多选图在图片位置展开。 */
export const REQUIRED_ORDER_COLUMNS: OrderColumnKey[] = ['imageUrl', 'quantity', 'size', 'shop', 'material'];
export function orderExportColumns(columns: readonly OrderColumnKey[]): OrderColumnKey[] {
  return [...REQUIRED_ORDER_COLUMNS, ...new Set(columns.filter((key) => !REQUIRED_ORDER_COLUMNS.includes(key)))];
}

/** 默认不带价格、邮箱和税号：导出文件通常发给工厂。需要时在方案里勾选。 */
export const DEFAULT_ORDER_COLUMNS: OrderColumnKey[] = orderExportColumns([
  'platform', 'shop', 'orderId', 'orderedAt', 'status',
  'material', 'productSku', 'variantSku', 'title', 'color', 'size', 'quantity', 'imageUrl',
  'recipient', 'phone', 'country', 'state', 'city', 'address', 'zipCode',
  'carrier', 'trackingNumber', 'materialEvidence', 'note',
]);

// ---- 导出方案 ----

export type OrderExportLayout = 'file-per-material' | 'sheet-per-material';
/** separate 为旧配置兼容值；未确定材质始终跳过，修正后再导。 */
export type UnknownMaterialHandling = 'separate' | 'skip';

export interface OrderShopRef {
  platform: string;
  shopId: string;
}

export interface OrderExportBucketConfig {
  material: ExportMaterial;
  /** 显示名，用于文件名 {material} 和工作表名 */
  label: string;
  /** 为空时使用方案的文件名模板 */
  fileName?: string;
}

export interface OrderExportProfile {
  id: string;
  name: string;
  layout: OrderExportLayout;
  /** 文件名模板，不含扩展名，如 {date}_{material}_{platform}订单 */
  fileName: string;
  /** 单独导出的材质，顺序即文件 / 工作表顺序 */
  buckets: OrderExportBucketConfig[];
  /** 未识别或未单独导出的材质 */
  unknown: { handling: UnknownMaterialHandling; label: string; fileName?: string };
  columns: OrderColumnKey[];
  /** 导出时自动记住的勾选条件 */
  defaults: { shops: OrderShopRef[]; statuses: OrderStatus[]; onlyNew: boolean };
  updatedAt: string;
}

export const DEFAULT_ORDER_PROFILE_ID = 'daily';

export function createDefaultOrderExportProfile(now = new Date()): OrderExportProfile {
  return {
    id: DEFAULT_ORDER_PROFILE_ID,
    name: '每日发厂',
    layout: 'file-per-material',
    fileName: '{date}_{material}_{platform}订单',
    buckets: [
      { material: 'cotton', label: '棉' },
      { material: 'polyester', label: '聚酯纤维' },
    ],
    unknown: { handling: 'skip', label: '待确认' },
    columns: [...DEFAULT_ORDER_COLUMNS],
    defaults: { shops: [], statuses: ['to_ship'], onlyNew: true },
    updatedAt: now.toISOString(),
  };
}

// ---- 北京时间工具（中国无夏令时，固定 +08:00） ----

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

interface DateParts { YYYY: string; MM: string; DD: string; HH: string; mm: string; ss: string }

function chinaParts(date: Date): DateParts {
  const d = new Date(date.getTime() + CHINA_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    YYYY: String(d.getUTCFullYear()),
    MM: pad(d.getUTCMonth() + 1),
    DD: pad(d.getUTCDate()),
    HH: pad(d.getUTCHours()),
    mm: pad(d.getUTCMinutes()),
    ss: pad(d.getUTCSeconds()),
  };
}

export function isDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** 北京时间的日期 YYYY-MM-DD。 */
export function chinaDate(date = new Date()): string {
  const p = chinaParts(date);
  return `${p.YYYY}-${p.MM}-${p.DD}`;
}

/** 北京时间某天 0 点对应的 UTC ISO 时间。 */
export function chinaDayStartIso(date: string): string {
  return new Date(`${date}T00:00:00+08:00`).toISOString();
}

/** 展示用：北京时间 YYYY-MM-DD HH:mm；无效时间返回空串。 */
export function formatChinaDateTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const p = chinaParts(date);
  return `${p.YYYY}-${p.MM}-${p.DD} ${p.HH}:${p.mm}`;
}

export const ORDER_RANGE_PRESETS = [
  { id: 'all', label: '不限' },
  { id: 'today', label: '今天' },
  { id: 'yesterday', label: '昨天' },
  { id: 'last7', label: '近 7 天' },
  { id: 'last30', label: '近 30 天' },
  { id: 'custom', label: '自定义' },
] as const;
export type OrderRangePreset = typeof ORDER_RANGE_PRESETS[number]['id'];

/** 预设对应的下单日期范围（北京时间，含首尾两天）。 */
export function rangeForPreset(preset: OrderRangePreset, today = chinaDate()): { from?: string; to?: string } {
  switch (preset) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'last7': return { from: addDays(today, -6), to: today };
    case 'last30': return { from: addDays(today, -29), to: today };
    default: return {};
  }
}

// ---- 文件名模板 ----

export const FILE_NAME_VARIABLES = [
  { token: '{date}', label: '导出日期' },
  { token: '{time}', label: '导出时间' },
  { token: '{material}', label: '材质' },
  { token: '{platform}', label: '平台' },
  { token: '{shops}', label: '店铺' },
  { token: '{profile}', label: '方案名' },
  { token: '{from}', label: '开始日期' },
  { token: '{to}', label: '结束日期' },
  { token: '{count}', label: '单数' },
  { token: '{qty}', label: '件数' },
  { token: '{seq}', label: '当天第几次' },
] as const;

export interface FileNameContext {
  platforms: string[];
  shops: string[];
  material: string;
  profile: string;
  now: Date;
  /** 下单日期范围（北京时间 YYYY-MM-DD，含当天） */
  from?: string;
  to?: string;
  count: number;
  qty: number;
  seq: number;
}

function formatParts(format: string, parts: DateParts): string {
  return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => parts[token as keyof DateParts]);
}

function datePartsOf(date: string): DateParts | undefined {
  if (!isDateString(date)) return undefined;
  const [YYYY, MM, DD] = date.split('-');
  return { YYYY, MM, DD, HH: '00', mm: '00', ss: '00' };
}

/**
 * 渲染文件名模板（不含扩展名）。支持 {date:YYYY-MM-DD} 这类自定义日期格式；
 * 未知变量原样保留，方便发现拼写错误。结果仍需 sanitizeFileName。
 */
export function renderFileName(template: string, ctx: FileNameContext): string {
  const now = chinaParts(ctx.now);
  return template.replace(/\{([a-zA-Z]+)(?::([^{}]*))?\}/g, (whole, name: string, format?: string) => {
    switch (name) {
      case 'date': return formatParts(format || 'YYYYMMDD', now);
      case 'time': return formatParts(format || 'HHmm', now);
      case 'from':
      case 'to': {
        const parts = datePartsOf((name === 'from' ? ctx.from : ctx.to) ?? '');
        return parts ? formatParts(format || 'YYYYMMDD', parts) : '';
      }
      case 'material': return ctx.material;
      case 'platform': return ctx.platforms.join('+');
      case 'shops': return ctx.shops.join('+');
      case 'profile': return ctx.profile;
      case 'count': return String(ctx.count);
      case 'qty': return String(ctx.qty);
      case 'seq': return String(ctx.seq).padStart(2, '0');
      default: return whole;
    }
  });
}

/** 去掉各系统文件名里的非法字符，压缩空变量留下的连续分隔符，并限制长度。 */
export function sanitizeFileName(name: string, maxLength = 120): string {
  let value = name
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_{2,}/g, '_')
    .replace(/-{2,}/g, '-')
    .replace(/^[\s._-]+|[\s._-]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(value)) value = `_${value}`;
  if (value.length > maxLength) value = value.slice(0, maxLength).replace(/[\s._-]+$/, '');
  return value || '订单导出';
}

// ---- 接口 DTO ----

export interface OrderSourceShopInfo {
  platform: string;
  platformLabel: string;
  shopId: string;
  shopName: string;
  configured: boolean;
  connected: boolean;
  orderCount: number;
  lastSyncedAt?: string;
  lastRunAt?: string;
  lastError?: string;
  /** 本地已覆盖的最早更新时间 */
  coveredFrom?: string;
}

export interface OrderSourcesResponse {
  platforms: Array<{ platform: string; label: string; shops: OrderSourceShopInfo[] }>;
  /** 首次同步回溯天数 */
  lookbackDays: number;
}

export interface OrderSyncShopProgress {
  platform: string;
  shopId: string;
  shopName: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  fetched: number;
  pages: number;
  since?: string;
  error?: string;
}

export interface OrderSyncJob {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
  createdAt: string;
  finishedAt?: string;
  shops: OrderSyncShopProgress[];
}

export interface OrderQueryInput {
  profileId: string;
  shops: OrderShopRef[];
  statuses: OrderStatus[];
  /** 下单日期（北京时间，含当天） */
  from?: string;
  to?: string;
  /** 只导出这个方案还没导过的订单 */
  onlyNew: boolean;
  /** 本次临时改的材质（key 为订单行 uid），不记住 */
  overrides?: Record<string, ProductMaterial>;
  /** 按订单行选图；未指定时只导出订单图片，不重复数量。 */
  selectedImages?: Record<string, string[]>;
}

export type MaterialSource =
  | 'override'
  | 'rule'
  | 'catalog-manual'
  | 'platform-attribute'
  | 'catalog-auto'
  | 'title'
  | 'none';

export interface OrderPreviewLine {
  uid: string;
  platform: string;
  shopId: string;
  shopName: string;
  orderId: string;
  orderedAt: string;
  status: OrderStatus;
  rawStatus: string;
  productId?: string;
  productSku?: string;
  variantSku?: string;
  title?: string;
  color?: string;
  size?: string;
  imageUrl?: string;
  imageUrls: string[];
  selectedImages: string[];
  quantity: number;
  isGift: boolean;
  material: ProductMaterial;
  materialSource: MaterialSource;
  materialEvidence: string;
  /** 这个方案之前导出过的时间（只在不勾选「只导新订单」时出现） */
  exportedAt?: string;
}

export interface OrderPreviewBucket {
  /** 材质 id；未识别为 unknown */
  key: string;
  label: string;
  kind: 'material' | 'unknown';
  /** 待确认的订单始终不导出 */
  excluded: boolean;
  orderCount: number;
  quantity: number;
  lines: OrderPreviewLine[];
}

export interface OrderPreviewFile {
  name: string;
  /** 文件里的工作表（材质显示名） */
  sheets: string[];
  orderCount: number;
  quantity: number;
}

export interface OrderPreview {
  buckets: OrderPreviewBucket[];
  files: OrderPreviewFile[];
  totals: { orders: number; lines: number; quantity: number };
  warnings: string[];
}

export interface OrderExportFileInfo {
  id: string;
  name: string;
  sheets: string[];
  orderCount: number;
  quantity: number;
  size: number;
}

export interface OrderExportRecord {
  id: string;
  profileId: string;
  profileName: string;
  createdAt: string;
  query: {
    shops: Array<OrderShopRef & { shopName: string }>;
    statuses: OrderStatus[];
    from?: string;
    to?: string;
    onlyNew: boolean;
  };
  summary: Array<{ key: string; label: string; orderCount: number; quantity: number; exported: boolean }>;
  files: OrderExportFileInfo[];
  zipName: string;
  /** 超过保留期后文件被清理，记录保留 */
  filesExpired: boolean;
}

export interface OrderMaterialRule {
  id: string;
  platform: string;
  productId?: string;
  productSku?: string;
  title?: string;
  material: ProductMaterial;
  updatedAt: string;
}

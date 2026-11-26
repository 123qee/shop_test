import type {
  OrderAddress,
  OrderLine,
  OrderShopRef,
  OrderStatus,
  OrderSyncJob,
  OrderTracking,
  UnifiedOrder,
} from '@shared/orders';
import { getDb } from '../db/index.js';

export function orderUid(platform: string, shopId: string, orderId: string): string {
  return `${platform}:${shopId}:${orderId}`;
}

export function orderLineUid(uid: string, lineId: string): string {
  return `${uid}#${lineId}`;
}

export function shopKey(platform: string, shopId: string): string {
  return `${platform}\u0000${shopId}`;
}

/** 统一成 toISOString 格式，保证按字符串比较时间时结果正确。 */
function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseJson<T>(text: string | null | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** 订单行 + 所属订单信息，预览和导出直接使用。 */
export interface StoredOrderLine extends OrderLine {
  uid: string;
  orderUid: string;
  platform: string;
  shopId: string;
  shopName: string;
  orderId: string;
  status: OrderStatus;
  rawStatus: string;
  orderedAt: string;
  updatedAt: string;
  currency?: string;
  address?: OrderAddress;
  tracking?: OrderTracking;
  isGift: boolean;
  /** 查询所用方案的导出时间 */
  exportedAt?: string;
}

export interface OrderLineQuery {
  shops: OrderShopRef[];
  statuses: OrderStatus[];
  /** UTC ISO，含 */
  orderedFrom?: string;
  /** UTC ISO，不含 */
  orderedTo?: string;
  profileId: string;
  onlyNew: boolean;
}

export interface OrderSyncState {
  platform: string;
  shopId: string;
  syncedUntil?: string;
  coveredFrom?: string;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}

export interface OrderSyncJobParams {
  /** 下单开始日期（北京时间）；早于本地覆盖范围时补拉 */
  from?: string;
}

interface LineRow {
  uid: string;
  order_uid: string;
  line_id: string;
  product_id: string | null;
  product_sku: string | null;
  variant_id: string | null;
  variant_sku: string | null;
  title: string | null;
  color: string | null;
  size: string | null;
  image_url: string | null;
  image_urls: string | null;
  quantity: number;
  unit_price: number | null;
  amount: number | null;
  material_hint: string | null;
  is_gift: number;
  platform: string;
  shop_id: string;
  shop_name: string;
  order_id: string;
  status: string;
  raw_status: string;
  ordered_at: string;
  updated_at: string;
  currency: string | null;
  address: string | null;
  tracking: string | null;
  exported_at: string | null;
}

interface SyncStateRow {
  platform: string;
  shop_id: string;
  synced_until: string | null;
  covered_from: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}

interface SyncJobRow {
  id: string;
  status: OrderSyncJob['status'];
  params: string;
  progress: string;
  created_at: string;
  finished_at: string | null;
}

function rowToLine(row: LineRow): StoredOrderLine {
  return {
    uid: row.uid,
    orderUid: row.order_uid,
    lineId: row.line_id,
    platform: row.platform,
    shopId: row.shop_id,
    shopName: row.shop_name,
    orderId: row.order_id,
    status: row.status as OrderStatus,
    rawStatus: row.raw_status,
    orderedAt: row.ordered_at,
    updatedAt: row.updated_at,
    currency: row.currency ?? undefined,
    address: parseJson<OrderAddress>(row.address),
    tracking: parseJson<OrderTracking>(row.tracking),
    productId: row.product_id ?? undefined,
    productSku: row.product_sku ?? undefined,
    variantId: row.variant_id ?? undefined,
    variantSku: row.variant_sku ?? undefined,
    title: row.title ?? undefined,
    color: row.color ?? undefined,
    size: row.size ?? undefined,
    imageUrl: row.image_url ?? undefined,
    imageUrls: parseJson<string[]>(row.image_urls),
    quantity: row.quantity,
    unitPrice: row.unit_price ?? undefined,
    amount: row.amount ?? undefined,
    materialHint: row.material_hint ?? undefined,
    isGift: Boolean(row.is_gift),
    exportedAt: row.exported_at ?? undefined,
  };
}

function rowToSyncState(row: SyncStateRow): OrderSyncState {
  return {
    platform: row.platform,
    shopId: row.shop_id,
    syncedUntil: row.synced_until ?? undefined,
    coveredFrom: row.covered_from ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    lastSuccessAt: row.last_success_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

function rowToJob(row: SyncJobRow): OrderSyncJob {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? undefined,
    shops: parseJson<OrderSyncJob['shops']>(row.progress) ?? [],
  };
}

export class OrderRepository {
  /**
   * 按 (平台, 店铺, 来源标识或订单号) 覆盖写入，支持独立更新同一订单的不同包裹。
   * 平台返回的更新时间比本地旧时跳过，
   * 补全字段（标题、颜色等）这次没拿到时保留上次的值。返回写入的订单数。
   */
  upsertOrders(orders: UnifiedOrder[], syncedAt = new Date().toISOString()): number {
    const db = getDb();
    const existing = db.prepare('SELECT updated_at FROM orders WHERE uid = ?');
    const upsertOrder = db.prepare(`
      INSERT INTO orders (uid, platform, shop_id, order_id, display_order_id, shop_name, status, raw_status, ordered_at, updated_at,
                          currency, address, tracking, raw, synced_at)
      VALUES (@uid, @platform, @shopId, @orderId, @displayOrderId, @shopName, @status, @rawStatus, @orderedAt, @updatedAt,
              @currency, @address, @tracking, @raw, @syncedAt)
      ON CONFLICT(uid) DO UPDATE SET
        display_order_id = excluded.display_order_id,
        shop_name = excluded.shop_name,
        status = excluded.status,
        raw_status = excluded.raw_status,
        ordered_at = excluded.ordered_at,
        updated_at = excluded.updated_at,
        currency = COALESCE(excluded.currency, orders.currency),
        address = COALESCE(excluded.address, orders.address),
        tracking = COALESCE(excluded.tracking, orders.tracking),
        raw = excluded.raw,
        synced_at = excluded.synced_at
    `);
    const upsertLine = db.prepare(`
      INSERT INTO order_lines (uid, order_uid, line_id, product_id, product_sku, variant_id, variant_sku, title, color, size,
                               image_url, image_urls, quantity, unit_price, amount, material_hint, is_gift, position)
      VALUES (@uid, @orderUid, @lineId, @productId, @productSku, @variantId, @variantSku, @title, @color, @size,
              @imageUrl, @imageUrls, @quantity, @unitPrice, @amount, @materialHint, @isGift, @position)
      ON CONFLICT(uid) DO UPDATE SET
        product_id = excluded.product_id,
        product_sku = excluded.product_sku,
        variant_id = excluded.variant_id,
        variant_sku = excluded.variant_sku,
        title = COALESCE(excluded.title, order_lines.title),
        color = COALESCE(excluded.color, order_lines.color),
        size = COALESCE(excluded.size, order_lines.size),
        image_url = COALESCE(excluded.image_url, order_lines.image_url),
        image_urls = COALESCE(excluded.image_urls, order_lines.image_urls),
        material_hint = COALESCE(excluded.material_hint, order_lines.material_hint),
        quantity = excluded.quantity,
        unit_price = excluded.unit_price,
        amount = excluded.amount,
        is_gift = excluded.is_gift,
        position = excluded.position
    `);
    const removeStaleLines = db.prepare(
      'DELETE FROM order_lines WHERE order_uid = ? AND uid NOT IN (SELECT value FROM json_each(?))',
    );
    let written = 0;
    db.transaction(() => {
      for (const order of orders) {
        if (!order.orderId) continue;
        const uid = orderUid(order.platform, order.shopId, order.sourceId ?? order.orderId);
        const orderedAt = toIso(order.orderedAt) ?? toIso(order.updatedAt) ?? syncedAt;
        const updatedAt = toIso(order.updatedAt) ?? orderedAt;
        const previous = existing.get(uid) as { updated_at: string } | undefined;
        if (previous && previous.updated_at > updatedAt) continue;
        upsertOrder.run({
          uid,
          platform: order.platform,
          shopId: order.shopId,
          orderId: order.sourceId ?? order.orderId,
          displayOrderId: order.orderId,
          shopName: order.shopName,
          status: order.status,
          rawStatus: order.rawStatus,
          orderedAt,
          updatedAt,
          currency: order.currency ?? null,
          address: order.address ? JSON.stringify(order.address) : null,
          tracking: order.tracking && (order.tracking.carrier || order.tracking.number) ? JSON.stringify(order.tracking) : null,
          raw: order.raw === undefined ? null : JSON.stringify(order.raw),
          syncedAt,
        });
        const lineUids: string[] = [];
        order.lines.forEach((line, position) => {
          const lineUid = orderLineUid(uid, line.lineId);
          lineUids.push(lineUid);
          upsertLine.run({
            uid: lineUid,
            orderUid: uid,
            lineId: line.lineId,
            productId: line.productId ?? null,
            productSku: line.productSku ?? null,
            variantId: line.variantId ?? null,
            variantSku: line.variantSku ?? null,
            title: line.title ?? null,
            color: line.color ?? null,
            size: line.size ?? null,
            imageUrl: line.imageUrl ?? null,
            imageUrls: line.imageUrls?.length ? JSON.stringify(line.imageUrls) : null,
            quantity: Math.max(1, Math.round(line.quantity) || 1),
            unitPrice: Number.isFinite(line.unitPrice) ? line.unitPrice : null,
            amount: Number.isFinite(line.amount) ? line.amount : null,
            materialHint: line.materialHint ?? null,
            isGift: line.isGift ? 1 : 0,
            position,
          });
        });
        removeStaleLines.run(uid, JSON.stringify(lineUids));
        written++;
      }
    })();
    return written;
  }

  queryLines(query: OrderLineQuery): StoredOrderLine[] {
    if (!query.shops.length || !query.statuses.length) return [];
    const rows = getDb().prepare(`
      SELECT l.*, o.platform, o.shop_id, o.shop_name, COALESCE(o.display_order_id, o.order_id) AS order_id, o.status, o.raw_status, o.ordered_at, o.updated_at,
             o.currency, o.address, o.tracking, m.exported_at AS exported_at
      FROM order_lines l
      JOIN orders o ON o.uid = l.order_uid
      LEFT JOIN order_export_marks m ON m.line_uid = l.uid AND m.profile_id = @profileId
      WHERE EXISTS (
          SELECT 1 FROM json_each(@shops) s
          WHERE json_extract(s.value, '$.platform') = o.platform
            AND json_extract(s.value, '$.shopId') = o.shop_id
        )
        AND o.status IN (SELECT value FROM json_each(@statuses))
        AND (@orderedFrom IS NULL OR o.ordered_at >= @orderedFrom)
        AND (@orderedTo IS NULL OR o.ordered_at < @orderedTo)
        AND (@onlyNew = 0 OR m.line_uid IS NULL)
      ORDER BY o.ordered_at, o.order_id, l.position
    `).all({
      profileId: query.profileId,
      shops: JSON.stringify(query.shops.map(({ platform, shopId }) => ({ platform, shopId }))),
      statuses: JSON.stringify(query.statuses),
      orderedFrom: query.orderedFrom ?? null,
      orderedTo: query.orderedTo ?? null,
      onlyNew: query.onlyNew ? 1 : 0,
    }) as LineRow[];
    return rows.map(rowToLine);
  }

  /** 各店铺本地订单数，key 为 shopKey(platform, shopId)。 */
  countByShop(): Map<string, number> {
    const rows = getDb()
      .prepare('SELECT platform, shop_id, COUNT(*) AS n FROM orders GROUP BY platform, shop_id')
      .all() as Array<{ platform: string; shop_id: string; n: number }>;
    return new Map(rows.map((row) => [shopKey(row.platform, row.shop_id), row.n]));
  }

  // ---- 同步进度 ----

  getSyncState(platform: string, shopId: string): OrderSyncState | null {
    const row = getDb()
      .prepare('SELECT * FROM order_sync_state WHERE platform = ? AND shop_id = ?')
      .get(platform, shopId) as SyncStateRow | undefined;
    return row ? rowToSyncState(row) : null;
  }

  listSyncStates(): OrderSyncState[] {
    return (getDb().prepare('SELECT * FROM order_sync_state').all() as SyncStateRow[]).map(rowToSyncState);
  }

  markSyncSuccess(platform: string, shopId: string, input: { syncedUntil: string; since: string; at: string }): void {
    getDb().prepare(`
      INSERT INTO order_sync_state (platform, shop_id, synced_until, covered_from, last_run_at, last_success_at, last_error)
      VALUES (@platform, @shopId, @syncedUntil, @since, @at, @at, NULL)
      ON CONFLICT(platform, shop_id) DO UPDATE SET
        synced_until = excluded.synced_until,
        covered_from = CASE
          WHEN order_sync_state.covered_from IS NULL OR excluded.covered_from < order_sync_state.covered_from
          THEN excluded.covered_from ELSE order_sync_state.covered_from END,
        last_run_at = excluded.last_run_at,
        last_success_at = excluded.last_success_at,
        last_error = NULL
    `).run({ platform, shopId, ...input });
  }

  markSyncFailure(platform: string, shopId: string, message: string, at: string): void {
    getDb().prepare(`
      INSERT INTO order_sync_state (platform, shop_id, last_run_at, last_error)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, shop_id) DO UPDATE SET last_run_at = excluded.last_run_at, last_error = excluded.last_error
    `).run(platform, shopId, at, message);
  }

  // ---- 平台商品信息缓存 ----

  getCachedProduct<T>(platform: string, shopId: string, productId: string): { data: T; fetchedAt: string } | null {
    const row = getDb()
      .prepare('SELECT data, fetched_at FROM order_product_cache WHERE platform = ? AND shop_id = ? AND product_id = ?')
      .get(platform, shopId, productId) as { data: string; fetched_at: string } | undefined;
    const data = parseJson<T>(row?.data);
    return row && data ? { data, fetchedAt: row.fetched_at } : null;
  }

  setCachedProduct(platform: string, shopId: string, productId: string, data: unknown, at = new Date().toISOString()): void {
    getDb().prepare(`
      INSERT INTO order_product_cache (platform, shop_id, product_id, data, fetched_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(platform, shop_id, product_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at
    `).run(platform, shopId, productId, JSON.stringify(data), at);
  }

  // ---- 同步任务 ----

  createSyncJob(job: OrderSyncJob, params: OrderSyncJobParams): void {
    getDb()
      .prepare('INSERT INTO order_sync_jobs (id, status, params, progress, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(job.id, job.status, JSON.stringify(params), JSON.stringify(job.shops), job.createdAt, job.finishedAt ?? null);
  }

  saveSyncJob(job: OrderSyncJob): void {
    getDb()
      .prepare('UPDATE order_sync_jobs SET status = ?, progress = ?, finished_at = ? WHERE id = ?')
      .run(job.status, JSON.stringify(job.shops), job.finishedAt ?? null, job.id);
  }

  getSyncJob(id: string): OrderSyncJob | null {
    const row = getDb().prepare('SELECT * FROM order_sync_jobs WHERE id = ?').get(id) as SyncJobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  nextQueuedSyncJob(): { job: OrderSyncJob; params: OrderSyncJobParams } | null {
    const row = getDb()
      .prepare("SELECT * FROM order_sync_jobs WHERE status = 'queued' ORDER BY rowid LIMIT 1")
      .get() as SyncJobRow | undefined;
    return row ? { job: rowToJob(row), params: parseJson<OrderSyncJobParams>(row.params) ?? {} } : null;
  }

  listSyncJobs(status: OrderSyncJob['status']): OrderSyncJob[] {
    return (getDb().prepare('SELECT * FROM order_sync_jobs WHERE status = ? ORDER BY rowid').all(status) as SyncJobRow[]).map(rowToJob);
  }
}

export const orderRepository = new OrderRepository();

import type { OrderLine, OrderStatus, UnifiedOrder } from '@shared/orders';
import type { FetchOrdersOptions, OrderSourceAdapter, OrderSourceShop } from '../../orders/types.js';
import { getDb } from '../../db/index.js';
import { settingsRepository } from '../../repositories/settings-repository.js';
import { miaoshouService, type MiaoshouService } from '../../services/miaoshou-service.js';
import { MiaoshouError } from './client.js';

const PLATFORM = 'mercadolibre';
const SHOPS_KEY = 'miaoshou.orderShops';
const CACHE_MS = 5 * 60 * 1000;
const MAX_PAGES = 1000;
// 妙手按服务端当前时间校验结束时间，本机快几秒也会失败。
// 余量小于同步服务的十分钟回拉重叠，最近一分钟的变更会在下次同步补齐。
const END_TIME_LAG_MS = 60 * 1000;
type Connection = Pick<MiaoshouService, 'publicConfig' | 'orderConnectionId' | 'shops' | 'orderPackages'>;
interface ShopCache { connectionId: string; fetchedAt: number; shops: OrderSourceShop[] }

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}
function money(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
function image(value: unknown): string | undefined {
  const url = text(value);
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

/** 妙手无时区的时间按后台的北京时间解析，避免服务进程所在时区影响日期筛选。 */
export function miaoshouOrderTime(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const zoned = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw) ? raw.replace(' ', 'T') + '+08:00' : raw;
  const time = new Date(zoned);
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString();
}
function apiTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/** 尺码来自平台规格，不能用卖家 SKU 的尾部代替（两者可能已经做过尺码转换）。 */
export function miaoshouOrderOptions(value: unknown): { size?: string; color?: string } {
  const result: { size?: string; color?: string } = {};
  for (const part of (text(value) ?? '').split(/[;；\n]/)) {
    const match = part.trim().match(/^([^:：=]+)\s*[:：=]\s*(.+)$/);
    if (!match) continue;
    const key = match[1].trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const val = match[2].trim();
    if (/^(size|talla|talle|tamanho|尺码|尺寸)$/.test(key)) result.size = val;
    if (/^(colou?r|cor|颜色|色彩)$/.test(key)) result.color = val;
  }
  return result;
}

/** 以包裹履约状态为准；paid 仅代表付款，不能直接当作待发货。 */
export function mapMiaoshouOrderStatus(status: string, label = ''): OrderStatus {
  if (/退款/.test(label) || ['refunded', 'refund_success'].includes(status)) return 'refunded';
  if (/退货/.test(label) || status === 'returned') return 'returned';
  if (['cancelled', 'closed'].includes(status)) return 'cancelled';
  if (status === 'wait_seller_send') return 'to_ship';
  if (['wait_receiver_confirm', 'finished', 'shipped'].includes(status)) return 'shipped';
  return 'other';
}

function mapItem(raw: any, gift: boolean): OrderLine {
  const lineId = text(gift ? raw?.opOrderPackageGiftId : raw?.opOrderPackageItemId) ?? text(raw?.opOrderItemId);
  if (!lineId || lineId === '0') throw new MiaoshouError('妙手订单商品缺少稳定明细 ID，已停止同步以避免重复数量');
  const quantity = money(raw.quantity);
  if (!Number.isSafeInteger(quantity) || quantity! < 1) throw new MiaoshouError('妙手订单商品数量无效，请核对订单明细');
  const images = [...new Set([image(raw.originalPicUrl), image(raw.picUrl)].filter((url): url is string => Boolean(url)))];
  const price = money(raw.discountedPrice) ?? money(raw.originalPrice);
  return {
    lineId: `${gift ? 'gift' : 'item'}:${lineId}`,
    productId: text(gift ? raw.goodsId : raw.platformItemId),
    productSku: text(gift ? raw.itemNum : raw.platformItemNum),
    variantId: text(gift ? raw.goodsSkuId : raw.platformSkuId),
    variantSku: text(gift ? raw.goodsSkuOuterId : raw.platformOuterSkuId),
    title: text(gift ? raw.goodsName : raw.title),
    ...miaoshouOrderOptions(gift ? raw.goodsSkuSubName : raw.skuSubName),
    imageUrl: images[0], imageUrls: images,
    quantity: quantity!, unitPrice: price,
    amount: price === undefined ? undefined : Math.round(price * quantity! * 100) / 100,
    isGift: gift || [true, 1, '1', 'true'].includes(raw.isGift),
  };
}

export function mapMiaoshouPackage(raw: any, shop: Pick<OrderSourceShop, 'shopId' | 'shopName'>): UnifiedOrder {
  if (raw?.platform !== PLATFORM || String(raw?.shopId) !== shop.shopId) throw new MiaoshouError('妙手返回的订单平台或店铺不符，已停止同步');
  const info = raw.orderInfo ?? {};
  const packageId = text(raw.opOrderPackageId);
  const orderId = text(info.platformOrderSn);
  const orderedAt = miaoshouOrderTime(info.gmtOrderStart);
  if (!packageId || packageId === '0' || !orderId || !orderedAt) throw new MiaoshouError('妙手订单缺少包裹 ID、平台订单号或下单时间，请核对数据');
  if (!Array.isArray(raw.items) || (raw.giftItems != null && !Array.isArray(raw.giftItems))) throw new MiaoshouError('妙手返回的订单商品明细格式异常');
  const lines = [...raw.items.map((item: any) => mapItem(item, false)), ...(raw.giftItems ?? []).map((item: any) => mapItem(item, true))];
  if (new Set(lines.map(line => line.lineId)).size !== lines.length) throw new MiaoshouError('妙手返回了重复的包裹商品明细，已停止同步');
  const rawStatus = text(raw.appPackageStatus) ?? '';
  const consignee = raw.consigneeInfo ?? {};
  const logistics = raw.logisticsAgentProductInfo ?? {};
  return {
    platform: PLATFORM, shopId: shop.shopId, shopName: shop.shopName,
    orderId, sourceId: `package:${packageId}`,
    status: mapMiaoshouOrderStatus(rawStatus, text(raw.appPackageStatusText)), rawStatus,
    orderedAt,
    updatedAt: miaoshouOrderTime(raw.gmtModified) ?? miaoshouOrderTime(info.gmtOrderModified) ?? orderedAt,
    currency: text(info.currency),
    address: { country: text(consignee.country) ?? text(raw.site), state: text(consignee.state), city: text(consignee.city) },
    tracking: { carrier: text(logistics.logisticsCompany), number: text(raw.logisticsNo) ?? text(logistics.logisticsNo) },
    lines, raw,
  };
}

/** 美客多传统店铺的订单只从妙手读取，复用订单导出的图片、材质和尺码流程。 */
export class MiaoshouOrderSource implements OrderSourceAdapter {
  readonly platform = PLATFORM;
  readonly label = '美客多（妙手）';
  private refreshing?: Promise<void>;
  constructor(private connection: Connection = miaoshouService) {}

  private cache(): ShopCache | null {
    const cache = settingsRepository.get<ShopCache>(SHOPS_KEY);
    return cache?.connectionId === this.connection.orderConnectionId() ? cache : null;
  }
  listShops(): OrderSourceShop[] {
    return this.connection.publicConfig().configured ? this.cache()?.shops ?? [] : [];
  }
  async refreshShops(): Promise<void> {
    if (!this.connection.publicConfig().configured) return;
    const cache = this.cache();
    if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return;
    if (this.refreshing) return this.refreshing;
    const connectionId = this.connection.orderConnectionId();
    this.refreshing = (async () => {
      const shops = (await this.connection.shops()).filter(shop => shop.site === 'CBT').map(shop => ({
        shopId: shop.shopId, shopName: shop.name, configured: true, connected: shop.status === 'normal',
      }));
      if (connectionId !== this.connection.orderConnectionId()) throw new MiaoshouError('妙手连接已变更，请重新读取店铺');
      settingsRepository.set<ShopCache>(SHOPS_KEY, { connectionId, fetchedAt: Date.now(), shops });
    })();
    try { await this.refreshing; } finally { this.refreshing = undefined; }
  }

  async *fetchOrders(shopId: string, { since }: FetchOrdersOptions): AsyncIterable<UnifiedOrder[]> {
    await this.refreshShops();
    const shop = this.listShops().find(shop => shop.shopId === shopId);
    if (!shop?.connected) throw new MiaoshouError('妙手店铺不存在或授权已失效，请在妙手连接中检查');
    if (!/^[1-9]\d*$/.test(shopId) || !Number.isSafeInteger(Number(shopId))) throw new MiaoshouError('妙手店铺 ID 无效');
    const connectionId = this.connection.orderConnectionId();
    const until = new Date(Date.now() - END_TIME_LAG_MS);
    const seen = new Set<string>();
    // 实际接口限制修改时间范围最多 15 天。每段取 14 天，相邻段边界重叠并去重，不漏边界秒。
    for (let from = since; from <= until;) {
      const to = new Date(Math.min(from.getTime() + 14 * 24 * 60 * 60 * 1000, until.getTime()));
      const windowSeen = new Set<string>();
      let count = 0;
      let total: number | undefined;
      let complete = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const query = { page, pageSize: 200, platform: PLATFORM as 'mercadolibre', shopIds: [Number(shopId)], gmtModifiedFrom: apiTime(from), gmtModifiedTo: apiTime(to) };
        let data: any;
        for (let attempt = 0; ; attempt++) {
          try { data = await this.connection.orderPackages(query); break; }
          catch (error) {
            if (attempt >= 2 || !(error instanceof MiaoshouError) || !/RateLimit|频繁|限流|频率超限|繁忙/i.test(error.message)) throw error;
            await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
          }
        }
        if (connectionId !== this.connection.orderConnectionId()) throw new MiaoshouError('妙手连接在同步期间发生变化，请重新同步');
        if (!Array.isArray(data?.orderPackageList) || !Number.isSafeInteger(data.total) || data.total < 0 || Number(data.page) !== page) throw new MiaoshouError('妙手订单分页响应异常，未将本次标记为同步成功');
        if (total !== undefined && data.total !== total) throw new MiaoshouError('妙手订单列表在同步期间发生变化，请重新同步');
        total = data.total;
        const orders = data.orderPackageList.map((raw: any) => mapMiaoshouPackage(raw, shop)) as UnifiedOrder[];
        for (const order of orders) {
          if (windowSeen.has(order.sourceId!)) throw new MiaoshouError('妙手订单分页出现重复包裹，请重新同步');
          windowSeen.add(order.sourceId!);
        }
        count += orders.length;
        if (count > total!) throw new MiaoshouError('妙手订单分页总数不一致，请重新同步');
        const fresh = orders.filter(order => !seen.has(order.sourceId!));
        for (const order of fresh) seen.add(order.sourceId!);
        if (fresh.length) yield fresh;
        if (count === total) { complete = true; break; }
        if (!orders.length) throw new MiaoshouError('妙手订单分页提前结束，请重新同步');
      }
      if (!complete) throw new MiaoshouError('妙手订单超过单次同步页数上限，请缩短日期范围后重试');
      if (to.getTime() === until.getTime()) return;
      from = to;
    }
  }

  findCatalogProductId(line: OrderLine, shopId: string): string | undefined {
    if (!line.variantSku) return undefined;
    const rows = getDb().prepare(`
      SELECT DISTINCT d.product_id FROM miaoshou_drafts d, json_each(json_extract(d.data, '$.variants')) v
      WHERE json_extract(d.data, '$.shopId') = ? AND json_extract(v.value, '$.sku') = ? LIMIT 2
    `).all(shopId, line.variantSku) as { product_id: string }[];
    return rows.length === 1 ? rows[0].product_id : undefined;
  }
}

import type { OrderAddress, OrderLine, OrderStatus, UnifiedOrder } from '@shared/orders';
import { getDb } from '../../db/index.js';
import { orderRepository } from '../../repositories/order-repository.js';
import { productRepository } from '../../repositories/product-repository.js';
import { shopService } from '../../services/shop-service.js';
import type { FetchOrdersOptions, OrderSourceAdapter, OrderSourceShop } from '../../orders/types.js';
import { logger } from '../../util/logger.js';
import { MarketplaceError } from '../types.js';
import type { JoomAdapter } from './adapter.js';
import type { JoomClient } from './client.js';

/**
 * Joom 订单来源（API v3）：
 * - GET /orders/multi?updatedFrom=&limit= 增量拉取，paging.next 翻页；该接口限 50 次/分钟/店铺；
 * - 一个订单只对应一个商品变体（另可能带赠品 giftProduct）；
 * - 订单里只有商品/变体 id 和 SKU，标题、颜色、尺码、图片、材质原文通过 GET /products 读取并缓存。
 */

const PLATFORM = 'joom';
const PAGE_LIMIT = 500;
const FALLBACK_PAGE_LIMIT = 100;
const MAX_PAGES = 400;
const PRODUCT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MATERIAL_KEY = /material|fabric|composition|textile|материал|состав|ткань|composici|tejido|材质|面料|成分|材料/i;
const FIBER_WORD = /cotton|polyester|algod[oó]n|poli[eé]ster|хлоп|полиэст|棉|聚酯|涤纶|nylon|spandex|elastane|viscose|wool|linen|acrylic|lycra/i;

export interface JoomVariantInfo {
  sku?: string;
  color?: string;
  size?: string;
  imageUrl?: string;
  materialHint?: string;
}

export interface JoomProductInfo {
  name?: string;
  imageUrls?: string[];
  imageUrl?: string;
  materialHint?: string;
  /** key 为 Joom 变体 id */
  variants: Record<string, JoomVariantInfo>;
  /** key 为变体 SKU（本地商品库回退时只有 SKU） */
  variantsBySku: Record<string, JoomVariantInfo>;
}

type ShopRef = { shopId: string; shopName: string };

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function money(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function isoTime(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** 取一张约 400px 宽的处理后图片，没有时用原图。 */
function imageOf(bundle: any): string | undefined {
  const processed = (Array.isArray(bundle?.processed) ? bundle.processed : [])
    .filter((image: any) => text(image?.url))
    .sort((a: any, b: any) => (Number(a.width) || 0) - (Number(b.width) || 0));
  const picked = processed.find((image: any) => (Number(image.width) || 0) >= 400) ?? processed[processed.length - 1];
  return text(picked?.url) ?? text(bundle?.origUrl);
}

/**
 * 材质原文：商家填写的材质类属性 → Joom 从描述解析出的材质 → 任意属性值里出现的纤维词。
 * 本系统发布时类目属性的 key 是属性 id，所以第三步用来兜底。
 */
function materialHintOf(attributes: unknown, parsedAttributes: unknown): string | undefined {
  const merchant: string[] = [];
  const fiber: string[] = [];
  for (const attribute of Array.isArray(attributes) ? attributes : []) {
    const value = text(attribute?.value);
    if (!value) continue;
    if (MATERIAL_KEY.test(text(attribute?.key) ?? '')) merchant.push(value);
    else if (FIBER_WORD.test(value)) fiber.push(value);
  }
  const parsed: string[] = [];
  for (const attribute of Array.isArray(parsedAttributes) ? parsedAttributes : []) {
    if (!MATERIAL_KEY.test(text(attribute?.key) ?? '')) continue;
    const values = (Array.isArray(attribute?.values) ? attribute.values : []).map((value: any) => text(value?.text)).filter(Boolean);
    if (values.length) parsed.push(values.join(', '));
  }
  const picked = merchant.length ? merchant : parsed.length ? parsed : fiber;
  return picked.length ? [...new Set(picked)].join('; ') : undefined;
}

export function extractJoomProductInfo(raw: any): JoomProductInfo {
  const variants: Record<string, JoomVariantInfo> = {};
  const variantsBySku: Record<string, JoomVariantInfo> = {};
  for (const variant of Array.isArray(raw?.variants) ? raw.variants : []) {
    const info: JoomVariantInfo = {
      sku: text(variant?.sku),
      color: text(variant?.colors),
      size: text(variant?.size),
      imageUrl: imageOf(variant?.mainImage),
      materialHint: materialHintOf(variant?.attributes, variant?.parsedAttributes),
    };
    const id = text(variant?.id);
    if (id) variants[id] = info;
    if (info.sku) variantsBySku[info.sku] = info;
  }
  return {
    name: text(raw?.name),
    imageUrl: imageOf(raw?.mainImage),
    imageUrls: [imageOf(raw?.mainImage), ...(Array.isArray(raw?.extraImages) ? raw.extraImages.map(imageOf) : [])].filter((url): url is string => Boolean(url)),
    materialHint: materialHintOf(raw?.attributes, raw?.parsedAttributes),
    variants,
    variantsBySku,
  };
}

export function mapJoomOrderStatus(status: string): OrderStatus {
  switch (status) {
    // fulfilledOnline：已在线下单物流、尚未交运，仍需要发货
    case 'approved':
    case 'fulfilledOnline':
      return 'to_ship';
    case 'shipped':
      return 'shipped';
    case 'cancelled':
      return 'cancelled';
    case 'refunded':
    case 'paidByJoomRefund':
      return 'refunded';
    default:
      return status.startsWith('return') ? 'returned' : 'other';
  }
}

/** 优先用拉丁字母地址（面单通用），缺的字段用买家语言的地址补。 */
function mapAddress(primary: any, native: any): OrderAddress | undefined {
  const pick = (key: string) => text(primary?.[key]) ?? text(native?.[key]);
  const composed = ['street', 'house', 'block', 'building', 'flat'].map(pick).filter(Boolean).join(', ');
  const streetAddress1 = pick('streetAddress1');
  const streetAddress2 = pick('streetAddress2');
  const address: OrderAddress = {
    name: pick('name'),
    phone: pick('phoneNumber'),
    email: pick('email'),
    country: pick('country'),
    state: pick('state'),
    city: pick('city'),
    zipCode: pick('zipCode'),
    line1: streetAddress1 ?? (composed || undefined),
    line2: streetAddress1 && composed ? [streetAddress2, composed].filter(Boolean).join(', ') : streetAddress2,
    taxNumber: pick('taxNumber'),
  };
  return Object.values(address).some(Boolean) ? address : undefined;
}

function variantInfo(info: JoomProductInfo | undefined, variantId?: string, variantSku?: string): JoomVariantInfo | undefined {
  if (!info) return undefined;
  if (variantId && info.variants[variantId]) return info.variants[variantId];
  if (variantSku && info.variantsBySku[variantSku]) return info.variantsBySku[variantSku];
  return undefined;
}

function toLine(
  lineId: string,
  product: any,
  quantity: number,
  products: Map<string, JoomProductInfo>,
  prices: { unitPrice?: number; amount?: number },
): OrderLine {
  const productId = text(product?.id);
  const variantId = text(product?.variant?.id);
  const variantSku = text(product?.variant?.sku);
  const info = productId ? products.get(productId) : undefined;
  const variant = variantInfo(info, variantId, variantSku);
  return {
    lineId,
    productId,
    productSku: text(product?.sku),
    variantId,
    variantSku,
    title: info?.name,
    color: variant?.color,
    size: variant?.size,
    imageUrl: variant?.imageUrl ?? info?.imageUrl,
    imageUrls: info?.imageUrls,
    quantity,
    ...prices,
    materialHint: variant?.materialHint ?? info?.materialHint,
  };
}

/** Joom 订单 → 统一订单。没有订单号的返回 null。 */
export function mapJoomOrder(raw: any, shop: ShopRef, products: Map<string, JoomProductInfo>): UnifiedOrder | null {
  const orderId = text(raw?.id);
  if (!orderId) return null;
  const rawStatus = text(raw?.status) ?? '';
  const quantity = Math.max(1, Math.round(Number(raw?.quantity)) || 1);
  const priceInfo = raw?.priceInfo ?? {};
  const lines: OrderLine[] = [];
  if (raw?.product) {
    lines.push(toLine('main', raw.product, quantity, products, {
      unitPrice: money(priceInfo.unitPrice),
      amount: money(priceInfo.orderPrice) ?? money(priceInfo.origAmount),
    }));
  }
  // 「买赠」的赠品也要发货；数量按订单数量计，宁可多备不少发
  if (raw?.giftProduct) lines.push({ ...toLine('gift', raw.giftProduct, quantity, products, {}), isGift: true });
  const orderedAt = isoTime(raw?.orderTimestamp) ?? isoTime(raw?.updateTimestamp) ?? new Date().toISOString();
  const carrier = text(raw?.shipment?.provider);
  const trackingNumber = text(raw?.shipment?.trackingNumber);
  return {
    platform: PLATFORM,
    shopId: shop.shopId,
    shopName: shop.shopName,
    orderId,
    status: mapJoomOrderStatus(rawStatus),
    rawStatus,
    orderedAt,
    updatedAt: isoTime(raw?.updateTimestamp) ?? orderedAt,
    currency: text(raw?.currency),
    address: mapAddress(raw?.shippingAddress, raw?.shippingAddressNative),
    tracking: carrier || trackingNumber ? { carrier, number: trackingNumber } : undefined,
    lines,
    raw,
  };
}

function listItems(data: unknown): any[] {
  if (Array.isArray(data)) return data;
  const items = (data as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? items : [];
}

function firstPage(limit: number, since: Date): string {
  const updatedFrom = since.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `/orders/multi?${new URLSearchParams({ limit: String(limit), updatedFrom }).toString()}`;
}

function isLimitError(error: unknown): boolean {
  return error instanceof MarketplaceError && Boolean(error.details?.some((detail) => detail.field === 'limit'));
}

function isNotFound(error: unknown): boolean {
  return error instanceof MarketplaceError && /\((403|404)\)/.test(error.message);
}

export class JoomOrderSource implements OrderSourceAdapter {
  readonly platform = PLATFORM;
  readonly label = 'Joom';

  constructor(private readonly joom: JoomAdapter) {}

  listShops(): OrderSourceShop[] {
    return shopService.getPublic().profiles.map((profile) => ({
      shopId: profile.id,
      shopName: profile.name,
      configured: shopService.isConfigured(profile.id),
      connected: profile.connected,
    }));
  }

  async *fetchOrders(shopId: string, { since }: FetchOrdersOptions): AsyncIterable<UnifiedOrder[]> {
    const profile = shopService.getProfile(shopId);
    if (!profile) throw new MarketplaceError('店铺不存在或已被删除');
    if (!this.joom.isShopConnected(shopId)) throw new MarketplaceError(`「${profile.name}」还没有授权 Joom`);
    const client = this.joom.clientForShop(shopId);
    const shop = { shopId, shopName: profile.name };
    let limit = PAGE_LIMIT;
    let path: string | undefined = firstPage(limit, since);
    const seen = new Set<string>();
    let pages = 0;
    while (path) {
      if (pages >= MAX_PAGES) throw new MarketplaceError('Joom 订单超过单次同步页数上限，请选择更短的时间范围后重试');
      if (seen.has(path)) throw new MarketplaceError('Joom 订单分页链接重复，已停止同步');
      seen.add(path);
      let envelope: { data?: unknown; paging?: { next?: string } };
      try {
        envelope = await client.requestEnvelope<unknown>('GET', path);
      } catch (error) {
        // 文档没写单页上限；首页若因 limit 被拒，降到 100 重试
        if (pages === 0 && limit !== FALLBACK_PAGE_LIMIT && isLimitError(error)) {
          limit = FALLBACK_PAGE_LIMIT;
          path = firstPage(limit, since);
          seen.clear();
          continue;
        }
        throw error;
      }
      pages++;
      // 商户身份授权时同一 token 可能看到多个店铺的订单，按档案里的 storeId 过滤
      const items = listItems(envelope.data).filter((order) =>
        !profile.storeId || !text(order?.storeId) || text(order.storeId) === profile.storeId);
      const products = await this.loadProducts(client, shopId, items);
      yield items.map((order) => mapJoomOrder(order, shop, products)).filter((order): order is UnifiedOrder => Boolean(order));
      path = text(envelope.paging?.next);
    }
  }

  /** 先按 Joom 商品 id 找刊登记录，再按商品 SKU 找；最后查本地商品的 joomProductId。 */
  findCatalogProductId(line: OrderLine, shopId: string): string | undefined {
    const db = getDb();
    if (line.productId) {
      const listing = db.prepare(`
        SELECT product_id FROM joom_shop_listings
        WHERE joom_product_id = ? AND product_id IS NOT NULL
        ORDER BY (shop_id = ?) DESC LIMIT 1
      `).get(line.productId, shopId) as { product_id: string } | undefined;
      if (listing) return listing.product_id;
      const product = db.prepare('SELECT id FROM products WHERE joom_product_id = ? LIMIT 1').get(line.productId) as { id: string } | undefined;
      if (product) return product.id;
    }
    if (line.productSku) {
      const listing = db.prepare(`
        SELECT product_id FROM joom_shop_listings
        WHERE sku = ? AND product_id IS NOT NULL
        ORDER BY (shop_id = ?) DESC LIMIT 1
      `).get(line.productSku, shopId) as { product_id: string } | undefined;
      if (listing) return listing.product_id;
    }
    return undefined;
  }

  /** 订单涉及的商品信息：7 天内的缓存直接用（新变体除外），否则调 GET /products；失败时用本地商品库兜底。 */
  private async loadProducts(client: JoomClient, shopId: string, orders: any[]): Promise<Map<string, JoomProductInfo>> {
    const wanted = new Map<string, { sku?: string; variantIds: Set<string> }>();
    for (const order of orders) {
      for (const product of [order?.product, order?.giftProduct]) {
        const productId = text(product?.id);
        if (!productId) continue;
        const entry = wanted.get(productId) ?? { sku: text(product?.sku), variantIds: new Set<string>() };
        const variantId = text(product?.variant?.id);
        if (variantId) entry.variantIds.add(variantId);
        wanted.set(productId, entry);
      }
    }
    const result = new Map<string, JoomProductInfo>();
    for (const [productId, { sku, variantIds }] of wanted) {
      const cached = orderRepository.getCachedProduct<JoomProductInfo>(PLATFORM, shopId, productId);
      const fresh = cached
        && Date.now() - Date.parse(cached.fetchedAt) < PRODUCT_CACHE_TTL_MS
        && [...variantIds].every((id) => cached.data.variants?.[id]);
      if (cached && cached.data.imageUrls && fresh) {
        result.set(productId, cached.data);
        continue;
      }
      try {
        const raw = await client.request<unknown>('GET', `/products?${new URLSearchParams({ id: productId }).toString()}`);
        const info = extractJoomProductInfo(raw);
        orderRepository.setCachedProduct(PLATFORM, shopId, productId, info);
        result.set(productId, info);
      } catch (error) {
        // 商品读取失败不影响订单本身入库（例如商品已从 Joom 删除），只是少了标题等信息
        if (!isNotFound(error)) {
          logger.warn('读取 Joom 商品信息失败，订单仍会保存', {
            shopId,
            productId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        const fallback = cached?.data ?? this.catalogProductInfo(productId, sku, shopId);
        if (fallback) result.set(productId, fallback);
      }
    }
    return result;
  }

  private catalogProductInfo(productId: string, productSku: string | undefined, shopId: string): JoomProductInfo | undefined {
    const localId = this.findCatalogProductId({ lineId: 'main', quantity: 1, productId, productSku }, shopId);
    const record = localId ? productRepository.get(localId) : null;
    if (!record) return undefined;
    const edited = record.edited;
    const variantsBySku: Record<string, JoomVariantInfo> = {};
    for (const variant of edited?.variants ?? []) {
      if (variant.sku) variantsBySku[variant.sku] = { sku: variant.sku, color: variant.colors, size: variant.size, imageUrl: variant.image };
    }
    return {
      name: edited?.title || record.collected.title,
      imageUrl: edited?.images?.[0] ?? record.collected.images?.[0],
      imageUrls: edited?.images?.length ? edited.images : record.collected.images,
      variants: {},
      variantsBySku,
    };
  }
}

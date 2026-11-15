import type { CollectedProduct, Price, Variant } from '@shared/types';

/** 莫斯科 dest,用于取标价;采集场景不需要精确到用户所在仓。 */
const DEST = '-1257786';

export type JsonFetcher = (url: string) => Promise<unknown>;

interface WbPrice {
  basic?: number;
  product?: number;
}

interface WbSize {
  name?: string;
  origName?: string;
  optionId?: number;
  price?: WbPrice;
  priceU?: number;
  salePriceU?: number;
  stocks?: Array<{ qty?: number }>;
}

interface WbColor {
  name?: string;
  id?: number;
}

interface WbCard {
  id?: number;
  root?: number;
  name?: string;
  brand?: string;
  entity?: string;
  supplier?: string;
  pics?: number;
  colors?: WbColor[];
  sizes?: WbSize[];
  totalQuantity?: number;
  priceU?: number;
  salePriceU?: number;
}

interface WbOption {
  name?: string;
  value?: string;
}

interface WbStaticCard {
  imt_name?: string;
  nm_id?: number;
  description?: string;
  options?: WbOption[];
  compositions?: Array<{ name?: string }>;
  media?: { photo_count?: number };
  colors?: Array<{ name?: string }>;
}

const hostByVol = new Map<number, string>();

export function isWildberriesUrl(url: string): boolean {
  try {
    return /(^|\.)wildberries\.ru$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** 从详情 URL 解析 nmId。搜索页 /catalog/0/search.aspx 不算商品。 */
export function parseNmId(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.match(/\/catalog\/(\d{5,})(?:\/detail\.aspx)?/i)?.[1];
    if (path) return path;
    return parsed.searchParams.get('nm') || parsed.searchParams.get('nmId') || parsed.searchParams.get('nmID') || '';
  } catch {
    return '';
  }
}

export function productUrl(nmId: string | number): string {
  return `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function kopecksToRub(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.round(value) / 100;
}

function sizePrice(size: WbSize | undefined, card: WbCard): Price | undefined {
  const sale = size?.price?.product ?? size?.salePriceU ?? card.salePriceU;
  const basic = size?.price?.basic ?? size?.priceU ?? card.priceU;
  const value = kopecksToRub(sale ?? basic);
  if (value == null) return undefined;
  const original = kopecksToRub(basic);
  return { value, currency: 'RUB', original: original != null && original > value ? original : undefined };
}

function sizeStock(size: WbSize): number | undefined {
  const qty = (size.stocks ?? []).reduce((sum, s) => sum + (s.qty ?? 0), 0);
  return qty || undefined;
}

function hasRealSize(size: WbSize): boolean {
  const name = (size.name || '').trim();
  const orig = (size.origName || '').trim();
  if (!name && !orig) return false;
  if ((name === '0' || name === '') && (orig === '0' || orig === '')) return false;
  return true;
}

function sizeLabel(size: WbSize): string {
  const name = (size.name || '').trim();
  const orig = (size.origName || '').trim();
  if (name && orig && name !== orig && orig !== '0') return `${orig}/${name}`;
  return name && name !== '0' ? name : orig;
}

/** vol → 常见 basket 分片;只作探针起点,实际 host 以请求成功为准。 */
function guessBasket(vol: number): number {
  const table: Array<[number, number]> = [
    [143, 1], [287, 2], [431, 3], [719, 4], [1007, 5], [1061, 6], [1115, 7], [1169, 8],
    [1313, 9], [1601, 10], [1655, 11], [1919, 12], [2045, 13], [2189, 14], [2405, 15],
    [2621, 16], [2837, 17], [3053, 18], [3269, 19], [3485, 20], [3701, 21], [3917, 22],
    [4133, 23], [4349, 24], [4565, 25], [4877, 26], [5189, 27], [5501, 28], [5813, 29],
    [6125, 30], [6437, 31], [6749, 32], [7061, 33], [7373, 34], [7685, 35], [7997, 36],
    [8309, 37], [8621, 38], [8933, 39], [9245, 40], [9557, 41], [9869, 42], [10200, 42],
    [10979, 42], [11333, 43], [11765, 44], [12197, 45], [12629, 46], [13061, 47],
    [13493, 48], [13925, 49], [14357, 50], [14789, 51], [15221, 52], [15653, 53],
    [16085, 54], [16517, 55],
  ];
  for (const [max, n] of table) if (vol <= max) return n;
  return 55;
}

function probeOrder(vol: number): string[] {
  const guess = guessBasket(vol);
  const nearby: number[] = [];
  for (let d = 0; d <= 8; d++) {
    if (d === 0) nearby.push(guess);
    else {
      if (guess - d >= 1) nearby.push(guess - d);
      if (guess + d <= 60) nearby.push(guess + d);
    }
  }
  const rest = [];
  for (let n = 1; n <= 60; n++) if (!nearby.includes(n)) rest.push(n);
  return unique([...nearby, ...rest]).map((n) => String(n).padStart(2, '0'));
}

function imageUrls(nmId: number, host: string, count: number): string[] {
  const vol = Math.floor(nmId / 100000);
  const part = Math.floor(nmId / 1000);
  const n = Math.max(1, Math.min(count || 1, 10));
  return Array.from({ length: n }, (_, i) => (
    `https://basket-${host}.wbbasket.ru/vol${vol}/part${part}/${nmId}/images/big/${i + 1}.webp`
  ));
}

async function fetchCards(nmIds: string[], fetchJson: JsonFetcher): Promise<Map<string, WbCard>> {
  const out = new Map<string, WbCard>();
  for (const chunk of chunks(unique(nmIds.filter(Boolean)), 20)) {
    const url = `https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=${DEST}&spp=0&nm=${chunk.join(';')}`;
    const data = asRecord(await fetchJson(url));
    const products = Array.isArray(data?.products) ? data.products : [];
    for (const item of products) {
      const card = asRecord(item) as WbCard | null;
      if (card?.id) out.set(String(card.id), card);
    }
  }
  return out;
}

async function fetchStaticCard(nmId: number, fetchJson: JsonFetcher): Promise<{ host: string; card: WbStaticCard } | null> {
  const vol = Math.floor(nmId / 100000);
  const part = Math.floor(nmId / 1000);
  const path = `/vol${vol}/part${part}/${nmId}/info/ru/card.json`;
  const tryHost = async (nn: string): Promise<WbStaticCard | null> => {
    try {
      const json = asRecord(await fetchJson(`https://basket-${nn}.wbbasket.ru${path}`));
      return json as WbStaticCard | null;
    } catch {
      return null;
    }
  };

  const cached = hostByVol.get(vol);
  if (cached) {
    const card = await tryHost(cached);
    if (card) return { host: cached, card };
    hostByVol.delete(vol);
  }

  for (const group of chunks(probeOrder(vol), 8)) {
    const hits = await Promise.all(group.map(async (nn) => {
      const card = await tryHost(nn);
      return card ? { host: nn, card } : null;
    }));
    const hit = hits.find(Boolean);
    if (hit) {
      hostByVol.set(vol, hit.host);
      return hit;
    }
  }
  return null;
}

function mapProduct(card: WbCard, staticCard: WbStaticCard | null, host: string | null): CollectedProduct | null {
  const id = card.id != null ? String(card.id) : staticCard?.nm_id != null ? String(staticCard.nm_id) : '';
  if (!id) return null;
  const brand = (card.brand || '').trim();
  const name = (staticCard?.imt_name || card.name || '').trim();
  const title = brand && name && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name || brand;
  if (!title) return null;

  const color = (card.colors?.[0]?.name || staticCard?.colors?.[0]?.name || '').trim();
  const sizes = card.sizes ?? [];
  const priced = sizes.find((s) => sizePrice(s, card));
  const price = sizePrice(priced, card);
  const photoCount = staticCard?.media?.photo_count || card.pics || 1;
  const images = host ? imageUrls(Number(id), host, photoCount) : [];

  const variants: Variant[] = [];
  const sized = sizes.filter(hasRealSize);
  if (sized.length) {
    for (const size of sized) {
      const options: Record<string, string> = {};
      if (color) options['颜色'] = color;
      options['尺码'] = sizeLabel(size);
      const sp = sizePrice(size, card);
      variants.push({
        sourceSkuId: String(size.optionId ?? `${id}-${sizeLabel(size)}`),
        options,
        price: sp?.value,
        image: images[0],
        stock: sizeStock(size) ?? card.totalQuantity,
      });
    }
  } else {
    const options: Record<string, string> = {};
    if (color) options['颜色'] = color;
    variants.push({
      sourceSkuId: id,
      options,
      price: price?.value,
      image: images[0],
      stock: card.totalQuantity,
    });
  }

  const attributes: Record<string, string> = {};
  if (brand) attributes['品牌'] = brand;
  if (card.entity) attributes['类目'] = card.entity;
  for (const opt of staticCard?.options ?? []) {
    const key = (opt.name || '').trim();
    const value = (opt.value || '').trim();
    if (key && value) attributes[key] = value;
  }
  const composition = (staticCard?.compositions ?? []).map((c) => c.name?.trim()).filter(Boolean).join(', ');
  if (composition) attributes['成分'] = composition;

  return {
    source: 'wildberries',
    sourceUrl: productUrl(id),
    sourceProductId: id,
    title,
    description: staticCard?.description?.trim() || undefined,
    images,
    price,
    variants,
    attributes,
    store: card.supplier ? { name: card.supplier } : undefined,
    raw: { platform: 'wildberries', parser: 'card.wb.ru+v4', pics: card.pics, root: card.root },
  };
}

/**
 * 通过公开 JSON 接口采集 Wildberries 商品,不打开详情页,避开 antibot 挑战页。
 */
export async function extractWildberriesProducts(
  urls: string[],
  fetchJson: JsonFetcher,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, CollectedProduct>> {
  const idByUrl = new Map<string, string>();
  for (const url of urls) {
    const id = parseNmId(url);
    if (id) idByUrl.set(url, id);
  }
  const ids = unique([...idByUrl.values()]);
  const cards = await fetchCards(ids, fetchJson);
  const out = new Map<string, CollectedProduct>();

  const enrich = async (id: string): Promise<CollectedProduct | null> => {
    const card = cards.get(id);
    if (!card) return null;
    const staticHit = await fetchStaticCard(Number(id), fetchJson);
    return mapProduct(card, staticHit?.card ?? null, staticHit?.host ?? null);
  };

  const productsById = new Map<string, CollectedProduct>();
  let done = 0;
  for (const group of chunks(ids, 4)) {
    const mapped = await Promise.all(group.map(enrich));
    for (let i = 0; i < group.length; i++) {
      const product = mapped[i];
      if (product) productsById.set(group[i], product);
      done += 1;
      onProgress?.(done, ids.length);
    }
  }

  for (const [url, id] of idByUrl) {
    const product = productsById.get(id);
    if (product) out.set(url, { ...product, sourceUrl: url.startsWith('http') ? url : product.sourceUrl });
  }
  return out;
}

export async function extractWildberriesProduct(url: string, fetchJson: JsonFetcher): Promise<CollectedProduct | null> {
  const id = parseNmId(url);
  if (!id) return null;
  const products = await extractWildberriesProducts([productUrl(id)], fetchJson);
  return products.get(productUrl(id)) ?? [...products.values()][0] ?? null;
}

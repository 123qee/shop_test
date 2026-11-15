import type { CollectedProduct, Price, Variant } from '@shared/types';
import type { SourceExtractor } from './types.js';
import { productVideosFromPage } from './media.js';

// ---------- 通用工具 ----------

/** 规范化 URL(补协议、去空白) */
function absUrl(u: string | undefined | null): string | null {
  if (!u) return null;
  let s = u.trim();
  if (!s) return null;
  if (s.startsWith('//')) s = 'https:' + s;
  return s;
}

/** 从价格文本中解析数字,如 "MX$64.9"、"64,90"、"US $9.99" */
function parseNumber(text: string | undefined | null): number | undefined {
  if (!text) return undefined;
  // 保留数字、点、逗号
  const cleaned = text.replace(/[^\d.,]/g, '');
  if (!cleaned) return undefined;
  // 若同时含 . 和 ,:假定 , 为千分位或小数;取最后一个分隔符为小数点
  let normalized = cleaned;
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    const decimalSep = lastDot > lastComma ? '.' : ',';
    const thousandSep = decimalSep === '.' ? ',' : '.';
    normalized = cleaned.split(thousandSep).join('').replace(decimalSep, '.');
  } else if (lastComma !== -1) {
    // 只有逗号:若后面 2 位则当小数点,否则当千分位
    normalized = /,\d{1,2}$/.test(cleaned) ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  }
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : undefined;
}

/** 从 URL 提取商品 id */
function productIdFromUrl(url: string): string {
  const m = url.match(/\/item\/(\d+)\.html/) || url.match(/[?&]productId=(\d+)/) || url.match(/(\d{10,})/);
  return m ? m[1] : '';
}

function getMeta(prop: string): string | undefined {
  const el =
    document.querySelector(`meta[property="${prop}"]`) || document.querySelector(`meta[name="${prop}"]`);
  return el?.getAttribute('content') ?? undefined;
}

/** 解析所有 JSON-LD 脚本,返回 Product 类型对象(若有) */
function getJsonLdProduct(): any | null {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const s of Array.from(scripts)) {
    try {
      const data = JSON.parse(s.textContent || '');
      const arr = Array.isArray(data) ? data : [data];
      for (const item of arr) {
        if (item && (item['@type'] === 'Product' || item.name)) return item;
      }
    } catch {
      /* 忽略无效 JSON-LD */
    }
  }
  return null;
}

/**
 * 从 inline <script> 文本中抠出赋值给某全局变量的 JSON。
 * 注意:content script 处于隔离环境,无法直接读 window.runParams,
 * 但能读到设置它的 <script> 文本,故用括号匹配从文本里解析。
 */
function extractGlobalJson(markers: string[]): any | null {
  const scripts = Array.from(document.querySelectorAll('script:not([src])'));
  for (const s of scripts) {
    const text = s.textContent || '';
    for (const marker of markers) {
      const idx = text.indexOf(marker);
      if (idx === -1) continue;
      const braceStart = text.indexOf('{', idx);
      if (braceStart === -1) continue;
      const json = sliceBalanced(text, braceStart);
      if (!json) continue;
      try {
        return JSON.parse(json);
      } catch {
        /* 继续尝试其他 marker/script */
      }
    }
  }
  return null;
}

/** 从 str[start]('{') 开始,返回配平的 JSON 子串(处理字符串与转义) */
function sliceBalanced(str: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

// ---------- AliExpress 详情页解析 ----------

/** 经典 runParams.data 结构(旧版详情页)的字段路径解析 */
function fromRunParams(data: any): Partial<CollectedProduct> | null {
  const d = data?.data ?? data;
  if (!d) return null;
  const out: Partial<CollectedProduct> = {};
  const title = d.titleModule?.subject || d.productInfoComponent?.subject;
  if (title) out.title = String(title);

  const imgs: string[] = d.imageModule?.imagePathList || d.imageComponent?.imagePathList || [];
  if (imgs.length) out.images = imgs.map((i) => absUrl(i)!).filter(Boolean);

  const priceVal =
    d.priceModule?.minActivityAmount?.value ??
    d.priceModule?.minAmount?.value ??
    d.priceComponent?.origPrice?.minPrice;
  const currency = d.priceModule?.minAmount?.currency || d.webEnv?.currency;
  if (priceVal != null) out.price = { value: Number(priceVal), currency: currency || 'USD' };

  // 变体:skuModule.productSKUPropertyList / skuPriceList
  const variants: Variant[] = [];
  const priceList = d.skuModule?.skuPriceList;
  if (Array.isArray(priceList)) {
    for (const sku of priceList) {
      const options: Record<string, string> = {};
      const names = String(sku.skuPropIds ?? '');
      variants.push({
        sourceSkuId: String(sku.skuId ?? sku.skuIdStr ?? ''),
        options: options && Object.keys(options).length ? options : { sku: names },
        price: parseNumber(String(sku.skuVal?.actSkuCalPrice ?? sku.skuVal?.skuAmount?.value ?? '')),
        stock: sku.skuVal?.availQuantity,
      });
    }
  }
  if (variants.length) out.variants = variants;
  out.raw = { source: 'runParams', keys: Object.keys(d) };
  return out;
}

/**
 * 注入主世界脚本读取 window.runParams 的完整 SKU 矩阵。
 * content script 处于隔离世界读不到页面全局变量,故用 <script src> 注入。
 */
function readMainWorld(): Promise<Partial<CollectedProduct> | null> {
  return new Promise((resolve) => {
    let done = false;
    const nonce = Math.random().toString(36).slice(2);
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window || !e.data || e.data.__joomCollect !== nonce) return;
      done = true;
      window.removeEventListener('message', onMsg);
      // 诊断信息:采集不全时把它发我即可定位
      console.log('[Joom采集助手] 主世界读取结果', e.data.debug);
      resolve((e.data.payload as Partial<CollectedProduct>) ?? null);
    };
    window.addEventListener('message', onMsg);
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('injected.js');
      s.dataset.nonce = nonce;
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch {
      window.removeEventListener('message', onMsg);
      return resolve(null);
    }
    setTimeout(() => {
      if (done) return;
      window.removeEventListener('message', onMsg);
      resolve(null);
    }, 4000);
  });
}

async function extractDetail(): Promise<CollectedProduct | null> {
  const url = location.href;
  const base: CollectedProduct = {
    source: 'aliexpress',
    sourceUrl: url,
    sourceProductId: productIdFromUrl(url),
    title: '',
    images: [],
    variants: [],
    attributes: {},
  };

  // 0) 主世界注入:读取完整 SKU 矩阵(最可靠)
  const main = await readMainWorld();
  if (main) {
    if (main.title) base.title = main.title;
    if (main.images?.length) base.images = main.images;
    if (main.videos?.length) base.videos = main.videos;
    if (main.description) base.description = main.description;
    if (main.price) base.price = main.price;
    if (main.variants?.length) base.variants = main.variants;
  }

  // 1) 内嵌 JSON 兜底(隔离世界读 <script> 文本)
  if (!base.variants.length || !base.title) {
    const embedded =
      extractGlobalJson(['window.runParams', '_init_data_', 'window.__STORE_DATA__', 'window.__AER_DATA__']) ?? null;
    if (embedded) {
      const parsed = fromRunParams(embedded);
      if (parsed) {
        if (!base.title && parsed.title) base.title = parsed.title;
        if (!base.images.length && parsed.images) base.images = parsed.images;
        if (!base.price && parsed.price) base.price = parsed.price;
        if (!base.variants.length && parsed.variants) base.variants = parsed.variants;
      }
    }
  }

  // 2) JSON-LD 补全
  if (!base.title || base.images.length === 0 || !base.price) {
    const ld = getJsonLdProduct();
    if (ld) {
      if (!base.title && ld.name) base.title = String(ld.name);
      if (base.images.length === 0 && ld.image) {
        base.images = (Array.isArray(ld.image) ? ld.image : [ld.image]).map((i: string) => absUrl(i)!).filter(Boolean);
      }
      const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
      if (!base.price && offer?.price) {
        base.price = { value: Number(offer.price), currency: offer.priceCurrency || 'USD' };
      }
      if (!base.description && ld.description) base.description = String(ld.description);
    }
  }

  // 3) og / meta 补全
  if (!base.title) base.title = getMeta('og:title') || document.title;
  if (base.images.length === 0) {
    const og = absUrl(getMeta('og:image'));
    if (og) base.images = [og];
  }
  if (!base.description) base.description = getMeta('og:description') || getMeta('description');
  if (!base.price) {
    const amount = getMeta('product:price:amount');
    const cur = getMeta('product:price:currency');
    if (amount) base.price = { value: Number(amount), currency: cur || 'USD' };
  }

  // 4) DOM 兜底
  if (!base.title) {
    const h1 = document.querySelector('h1');
    if (h1?.textContent) base.title = h1.textContent.trim();
  }
  if (!base.price) {
    const priceEl = document.querySelector('[class*="price"], [class*="Price"]');
    const p = parseNumber(priceEl?.textContent);
    if (p) base.price = { value: p, currency: 'USD' };
  }

  base.title = base.title.trim();
  if (!base.title) return null;
  base.images = dedupe(base.images);
  base.videos = dedupeVideos([...(base.videos ?? []), ...productVideosFromPage(getJsonLdProduct())]);
  return base;
}

function dedupeVideos(videos: NonNullable<CollectedProduct['videos']>): NonNullable<CollectedProduct['videos']> {
  const seen = new Set<string>();
  return videos.filter((video) => {
    const key = video.url.replace(/[?#].*$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

// ---------- 列表/店铺页卡片解析 ----------

/** 单张商品卡的尺寸范围。过小是缩略图/购物车条目，过大是整页或推荐区容器。 */
function isCardSized(el: HTMLElement): boolean {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  return w > 120 && h > 140 && w < 520 && h < 760;
}

function findCards(root: ParentNode = document): HTMLElement[] {
  const anchors = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/item/"]'));
  const cards = new Set<HTMLElement>();
  for (const a of anchors) {
    if (isCurrentItemHref(a.href)) continue;
    // 搜索结果页的商品卡本身就是链接；排除页尾推荐词等普通 /item/ 链接。
    if (a.classList.contains('search-card-item')) {
      cards.add(a);
      continue;
    }
    const card = closestCard(a);
    if (card && card.querySelector('img') && isCardSized(card)) cards.add(card);
  }
  const list = Array.from(cards);
  // 同一区域里若外层容器和内层卡都命中，只保留最内层，避免整行只出现一个按钮。
  return list.filter((card) => !list.some((other) => other !== card && card.contains(other)));
}

function isCurrentItemHref(href: string): boolean {
  const id = productIdFromUrl(href);
  const current = productIdFromUrl(location.href);
  return Boolean(id && current && id === current);
}

/** 从 /item 链接向上找一个合理的卡片容器 */
function closestCard(a: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = a;
  let depth = 0;
  while (el && depth < 8) {
    if (el.querySelector('img') && isCardSized(el)) return el;
    el = el.parentElement;
    depth++;
  }
  return null;
}

function extractCard(card: HTMLElement): CollectedProduct | null {
  const link = card.matches('a[href*="/item/"]')
    ? (card as HTMLAnchorElement)
    : card.querySelector<HTMLAnchorElement>('a[href*="/item/"]');
  const href = link ? absUrl(link.href) : null;
  if (!href) return null;

  const img = card.querySelector<HTMLImageElement>('img');
  const imgSrc = absUrl(img?.getAttribute('src') || img?.getAttribute('data-src'));

  // 标题:优先 img alt / title 属性 / 链接文本
  const title =
    (link?.getAttribute('title') || img?.getAttribute('alt') || cardText(card))?.trim() || '';

  // 价格:卡片内含货币符号的文本
  const priceText = findPriceText(card);
  const price: Price | undefined = priceText
    ? { value: parseNumber(priceText) ?? 0, currency: guessCurrency(priceText) }
    : undefined;

  if (!title) return null;
  return {
    source: 'aliexpress',
    sourceUrl: href,
    sourceProductId: productIdFromUrl(href),
    title,
    images: imgSrc ? [imgSrc] : [],
    price,
    variants: [],
    attributes: {},
    raw: { from: 'card' },
  };
}

function getCardUrl(card: HTMLElement): string | null {
  const link = card.matches('a[href*="/item/"]')
    ? (card as HTMLAnchorElement)
    : card.querySelector<HTMLAnchorElement>('a[href*="/item/"]');
  return link?.href || null;
}

function cardText(card: HTMLElement): string {
  // 取卡片里最长的一段文本作为标题候选
  const candidates = Array.from(card.querySelectorAll('h1,h2,h3,a,span,div'))
    .map((e) => e.textContent?.trim() || '')
    .filter((t) => t.length > 8 && !/^\W*[\d.,]+\W*$/.test(t));
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || '';
}

function findPriceText(card: HTMLElement): string | null {
  const els = Array.from(card.querySelectorAll('*'));
  for (const e of els) {
    const t = e.textContent || '';
    if (/[$€£¥]|MX\$|US\s?\$|R\$/.test(t) && /\d/.test(t) && t.length < 30) return t;
  }
  return null;
}

function guessCurrency(text: string): string {
  if (/MX\$/.test(text)) return 'MXN';
  if (/R\$/.test(text)) return 'BRL';
  if (/US\s?\$|\$/.test(text)) return 'USD';
  if (/€/.test(text)) return 'EUR';
  if (/£/.test(text)) return 'GBP';
  if (/¥/.test(text)) return 'CNY';
  return 'USD';
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

// ---------- 导出 extractor ----------

export const aliexpressExtractor: SourceExtractor = {
  id: 'aliexpress',
  matches: (url) => /(^|\.)aliexpress\.(com|us)$/i.test(new URL(url).hostname),
  isDetailPage: (url) => /\/item\/\d+\.html/.test(url),
  findCards,
  getCardUrl,
  extractCard,
  extractDetail,
};

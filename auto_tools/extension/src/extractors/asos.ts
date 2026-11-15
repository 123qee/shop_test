import type { CollectedProduct, Price, Variant } from '@shared/types';
import type { SourceExtractor } from './types.js';
import { productVideosFromPage } from './media.js';

const ASOS_HOST = /(^|\.)asos\.com$/i;
const PRODUCT_PATH = /\/prd\/(\d+)/i;
const DETAIL_READY_TIMEOUT_MS = 8_000;

interface AsosProductConfig {
  productCode?: string;
  name?: string;
  gender?: string;
  id?: number;
  brandName?: string;
  countryOfManufacture?: string;
  description?: string;
  productType?: { name?: string };
  fitType?: { name?: string };
  variants?: Array<{
    variantId?: number;
    size?: string;
    brandSize?: string;
    colour?: string;
    colourWayId?: number;
    ean?: string;
    sku?: string;
    isAvailable?: boolean;
  }>;
  images?: Array<{
    url?: string;
    colour?: string;
    colourWayId?: number | null;
    isPrimary?: boolean;
    isVisible?: boolean;
  }>;
}

interface JsonLdOffer {
  price?: string | number;
  priceCurrency?: string;
  availability?: string;
  itemOffered?: { sku?: string; color?: string; image?: string };
}

interface JsonLdProduct {
  '@type'?: string | string[];
  name?: string;
  sku?: string;
  color?: string;
  image?: string | string[];
  description?: string;
  productID?: string | number;
  url?: string;
  brand?: { name?: string } | string;
  offers?: JsonLdOffer | JsonLdOffer[];
}

function parsedUrl(value: string, base = location.href): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function isAsosUrl(value: string): boolean {
  const url = parsedUrl(value);
  return Boolean(url && ASOS_HOST.test(url.hostname));
}

function productIdFromUrl(value: string): string {
  return parsedUrl(value)?.pathname.match(PRODUCT_PATH)?.[1] ?? '';
}

/** 保留合法 colourWayId，丢弃用户粘贴到链接尾部的说明文字。 */
function cleanProductUrl(value: string): string | null {
  const url = parsedUrl(value);
  if (!url || !ASOS_HOST.test(url.hostname) || !PRODUCT_PATH.test(url.pathname)) return null;
  const colourWayId = url.hash.match(/colourWayId-(\d+)/i)?.[1];
  url.search = '';
  url.hash = colourWayId ? `colourWayId-${colourWayId}` : '';
  return url.toString();
}

function absoluteUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const url = parsedUrl(value.trim().startsWith('//') ? `https:${value.trim()}` : value.trim());
  return url?.toString() ?? null;
}

/** ASOS 裸图片地址默认返回低分辨率图；固定请求可用于预览和发布的 1000px 版本。 */
function asosImageUrl(value: string | null | undefined): string | null {
  const absolute = absoluteUrl(value);
  if (!absolute) return null;
  const url = parsedUrl(absolute);
  if (!url) return null;
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  url.searchParams.set('wid', '1000');
  url.searchParams.set('fit', 'constrain');
  return url.toString();
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function parseNumber(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const match = text.replace(/\s/g, '').match(/[-+]?\d[\d.,]*/);
  if (!match) return undefined;
  const raw = match[0];
  const lastDot = raw.lastIndexOf('.');
  const lastComma = raw.lastIndexOf(',');
  let normalized = raw;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    normalized = raw.split(decimal === '.' ? ',' : '.').join('').replace(decimal, '.');
  } else if (lastComma >= 0) {
    normalized = /,\d{1,2}$/.test(raw) ? raw.replace(',', '.') : raw.replace(/,/g, '');
  } else if (lastDot >= 0 && !/\.\d{1,2}$/.test(raw)) {
    normalized = raw.replace(/\./g, '');
  }
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function currencyFromText(text: string | null | undefined, fallback = 'GBP'): string {
  const value = text || '';
  if (/CNY|CN¥|RMB|¥|￥/i.test(value)) return 'CNY';
  if (/GBP|£/i.test(value)) return 'GBP';
  if (/EUR|€/i.test(value)) return 'EUR';
  if (/USD|US\s*\$/i.test(value)) return 'USD';
  if (/AUD|AU\s*\$/i.test(value)) return 'AUD';
  return fallback;
}

function meta(name: string): string | undefined {
  return (
    document.querySelector(`meta[property="${name}"]`)?.getAttribute('content') ??
    document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ??
    undefined
  );
}

function sliceBalanced(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** ASOS 会先写一个只有 id 的对象，再写完整商品对象，因此取最后一个有效完整对象。 */
function productConfig(): AsosProductConfig | null {
  const marker = 'window.asos.pdp.config.product =';
  let selected: AsosProductConfig | null = null;
  for (const script of Array.from(document.querySelectorAll('script:not([src])'))) {
    const text = script.textContent || '';
    let offset = 0;
    while (offset < text.length) {
      const markerIndex = text.indexOf(marker, offset);
      if (markerIndex < 0) break;
      const start = text.indexOf('{', markerIndex + marker.length);
      if (start < 0) break;
      const json = sliceBalanced(text, start);
      offset = start + Math.max(json?.length ?? 1, 1);
      if (!json) continue;
      try {
        const parsed = JSON.parse(json) as AsosProductConfig;
        if (parsed.name || parsed.productCode || parsed.variants?.length) selected = parsed;
      } catch {
        /* 忽略页面中的短配置对象或结构更新，继续使用 JSON-LD/DOM 兜底。 */
      }
    }
  }
  return selected;
}

function jsonLdProduct(): JsonLdProduct | null {
  const visit = (value: unknown): JsonLdProduct | null => {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found) return found;
      }
      return null;
    }
    const record = value as Record<string, unknown>;
    const type = record['@type'];
    if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) return record as JsonLdProduct;
    return visit(record['@graph']);
  };

  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const product = visit(JSON.parse(script.textContent || ''));
      if (product) return product;
    } catch {
      /* 页面可能包含无效或不相关 JSON-LD。 */
    }
  }
  return null;
}

function htmlToText(html: string | undefined): string {
  if (!html) return '';
  const holder = document.createElement('div');
  holder.innerHTML = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/li>/gi, '\n');
  return (holder.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function priceFromPage(ld: JsonLdProduct | null): Price | undefined {
  const currentText = document.querySelector('[data-testid="current-price"]')?.textContent;
  const current = parseNumber(currentText);
  const previous = parseNumber(document.querySelector('[data-testid="previous-price"]')?.textContent);
  const offers = Array.isArray(ld?.offers) ? ld.offers : ld?.offers ? [ld.offers] : [];
  const firstOffer = offers[0];
  const value = current ?? parseNumber(String(firstOffer?.price ?? ''));
  if (value == null) return undefined;
  return {
    value,
    currency: firstOffer?.priceCurrency || currencyFromText(currentText),
    ...(previous != null && previous > value ? { original: previous } : {}),
  };
}

function pageColour(config: AsosProductConfig | null, ld: JsonLdProduct | null): string {
  const fromConfig = config?.variants?.find((variant) => variant.colour)?.colour;
  if (fromConfig) return fromConfig;
  if (ld?.color) return ld.color;
  const text = document.querySelector('[data-testid="productColour"]')?.textContent || '';
  return text.replace(/^\s*COLOU?R\s*:\s*/i, '').trim();
}

function detailImages(config: AsosProductConfig | null, ld: JsonLdProduct | null): string[] {
  const configImages = (config?.images ?? [])
    .filter((image) => image.isVisible !== false)
    .map((image) => asosImageUrl(image.url));
  const domImages = Array.from(document.querySelectorAll<HTMLImageElement>('[data-testid="heroGallery"] img'))
    .map((image) => asosImageUrl(image.currentSrc || image.getAttribute('src')));
  const ldImages = (Array.isArray(ld?.image) ? ld.image : ld?.image ? [ld.image] : []).map(asosImageUrl);
  return dedupe([...configImages, ...domImages, ...ldImages, asosImageUrl(meta('og:image'))]);
}

function detailVariants(
  config: AsosProductConfig | null,
  ld: JsonLdProduct | null,
  price: Price | undefined,
  colour: string,
  image: string | undefined,
): Variant[] {
  if (config?.variants?.length) {
    return config.variants.map((variant) => ({
      sourceSkuId: String(variant.sku || variant.variantId || ''),
      options: {
        ...(variant.colour || colour ? { Color: variant.colour || colour } : {}),
        ...(variant.brandSize || variant.size ? { Size: variant.brandSize || variant.size || '' } : {}),
      },
      price: price?.value,
      image,
      ...(variant.isAvailable === false ? { stock: 0 } : {}),
    }));
  }

  const offers = Array.isArray(ld?.offers) ? ld.offers : ld?.offers ? [ld.offers] : [];
  const options = Array.from(document.querySelectorAll<HTMLOptionElement>('[data-testid="variant-selector"] option, #variantSelector option'))
    .filter((option) => Boolean(option.value));
  if (options.length) {
    return options.map((option, index) => {
      const label = (option.getAttribute('aria-label') || option.textContent || '').trim();
      const size = label.replace(/\s*-\s*out of stock\s*$/i, '').trim();
      const offer = offers[index];
      return {
        sourceSkuId: String(offer?.itemOffered?.sku || option.value),
        options: { ...(colour ? { Color: colour } : {}), ...(size ? { Size: size } : {}) },
        price: parseNumber(String(offer?.price ?? '')) ?? price?.value,
        image,
        ...(/out of stock/i.test(label) || /OutOfStock/i.test(offer?.availability || '') ? { stock: 0 } : {}),
      };
    });
  }

  if (ld) {
    const offer = offers[0];
    return [{
      sourceSkuId: String(offer?.itemOffered?.sku || ld.sku || ''),
      options: colour ? { Color: colour } : {},
      price: parseNumber(String(offer?.price ?? '')) ?? price?.value,
      image,
      ...(/OutOfStock/i.test(offer?.availability || '') ? { stock: 0 } : {}),
    }];
  }
  return [];
}

function findCards(root: ParentNode = document): HTMLElement[] {
  const cards = new Set<HTMLElement>();
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/prd/"]'))) {
    if (!cleanProductUrl(link.href)) continue;
    const card = link.closest<HTMLElement>('li[id^="product-"], [data-testid="productCard"], article');
    if (card?.querySelector('img')) cards.add(card);
  }
  const list = Array.from(cards);
  return list.filter((card) => !list.some((other) => other !== card && card.contains(other)));
}

function getCardUrl(card: HTMLElement): string | null {
  const link = card.matches('a[href*="/prd/"]')
    ? (card as HTMLAnchorElement)
    : card.querySelector<HTMLAnchorElement>('a[href*="/prd/"]');
  return link ? cleanProductUrl(link.href) : null;
}

function extractCard(card: HTMLElement): CollectedProduct | null {
  const sourceUrl = getCardUrl(card);
  if (!sourceUrl) return null;
  const link = card.matches('a[href*="/prd/"]')
    ? (card as HTMLAnchorElement)
    : card.querySelector<HTMLAnchorElement>('a[href*="/prd/"]');
  const image = card.querySelector<HTMLImageElement>('img');
  const title = (
    card.querySelector<HTMLElement>('p[id^="pta-product-"][class*="productDescription"]')?.textContent ||
    image?.alt.replace(/\s+-\s+view\s+\d+.*$/i, '') ||
    link?.getAttribute('aria-label')?.split(/,\s*(?:Original price|Price|Current price)/i)[0] ||
    ''
  ).trim();
  if (!title) return null;

  const currentText =
    card.querySelector<HTMLElement>('[class*="reducedPrice"]')?.textContent ||
    card.querySelector<HTMLElement>('[class*="price_"]')?.textContent ||
    link?.getAttribute('aria-label');
  const originalText = card.querySelector<HTMLElement>('[class*="originalPrice"]')?.textContent;
  const value = parseNumber(currentText);
  const original = parseNumber(originalText);
  const price = value == null ? undefined : {
    value,
    currency: currencyFromText(currentText),
    ...(original != null && original > value ? { original } : {}),
  };
  const images = dedupe(Array.from(card.querySelectorAll<HTMLImageElement>('img')).map((item) => asosImageUrl(item.currentSrc || item.src)));
  return {
    source: 'asos',
    sourceUrl,
    sourceProductId: productIdFromUrl(sourceUrl),
    title,
    images,
    price,
    variants: [],
    attributes: {},
    store: { name: 'ASOS', url: 'https://www.asos.com/' },
    raw: { platform: 'asos', parser: 'card' },
  };
}

async function waitForDetail(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < DETAIL_READY_TIMEOUT_MS) {
    if (document.querySelector('h1') && (productConfig() || jsonLdProduct())) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function extractDetail(): Promise<CollectedProduct | null> {
  await waitForDetail();
  const config = productConfig();
  const ld = jsonLdProduct();
  const currentUrl = cleanProductUrl(location.href) || meta('og:url') || location.href;
  const sourceProductId = String(config?.id || ld?.productID || productIdFromUrl(currentUrl));
  const title = String(config?.name || ld?.name || document.querySelector('h1')?.textContent || meta('og:title') || '')
    .replace(/\s*\|\s*ASOS\s*$/i, '')
    .trim();
  if (!sourceProductId || !title) return null;

  const price = priceFromPage(ld);
  const colour = pageColour(config, ld);
  const images = detailImages(config, ld);
  const detailsText = document.querySelector('[data-testid="productDescriptionDetails"]')?.textContent?.trim() || '';
  const material = detailsText.match(/(?:Main|Material)\s*:\s*([^.;\n]+)/i)?.[1]?.trim();
  const brand = config?.brandName || (typeof ld?.brand === 'string' ? ld.brand : ld?.brand?.name);
  const attributes: Record<string, string> = {};
  if (brand) attributes.Brand = brand;
  if (colour) attributes.Color = colour;
  if (config?.gender) attributes.Gender = config.gender;
  if (config?.productType?.name) attributes['Product Type'] = config.productType.name;
  if (config?.fitType?.name) attributes.Fit = config.fitType.name;
  if (config?.countryOfManufacture) attributes['Country of Manufacture'] = config.countryOfManufacture;
  if (config?.productCode || ld?.sku) attributes['Product Code'] = String(config?.productCode || ld?.sku);
  if (material) attributes.Material = material;

  const variants = detailVariants(config, ld, price, colour, images[0]);
  return {
    source: 'asos',
    sourceUrl: currentUrl,
    sourceProductId,
    title,
    description: htmlToText(config?.description) || ld?.description || meta('description'),
    images,
    videos: productVideosFromPage(ld),
    price,
    variants,
    attributes,
    store: { name: 'ASOS', url: 'https://www.asos.com/' },
    raw: {
      platform: 'asos',
      parser: 'pdp-config+json-ld+dom',
      colourWayId: config?.variants?.find((variant) => variant.colourWayId)?.colourWayId,
      productCode: config?.productCode,
      eans: (config?.variants ?? []).map((variant) => variant.ean).filter(Boolean),
      variantCount: variants.length,
    },
  };
}

export const asosExtractor: SourceExtractor = {
  id: 'asos',
  matches: isAsosUrl,
  isDetailPage: (url) => Boolean(productIdFromUrl(url)),
  findCards,
  getCardUrl,
  extractCard,
  extractDetail,
};

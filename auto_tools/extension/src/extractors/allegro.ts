import type { CollectedProduct, Price, Variant } from '@shared/types';
import type { SourceExtractor } from './types.js';
import { productVideosFromPage } from './media.js';

const ALLEGRO_HOST = /(^|\.)allegro\.pl$/i;
const OFFER_PATH = /\/oferta\/(?:.*-)?(\d+)\/?$/i;
const DETAIL_READY_TIMEOUT_MS = 8_000;

interface JsonLdImage {
  url?: string;
  contentUrl?: string;
}

interface JsonLdOffer {
  price?: string | number;
  priceCurrency?: string;
  availability?: string;
  url?: string;
}

interface JsonLdProduct {
  '@type'?: string | string[];
  name?: string;
  sku?: string | number;
  gtin?: string;
  image?: string | JsonLdImage | Array<string | JsonLdImage>;
  description?: string;
  brand?: string | { name?: string };
  offers?: JsonLdOffer | JsonLdOffer[];
  aggregateRating?: { ratingValue?: string | number; reviewCount?: string | number };
}

function parsedUrl(value: string, base = location.href): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function isAllegroUrl(value: string): boolean {
  const url = parsedUrl(value);
  return Boolean(url && ALLEGRO_HOST.test(url.hostname));
}

function offerIdFromUrl(value: string, depth = 0): string {
  const url = parsedUrl(value);
  if (!url || !ALLEGRO_HOST.test(url.hostname) || depth > 2) return '';
  const direct = url.pathname.match(OFFER_PATH)?.[1];
  if (direct) return direct;
  const offerId = url.searchParams.get('offerId');
  if (offerId && /^\d+$/.test(offerId)) return offerId;
  const redirect = url.searchParams.get('redirect');
  return redirect ? offerIdFromUrl(redirect, depth + 1) : '';
}

/** 去除广告追踪参数；产品族链接和广告跳转链接统一落到可打开的 offer URL。 */
function cleanOfferUrl(value: string): string | null {
  const url = parsedUrl(value);
  if (!url || !ALLEGRO_HOST.test(url.hostname)) return null;
  const id = offerIdFromUrl(value);
  if (!id) return null;
  if (OFFER_PATH.test(url.pathname)) return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return `https://allegro.pl/oferta/${id}`;
}

function meta(name: string): string | undefined {
  return (
    document.querySelector(`meta[property="${name}"]`)?.getAttribute('content') ??
    document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ??
    undefined
  );
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function parseNumber(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const match = text.replace(/[\s\u00a0]/g, '').match(/[-+]?\d[\d.,]*/);
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

function allegroImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const url = parsedUrl(value.trim().startsWith('//') ? `https:${value.trim()}` : value.trim());
  if (!url || url.hostname !== 'a.allegroimg.com') return null;
  url.pathname = url.pathname.replace(/^\/s\d+\//i, '/original/');
  url.search = '';
  url.hash = '';
  return url.toString();
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
      /* 忽略无效或与商品无关的 JSON-LD。 */
    }
  }
  return null;
}

function htmlToText(html: string | undefined): string {
  if (!html) return '';
  const holder = document.createElement('div');
  holder.innerHTML = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>|<\/li>/gi, '\n');
  return (holder.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function detailAttributes(): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const row of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="parameters-two-column-table"] tr'))) {
    const cells = row.querySelectorAll<HTMLElement>('th, td');
    const key = cells[0]?.textContent?.replace(/\s+/g, ' ').trim();
    const value = cells[1]?.textContent?.replace(/\s+/g, ' ').trim();
    if (key && value) attributes[key] = value;
  }
  return attributes;
}

function attributeValue(attributes: Record<string, string>, names: string[]): string {
  for (const [key, value] of Object.entries(attributes)) {
    if (names.some((name) => key.localeCompare(name, undefined, { sensitivity: 'base' }) === 0)) return value;
  }
  return '';
}

function offerFrom(ld: JsonLdProduct | null): JsonLdOffer | undefined {
  return Array.isArray(ld?.offers) ? ld.offers[0] : ld?.offers;
}

function priceFromPage(ld: JsonLdProduct | null): Price | undefined {
  const offer = offerFrom(ld);
  const labelledPrice = Array.from(document.querySelectorAll<HTMLElement>('[aria-label]'))
    .find((element) => /aktualna cena|current price/i.test(element.getAttribute('aria-label') || ''))
    ?.getAttribute('aria-label');
  const value = parseNumber(String(offer?.price ?? '')) ?? parseNumber(labelledPrice);
  if (value == null) return undefined;
  return { value, currency: offer?.priceCurrency || 'PLN' };
}

function detailImages(ld: JsonLdProduct | null): string[] {
  const values = Array.isArray(ld?.image) ? ld.image : ld?.image ? [ld.image] : [];
  const ldImages = values.map((image) => allegroImageUrl(typeof image === 'string' ? image : image.url || image.contentUrl));
  return dedupe([...ldImages, allegroImageUrl(meta('og:image'))]);
}

function cleanSellerUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const url = parsedUrl(value);
  if (!url || !ALLEGRO_HOST.test(url.hostname)) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function cardParameters(card: HTMLElement): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const term of Array.from(card.querySelectorAll<HTMLElement>('dl dt'))) {
    const value = term.nextElementSibling?.textContent?.replace(/\s+/g, ' ').trim();
    const key = term.textContent?.replace(/\s+/g, ' ').trim();
    if (key && value) attributes[key] = value;
  }
  return attributes;
}

function productLink(card: HTMLElement): HTMLAnchorElement | null {
  const links = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'));
  return links.find((link) => Boolean(cleanOfferUrl(link.href)) && Boolean(link.closest('h2'))) ??
    links.find((link) => Boolean(cleanOfferUrl(link.href))) ?? null;
}

function findCards(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('article')).filter((card) => {
    const link = productLink(card);
    return Boolean(link && card.querySelector('h2') && card.querySelector('img'));
  });
}

function getCardUrl(card: HTMLElement): string | null {
  const link = productLink(card);
  return link ? cleanOfferUrl(link.href) : null;
}

function extractCard(card: HTMLElement): CollectedProduct | null {
  const sourceUrl = getCardUrl(card);
  if (!sourceUrl) return null;
  const link = productLink(card);
  const title = (card.querySelector('h2')?.textContent || link?.textContent || '').replace(/\s+/g, ' ').trim();
  if (!title) return null;

  const priceElement = Array.from(card.querySelectorAll<HTMLElement>('[aria-label]'))
    .find((element) => /aktualna cena|current price/i.test(element.getAttribute('aria-label') || ''));
  const priceText = priceElement?.getAttribute('aria-label') || priceElement?.textContent;
  const value = parseNumber(priceText);
  const imageValues = link
    ? Array.from(link.querySelectorAll<HTMLImageElement>('img')).map((image) => image.currentSrc || image.src)
    : [];
  const images = dedupe([...imageValues.map(allegroImageUrl), allegroImageUrl(card.querySelector('img')?.getAttribute('src'))]);
  return {
    source: 'allegro',
    sourceUrl,
    sourceProductId: offerIdFromUrl(sourceUrl),
    title,
    images,
    price: value == null ? undefined : { value, currency: 'PLN' },
    variants: [],
    attributes: cardParameters(card),
    store: { name: 'Allegro', url: 'https://allegro.pl/' },
    raw: { platform: 'allegro', parser: 'card' },
  };
}

async function waitForDetail(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < DETAIL_READY_TIMEOUT_MS) {
    if (document.querySelector('h1') && jsonLdProduct()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function extractDetail(): Promise<CollectedProduct | null> {
  await waitForDetail();
  const ld = jsonLdProduct();
  const canonical = cleanOfferUrl(location.href) || cleanOfferUrl(meta('og:url') || '') || location.href;
  const sourceProductId = String(ld?.sku || offerIdFromUrl(canonical));
  const title = String(ld?.name || document.querySelector('h1')?.textContent || meta('og:title') || '')
    .replace(/\s*[-|]\s*Allegro\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sourceProductId || !title) return null;

  const attributes = detailAttributes();
  const brand = typeof ld?.brand === 'string' ? ld.brand : ld?.brand?.name;
  if (brand && !attributeValue(attributes, ['Marka', 'Brand'])) attributes.Marka = brand;
  const color = attributeValue(attributes, ['Kolor', 'Color', 'Colour']);
  const size = attributeValue(attributes, ['Rozmiar', 'Size']);
  const images = detailImages(ld);
  const price = priceFromPage(ld);
  const offer = offerFrom(ld);
  const options: Record<string, string> = {};
  if (color) options.Color = color;
  if (size) options.Size = size;
  const variant: Variant = {
    sourceSkuId: sourceProductId,
    options,
    price: price?.value,
    image: images[0],
    ...(/OutOfStock/i.test(offer?.availability || '') ? { stock: 0 } : {}),
  };
  const sellerLink = document.querySelector<HTMLAnchorElement>('a[data-testid="seller-shop-link"]');
  const sellerName = sellerLink?.textContent?.replace(/\s+/g, ' ').trim() ||
    sellerLink?.getAttribute('data-analytics-interaction-value') ||
    sellerLink?.getAttribute('data-analytics-view-value') ||
    undefined;

  return {
    source: 'allegro',
    sourceUrl: canonical,
    sourceProductId,
    title,
    description: htmlToText(ld?.description) || meta('description'),
    images,
    videos: productVideosFromPage(ld),
    price,
    variants: [variant],
    attributes,
    store: {
      name: sellerName || 'Allegro',
      url: cleanSellerUrl(sellerLink?.href) || 'https://allegro.pl/',
    },
    raw: {
      platform: 'allegro',
      parser: 'json-ld+parameters-table+dom',
      gtin: ld?.gtin,
      availability: offer?.availability,
      rating: ld?.aggregateRating,
      variantCount: 1,
    },
  };
}

export const allegroExtractor: SourceExtractor = {
  id: 'allegro',
  matches: isAllegroUrl,
  isDetailPage: (url) => Boolean(parsedUrl(url)?.pathname.match(OFFER_PATH)),
  findCards,
  getCardUrl,
  extractCard,
  extractDetail,
};

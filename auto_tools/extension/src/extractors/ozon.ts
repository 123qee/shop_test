import type { CollectedProduct, Price, Variant } from '@shared/types';
import type { SourceExtractor } from './types.js';

const HOST = /(^|\.)ozon\.ru$/i;
const PRODUCT_PATH = /^\/product\/(?:[^/]*-)?(\d+)\/?$/i;
type RichText = Array<{ content?: string }>;
interface AspectVariant {
  sku?: string | number;
  active?: boolean;
  availability?: string;
  link?: string;
  data?: { searchableText?: string; textRs?: RichText; coverImage?: string };
}
interface Aspect {
  aspectKey?: string;
  aspectName?: string;
  variants?: AspectVariant[];
}
interface ProductLd {
  name?: string;
  sku?: string | number;
  description?: string;
  image?: string | Array<string | { url?: string }>;
  brand?: string | { name?: string };
  offers?: { price?: string | number; priceCurrency?: string; availability?: string };
}

function parsedUrl(value: string): URL | null {
  try { return new URL(value, 'https://www.ozon.ru'); } catch { return null; }
}

export function ozonProductId(value: string): string {
  const url = parsedUrl(value);
  return url && HOST.test(url.hostname) ? url.pathname.match(PRODUCT_PATH)?.[1] || '' : '';
}

export function cleanOzonProductUrl(value: string): string | null {
  const id = ozonProductId(value);
  return id ? `https://www.ozon.ru/product/${id}/` : null;
}

export function ozonImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const url = parsedUrl(value);
  if (!url || !/^https?:$/.test(url.protocol) || !/(^|\.)ozonstatic\.(?:ru|cn|com)$/i.test(url.hostname)) return null;
  // Only product media: exclude seller logos, payment icons, review photos and video covers.
  if (!/^\/s3\/multimedia[^/]*\//.test(url.pathname)) return null;
  url.pathname = url.pathname.replace(/\/(?:wc|c)\d+\//g, '/').replace(/\/(?:wc|c)\d+\//g, '/');
  url.search = '';
  url.hash = '';
  return url.href;
}

export function ozonNumber(value: string | number | undefined): number | undefined {
  if (value == null) return undefined;
  const raw = String(value).replace(/\s/g, '').match(/\d+(?:[.,]\d+)?/)?.[0];
  const number = raw ? Number(raw.replace(',', '.')) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

const text = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim();
const richText = (value?: RichText) => text(value?.map((part) => part.content || '').join(''));
const unique = (values: Array<string | null | undefined>) => [...new Set(values.filter((v): v is string => Boolean(v)))];
const meta = (name: string) => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content') || '';

function state<T>(widget: string): T | null {
  const element = document.querySelector(`[id^="state-${widget}-"][data-state]`);
  try { return JSON.parse(element?.getAttribute('data-state') || 'null') as T | null; } catch { return null; }
}

function jsonLd(): ProductLd | null {
  const visit = (value: unknown): ProductLd | null => {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) return value.map(visit).find(Boolean) || null;
    const record = value as Record<string, unknown>;
    const type = record['@type'];
    if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) return record as ProductLd;
    return visit(record['@graph']);
  };
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { const result = visit(JSON.parse(script.textContent || '')); if (result) return result; } catch { /* malformed JSON-LD */ }
  }
  return null;
}

function cardLink(card: HTMLElement): HTMLAnchorElement | undefined {
  return Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]')).find((a) => Boolean(ozonProductId(a.href)));
}

function findCards(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.tile-root')).filter((card) => Boolean(cardLink(card)));
}

function extractCard(card: HTMLElement): CollectedProduct | null {
  const sourceUrl = cleanOzonProductUrl(cardLink(card)?.href || '');
  const title = text(card.querySelector('a[href*="/product/"] .tsBody500Medium')?.textContent) ||
    text(Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href*="/product/"]')).find((a) => !a.querySelector('img') && text(a.textContent))?.textContent);
  if (!sourceUrl || !title) return null;
  const value = ozonNumber(card.querySelector('[class*="tsHeadline"]')?.textContent || undefined);
  return {
    source: 'ozon', sourceUrl, sourceProductId: ozonProductId(sourceUrl), title,
    images: unique(Array.from(card.querySelectorAll('img')).map((img) => ozonImageUrl(img.currentSrc || img.src))),
    price: value == null ? undefined : { value, currency: 'RUB' },
    variants: [], attributes: {}, raw: { parser: 'ozon-card', priceKind: 'displayed' },
  };
}

function detailAttributes(): Record<string, string> {
  const attributes: Record<string, string> = {};
  const short = state<{ characteristics?: Array<{ title?: { textRs?: RichText }; values?: Array<{ text?: string }> }> }>('webShortCharacteristics');
  for (const item of short?.characteristics || []) {
    const key = richText(item.title?.textRs);
    const value = text(item.values?.map((v) => v.text).join(', '));
    if (key && value) attributes[key] = value;
  }
  for (const term of document.querySelectorAll('[data-widget="webCharacteristics"] dt')) {
    const key = text(term.textContent).replace(/:$/, '');
    const value = text(term.nextElementSibling?.textContent);
    if (key && value) attributes[key] = value;
  }
  return attributes;
}

function optionKey(aspect: Aspect): string {
  if (/^(color|colour)$/i.test(aspect.aspectKey || '') || /цвет/i.test(aspect.aspectName || '')) return 'Color';
  if (/size/i.test(aspect.aspectKey || '') || /размер/i.test(aspect.aspectName || '')) return 'Size';
  return aspect.aspectName || aspect.aspectKey || 'Option';
}

function optionValue(variant: AspectVariant, key: string): string {
  const value = text(variant.data?.searchableText) || richText(variant.data?.textRs?.slice(0, 1));
  return key === 'Size' ? value.replace(/\s+RU\s*\/.*$/i, '') : value;
}

/** Each aspect contains real SKUs for one axis with the other selections fixed.
 * Keep the current color's sizes; never invent a color × size Cartesian product. */
export function ozonVariants(aspects: Aspect[], id: string, attributes: Record<string, string>, price?: Price, image?: string, unavailable = false): Variant[] {
  const options: Record<string, string> = {};
  if (attributes['Цвет']) options.Color = attributes['Цвет'];
  if (attributes['Российский размер'] || attributes['Размер производителя']) options.Size = attributes['Российский размер'] || attributes['Размер производителя'];
  for (const aspect of aspects) {
    const active = aspect.variants?.find((v) => v.active || String(v.sku) === id);
    const key = optionKey(aspect);
    const value = active && optionValue(active, key);
    if (value) options[key] = value;
  }
  const sizeAxis = aspects.find((a) => optionKey(a) === 'Size');
  const variants = new Map<string, Variant>();
  for (const item of sizeAxis?.variants || []) {
    const sku = String(item.sku || ozonProductId(item.link || ''));
    const size = optionValue(item, 'Size');
    if (!/^\d+$/.test(sku) || !size) continue;
    variants.set(sku, {
      sourceSkuId: sku, options: { ...options, Size: size },
      // Aspect prices are bank-card discounts; use only the verified regular offer price.
      price: sku === id ? price?.value : undefined,
      image: ozonImageUrl(item.data?.coverImage) || image,
      ...(/^(?:outOfStock|unavailable|notAvailable)$/i.test(item.availability || '') ? { stock: 0 } : {}),
    });
  }
  if (!variants.has(id)) variants.set(id, { sourceSkuId: id, options, price: price?.value, image });
  if (unavailable) variants.get(id)!.stock = 0;
  return [...variants.values()];
}

async function extractDetail(): Promise<CollectedProduct | null> {
  const sourceUrl = cleanOzonProductUrl(location.href);
  if (!sourceUrl) return null;
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    if (document.querySelector('h1') && (state('webGallery') || jsonLd())) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const ld = jsonLd();
  const id = ozonProductId(sourceUrl);
  const title = text(document.querySelector('h1')?.textContent) || text(ld?.name);
  if (!title) return null;
  const gallery = state<{ images?: Array<{ src?: string }>; coverImage?: string; isUnavailable?: boolean; videos?: Array<{ url?: string; coverUrl?: string }> }>('webGallery');
  const prices = state<{ price?: string; originalPrice?: string; cardPrice?: string; isAvailable?: boolean }>('webPrice');
  const aspects = state<{ aspects?: Aspect[] }>('webAspects')?.aspects || [];
  const attributes = detailAttributes();
  const brand = typeof ld?.brand === 'string' ? ld.brand : ld?.brand?.name;
  if (brand) attributes.Brand = brand;
  const ldImages = Array.isArray(ld?.image) ? ld.image.map((i) => typeof i === 'string' ? i : i.url) : [ld?.image];
  const images = unique([
    ozonImageUrl(gallery?.coverImage), ...(gallery?.images || []).map((i) => ozonImageUrl(i.src)),
    ...ldImages.map(ozonImageUrl),
    ...Array.from(document.querySelectorAll<HTMLImageElement>('[data-widget="webGallery"] img')).map((i) => ozonImageUrl(i.currentSrc || i.src)),
    ozonImageUrl(meta('og:image')),
  ]);
  const value = ozonNumber(prices?.price) ?? ozonNumber(ld?.offers?.price);
  const original = ozonNumber(prices?.originalPrice);
  const price: Price | undefined = value == null ? undefined : { value, currency: ld?.offers?.priceCurrency || 'RUB', ...(original != null && original > value ? { original } : {}) };
  const seller = state<{ sellerCell?: { centerBlock?: { title?: { text?: string } }; common?: { action?: { link?: string } } } }>('webCurrentSeller');
  const sellerLink = parsedUrl(seller?.sellerCell?.common?.action?.link || '');
  const unavailable = gallery?.isUnavailable === true || prices?.isAvailable === false || /OutOfStock/i.test(ld?.offers?.availability || '');
  return {
    source: 'ozon', sourceUrl, sourceProductId: id, title,
    description: text(ld?.description) || text(document.querySelector('[data-widget="webDescription"]')?.textContent) || undefined,
    images, price,
    videos: (gallery?.videos || []).filter((v) => v.url && /^https:\/\//.test(v.url)).map((v) => ({ url: v.url!, poster: v.coverUrl })),
    variants: ozonVariants(aspects, id, attributes, price, images[0], unavailable),
    attributes,
    store: { name: text(seller?.sellerCell?.centerBlock?.title?.text) || 'Ozon', url: sellerLink && HOST.test(sellerLink.hostname) && sellerLink.pathname.startsWith('/seller/') ? `${sellerLink.origin}${sellerLink.pathname}` : 'https://www.ozon.ru/' },
    raw: { parser: 'ozon-widget-state+json-ld+dom', priceKind: 'regular', bankCardPrice: ozonNumber(prices?.cardPrice), variantScope: 'current-color-sizes', colorUrls: unique(aspects.filter((a) => optionKey(a) === 'Color').flatMap((a) => (a.variants || []).map((v) => cleanOzonProductUrl(v.link || '')))) },
  };
}

export const ozonExtractor: SourceExtractor = {
  id: 'ozon',
  matches: (value) => { const url = parsedUrl(value); return Boolean(url && HOST.test(url.hostname)); },
  isDetailPage: (value) => Boolean(ozonProductId(value)),
  findCards,
  getCardUrl: (card) => cleanOzonProductUrl(cardLink(card)?.href || ''),
  extractCard,
  extractDetail,
};

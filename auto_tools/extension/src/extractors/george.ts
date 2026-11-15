import type { CollectedProduct, Price, Variant } from '@shared/types';
import type { SourceExtractor } from './types.js';
import { productVideosFromPage } from './media.js';

const ASDA_HOST = /(^|\.)asda\.com$/i;
const PRODUCT_PATH = /\/([^/]+),default,pd\.html$/i;
const DETAIL_READY_TIMEOUT_MS = 8_000;
const STORE_URL = 'https://direct.asda.com/george/';

interface JsonLdOffer {
  price?: string | number;
  lowPrice?: string | number;
  highPrice?: string | number;
  priceCurrency?: string;
  availability?: string;
}

interface JsonLdProduct {
  '@type'?: string | string[];
  name?: string;
  sku?: string;
  image?: string | string[];
  description?: string;
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

function isProductUrl(value: string): boolean {
  const url = parsedUrl(value);
  return Boolean(url && ASDA_HOST.test(url.hostname) && /\/george\//i.test(url.pathname) && PRODUCT_PATH.test(url.pathname));
}

function cleanProductUrl(value: string): string | null {
  const url = parsedUrl(value);
  if (!url || !isProductUrl(url.href)) return null;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function productIdFromUrl(value: string): string {
  const pathPart = parsedUrl(value)?.pathname.match(PRODUCT_PATH)?.[1] ?? '';
  return pathPart.replace(/-\d+$/i, '');
}

function absoluteUrl(value: string | null | undefined): string | null {
  const cleaned = value?.trim().replace(/&amp;/g, '&');
  if (!cleaned) return null;
  const url = parsedUrl(cleaned.startsWith('//') ? `https:${cleaned}` : cleaned);
  if (!url || !/^https?:$/.test(url.protocol) || /george_blank/i.test(url.pathname)) return null;
  return url.toString();
}

function isGeorgeImage(value: string): boolean {
  const url = parsedUrl(value);
  return Boolean(url && url.hostname === 'asda.scene7.com' && /\/is\/image\/Asda\//i.test(url.pathname) && !/george_blank/i.test(url.pathname));
}

/** George's gallery DOM exposes 142x192 thumbnails before the full product images. */
function highResolutionGeorgeImage(value: string): string {
  const url = parsedUrl(value);
  if (!url || !isGeorgeImage(value)) return value;
  url.searchParams.set('hei', '1024');
  url.searchParams.set('wid', '768');
  url.searchParams.set('qlt', '85');
  url.searchParams.set('fmt', 'pjpg');
  return url.toString();
}

/** Keep one high-resolution URL per George gallery asset, even if the page exposes several sizes/formats. */
function uniqueGeorgeImages(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const images: string[] = [];
  for (const value of dedupe(values).filter(isGeorgeImage).map(highResolutionGeorgeImage)) {
    const url = parsedUrl(value);
    const key = url ? `${url.hostname}${url.pathname}` : value;
    if (seen.has(key)) continue;
    seen.add(key);
    images.push(value);
  }
  return images;
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function parseNumber(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const match = text.replace(/\s/g, '').match(/\d[\d,.]*/);
  if (!match) return undefined;
  const raw = match[0];
  const dot = raw.lastIndexOf('.');
  const comma = raw.lastIndexOf(',');
  let normalized = raw;
  if (dot >= 0 && comma >= 0) {
    const decimal = dot > comma ? '.' : ',';
    normalized = raw.split(decimal === '.' ? ',' : '.').join('').replace(decimal, '.');
  } else if (comma >= 0) {
    normalized = /,\d{1,2}$/.test(raw) ? raw.replace(',', '.') : raw.replace(/,/g, '');
  } else if (dot >= 0 && !/\.\d{1,2}$/.test(raw)) {
    normalized = raw.replace(/\./g, '');
  }
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function meta(name: string): string | undefined {
  return (
    document.querySelector<HTMLMetaElement>(`meta[property="${name}"]`)?.content ||
    document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ||
    undefined
  );
}

function visitProduct(value: unknown): JsonLdProduct | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const product = visitProduct(item);
      if (product) return product;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const type = record['@type'];
  if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) return record as JsonLdProduct;
  return visitProduct(record['@graph']);
}

function jsonLdProduct(): JsonLdProduct | null {
  for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'))) {
    try {
      const product = visitProduct(JSON.parse(script.textContent || ''));
      if (product) return product;
    } catch {
      // George pages may contain unrelated or malformed JSON-LD blocks.
    }
  }
  return null;
}

function offerList(product: JsonLdProduct | null): JsonLdOffer[] {
  const offers = product?.offers;
  return Array.isArray(offers) ? offers : offers ? [offers] : [];
}

function pagePrice(product: JsonLdProduct | null): Price | undefined {
  const mainText = document.querySelector('main')?.textContent || '';
  const visiblePrice = mainText.match(/£\s*[\d,.]+|[\d,.]+\s*GBP/i)?.[0];
  const visibleValue = parseNumber(visiblePrice);
  if (visibleValue != null) return { value: visibleValue, currency: 'GBP' };

  const offer = offerList(product)[0];
  const value = parseNumber(String(offer?.lowPrice ?? offer?.price ?? ''));
  if (value == null) return undefined;
  return { value, currency: String(offer?.priceCurrency || 'GBP') };
}

function pageImages(product: JsonLdProduct | null, title: string): string[] {
  const ldImages = Array.isArray(product?.image) ? product.image : product?.image ? [product.image] : [];
  const galleryImages = Array.from(document.querySelectorAll<HTMLImageElement>('main img'))
    .filter((image) => !image.alt || image.alt.toLowerCase().includes(title.toLowerCase()))
    .map((image) => absoluteUrl(image.currentSrc || image.src || image.getAttribute('data-src')));
  return uniqueGeorgeImages([...galleryImages, ...ldImages.map((value) => absoluteUrl(value)), absoluteUrl(meta('og:image'))]);
}

function attributeOptions(): Array<{ key: string; label: string; value: string; available: boolean }> {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('main button[data-id^="button-attribute-selector-"]'))
    .map((button) => {
      const id = button.getAttribute('data-id') || '';
      const key = id.replace(/^button-attribute-selector-/i, '').trim();
      const ariaLabel = button.getAttribute('aria-label') || '';
      const value =
        ariaLabel.replace(/^(?:size|colour|color)\s*-\s*/i, '').trim() ||
        button.querySelector<HTMLElement>('[data-id="attribute-selector-value"]')?.textContent?.trim() ||
        button.textContent?.trim() || '';
      if (!key || !value) return null;
      return {
        key,
        label: /^(?:colour|color)$/i.test(key) ? 'Color' : key.charAt(0).toUpperCase() + key.slice(1),
        value,
        available: button.getAttribute('aria-disabled') !== 'true' && !button.disabled && !button.classList.contains('unavailable'),
      };
    })
    .filter((option): option is { key: string; label: string; value: string; available: boolean } => Boolean(option));
}

function makeVariants(productId: string, price: Price | undefined, images: string[]): Variant[] {
  const groups = new Map<string, Array<{ label: string; value: string; available: boolean }>>();
  for (const option of attributeOptions()) {
    const group = groups.get(option.key) ?? [];
    if (!group.some((item) => item.value === option.value)) group.push(option);
    groups.set(option.key, group);
  }

  let combinations: Array<{ options: Record<string, string>; available: boolean }> = [{ options: {}, available: true }];
  for (const options of groups.values()) {
    combinations = combinations.flatMap((combination) => options.map((option) => ({
      options: { ...combination.options, [option.label]: option.value },
      available: combination.available && option.available,
    })));
  }
  if (!combinations.length) combinations = [{ options: {}, available: true }];

  return combinations.map((combination, index) => ({
    sourceSkuId: combinations.length === 1 ? productId : `${productId}-${index + 1}`,
    options: combination.options,
    price: price?.value,
    image: images[0],
    ...(!combination.available ? { stock: 0 } : {}),
  }));
}

function findCards(root: ParentNode = document): HTMLElement[] {
  // George may hold both listing and detail content behind a delivery-region prompt.
  chooseUkDeliveryRegion();
  const cards = new Set<HTMLElement>();
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/george/"][href*=",pd.html"]'))) {
    if (!cleanProductUrl(link.href)) continue;
    const card = link.closest<HTMLElement>('.product-mini, [data-testid="productCard"], article, li');
    if (card?.querySelector('img')) cards.add(card);
  }
  const list = Array.from(cards);
  return list.filter((card) => !list.some((other) => other !== card && card.contains(other)));
}

function getCardUrl(card: HTMLElement): string | null {
  const link = card.matches('a[href*="/george/"][href*=",pd.html"]')
    ? card as HTMLAnchorElement
    : card.querySelector<HTMLAnchorElement>('a[href*="/george/"][href*=",pd.html"]');
  return link ? cleanProductUrl(link.href) : null;
}

function extractCard(card: HTMLElement): CollectedProduct | null {
  const sourceUrl = getCardUrl(card);
  if (!sourceUrl) return null;
  const link = card.querySelector<HTMLAnchorElement>('a[href*="/george/"][href*=",pd.html"]');
  const image = card.querySelector<HTMLImageElement>('img.primary-image, img[alt]');
  const title = (
    link?.getAttribute('title') ||
    image?.alt ||
    link?.textContent ||
    ''
  ).trim();
  if (!title) return null;

  const priceText = card.querySelector<HTMLElement>('.price__wrapper')?.textContent || card.textContent || '';
  const value = parseNumber(priceText);
  const images = uniqueGeorgeImages([
    absoluteUrl(image?.currentSrc || image?.src || image?.getAttribute('data-src')),
    ...Array.from(card.querySelectorAll<HTMLSourceElement>('picture source')).map((source) => absoluteUrl(source.srcset.split(',')[0]?.trim().split(/\s+/)[0])),
  ]);
  return {
    source: 'george',
    sourceUrl,
    sourceProductId: productIdFromUrl(sourceUrl),
    title,
    images,
    ...(value != null ? { price: { value, currency: 'GBP' } } : {}),
    variants: [],
    attributes: { Brand: 'George' },
    store: { name: 'George at ASDA', url: STORE_URL },
    raw: { platform: 'george', parser: 'product-card' },
  };
}

function hasDetailData(): boolean {
  const product = jsonLdProduct();
  const title = document.querySelector('main h1')?.textContent?.trim() || product?.name;
  return Boolean(title && (product || document.querySelector('main img')));
}

async function waitForDetailData(): Promise<void> {
  const deadline = Date.now() + DETAIL_READY_TIMEOUT_MS;
  while (!hasDetailData() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function chooseUkDeliveryRegion(): void {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((item) => /shop the uk george range/i.test(`${item.textContent || ''} ${item.getAttribute('aria-label') || ''}`));
  button?.click();
}

async function extractDetail(): Promise<CollectedProduct | null> {
  chooseUkDeliveryRegion();
  await waitForDetailData();
  const url = cleanProductUrl(location.href);
  if (!url) return null;
  const product = jsonLdProduct();
  const title = (
    document.querySelector<HTMLElement>('main h1')?.textContent?.trim() ||
    product?.name ||
    meta('og:title') ||
    document.title
  ).trim();
  if (!title) return null;

  // ASDA can return an offline or anti-bot page at a valid product URL.
  // Do not let its document title and empty gallery enter the product library.
  if (/^(?:attention required\s*!?\s*\|\s*asda|george\s*-\s*offline page)$/i.test(title)) {
    throw new Error('ASDA 返回了验证/离线页面，请稍后重试');
  }

  const sourceProductId = product?.sku?.trim() || productIdFromUrl(url);
  const images = pageImages(product, title);
  if (!images.length) {
    throw new Error('未提取到商品图片，请等待页面图片加载后重试');
  }
  const description =
    document.querySelector<HTMLElement>('main [data-id*="description" i], main [class*="description" i]')?.textContent?.trim() ||
    product?.description?.replace(/&amp;/g, '&').replace(/&#x27;/gi, "'").trim() ||
    meta('og:description')?.trim();
  const price = pagePrice(product);
  const attributes: Record<string, string> = { Brand: typeof product?.brand === 'string' ? product.brand : product?.brand?.name || 'George' };
  const breadcrumbs = Array.from(document.querySelectorAll<HTMLElement>('main nav[aria-label*="Breadcrumb" i] button'))
    .map((item) => item.textContent?.trim())
    .filter((value): value is string => Boolean(value));
  if (breadcrumbs.length) attributes.Category = breadcrumbs.join(' > ');
  const variants = makeVariants(sourceProductId, price, images);

  return {
    source: 'george',
    sourceUrl: url,
    sourceProductId,
    title,
    ...(description ? { description } : {}),
    images,
    videos: productVideosFromPage(product),
    ...(price ? { price } : {}),
    variants,
    attributes,
    store: { name: 'George at ASDA', url: STORE_URL },
    raw: { platform: 'george', parser: 'json-ld+dom', variantCount: variants.length },
  };
}

export const georgeExtractor: SourceExtractor = {
  id: 'george',
  matches: (url) => {
    try {
      const parsed = new URL(url);
      return ASDA_HOST.test(parsed.hostname) && /\/george(?:\/|$)/i.test(parsed.pathname);
    } catch {
      return false;
    }
  },
  isDetailPage: (url) => isProductUrl(url),
  findCards,
  getCardUrl,
  extractCard,
  extractDetail,
};

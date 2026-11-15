import type { CollectedProduct, Price, Variant } from '@shared/types';
import type { SourceExtractor } from './types.js';
import { productVideosFromPage } from './media.js';

const ML_HOST = /(^|\.)mercadolibre\.cl$/i;
const PRODUCT_ID_RE = /(?:\/MLC[-_](\d+)|\/up\/MLCU?(\d+)|\/p\/MLC[-_]?(\d+))/i;
const PRODUCT_LINK_RE = /(?:\/MLC[-_]?\d+|\/up\/MLCU?\d+|\/p\/MLC[-_]?\d+)/i;

function absUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.trim(), location.href).toString();
  } catch {
    return null;
  }
}

function productIdFromUrl(url: string): string {
  try {
    const parsed = new URL(url, location.href);
    const wid = parsed.searchParams.get('wid')?.match(/MLC[-_]?(\d+)/i)?.[1];
    if (wid) return wid;
    const path = parsed.pathname.match(PRODUCT_ID_RE);
    return path?.[1] || path?.[2] || path?.[3] || '';
  } catch {
    return '';
  }
}

function parseNumber(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const match = text.replace(/\s/g, '').match(/\d[\d.,]*/);
  if (!match) return undefined;
  const cleaned = match[0];
  // Mercado Libre Chile displays CLP as $10.333. Keep dots/commas as
  // thousands separators unless there is a clear decimal suffix.
  const normalized = /[.,]\d{1,2}$/.test(cleaned) && !/^\d{1,3}(?:[.]\d{3})+$/.test(cleaned)
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(/[.,]/g, '');
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function meta(name: string, doc: Document = document): string | undefined {
  return (
    doc.querySelector(`meta[property="${name}"]`)?.getAttribute('content') ??
    doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ??
    undefined
  );
}

function jsonLdProduct(doc: Document = document): any | null {
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const parsed = JSON.parse(script.textContent || '');
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const flattened = items.flatMap((item) => Array.isArray(item?.['@graph']) ? item['@graph'] : [item]);
      const product = flattened.find((item) => {
        const type = item?.['@type'];
        return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
      });
      if (product) return product;
    } catch {
      /* Ignore unrelated or incomplete JSON-LD blocks. */
    }
  }
  return null;
}

function bestImageUrl(img: HTMLImageElement): string | null {
  const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
  if (srcset) {
    const candidates = srcset
      .split(',')
      .map((part) => {
        const bits = part.trim().split(/\s+/);
        return { url: bits[0], width: Number.parseInt(bits[1] || '0', 10) || 0 };
      })
      .filter((item) => item.url)
      .sort((a, b) => b.width - a.width);
    const selected = absUrl(candidates[0]?.url);
    if (selected) return selected;
  }
  return absUrl(img.currentSrc || img.getAttribute('data-src') || img.getAttribute('src'));
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function isProductImage(url: string): boolean {
  const lower = url.toLowerCase();
  // Mercado Libre serves page chrome and specification icons from the same
  // CDN as product photos. Only keep the gallery/photo families here.
  if (lower.includes('/storage/') || lower.includes('/frontend-assets/')) return false;
  return /mlstatic\.com\/d_(?:nq|q)_np_/i.test(lower);
}

function priceFromText(text: string | null | undefined): Price | undefined {
  const value = parseNumber(text);
  return value == null ? undefined : { value, currency: 'CLP' };
}

function detailPrice(ld: any, doc: Document = document): Price | undefined {
  const current =
    doc.querySelector('.ui-pdp-price__second-line [aria-label]')?.getAttribute('aria-label') ||
    doc.querySelector('.ui-pdp-price__second-line .andes-money-amount__fraction')?.textContent ||
    doc.querySelector('[itemprop="price"]')?.getAttribute('content');
  const visible = priceFromText(current);
  if (visible) {
    const originalText = doc.querySelector('.ui-pdp-price__original-value [aria-label]')?.getAttribute('aria-label');
    const original = parseNumber(originalText);
    return { ...visible, ...(original != null && original > visible.value ? { original } : {}) };
  }
  const offer = Array.isArray(ld?.offers) ? ld.offers[0] : ld?.offers;
  const value = parseNumber(String(offer?.price ?? ''));
  return value == null ? undefined : { value, currency: String(offer?.priceCurrency || 'CLP') };
}

function detailImages(ld: any, doc: Document = document): string[] {
  const ldImages = Array.isArray(ld?.image) ? ld.image : typeof ld?.image === 'string' ? [ld.image] : [];
  const gallery = doc.querySelector<HTMLElement>('.ui-pdp-gallery, .ui-pdp-gallery__column, [data-testid="gallery"]');
  const galleryImages = gallery
    ? Array.from(gallery.querySelectorAll<HTMLImageElement>('img'))
    : Array.from(doc.querySelectorAll<HTMLImageElement>('.ui-pdp-gallery__figure img, .ui-pdp-gallery__thumbnail img'));
  return dedupe([
    ...ldImages.map((value: unknown) => absUrl(String(value))),
    ...galleryImages.map(bestImageUrl),
    meta('og:image', doc),
  ]).filter(isProductImage);
}

function detailDescription(ld: any, doc: Document = document): string | undefined {
  const dom = doc.querySelector('.ui-pdp-description__content, [data-testid="description"]')?.textContent?.trim();
  return dom || String(ld?.description || meta('og:description', doc) || meta('description', doc) || '').trim() || undefined;
}

interface MercadoPickerOption {
  value: string;
  attributeId?: string;
  href?: string;
}

interface MercadoPicker {
  id: string;
  label: string;
  selected?: string;
  options: MercadoPickerOption[];
}

interface MercadoPageData {
  pickers: MercadoPicker[];
  images: string[];
}

function parsePageState(doc: Document): any | null {
  const script = Array.from(doc.scripts).find((item) => {
    const text = item.textContent || '';
    return text.includes('_n.ctx.r=') && text.includes('"initialState"');
  });
  const text = script?.textContent || '';
  const marker = '_n.ctx.r=';
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const jsonStart = start + marker.length;
  const jsonEnd = text.indexOf('};_n.ctx.r', jsonStart);
  if (jsonEnd < 0) return null;
  try {
    return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch {
    return null;
  }
}

function stateComponent(root: any, id: string): any | null {
  const direct = root?.components?.[id];
  if (direct) return direct;
  for (const value of Object.values(root?.components ?? {})) {
    if (Array.isArray(value)) {
      const found = value.find((item: any) => item?.id === id);
      if (found) return found;
    } else if ((value as any)?.id === id) {
      return value;
    }
  }
  return null;
}

function pictureUrl(picture: any): string | null {
  if (!picture?.id || !picture?.sanitized_title) return null;
  return absUrl(`https://http2.mlstatic.com/D_NQ_NP_2X_${picture.id}-F${picture.sanitized_title}.webp`);
}

function domPickers(doc: Document): MercadoPicker[] {
  const root = doc.querySelector<HTMLElement>('#outside_variations, .ui-pdp-container__row--outside-variations');
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(':scope > .ui-pdp-outside_variations > .ui-pdp-outside_variations__picker'))
    .map((picker) => {
      const label = picker.querySelector('.ui-pdp-outside_variations__title__label')?.textContent?.trim() || '';
      const selected = picker.querySelector('.ui-pdp-outside_variations__title__value')?.textContent?.trim() || undefined;
      const options = Array.from(picker.querySelectorAll<HTMLAnchorElement>('[data-testid="thumbnail-item"], .ui-pdp-outside_variations__thumbnails__item'))
        .map((item) => ({
          value: item.querySelector('span')?.textContent?.trim() || item.textContent?.trim() || '',
          href: absUrl(item.getAttribute('href')) || undefined,
        }))
        .filter((item) => item.value);
      return { id: '', label, selected, options };
    })
    .filter((picker) => picker.label || picker.options.length);
}

function pageData(doc: Document, ld: any): MercadoPageData {
  const state = parsePageState(doc);
  const root = state?.appProps?.pageProps?.initialState;
  const variationState = stateComponent(root, 'outside_variations');
  const galleryState = stateComponent(root, 'gallery');
  const dom = domPickers(doc);
  const pickers: MercadoPicker[] = Array.isArray(variationState?.pickers)
    ? variationState.pickers.map((picker: any, index: number) => {
        const domPicker = dom[index];
        const options = Array.isArray(picker.products)
          ? picker.products
              .map((option: any, optionIndex: number) => ({
                value: String(option?.label?.text || option?.option_label?.text || '').trim(),
                attributeId: option?.attribute_id ? String(option.attribute_id) : undefined,
                href: domPicker?.options[optionIndex]?.href,
              }))
              .filter((option: MercadoPickerOption) => option.value)
          : domPicker?.options ?? [];
        return {
          id: String(picker?.id || ''),
          label: String(picker?.label?.text || domPicker?.label || '').trim(),
          selected: String(picker?.selected_option?.text || domPicker?.selected || '').trim() || undefined,
          options,
        };
      })
    : dom;
  const stateImages = Array.isArray(galleryState?.pictures)
    ? galleryState.pictures.map(pictureUrl).filter((value: string | null): value is string => Boolean(value))
    : [];
  return { pickers, images: dedupe([...stateImages, ...detailImages(ld, doc)]) };
}

function selectedOptions(doc: Document = document): Record<string, string> {
  const options: Record<string, string> = {};
  const root = doc.querySelector<HTMLElement>('main, .ui-pdp-container') || doc;
  for (const select of Array.from(root.querySelectorAll<HTMLSelectElement>('select'))) {
    const value = select.selectedOptions[0]?.textContent?.trim() || select.value.trim();
    if (!value) continue;
    const name = select.getAttribute('aria-label') || select.name || select.closest('label')?.textContent?.trim();
    if (name) options[name.replace(/[:：].*$/, '').trim()] = value;
  }
  return options;
}

function isColorPicker(picker: MercadoPicker): boolean {
  return /color|colour|颜色|色/i.test(`${picker.id} ${picker.label}`);
}

function chooseSizePicker(pickers: MercadoPicker[], colorPicker?: MercadoPicker): MercadoPicker | undefined {
  const candidates = pickers.filter((picker) => picker !== colorPicker && picker.options.length > 1);
  return candidates.find((picker) => /size|talla|尺码|尺寸|age|edad|year|años|fabric|design|diseño/i.test(`${picker.id} ${picker.label}`))
    || candidates.sort((a, b) => b.options.length - a.options.length)[0];
}

async function fetchColorImages(option: MercadoPickerOption): Promise<string[]> {
  if (!option.href) return [];
  try {
    const response = await fetch(option.href, { credentials: 'include' });
    if (!response.ok) return [];
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ld = jsonLdProduct(doc);
    return pageData(doc, ld).images;
  } catch {
    return [];
  }
}

async function makeDetailVariants(
  productId: string,
  price: Price | undefined,
  images: string[],
  ld: any,
): Promise<{ variants: Variant[]; images: string[] }> {
  const data = pageData(document, ld);
  const colorPicker = data.pickers.find((picker) => isColorPicker(picker) && picker.options.length);
  const sizePicker = chooseSizePicker(data.pickers, colorPicker);
  if (!colorPicker && !sizePicker) {
    return {
      variants: [{
        sourceSkuId: productId || 'product',
        options: selectedOptions(),
        ...(price ? { price: price.value } : {}),
        ...(images[0] ? { image: images[0] } : {}),
      }],
      images,
    };
  }

  const colorOptions = colorPicker?.options.length ? colorPicker.options : [{ value: colorPicker?.selected || '' }];
  const sizeOptions = sizePicker?.options.length ? sizePicker.options : [{ value: sizePicker?.selected || '' }];
  const currentColor = colorPicker?.selected || colorOptions[0]?.value || '';
  const colorImages = new Map<string, string[]>();
  if (currentColor) colorImages.set(currentColor, images);
  if (colorPicker && colorOptions.length > 1) {
    const fetched = await Promise.all(colorOptions.map(async (option) => ({
      value: option.value,
      images: option.value === currentColor ? images : await fetchColorImages(option),
    })));
    for (const item of fetched) {
      if (item.images.length) colorImages.set(item.value, item.images);
    }
  }

  const extraOptions = data.pickers
    .filter((picker) => picker !== colorPicker && picker !== sizePicker)
    .reduce<Record<string, string>>((result, picker) => {
      const value = picker.selected?.trim();
      if (value && !/elige|choose|selecciona/i.test(value)) result[picker.label.replace(/[:：].*$/, '').trim() || picker.id] = value;
      return result;
    }, {});
  const variants: Variant[] = [];
  for (const [colorIndex, color] of colorOptions.entries()) {
    const colorName = color.value.trim();
    const colorGallery = colorImages.get(colorName) ?? (images[colorIndex] ? [images[colorIndex]] : images[0] ? [images[0]] : []);
    for (const size of sizeOptions) {
      const options: Record<string, string> = { ...extraOptions };
      if (colorName) options.Color = colorName;
      if (size.value.trim()) options.Size = size.value.trim();
      variants.push({
        sourceSkuId: `${productId || 'product'}-${variants.length + 1}`,
        options,
        ...(price ? { price: price.value } : {}),
        ...(colorGallery[0] ? { image: colorGallery[0] } : {}),
      });
    }
  }
  return { variants, images: dedupe([...images, ...Array.from(colorImages.values()).flat()]).slice(0, 20) };
}

function productLink(card: HTMLElement): HTMLAnchorElement | null {
  const selector = 'a[href*="/MLC-"], a[href*="/MLC_"], a[href*="/up/MLCU"], a[href*="/p/MLC"]';
  if (card.matches('a.poly-component__title')) return card as HTMLAnchorElement;
  return card.querySelector<HTMLAnchorElement>('a.poly-component__title') || card.querySelector<HTMLAnchorElement>(selector);
}

function cardRoot(anchor: HTMLAnchorElement): HTMLElement {
  return anchor.closest<HTMLElement>('.poly-card, li.ui-search-layout__item, .ui-search-result, article') || anchor;
}

function findCards(root: ParentNode = document): HTMLElement[] {
  const cards = new Set<HTMLElement>();
  const selector = 'a.poly-component__title, a[href*="/MLC-"], a[href*="/MLC_"], a[href*="/up/MLCU"], a[href*="/p/MLC"]';
  for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>(selector))) {
    if (!PRODUCT_LINK_RE.test(anchor.href)) continue;
    const card = cardRoot(anchor);
    if (card.querySelector('img')) cards.add(card);
  }
  return Array.from(cards);
}

function getCardUrl(card: HTMLElement): string | null {
  return productLink(card)?.href || null;
}

function extractCard(card: HTMLElement): CollectedProduct | null {
  const link = productLink(card);
  const href = link ? absUrl(link.href) : null;
  if (!href) return null;
  const image = card.querySelector<HTMLImageElement>('img[data-testid="picture"], img.poly-component__picture, img');
  const title = (
    link?.textContent?.trim() ||
    link?.getAttribute('title')?.trim() ||
    image?.getAttribute('alt')?.trim() ||
    ''
  ).trim();
  if (!title) return null;
  const currentPrice = card.querySelector('.poly-price__current [aria-label], .poly-price__current .andes-money-amount__fraction')?.textContent ||
    card.querySelector('.poly-price__current [aria-label]')?.getAttribute('aria-label') ||
    '';
  const price = priceFromText(currentPrice);
  const originalText = card.querySelector('.andes-money-amount--previous [aria-label]')?.getAttribute('aria-label');
  if (price && originalText) {
    const original = parseNumber(originalText);
    if (original != null && original > price.value) price.original = original;
  }
  const imageUrl = image ? bestImageUrl(image) : null;
  return {
    source: 'mercadolibre',
    sourceUrl: href,
    sourceProductId: productIdFromUrl(href),
    title,
    images: imageUrl ? [imageUrl] : [],
    price,
    variants: [],
    attributes: {},
    raw: { platform: 'mercadolibre', from: 'poly-card' },
  };
}

async function extractDetail(): Promise<CollectedProduct | null> {
  const url = location.href;
  const ld = jsonLdProduct();
  const title = (
    document.querySelector('.ui-pdp-title, h1')?.textContent?.trim() ||
    String(ld?.name || meta('og:title') || document.title).trim()
  ).trim();
  if (!title) return null;
  const baseImages = detailImages(ld);
  const price = detailPrice(ld);
  const description = detailDescription(ld);
  const variantData = await makeDetailVariants(productIdFromUrl(url), price, baseImages, ld);
  const { variants, images } = variantData;
  const storeLink = document.querySelector<HTMLAnchorElement>('.ui-pdp-seller__link, a[href*="/perfil/"]');
  return {
    source: 'mercadolibre',
    sourceUrl: url,
    sourceProductId: productIdFromUrl(url),
    title,
    description,
    images,
    videos: productVideosFromPage(ld),
    price,
    variants,
    attributes: {},
    ...(storeLink?.textContent?.trim() ? { store: { name: storeLink.textContent.trim(), url: storeLink.href } } : {}),
    raw: { platform: 'mercadolibre', parser: 'json-ld+dom', variantCount: variants.length },
  };
}

export const mercadolibreExtractor: SourceExtractor = {
  id: 'mercadolibre',
  matches: (url) => {
    try {
      return ML_HOST.test(new URL(url).hostname);
    } catch {
      return false;
    }
  },
  isDetailPage: (url) => PRODUCT_ID_RE.test(new URL(url).pathname),
  findCards,
  getCardUrl,
  extractCard,
  extractDetail,
};

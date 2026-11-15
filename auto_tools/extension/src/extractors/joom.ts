import type { CollectedProduct, Price, Variant } from '@shared/types';
import type { SourceExtractor } from './types.js';
import { productVideosFromPage } from './media.js';

const JOOM_HOST = /(^|\.)joom\.com$/i;
const PRODUCT_PATH = /\/products\/([^/?#]+)/i;
const DETAIL_READY_TIMEOUT_MS = 10_000;

function absUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const valueTrimmed = value.trim();
  if (!valueTrimmed) return null;
  try {
    return new URL(valueTrimmed, location.href).toString();
  } catch {
    return null;
  }
}

function productIdFromUrl(url: string): string {
  return new URL(url, location.href).pathname.match(PRODUCT_PATH)?.[1] ?? '';
}

function parseNumber(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const match = text.match(/[-+]?\d[\d\s.,]*/);
  if (!match) return undefined;
  const cleaned = match[0].replace(/\s/g, '');
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  let normalized = cleaned;
  if (lastDot !== -1 && lastComma !== -1) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousand = decimal === '.' ? ',' : '.';
    normalized = cleaned.split(thousand).join('').replace(decimal, '.');
  } else if (lastComma !== -1) {
    normalized = /,\d{1,2}$/.test(cleaned) ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  }
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function currencyFromText(text: string): string {
  if (/€/.test(text)) return 'EUR';
  if (/£/.test(text)) return 'GBP';
  if (/[¥￥]/.test(text)) return 'CNY';
  if (/₽/.test(text)) return 'RUB';
  return 'USD';
}

function meta(name: string): string | undefined {
  return (
    document.querySelector(`meta[property="${name}"]`)?.getAttribute('content') ??
    document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ??
    undefined
  );
}

function jsonLdProduct(): any | null {
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const parsed = JSON.parse(script.textContent || '');
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const product = items.find((item) => {
        const type = item?.['@type'];
        return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
      });
      if (product) return product;
    } catch {
      /* 页面上可能有其他非 JSON-LD 脚本,忽略 */
    }
  }
  return null;
}

function bestImageUrl(img: HTMLImageElement): string | null {
  const srcset = img.getAttribute('srcset');
  if (srcset) {
    const candidates = srcset
      .split(',')
      .map((part) => {
        const bits = part.trim().split(/\s+/);
        return { url: bits[0], width: Number.parseInt(bits[1] || '0', 10) || 0 };
      })
      .filter((item) => item.url);
    candidates.sort((a, b) => b.width - a.width);
    const url = absUrl(candidates[0]?.url);
    if (url) return url;
  }
  return absUrl(img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src'));
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function priceFromPage(ld: any): Price | undefined {
  // 详情页的当前价位于主内容最前面的价格块,优先于 JSON-LD 中可能存在的原价。
  const mainText = document.querySelector('main')?.textContent || '';
  const visibleMatch = mainText.match(/(?:[$€£¥₽]\s*[\d.,]+|[\d.,]+\s*(?:USD|EUR|GBP|CNY|RUB))/i);
  const visibleValue = parseNumber(visibleMatch?.[0]);
  if (visibleValue != null) {
    return { value: visibleValue, currency: currencyFromText(visibleMatch![0]) };
  }
  const offer = Array.isArray(ld?.offers) ? ld.offers[0] : ld?.offers;
  const ldValue = parseNumber(String(offer?.price ?? ''));
  if (ldValue != null) return { value: ldValue, currency: String(offer?.priceCurrency || 'USD') };
  const metaValue = parseNumber(meta('product:price:amount'));
  return metaValue != null
    ? { value: metaValue, currency: meta('product:price:currency') || 'USD' }
    : undefined;
}

function descriptionFromPage(ld: any): string {
  const paragraphs = Array.from(document.querySelectorAll('[data-testid="DescriptionOnProductPage"]'))
    .map((el) => (el.textContent || '').trim())
    .filter(Boolean);
  return paragraphs.join('\n\n') || String(ld?.description || '').trim();
}

function descriptionAttributes(description: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const line of description.split(/\r?\n/)) {
    const match = line.trim().match(/^([^:：]{1,80})\s*[:：]\s*(.+)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (key && value && !/^note$/i.test(key)) attributes[key] = value;
  }
  return attributes;
}

function optionValues(name: string): Array<{ value: string; image?: string }> {
  return Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`))
    .map((input) => {
      const parts = input.value.split(',');
      const value = parts[0].trim();
      const hash = parts[1]?.trim();
      const optionImage = input.closest('label')?.querySelector<HTMLImageElement>('img');
      const image = hash
        ? `https://img.joomcdn.net/${hash}_original.jpeg`
        : optionImage
          ? bestImageUrl(optionImage) ?? undefined
          : undefined;
      return {
        value,
        ...(image ? { image } : {}),
      };
    })
    .filter((item) => item.value);
}

function makeVariants(
  productId: string,
  price: number | undefined,
  colors: Array<{ value: string; image?: string }>,
  fallbackImage?: string,
): Variant[] {
  const sizes = optionValues('clothingSize');
  const variants: Variant[] = [];
  const colorValues = colors.length ? colors : [{ value: '' }];
  const sizeValues = sizes.length ? sizes : [{ value: '' }];
  const singleStyle = colorValues.length === 1;
  for (const color of colorValues) {
    for (const size of sizeValues) {
      const options: Record<string, string> = {};
      if (color.value) options.Color = color.value;
      if (size.value) options.Size = size.value;
      variants.push({
        sourceSkuId: `${productId}-${variants.length + 1}`,
        options,
        price,
        image: color.image ?? (singleStyle ? fallbackImage : undefined),
      });
    }
  }
  return variants;
}

function hasDetailData(): boolean {
  const ld = jsonLdProduct();
  const title = document.querySelector('main h1')?.textContent?.trim() || ld?.name;
  if (!title) return false;
  // Joom 的 React 页面可能先输出标题,再异步挂载图片/描述/规格。
  return Boolean(
    document.querySelector('main [aria-label="Product photo carousel"] img') ||
      document.querySelector('[data-testid="DescriptionOnProductPage"]') ||
      document.querySelector('main [class*="price" i]') ||
      document.querySelector('input[type="radio"]'),
  );
}

async function waitForDetailData(): Promise<void> {
  const deadline = Date.now() + DETAIL_READY_TIMEOUT_MS;
  while (!hasDetailData() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function extractDetail(): Promise<CollectedProduct | null> {
  await waitForDetailData();
  const url = location.href;
  const productId = productIdFromUrl(url);
  const ld = jsonLdProduct();
  const heading = document.querySelector('main h1')?.textContent?.trim();
  const title = String(heading || ld?.name || meta('og:title') || document.title).trim();
  if (!title) return Promise.resolve(null);

  const ldImages: string[] = Array.isArray(ld?.image) ? ld.image.filter((value: unknown): value is string => typeof value === 'string') : typeof ld?.image === 'string' ? [ld.image] : [];
  const galleryImages = Array.from(document.querySelectorAll<HTMLImageElement>('main [aria-label="Product photo carousel"] img'))
    .map((img) => bestImageUrl(img))
    .filter((value): value is string => Boolean(value));
  const pageImages = dedupe([...ldImages.map((value: string) => absUrl(value)).filter((v): v is string => Boolean(v)), ...galleryImages]);
  const description = descriptionFromPage(ld);
  const price = priceFromPage(ld);
  const colors = optionValues('color');
  const missingStyleImages = colors.filter((color) => !color.image);
  if (colors.length > 1 && missingStyleImages.length) {
    throw new Error(
      `检测到 ${colors.length} 个款式，其中 ${missingStyleImages.length} 个没有款式图片，请等待规格图片加载后重新采集`,
    );
  }
  const variants = makeVariants(productId || 'product', price?.value, colors, pageImages[0]);
  const variantImages = variants.map((variant) => variant.image).filter((value): value is string => Boolean(value));
  const images = dedupe([...pageImages, ...variantImages]);
  return {
    source: 'joom',
    sourceUrl: url,
    sourceProductId: productId,
    title,
    description: description || undefined,
    images,
    videos: productVideosFromPage(ld),
    price,
    variants,
    attributes: descriptionAttributes(description),
    raw: { platform: 'joom', parser: 'json-ld+dom', variantCount: variants.length },
  };
}

function productLink(card: HTMLElement): HTMLAnchorElement | null {
  return card.matches('a[href*="/products/"]')
    ? (card as HTMLAnchorElement)
    : card.querySelector<HTMLAnchorElement>('a[href*="/products/"]');
}

function getCardUrl(card: HTMLElement): string | null {
  const link = productLink(card);
  return link?.href || null;
}

function findCards(root: ParentNode = document): HTMLElement[] {
  const cards = new Set<HTMLElement>();
  for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/products/"]'))) {
    if (!PRODUCT_PATH.test(new URL(anchor.href, location.href).pathname)) continue;
    const card = anchor.closest<HTMLElement>('[class*="type-product"], [class*="product___"]') || anchor;
    if (card.querySelector('img[alt]')) cards.add(card);
  }
  return Array.from(cards);
}

function extractCard(card: HTMLElement): CollectedProduct | null {
  const link = productLink(card);
  const href = link?.href ? absUrl(link.href) : null;
  if (!href) return null;
  const image = card.querySelector<HTMLImageElement>('img[alt]');
  const title = (
    card.querySelector('h2')?.textContent?.trim() || image?.alt?.trim() || link?.getAttribute('title')?.trim() || ''
  ).trim();
  if (!title) return null;
  const priceText = card.querySelector('[class*="prices" i]')?.textContent || card.textContent || '';
  const priceValue = parseNumber(priceText);
  const price: Price | undefined = priceValue != null ? { value: priceValue, currency: currencyFromText(priceText) } : undefined;
  const imageUrl = image ? bestImageUrl(image) : null;
  return {
    source: 'joom',
    sourceUrl: href,
    sourceProductId: productIdFromUrl(href),
    title,
    images: imageUrl ? [imageUrl] : [],
    price,
    variants: [],
    attributes: {},
    raw: { from: 'joom-card' },
  };
}

export const joomExtractor: SourceExtractor = {
  id: 'joom',
  matches: (url) => {
    try {
      return JOOM_HOST.test(new URL(url).hostname);
    } catch {
      return false;
    }
  },
  isDetailPage: (url) => PRODUCT_PATH.test(new URL(url).pathname),
  findCards,
  getCardUrl,
  extractCard,
  extractDetail,
};

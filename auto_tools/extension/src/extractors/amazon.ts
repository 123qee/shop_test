import type { CollectedProduct, Price, Variant } from '@shared/types';
import type { SourceExtractor } from './types.js';
import { productVideosFromPage } from './media.js';

const AMAZON_HOST = /(^|\.)amazon\.de$/i;
const ASIN_PATH_RE = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?=[/?#]|$)/i;
const DEFAULT_CURRENCY = 'EUR';
/** 变体维度名 -> 统一的选项名;其它维度沿用页面上的显示文字。 */
const DIMENSION_NAMES: Record<string, string> = { size_name: 'Size', color_name: 'Color', style_name: 'Style' };

function absUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.trim(), location.href).toString();
  } catch {
    return null;
  }
}

function clean(value: string | null | undefined): string {
  return (value || '').replace(/[\u200e\u200f\u00a0]/g, ' ').replace(/\s+/g, ' ').trim();
}

function asinFromUrl(url: string): string {
  try {
    return new URL(url, location.href).pathname.match(ASIN_PATH_RE)?.[1]?.toUpperCase() || '';
  } catch {
    return '';
  }
}

/**
 * 德语/英语混合的金额解析:"176,29" -> 176.29,"1.234,56" -> 1234.56,"1,234.56" -> 1234.56。
 * 小数位恰为 2 位时视为小数点,否则视为千分位。
 */
function parseLocalizedNumber(raw: string): number | undefined {
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  } else if (lastComma >= 0) {
    normalized = raw.length - lastComma - 1 === 2 ? raw.replace(',', '.') : raw.replace(/,/g, '');
  } else if (lastDot >= 0) {
    normalized = raw.length - lastDot - 1 === 2 ? raw : raw.replace(/\./g, '');
  } else {
    normalized = raw;
  }
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : undefined;
}

/** 从显示文字中识别币种。Amazon 会按账户的显示币种换算价格,这里以页面实际显示的币种为准。 */
function currencyFromText(text: string): string | undefined {
  // 注意:Amazon 会写成 "176,29CNY"(数字与代码之间无空格),不能用 \b 边界。
  if (/CNY|RMB/i.test(text)) return 'CNY';
  if (/€|EUR/i.test(text)) return 'EUR';
  if (/£|GBP/i.test(text)) return 'GBP';
  if (/\$|USD/i.test(text)) return 'USD';
  if (/CHF/i.test(text)) return 'CHF';
  if (/PLN/i.test(text)) return 'PLN';
  if (/SEK/i.test(text)) return 'SEK';
  return undefined;
}

function moneyFromText(text: string | null | undefined): { value: number; currency: string } | undefined {
  const cleaned = clean(text);
  const match = cleaned.match(/\d[\d.,' ]*\d|\d/);
  if (!match) return undefined;
  const value = parseLocalizedNumber(match[0].replace(/[' ]/g, ''));
  if (value == null) return undefined;
  return { value, currency: currencyFromText(cleaned) || DEFAULT_CURRENCY };
}

/**
 * Amazon 图片统一成 1500px 版本:保留图片 id,替换尺寸后缀。
 * 列表页缩略图(_AC_UL320_)与详情页 hiRes 都会规范到同一格式,便于去重。
 */
function normalizeImage(url: string | null | undefined): string | null {
  const abs = absUrl(url);
  if (!abs) return null;
  const match = abs.match(/^https:\/\/m\.media-amazon\.com\/images\/I\/([^./?]+)\./i);
  return match ? `https://m.media-amazon.com/images/I/${match[1]}._AC_SL1500_.jpg` : null;
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function scriptsContaining(pattern: string): string[] {
  return Array.from(document.scripts)
    .map((script) => script.textContent || '')
    .filter((text) => text.includes(pattern));
}

/** 解析页面内联脚本里的扁平 JSON 对象字段,如 "dimensionValuesDisplayData" : {...}。 */
function inlineObjects(key: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const re = new RegExp(`"${key}"\\s*:\\s*(\\{[^{}]*\\})`, 'g');
  for (const text of scriptsContaining(key)) {
    for (const match of text.matchAll(re)) {
      try {
        found.push(JSON.parse(match[1]));
      } catch {
        /* 忽略不完整的片段 */
      }
    }
  }
  return found;
}

/** 当前 ASIN 的主图(来自 colorImages.initial),没有时退回 DOM 上的图库。 */
function detailImages(): string[] {
  const fromScript = scriptsContaining("'colorImages'")
    .flatMap((text) => Array.from(text.matchAll(/"hiRes"\s*:\s*"(https:[^"]+)"/g)).map((match) => match[1]));
  const landing = document.querySelector<HTMLImageElement>('#landingImage, #imgTagWrapperId img');
  const gallery = Array.from(document.querySelectorAll<HTMLImageElement>('#altImages img'))
    .map((img) => img.getAttribute('src'));
  return dedupe([
    ...fromScript.map(normalizeImage),
    normalizeImage(landing?.getAttribute('data-old-hires')),
    normalizeImage(landing?.getAttribute('src')),
    ...gallery.map(normalizeImage),
  ]).slice(0, 20);
}

function detailPrice(): Price | undefined {
  // 逐个候选取值,跳过 Amazon 常见的空白 offscreen 占位文本。
  const selectors = [
    '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
    '#corePrice_feature_div .priceToPay .a-offscreen',
    '#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen',
    '#priceblock_ourprice, #priceblock_dealprice, #sns-base-price',
  ];
  let money: { value: number; currency: string } | undefined;
  for (const selector of selectors) {
    for (const node of Array.from(document.querySelectorAll(selector))) {
      money = moneyFromText(node.textContent);
      if (money) break;
    }
    if (money) break;
  }
  if (!money) return undefined;
  const originalText = document.querySelector('#corePrice_feature_div .a-price.a-text-price .a-offscreen, #corePrice_feature_div .basisPrice .a-offscreen')?.textContent;
  const original = moneyFromText(originalText)?.value;
  return { ...money, ...(original != null && original > money.value ? { original } : {}) };
}

function detailAttributes(): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: string) => {
    const k = clean(key).replace(/[:：]$/, '');
    const v = clean(value);
    if (k && v && k.length <= 80 && !out[k]) out[k] = v.slice(0, 300);
  };
  document
    .querySelectorAll<HTMLTableRowElement>('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #productOverview_feature_div tr')
    .forEach((row) => {
      const th = row.querySelector('th');
      const td = row.querySelector('td');
      if (th && td) put(th.textContent || '', td.textContent || '');
    });
  document.querySelectorAll<HTMLLIElement>('#detailBullets_feature_div li').forEach((li) => {
    const bold = clean(li.querySelector('.a-text-bold')?.textContent);
    if (!bold) return;
    const text = clean(li.textContent);
    put(bold, text.slice(text.indexOf(bold) + bold.length));
  });
  return out;
}

function detailDescription(): string | undefined {
  const body = clean(document.querySelector('#productDescription')?.textContent);
  if (body) return body.slice(0, 5000);
  const bullets = Array.from(document.querySelectorAll('#feature-bullets li span.a-list-item'))
    .map((item) => clean(item.textContent))
    .filter(Boolean);
  return bullets.length ? bullets.join('\n') : undefined;
}

function detailStore(): { name?: string; url?: string } | undefined {
  const link = document.querySelector<HTMLAnchorElement>('#bylineInfo');
  const text = clean(link?.textContent);
  if (!text) return undefined;
  const name = text.replace(/^(?:Besuche den|Visit the)\s+/i, '').replace(/-Store$/i, '').replace(/\s+Store$/i, '');
  return { name: name || text, url: absUrl(link?.getAttribute('href')) || undefined };
}

/**
 * 变体来自页面内联数据:dimensionValuesDisplayData(ASIN -> 各维度取值)与 dimensions(维度顺序)。
 * Amazon 不在页面里直接给出每个变体的价格,变体价格暂用当前 ASIN 的价格,并在 raw 中标注。
 */
function detailVariants(asin: string, price: Price | undefined, mainImage: string | undefined): Variant[] {
  const valueMaps = inlineObjects('dimensionValuesDisplayData');
  const valueMap = valueMaps.sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0];
  if (!valueMap || !Object.keys(valueMap).length) return [];

  const labels = inlineObjects('variationDisplayLabels')[0] as Record<string, string> | undefined;
  const dimensionText = scriptsContaining('"dimensions"').join('\n');
  const dimensionArrays = Array.from(dimensionText.matchAll(/"dimensions"\s*:\s*(\[[^\]]*\])/g))
    .map((match) => {
      try {
        return JSON.parse(match[1]) as string[];
      } catch {
        return [] as string[];
      }
    });
  const tupleLength = Math.max(...Object.values(valueMap).map((value) => (Array.isArray(value) ? value.length : 0)));
  const dimensions = dimensionArrays.find((list) => list.length === tupleLength) || ['size_name', 'color_name'].slice(0, tupleLength);

  const variants: Variant[] = Object.entries(valueMap).map(([sku, values]) => {
    const tuple = Array.isArray(values) ? values : [];
    const options: Record<string, string> = {};
    dimensions.forEach((dimension, index) => {
      const value = clean(String(tuple[index] ?? ''));
      if (!value) return;
      const name = DIMENSION_NAMES[dimension] || clean(labels?.[dimension]) || dimension;
      options[name] = value;
    });
    return {
      sourceSkuId: sku,
      options,
      ...(price ? { price: price.value } : {}),
      ...(sku === asin && mainImage ? { image: mainImage } : {}),
    };
  });
  return variants;
}

function productLink(card: HTMLElement): HTMLAnchorElement | null {
  return card.querySelector<HTMLAnchorElement>('h2 a[href], a.a-link-normal[href*="/dp/"]') ||
    card.querySelector<HTMLAnchorElement>('a[href*="/dp/"]');
}

function findCards(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('div[data-component-type="s-search-result"][data-asin]'))
    .filter((card) => Boolean(card.dataset.asin) && Boolean(card.querySelector('h2')));
}

function getCardUrl(card: HTMLElement): string | null {
  const asin = card.dataset.asin?.trim();
  if (asin && /^[A-Z0-9]{10}$/i.test(asin)) return `https://www.amazon.de/dp/${asin.toUpperCase()}`;
  return absUrl(productLink(card)?.getAttribute('href'));
}

function extractCard(card: HTMLElement): CollectedProduct | null {
  const url = getCardUrl(card);
  const asin = card.dataset.asin?.toUpperCase() || (url ? asinFromUrl(url) : '');
  if (!url || !asin) return null;
  const title = clean(card.querySelector('h2 span')?.textContent) || clean(card.querySelector('h2')?.getAttribute('aria-label'));
  if (!title) return null;
  const price = moneyFromText(card.querySelector('.a-price:not(.a-text-price) .a-offscreen')?.textContent);
  const original = moneyFromText(card.querySelector('.a-price.a-text-price .a-offscreen')?.textContent)?.value;
  const image = normalizeImage(card.querySelector<HTMLImageElement>('img.s-image')?.getAttribute('src'));
  return {
    source: 'amazon',
    sourceUrl: url,
    sourceProductId: asin,
    title,
    images: image ? [image] : [],
    price: price ? { ...price, ...(original != null && original > price.value ? { original } : {}) } : undefined,
    variants: [],
    attributes: {},
    raw: { platform: 'amazon', from: 'search-result' },
  };
}

async function extractDetail(): Promise<CollectedProduct | null> {
  const url = location.href;
  const asin = asinFromUrl(url) || document.querySelector<HTMLInputElement>('input#ASIN')?.value?.toUpperCase() || '';
  const title = clean(document.querySelector('#productTitle')?.textContent) || clean(document.querySelector('h1')?.textContent);
  if (!title) return null;
  const images = detailImages();
  const price = detailPrice();
  const variants = detailVariants(asin, price, images[0]);
  const store = detailStore();
  const displayedCurrency = price?.currency;
  return {
    source: 'amazon',
    sourceUrl: asin ? `https://www.amazon.de/dp/${asin}` : url,
    sourceProductId: asin,
    title,
    description: detailDescription(),
    images,
    // HLS(.m3u8) 无法作为直链缓存,只保留可直接下载的 mp4 等文件。
    videos: productVideosFromPage().filter((video) => !/\.m3u8(?:[?#]|$)/i.test(video.url)),
    price,
    variants: variants.length ? variants : [{
      sourceSkuId: asin || 'product',
      options: {},
      ...(price ? { price: price.value } : {}),
      ...(images[0] ? { image: images[0] } : {}),
    }],
    attributes: detailAttributes(),
    ...(store ? { store } : {}),
    raw: {
      platform: 'amazon',
      parser: 'dom+inline-json',
      variantCount: variants.length,
      variantPriceSource: variants.length ? 'landing-asin' : undefined,
      displayedCurrency,
    },
  };
}

export const amazonExtractor: SourceExtractor = {
  id: 'amazon',
  matches: (url) => {
    try {
      return AMAZON_HOST.test(new URL(url).hostname);
    } catch {
      return false;
    }
  },
  isDetailPage: (url) => {
    try {
      return ASIN_PATH_RE.test(new URL(url).pathname);
    } catch {
      return false;
    }
  },
  findCards,
  getCardUrl,
  extractCard,
  extractDetail,
};

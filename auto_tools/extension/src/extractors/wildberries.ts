import type { CollectedProduct, Price, Variant } from '@shared/types';
import { sendMessage } from '../common/messages.js';
import type { SourceExtractor } from './types.js';
import { productVideosFromPage } from './media.js';
import { parseNmId, productUrl } from './wildberries-api.js';

const HOST = /(^|\.)wildberries\.ru$/i;
const DETAIL = /\/catalog\/(\d{5,})(?:\/detail\.aspx)?\/?$/i;
const NM_ATTRS = ['data-nm-id', 'data-nmid', 'data-popup-nm-id', 'data-card-nm-id', 'data-product-id'];

function absUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try { return new URL(value.trim().replace(/^\/\//, 'https://'), location.href).toString(); } catch { return null; }
}

function number(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const s = text.replace(/\s/g, '').replace(/₽/g, '').match(/[\d.,]+/)?.[0];
  if (!s) return undefined;
  const normalized = s.includes(',') && s.includes('.')
    ? (s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, ''))
    : s.replace(',', '.');
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function imageUrl(img: HTMLImageElement): string | null {
  return absUrl(
    img.currentSrc ||
    img.getAttribute('src') ||
    img.getAttribute('data-src') ||
    img.getAttribute('data-original') ||
    img.getAttribute('data-src-pb') ||
    srcFromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset')),
  );
}

function srcFromSrcset(srcset: string | null): string | null {
  if (!srcset) return null;
  return srcset.split(',')[0]?.trim().split(/\s+/)[0] || null;
}

function nmFromAnyUrl(value: string | null | undefined): string {
  if (!value) return '';
  const href = absUrl(value) || value;
  const fromPath = parseNmId(href);
  if (fromPath) return fromPath;
  return href.match(/\/(\d{6,})\/images\//)?.[1] || '';
}

function attrNmId(el: HTMLElement): string {
  for (const name of NM_ATTRS) {
    const value = el.getAttribute(name)?.trim();
    if (value && /^\d{5,}$/.test(value)) return value;
  }
  const idMatch = el.id.match(/^c(\d{5,})$/i);
  return idMatch?.[1] || '';
}

function closestCard(el: HTMLElement): HTMLElement {
  const named = el.closest<HTMLElement>(
    '[data-nm-id], [data-popup-nm-id], [class*="product-card" i], [class*="j-card" i], article, li',
  );
  if (named) return named;
  let cur: HTMLElement | null = el;
  for (let i = 0; i < 8 && cur; i++) {
    if (cur.offsetWidth >= 140 && cur.offsetHeight >= 180) return cur;
    cur = cur.parentElement;
  }
  return el;
}

function jsonLd(): any | null {
  for (const node of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const data = JSON.parse(node.textContent || '');
      const items = Array.isArray(data) ? data : [data];
      const product = items.find((x) => x?.['@type'] === 'Product' || (Array.isArray(x?.['@type']) && x['@type'].includes('Product')));
      if (product) return product;
    } catch { /* ignore malformed page data */ }
  }
  return null;
}

function priceFrom(root: ParentNode): Price | undefined {
  const text = (root as HTMLElement).querySelector?.(
    '[class*="priceBlockWalletPrice" i], [class*="priceBlockFinalPrice" i], [class*="productLinePriceWallet" i], [class*="price" i], [class*="cost" i]',
  )?.textContent || (root as HTMLElement).textContent || '';
  const value = number(text);
  return value == null ? undefined : { value, currency: 'RUB' };
}

function findCards(root: ParentNode = document): HTMLElement[] {
  const byId = new Map<string, HTMLElement>();
  const consider = (el: HTMLElement, id: string) => {
    if (!id || !/^\d{5,}$/.test(id)) return;
    const card = closestCard(el);
    if (!card.getAttribute('data-nm-id')) card.setAttribute('data-nm-id', id);
    const prev = byId.get(id);
    const score = (node: HTMLElement) => node.offsetWidth * node.offsetHeight;
    if (!prev || score(card) >= score(prev)) byId.set(id, card);
  };

  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-nm-id], [data-popup-nm-id], [data-card-nm-id], [id^="c"]'))) {
    consider(el, attrNmId(el));
  }
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/catalog/"]'))) {
    consider(a, nmFromAnyUrl(a.getAttribute('href') || a.href));
  }
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
    const id = nmFromAnyUrl(img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('srcset'));
    if (id) consider(img, id);
  }
  return [...byId.values()];
}

function cardId(card: HTMLElement): string {
  return attrNmId(card) ||
    nmFromAnyUrl(card.querySelector('a[href*="/catalog/"]')?.getAttribute('href')) ||
    nmFromAnyUrl(card.querySelector('img')?.currentSrc || card.querySelector('img')?.getAttribute('src'));
}

function getCardUrl(card: HTMLElement): string | null {
  const id = cardId(card);
  return id ? productUrl(id) : null;
}

function extractCard(card: HTMLElement): CollectedProduct | null {
  const id = cardId(card);
  if (!id) return null;
  const href = productUrl(id);
  const img = card.querySelector<HTMLImageElement>('img');
  const title = (
    card.querySelector('[class*="name" i], [class*="brand" i]')?.textContent ||
    img?.alt ||
    card.textContent ||
    ''
  ).trim().replace(/\s+/g, ' ');
  if (!title) return null;
  const price = priceFrom(card);
  const image = img ? imageUrl(img) : null;
  return {
    source: 'wildberries',
    sourceUrl: href,
    sourceProductId: id,
    title,
    images: image ? [image] : [],
    price,
    variants: [{ sourceSkuId: id, options: {}, price: price?.value, image: image ?? undefined }],
    attributes: {},
    raw: { platform: 'wildberries', from: 'card' },
  };
}

function pageBlocked(): boolean {
  const text = `${document.title} ${document.body?.innerText?.slice(0, 400) || ''}`;
  return /проверяем браузер|доступ ограничен|antibot|captcha|robot/i.test(text) ||
    Boolean(document.querySelector('[src*="antibot"], [src*="challenges"]'));
}

async function extractDetailDom(): Promise<CollectedProduct | null> {
  const deadline = Date.now() + 12_000;
  while (pageBlocked() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  while (
    !document.querySelector('h1, [class*="productImtName" i], [class*="productLineName" i], [class*="productNameContainer" i], [class*="product-page" i]') &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const ld = jsonLd();
  const title = (
    document.querySelector('h1')?.textContent ||
    document.querySelector('[class*="productLineName" i]')?.textContent ||
    document.querySelector('[class*="productNameContainer" i]')?.textContent ||
    document.querySelector('[class*="productImtName" i]')?.textContent ||
    ld?.name ||
    ''
  ).trim().replace(/\s+/g, ' ');
  if (!title || pageBlocked() || /проверяем браузер|captcha|robot|доступ ограничен/i.test(title)) return null;
  const url = location.href;
  const id = parseNmId(url) || cardId(document.body);
  const imageRoot = document.querySelector('main') || document.body;
  const images = [...new Set(Array.from(imageRoot.querySelectorAll<HTMLImageElement>('img')).map(imageUrl).filter((x): x is string => Boolean(x)))];
  const ldImages = Array.isArray(ld?.image) ? ld.image : ld?.image ? [ld.image] : [];
  for (const img of ldImages) { const u = absUrl(String(img)); if (u && !images.includes(u)) images.push(u); }
  const price = priceFrom(document.querySelector('main') || document.body);
  const options: Record<string, string> = {};
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[class*="size" i] button, [class*="color" i] button, [class*="option" i] button'))) {
    const value = (el.textContent || '').trim();
    if (value && value.length < 40) options[el.parentElement?.querySelector('label, [class*="title" i]')?.textContent?.trim() || 'Option'] = value;
  }
  const description = (
    document.querySelector('[class*="description" i], [data-testid*="description" i]')?.textContent ||
    ld?.description ||
    ''
  ).trim();
  const attributes: Record<string, string> = {};
  const detailText = (document.querySelector('main')?.textContent || '').replace(/\s+/g, ' ');
  for (const key of ['Состав', 'Пол', 'Размер на модели', 'Рост модели на фото', 'Фактура материала']) {
    const match = detailText.match(new RegExp(`${key}\\s+([^\\d]{1,120}?)(?=Состав|Пол|Размер на модели|Рост модели на фото|Фактура материала|Характеристики|$)`));
    if (match?.[1]?.trim()) attributes[key] = match[1].trim();
  }
  const variant: Variant = { sourceSkuId: id, options, price: price?.value, image: images[0] };
  return { source: 'wildberries', sourceUrl: url, sourceProductId: id, title, description: description || undefined, images, videos: productVideosFromPage(ld), price, variants: [variant], attributes, raw: { platform: 'wildberries', parser: 'dom+json-ld' } };
}

async function extractDetail(): Promise<CollectedProduct | null> {
  try {
    const res = await sendMessage({ type: 'EXTRACT_BY_URL', url: location.href });
    if (res.ok && res.type === 'EXTRACT_BY_URL' && res.product?.title) return res.product;
  } catch {
    /* 接口失败时回退 DOM */
  }
  return extractDetailDom();
}

export const wildberriesExtractor: SourceExtractor = {
  id: 'wildberries',
  matches: (url) => { try { return HOST.test(new URL(url).hostname); } catch { return false; } },
  isDetailPage: (url) => {
    try {
      const path = new URL(url).pathname;
      if (/search\.aspx/i.test(path)) return false;
      return DETAIL.test(path);
    } catch {
      return false;
    }
  },
  findCards,
  getCardUrl,
  extractCard,
  extractDetail,
};

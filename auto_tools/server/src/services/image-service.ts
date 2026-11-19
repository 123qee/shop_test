import type { CollectedProduct, EditableProduct, ImageCheckResult } from '@shared/types';

// 与发布校验保持一致，避免图片代理首次生成时被误判为损坏。
const TIMEOUT_MS = 30000;
export const MIN_IMAGE_SIZE = 550;
export const PUBLISH_IMAGE_SIZE = 1200;
const ASOS_IMAGE_HOST = /(^|\.)images\.asos-media\.com$/i;
const ALLEGRO_IMAGE_HOST = /(^|\.)allegroimg\.com$/i;
const OZON_IMAGE_HOST = /(^|\.)ozonstatic\.(ru|cn|com)$/i;

interface ImageInfo {
  contentType?: string;
  width?: number;
  height?: number;
}

/** 读取常见图片格式的尺寸，不引入原生图像依赖。 */
function imageSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    if (buffer.toString('ascii', 12, 16) === 'VP8X') {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
    if (buffer.toString('ascii', 12, 16) === 'VP8 ' && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (!length) break;
      offset += 2 + length;
    }
  }
  return null;
}

async function readImage(url: string): Promise<{ ok: boolean; info?: ImageInfo; issue?: string }> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, issue: '必须是 http(s) 图片 URL' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const contentType = res.headers.get('content-type') ?? undefined;
    if (!res.ok) return { ok: false, info: { contentType }, issue: `HTTP ${res.status}` };
    if (contentType && !contentType.startsWith('image/')) return { ok: false, info: { contentType }, issue: 'Content-Type 不是图片' };
    const buffer = Buffer.from(await res.arrayBuffer());
    const size = imageSize(buffer);
    if (!size?.width || !size.height) return { ok: false, info: { contentType }, issue: '无法读取图片尺寸' };
    return { ok: true, info: { contentType, ...size } };
  } catch {
    return { ok: false, issue: '图片无法访问、解析失败或请求超时' };
  } finally { clearTimeout(timer); }
}

function parsedHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return /^https?:$/i.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function isAsosImageUrl(value: string): boolean {
  const url = parsedHttpUrl(value);
  return Boolean(url && ASOS_IMAGE_HOST.test(url.hostname));
}

function isAllegroImageUrl(value: string): boolean {
  const url = parsedHttpUrl(value);
  return Boolean(url && ALLEGRO_IMAGE_HOST.test(url.hostname));
}

/** Reject George thumbnails even when wsrv has enlarged them to a square 1200px output. */
function georgeSourceResolutionIssue(value: string): string | undefined {
  const source = wsrvSourceUrl(value) ?? value;
  const url = parsedHttpUrl(source);
  if (!url || url.hostname !== 'asda.scene7.com' || !/\/is\/image\/Asda\//i.test(url.pathname)) return undefined;
  const width = Number(url.searchParams.get('wid'));
  const height = Number(url.searchParams.get('hei'));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 768 || height < 1024) {
    return 'George 原图分辨率低于 768×1024；代理生成的 1200×1200 可能只是放大图';
  }
  return undefined;
}

/** 取出 wsrv 代理链中的源图地址，用于升级旧的 550x550 图片。 */
function wsrvSourceUrl(value: string): string | null {
  const url = parsedHttpUrl(value);
  if (!url || !/(^|\.)wsrv\.nl$/i.test(url.hostname)) return null;
  const source = url.searchParams.get('url');
  return source && parsedHttpUrl(source) ? source : null;
}

/** 将历史 ASOS 代理图还原为 ASOS CDN 原图；直链保持不变。 */
export function restoreAsosOriginalUrl(value: string): string {
  const source = wsrvSourceUrl(value);
  return source && isAsosImageUrl(source) ? source : value;
}

/** 请求 ASOS CDN 的 1000px 图，避免把裸地址默认返回的小图继续放大。 */
function asosHighResolutionUrl(value: string): string {
  const url = parsedHttpUrl(value);
  if (!url || !ASOS_IMAGE_HOST.test(url.hostname)) return value;
  url.searchParams.set('wid', '1000');
  url.searchParams.set('fit', 'constrain');
  return url.toString();
}

/** 通过公开图片处理代理生成可被 Joom 拉取的 1200x1200 白底高质量 JPEG。 */
export function squareImageUrl(url: string): string {
  const original = wsrvSourceUrl(url) ?? url;
  const source = isAsosImageUrl(original) ? asosHighResolutionUrl(original) : original;
  return `https://wsrv.nl/?url=${encodeURIComponent(source)}&w=${PUBLISH_IMAGE_SIZE}&h=${PUBLISH_IMAGE_SIZE}&fit=contain&cbg=fff&output=jpg&q=95`;
}

/**
 * 速卖通图链 Node 经常因 CDN 证书链不完整而 fetch 失败（UNABLE_TO_VERIFY_LEAF_SIGNATURE），
 * 且文件实际是 webp、扩展名却是 .jpg。浏览器能看，发布校验和 Joom 都拉不到。
 */
export function needsImageProxy(url: string): boolean {
  if (!url.trim() || url.includes('wsrv.nl/')) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith('.aliexpress-media.com') || host.endsWith('.alicdn.com') || host.endsWith('.aliexpress.com');
  } catch {
    return false;
  }
}

export function toPublishableImageUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  const source = wsrvSourceUrl(trimmed) ?? trimmed;
  // wsrv 对部分 Allegro 原图返回 404；Allegro CDN 原图可被 Joom 直接读取。
  if (isAllegroImageUrl(source)) return source;
  return needsImageProxy(source) || isAsosImageUrl(source) ? squareImageUrl(source) : trimmed;
}

export function rewriteEditableImages(p: EditableProduct): EditableProduct {
  return {
    ...p,
    images: p.images.map(toPublishableImageUrl),
    variants: p.variants.map((variant) => ({
      ...variant,
      image: variant.image ? toPublishableImageUrl(variant.image) : variant.image,
    })),
  };
}

/** 仅速卖通采集默认把第二张图作为主图；其他来源保留原始图片顺序。 */
export function imagesForCollectedSource(images: string[], source: CollectedProduct['source']): string[] {
  if (source !== 'aliexpress' || images.length < 2) return [...images];
  return [images[1], images[0], ...images.slice(2)];
}

/** 采集时规范化图片。Allegro 保留可直连原图，速卖通等不稳定图链再走代理。 */
export async function normalizeCollectedImages<T extends { images: string[]; variants: Array<{ image?: string }> }>(product: T): Promise<T> {
  const urls = [...product.images, ...product.variants.map((v) => v.image).filter((x): x is string => Boolean(x))];
  const replacements = new Map<string, string>();
  await Promise.all(urls.map(async (url) => {
    const original = wsrvSourceUrl(url);
    if (original && isAllegroImageUrl(original)) {
      replacements.set(url, original);
      return;
    }
    if (isAllegroImageUrl(url)) return;
    // ASOS 原图是高清竖图；母商品库保留原图，发布时再生成正方形留白版。
    if (isAsosImageUrl(url)) return;
    // Ozon 的商品原图由 CDN 提供，直接生成发布图链接，避免入库等待原图探测。
    const parsed = parsedHttpUrl(original ?? url);
    if (parsed && OZON_IMAGE_HOST.test(parsed.hostname) && parsed.pathname.startsWith('/s3/multimedia')) {
      replacements.set(url, squareImageUrl(url));
      return;
    }
    if (needsImageProxy(url)) {
      replacements.set(url, squareImageUrl(url));
      return;
    }
    const result = await readImage(url);
    const { width, height } = result.info ?? {};
    const badSize = Boolean(width && height && (width !== height || width < MIN_IMAGE_SIZE || height < MIN_IMAGE_SIZE));
    if (!result.ok || badSize) replacements.set(url, squareImageUrl(url));
  }));
  return {
    ...product,
    images: product.images.map((url) => replacements.get(url) ?? url),
    variants: product.variants.map((variant) => ({ ...variant, image: variant.image ? replacements.get(variant.image) ?? variant.image : undefined })),
  };
}

async function check(url: string): Promise<{ ok: boolean; contentType?: string; width?: number; height?: number; issue?: string }> {
  const result = await readImage(url);
  return { ok: result.ok, ...result.info, issue: result.issue };
}

export async function checkProductImages(p: EditableProduct): Promise<ImageCheckResult[]> {
  const seen = new Set<string>();
  const out: ImageCheckResult[] = [];
  for (const url of p.images.slice(0, 21)) {
    const duplicate = seen.has(url);
    seen.add(url);
    const result = await check(toPublishableImageUrl(url));
    const sizeIssue = result.ok && (result.width !== result.height || (result.width ?? 0) < MIN_IMAGE_SIZE)
      ? `图片需为正方形且至少 ${MIN_IMAGE_SIZE}×${MIN_IMAGE_SIZE}，当前 ${result.width}×${result.height}`
      : undefined;
    const sourceResolutionIssue = georgeSourceResolutionIssue(url);
    out.push({ url, ...result, duplicate, issue: duplicate ? '图片重复' : sizeIssue ?? sourceResolutionIssue ?? result.issue });
  }
  return out;
}

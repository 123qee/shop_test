/** wsrv 图床不可用时，使用 Allegro 采集的原图作为前端预览回退。 */
export function allegroOriginalImage(url: string): string | undefined {
  try {
    const current = new URL(url);
    if (current.hostname !== 'wsrv.nl') return;
    const source = current.searchParams.get('url');
    if (!source) return;
    const original = new URL(source);
    if (!/(^|\.)allegroimg\.com$/i.test(original.hostname)) return;
    return original.href;
  } catch {
    return;
  }
}

export function fallbackToAllegroOriginal(image: HTMLImageElement) {
  if (image.dataset.allegroFallbackAttempted === 'true') return;
  const original = allegroOriginalImage(image.currentSrc || image.src);
  if (!original) return;
  image.dataset.allegroFallbackAttempted = 'true';
  image.src = original;
}

/** ASOS 裸图默认只有 313px 左右；查询 CDN 的 1000px 版本，兼容旧记录和历史代理链。 */
function asosHighResolutionImage(url: string, pixels = 1000, depth = 0): string | undefined {
  if (depth > 4) return;
  try {
    const current = new URL(url);
    if (current.hostname === 'wsrv.nl') {
      const source = current.searchParams.get('url');
      return source ? asosHighResolutionImage(source, pixels, depth + 1) : undefined;
    }
    if (!/(^|\.)images\.asos-media\.com$/i.test(current.hostname)) return;
    current.searchParams.set('wid', String(pixels));
    current.searchParams.set('fit', 'constrain');
    return current.href;
  } catch {
    return;
  }
}

export function imagePreviewSource(url: string) {
  return allegroOriginalImage(url) ?? asosHighResolutionImage(url) ?? url;
}

/**
 * 分拣页按用途取尺寸：主图看得清即可，缩略图只有几十像素。
 * 只改显示用的地址，不改保存的图片数据。
 * 速卖通代理图（wsrv）改 w/h/q 参数；Allegro 原图改成 CDN 的缩小版本（s720 / s256）。
 */
export type ImageSize = 'preview' | 'thumb';
const SIZE_PRESETS = {
  preview: { px: 800, quality: 80, allegroVariant: 's720' },
  thumb: { px: 200, quality: 75, allegroVariant: 's256' },
} as const;

function allegroSizedImage(href: string, variant: string): string {
  try {
    const current = new URL(href);
    if (!/(^|\.)allegroimg\.com$/i.test(current.hostname)) return href;
    if (!current.pathname.startsWith('/original/')) return href;
    current.pathname = current.pathname.replace('/original/', `/${variant}/`);
    return current.href;
  } catch {
    return href;
  }
}

export function sizedImageSource(url: string, size: ImageSize): string {
  const preset = SIZE_PRESETS[size];
  const asos = asosHighResolutionImage(url, preset.px);
  if (asos) return asos;
  try {
    const current = new URL(url);
    if (current.hostname === 'wsrv.nl') {
      const source = current.searchParams.get('url');
      if (!source) return url;
      const inner = new URL(source);
      // wsrv 对部分 Allegro 原图会 404，Allegro 直接用 CDN 的缩小版本。
      if (/(^|\.)allegroimg\.com$/i.test(inner.hostname)) return allegroSizedImage(inner.href, preset.allegroVariant);
      current.searchParams.set('w', String(preset.px));
      current.searchParams.set('h', String(preset.px));
      current.searchParams.set('q', String(preset.quality));
      return current.href;
    }
    if (/(^|\.)allegroimg\.com$/i.test(current.hostname)) return allegroSizedImage(url, preset.allegroVariant);
    if (size === 'preview') return imagePreviewSource(url);
    return url;
  } catch {
    return url;
  }
}

/** 缩小版本不可用时仅回退一次；原始地址始终只用于显示，不写回商品。 */
export function fallbackToSourceImage(image: HTMLImageElement, source: string): boolean {
  const fallback = imagePreviewSource(source);
  if (image.dataset.sourceFallback === source || (image.currentSrc || image.src) === fallback) return false;
  image.dataset.sourceFallback = source;
  image.src = fallback;
  return true;
}

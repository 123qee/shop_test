import type { ProductVideo } from '@shared/types';

function absoluteUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let url = value.trim()
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/');
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return null;
  if (url.startsWith('//')) url = `https:${url}`;
  try {
    const parsed = new URL(url, location.href);
    return /^https?:$/.test(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function metaContent(selector: string): string | undefined {
  return document.querySelector<HTMLMetaElement>(selector)?.content || undefined;
}

function videoFromValue(value: unknown, poster?: string): ProductVideo | null {
  const url = absoluteUrl(value);
  if (!url) return null;
  return { url, ...(poster ? { poster } : {}) };
}

function jsonLdVideos(value: unknown): ProductVideo[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((item) => {
    if (typeof item === 'string') return [videoFromValue(item)].filter((v): v is ProductVideo => Boolean(v));
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const poster = absoluteUrl(row.thumbnailUrl || row.thumbnail || row.poster) || undefined;
    return [row.contentUrl, row.url]
      .map((candidate) => videoFromValue(candidate, poster))
      .filter((v): v is ProductVideo => Boolean(v));
  });
}

/**
 * 从 DOM、OpenGraph、JSON-LD 和常见内嵌 videoUrl 字段提取商品视频直链。
 * blob: URL 只在当前页面生命周期有效，因此不会入库。
 */
export function productVideosFromPage(jsonLd?: any): ProductVideo[] {
  const poster = absoluteUrl(
    metaContent('meta[property="og:video:image"]') ||
    metaContent('meta[property="og:image"]'),
  ) || undefined;
  const candidates: ProductVideo[] = [];

  for (const video of Array.from(document.querySelectorAll<HTMLVideoElement>('video'))) {
    const ownPoster = absoluteUrl(video.poster) || poster;
    const urls = [video.currentSrc, video.src, ...Array.from(video.querySelectorAll('source')).map((source) => source.src)];
    for (const value of urls) {
      const found = videoFromValue(value, ownPoster);
      if (found) candidates.push(found);
    }
  }

  for (const selector of [
    'meta[property="og:video"]',
    'meta[property="og:video:url"]',
    'meta[property="og:video:secure_url"]',
    'meta[name="twitter:player:stream"]',
  ]) {
    const found = videoFromValue(metaContent(selector), poster);
    if (found) candidates.push(found);
  }
  candidates.push(...jsonLdVideos(jsonLd?.video));

  // SPA 页面经常只把视频直链放在 hydration JSON 中。只扫描明确的视频键，
  // 避免把页面里的广告/埋点媒体误认为商品视频。
  const keyPattern = /["'](?:videoUrl|videoURL|video_url|videoPath|playUrl|contentUrl)["']\s*:\s*["']([^"']+)["']/gi;
  let scanned = 0;
  for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>('script:not([src])'))) {
    const text = script.textContent || '';
    if (!/video(?:url|path)|playurl|contenturl/i.test(text)) continue;
    scanned += text.length;
    if (scanned > 8_000_000) break;
    let match: RegExpExecArray | null;
    while ((match = keyPattern.exec(text))) {
      const found = videoFromValue(match[1], poster);
      if (found) candidates.push(found);
    }
  }

  const seen = new Set<string>();
  return candidates.filter((video) => {
    const key = video.url.replace(/[?#].*$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

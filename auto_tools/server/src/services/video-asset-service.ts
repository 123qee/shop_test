import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { v4 as uuid } from 'uuid';
import type { CollectedProduct, ProductVideo } from '@shared/types';
import { config } from '../config/index.js';
import { logger } from '../util/logger.js';

const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

function extensionFor(video: ProductVideo, contentType: string): string {
  const pathname = (() => { try { return new URL(video.url).pathname; } catch { return ''; } })();
  const ext = path.extname(pathname).toLowerCase();
  if (/^\.(mp4|webm|mov|m4v)$/.test(ext)) return ext;
  if (/webm/i.test(contentType)) return '.webm';
  if (/quicktime/i.test(contentType)) return '.mov';
  return '.mp4';
}

export function videoAssetPath(assetId: string): string | null {
  if (!/^[a-zA-Z0-9._-]+$/.test(assetId)) return null;
  const target = path.resolve(config.videoDir, assetId);
  return target.startsWith(path.resolve(config.videoDir) + path.sep) ? target : null;
}

export async function cacheVideo(video: ProductVideo, referer?: string, timeoutMs = 120_000): Promise<ProductVideo> {
  if (video.localAssetId && videoAssetPath(video.localAssetId) && fs.existsSync(videoAssetPath(video.localAssetId)!)) return video;
  if (/\.m3u8(?:[?#]|$)/i.test(video.url)) throw new Error('暂不支持缓存 HLS 播放列表，请采集 MP4/WebM 直链');

  fs.mkdirSync(config.videoDir, { recursive: true });
  const response = await fetch(video.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36',
      ...(referer ? { Referer: referer } : {}),
    },
  });
  if (!response.ok || !response.body) throw new Error(`下载视频失败 (${response.status})`);
  const declared = Number(response.headers.get('content-length')) || 0;
  if (declared > MAX_VIDEO_BYTES) throw new Error('视频超过 Joom 1 GB 上限');

  const contentType = response.headers.get('content-type') || video.mimeType || 'video/mp4';
  if (/^(?:text\/|application\/(?:json|xml))/i.test(contentType)) throw new Error(`视频地址返回了非视频内容 (${contentType})`);
  const assetId = `${uuid()}${extensionFor(video, contentType)}`;
  const target = videoAssetPath(assetId)!;
  const partial = `${target}.part`;
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      callback(size > MAX_VIDEO_BYTES ? new Error('视频超过 Joom 1 GB 上限') : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as any), limiter, fs.createWriteStream(partial, { flags: 'wx' }));
    fs.renameSync(partial, target);
    return { ...video, localAssetId: assetId, mimeType: contentType.split(';')[0], size };
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
}

/** 采集阶段立即缓存主视频；缓存失败不阻断商品入库，仍保留来源 URL 供重试。 */
export async function cachePrimaryCollectedVideo(product: CollectedProduct): Promise<CollectedProduct> {
  if (!product.videos?.length) return product;
  try {
    // 浏览器扩展的采集请求要尽快返回。慢视频保留直链，可在发布时再缓存。
    const first = await cacheVideo(product.videos[0], product.sourceUrl, product.source === 'ozon' ? 8_000 : undefined);
    return { ...product, videos: [first, ...product.videos.slice(1)] };
  } catch (error) {
    logger.warn('商品视频本地缓存失败，已保留来源 URL', {
      sourceUrl: product.sourceUrl,
      videoUrl: product.videos[0]?.url,
      error: (error as Error).message,
    });
    return product;
  }
}

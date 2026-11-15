import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { EditableProduct, JoomVideoState, ProductRecord, ProductVideo } from '@shared/types';
import { marketplaceRegistry } from '../marketplaces/registry.js';
import { JoomAdapter } from '../marketplaces/joom/adapter.js';
import { MarketplaceError } from '../marketplaces/types.js';
import { productRepository, type ProductRepository } from '../repositories/product-repository.js';
import { auditService } from './audit-service.js';
import { cacheVideo, videoAssetPath } from './video-asset-service.js';
import { logger } from '../util/logger.js';

const MIN_VIDEO_BYTES = 10 * 1024;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

function now(): string { return new Date().toISOString(); }

export class JoomVideoService {
  private readonly running = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly repo: ProductRepository = productRepository) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.resume(), 60_000);
    this.timer.unref();
    void this.resume();
  }

  enqueue(record: ProductRecord, editable: EditableProduct, shopId: string): void {
    const video = editable.video;
    const productId = record.joomProductId;
    if (!video || !productId) return;
    if (record.joomVideo?.sourceUrl === video.url && record.joomVideo.status === 'linked') return;
    this.repo.update(record.id, {
      joomVideo: { status: 'queued', sourceUrl: video.url, shopId, updatedAt: now() },
    });
    void this.processUpload(record.id);
  }

  async retry(productId: string): Promise<ProductRecord> {
    const record = this.repo.get(productId);
    if (!record) throw new MarketplaceError('商品不存在');
    const video = record.edited?.video ?? record.collected.videos?.[0];
    if (!video) throw new MarketplaceError('商品没有可上传的视频');
    const shopId = record.joomVideo?.shopId;
    if (!shopId) throw new MarketplaceError('缺少视频所属店铺，请重新发布一次商品');
    this.repo.update(productId, { joomVideo: { status: 'queued', sourceUrl: video.url, shopId, updatedAt: now() } });
    void this.processUpload(productId);
    return this.repo.get(productId)!;
  }

  async resume(): Promise<void> {
    for (const record of this.repo.list()) {
      const state = record.joomVideo;
      if (!state) continue;
      if (state.status === 'queued' || state.status === 'downloading' || state.status === 'uploading') {
        void this.processUpload(record.id);
      } else if (['processing', 'ready', 'approved'].includes(state.status)) {
        void this.pollAndLink(record.id);
      }
    }
  }

  private adapter(): JoomAdapter {
    return marketplaceRegistry.require('joom') as JoomAdapter;
  }

  private setState(productId: string, patch: Partial<JoomVideoState> & Pick<JoomVideoState, 'status'>): void {
    const record = this.repo.get(productId);
    if (!record?.joomVideo) return;
    this.repo.update(productId, { joomVideo: { ...record.joomVideo, ...patch, updatedAt: now() } });
  }

  private async processUpload(productId: string): Promise<void> {
    if (this.running.has(productId)) return;
    this.running.add(productId);
    try {
      let record = this.repo.get(productId);
      if (!record?.joomVideo || !record.joomProductId) return;
      const source = record.edited?.video ?? record.collected.videos?.find((video) => video.url === record!.joomVideo!.sourceUrl) ?? record.collected.videos?.[0];
      if (!source) throw new Error('本地商品没有可上传的视频素材');
      const shopId = record.joomVideo.shopId;
      if (!shopId) throw new Error('缺少发布店铺信息');

      this.setState(productId, { status: 'downloading', error: undefined });
      const cached = await cacheVideo(source, record.collected.sourceUrl);
      this.persistCachedVideo(record, source, cached);
      const filePath = cached.localAssetId ? videoAssetPath(cached.localAssetId) : null;
      if (!filePath || !fs.existsSync(filePath)) throw new Error('视频本地缓存文件不存在');
      const stat = fs.statSync(filePath);
      if (stat.size < MIN_VIDEO_BYTES || stat.size > MAX_VIDEO_BYTES) throw new Error('Joom 要求视频大小在 10 KB 到 1 GB 之间');
      const md5 = await md5File(filePath);
      const upload = await this.adapter().startVideoUpload({ name: path.basename(filePath), size: stat.size, md5 }, shopId);
      this.setState(productId, { status: 'uploading', uploadId: upload.id, videoId: upload.videoId });

      const completed: Array<{ id: string; etag: string }> = [];
      const handle = await fs.promises.open(filePath, 'r');
      try {
        for (const part of upload.uploadParts) {
          const length = part.bytesTo - part.bytesFrom;
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, part.bytesFrom);
          if (bytesRead !== length) throw new Error(`读取视频分片失败 (${bytesRead}/${length})`);
          const response = await fetch(part.url, {
            method: 'PUT',
            headers: { 'Content-Length': String(length) },
            body: buffer as any,
            signal: AbortSignal.timeout(120_000),
          });
          if (!response.ok) throw new Error(`上传视频分片失败 (${response.status})`);
          const etag = response.headers.get('etag');
          if (!etag) throw new Error('视频分片响应缺少 ETag');
          completed.push({ id: part.id, etag });
        }
      } finally {
        await handle.close();
      }
      await this.adapter().finishVideoUpload(upload.id, completed, shopId);
      this.setState(productId, { status: 'processing', error: undefined });
      auditService.record({ productId, action: 'product.video.upload', summary: 'Joom 视频上传完成，等待处理与审核', after: { videoId: upload.videoId } });
    } catch (error) {
      const message = formatError(error);
      this.setState(productId, { status: 'failed', error: message });
      logger.warn('Joom 商品视频上传失败', { productId, error: message });
    } finally {
      this.running.delete(productId);
    }
  }

  private persistCachedVideo(record: ProductRecord, source: ProductVideo, cached: ProductVideo): void {
    if (cached.localAssetId === source.localAssetId) return;
    const collected = {
      ...record.collected,
      videos: (record.collected.videos ?? []).map((video) => video.url === source.url ? cached : video),
    };
    const edited = record.edited?.video?.url === source.url
      ? { ...record.edited, video: cached }
      : record.edited;
    this.repo.update(record.id, { collected, ...(edited !== record.edited ? { edited } : {}) });
  }

  private async pollAndLink(productId: string): Promise<void> {
    if (this.running.has(productId)) return;
    this.running.add(productId);
    try {
      const record = this.repo.get(productId);
      const state = record?.joomVideo;
      if (!record?.joomProductId || !state?.videoId || !state.shopId) return;
      const remote = await this.adapter().getVideo(state.videoId, state.shopId);
      const status = String(remote?.status || 'processing');
      if (status === 'approved') {
        this.setState(productId, { status: 'approved', error: undefined });
        await this.adapter().linkVideo({ id: record.joomProductId }, state.videoId, state.shopId);
        this.setState(productId, { status: 'linked', error: undefined });
        auditService.record({ productId, action: 'product.video.link', summary: 'Joom 商品视频审核通过并已关联', after: { videoId: state.videoId } });
      } else if (status === 'rejected') {
        const reasons = Array.isArray(remote?.rejectReasons)
          ? remote.rejectReasons.map((item: any) => item.description || item.comment).filter(Boolean).join('；')
          : '';
        this.setState(productId, { status: 'rejected', error: reasons || remote?.moderationComment || 'Joom 视频审核未通过' });
      } else if (status === 'error') {
        this.setState(productId, { status: 'failed', error: remote?.errorType || 'Joom 视频处理失败' });
      } else {
        this.setState(productId, { status: status === 'ready' ? 'ready' : 'processing', error: undefined });
      }
    } catch (error) {
      this.setState(productId, { status: 'failed', error: formatError(error) });
    } finally {
      this.running.delete(productId);
    }
  }
}

async function md5File(filePath: string): Promise<string> {
  const hash = createHash('md5');
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(filePath).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve);
  });
  return hash.digest('hex');
}

function formatError(error: unknown): string {
  if (error instanceof MarketplaceError) {
    const detail = error.details?.map((item) => item.message).join('；');
    return `${error.message}${detail ? `：${detail}` : ''}`;
  }
  return (error as Error).message;
}

export const joomVideoService = new JoomVideoService();

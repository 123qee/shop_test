import { v4 as uuid } from 'uuid';
import type { PublishJob, PublishJobItem } from '@shared/types';
import { getDb } from '../db/index.js';
import { productRepository } from '../repositories/product-repository.js';
import { PublishShopError, shopService } from './shop-service.js';
import { publishService } from './publish-service.js';
import { requireNoPendingPublishReview } from './publish-reconciliation.js';
import { logger } from '../util/logger.js';
import { PublishValidationError } from './validation.js';
import { MarketplaceError } from '../marketplaces/types.js';

interface JobRow { id: string; shop_id: string; created_at: string; queue_order: number }
interface ItemRow { product_id: string; status: PublishJobItem['status']; error: string | null; joom_product_id: string | null }

export class PublishJobInputError extends Error {}

class PublishJobService {
  private working = false;

  private schedule() {
    setImmediate(() => { void this.run().catch((error) => logger.error('后台发布队列异常', { message: String(error) })); });
  }

  get(id: string): PublishJob | null {
    const db = getDb();
    const row = db.prepare('SELECT rowid AS queue_order, * FROM publish_jobs WHERE id = ?').get(id) as JobRow | undefined;
    if (!row) return null;
    const items = db.prepare('SELECT * FROM publish_job_items WHERE job_id = ? ORDER BY position').all(id) as ItemRow[];
    const ahead = db.prepare(`
      SELECT COUNT(*) AS count
      FROM publish_job_items i
      JOIN publish_jobs j ON j.id = i.job_id
      WHERE i.status IN ('queued', 'running') AND j.rowid < ?
    `).get(row.queue_order) as { count: number };
    return {
      id: row.id,
      shopId: row.shop_id,
      createdAt: row.created_at,
      aheadCount: ahead.count,
      items: items.map((item) => ({
        productId: item.product_id,
        status: item.status,
        error: item.error ?? undefined,
        joomProductId: item.joom_product_id ?? undefined,
      })),
    };
  }

  recent(limit = 5): PublishJob[] {
    const db = getDb();
    // Always return every active task in execution order. Recent completed tasks
    // are appended afterwards so a newly queued job cannot hide the running job.
    const active = db.prepare(`
      SELECT j.id
      FROM publish_jobs j
      WHERE EXISTS (
        SELECT 1 FROM publish_job_items i
        WHERE i.job_id = j.id AND i.status IN ('queued', 'running', 'needs_review')
      )
      ORDER BY j.rowid
    `).all() as Array<{ id: string }>;
    const completed = db.prepare(`
      SELECT j.id
      FROM publish_jobs j
      WHERE NOT EXISTS (
        SELECT 1 FROM publish_job_items i
        WHERE i.job_id = j.id AND i.status IN ('queued', 'running', 'needs_review')
      )
      ORDER BY j.rowid DESC
      LIMIT ?
    `).all(Math.min(20, Math.max(1, limit))) as Array<{ id: string }>;
    return [...active, ...completed].map(({ id }) => this.get(id)!);
  }

  hasActive(): boolean {
    return Boolean(getDb().prepare("SELECT 1 FROM publish_job_items WHERE status IN ('queued', 'running') LIMIT 1").get());
  }

  isProductActive(id: string): boolean {
    return Boolean(getDb().prepare("SELECT 1 FROM publish_job_items WHERE product_id = ? AND status IN ('queued', 'running') LIMIT 1").get(id));
  }

  enqueue(ids: string[], requestedShopId: unknown): PublishJob {
    const shopId = shopService.confirmPublishTarget(requestedShopId);
    const unique = [...new Set(ids.map(String))];
    if (!unique.length || unique.length > 500) throw new PublishJobInputError('请选择 1–500 个商品');
    const db = getDb();
    const jobId = uuid();
    db.transaction(() => {
      for (const id of unique) {
        requireNoPendingPublishReview(id);
        const record = productRepository.get(id);
        if (!record) throw new PublishJobInputError(`商品不存在：${id}`);
        if (record.status === 'discarded') throw new PublishJobInputError('废弃箱商品不能发布，请先恢复');
        if (db.prepare("SELECT 1 FROM publish_job_items WHERE product_id = ? AND status IN ('queued', 'running')").get(id)) {
          throw new PublishJobInputError('所选商品已有发布任务，请等待任务完成');
        }
      }
      db.prepare('INSERT INTO publish_jobs (id, shop_id, created_at) VALUES (?, ?, ?)').run(jobId, shopId, new Date().toISOString());
      // JSON null means the new worker has not handed anything to Joom. SQL NULL is an older task.
      const insert = db.prepare("INSERT INTO publish_job_items (job_id, product_id, status, position, submission) VALUES (?, ?, 'queued', ?, 'null')");
      unique.forEach((id, position) => insert.run(jobId, id, position));
    })();
    this.schedule();
    return this.get(jobId)!;
  }

  pause(id: string): PublishJob | null {
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM publish_jobs WHERE id = ?').get(id)) return null;
    // 正在进行的 HTTP 请求无法安全中断；只暂停尚未开始的条目。
    db.prepare("UPDATE publish_job_items SET status = 'paused', error = NULL WHERE job_id = ? AND status = 'queued'").run(id);
    return this.get(id);
  }

  start() {
    const db = getDb();
    const message = '服务在发布过程中重启，结果可能已提交到 Joom；请先核对店铺，再重试';
    db.transaction(() => {
      db.prepare("UPDATE publish_job_items SET status = 'failed', error = ? WHERE status = 'running' AND submission = 'null'")
        .run('服务在向 Joom 发送商品前已停止，可手动重试。');
      const interrupted = db.prepare("SELECT product_id FROM publish_job_items WHERE status = 'running'").all() as Array<{ product_id: string }>;
      db.prepare("UPDATE publish_job_items SET status = 'needs_review', error = ? WHERE status = 'running'").run(message);
      for (const { product_id } of interrupted) {
        const record = productRepository.get(product_id);
        if (record?.status === 'publishing') productRepository.update(product_id, { status: 'failed', lastError: message });
      }
    })();
    this.schedule();
  }

  private async run() {
    if (this.working) return;
    this.working = true;
    const db = getDb();
    try {
      for (;;) {
        const next = db.prepare(`
          SELECT i.job_id, i.product_id, j.shop_id FROM publish_job_items i
          JOIN publish_jobs j ON j.id = i.job_id
          WHERE i.status = 'queued' ORDER BY j.rowid, i.position LIMIT 1
        `).get() as { job_id: string; product_id: string; shop_id: string } | undefined;
        if (!next) break;
        db.prepare("UPDATE publish_job_items SET status = 'running' WHERE job_id = ? AND product_id = ?").run(next.job_id, next.product_id);
        try {
          await publishService.publish(next.product_id, 'joom', next.shop_id, next.job_id);
        } catch (error) {
          const message = error instanceof PublishValidationError
            ? error.issues.filter((issue) => issue.severity === 'error').map((issue) => `${issue.field ? `${issue.field}: ` : ''}${issue.message}`).join('；') || error.message
            : error instanceof MarketplaceError
              ? error.message + (error.details?.length ? `：${error.details.map((detail) => detail.message).join('；')}` : '')
              : error instanceof Error ? error.message : String(error);
          const changed = db.prepare("UPDATE publish_job_items SET status = 'failed', error = ? WHERE job_id = ? AND product_id = ? AND status = 'running'")
            .run(message, next.job_id, next.product_id);
          const record = productRepository.get(next.product_id);
          if (changed.changes && record && record.status !== 'discarded' && !(error instanceof PublishShopError)) {
            productRepository.update(next.product_id, { status: 'failed', lastError: message });
          }
          logger.error('后台发布失败', { productId: next.product_id, message });
        }
      }
    } finally {
      this.working = false;
    }
  }
}

export const publishJobService = new PublishJobService();

import { randomUUID } from 'node:crypto';
import type { CollectBatchDetail, CollectBatchItem, CollectBatchSummary } from '@shared/collect-batches';
import type { CollectResponse, SourcePlatform } from '@shared/types';
import { getDb } from '../db/index.js';

const summaryQuery = `
  SELECT b.id, b.source, b.created_at AS createdAt, b.template_id AS templateId, count(i.url) AS total,
    sum(i.status = 'collected') AS collected, sum(i.status = 'duplicate') AS duplicate,
    sum(i.status = 'failed') AS failed, sum(i.status = 'pending') AS pending
  FROM collect_batches b JOIN collect_batch_items i ON i.batch_id = b.id`;

export const collectBatches = {
  create(source: SourcePlatform, urls: string[], templateId?: string) {
    const db = getDb();
    const id = randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO collect_batches(id, source, created_at, template_id) VALUES (?, ?, ?, ?)')
        .run(id, source, new Date().toISOString(), templateId ?? null);
      const insert = db.prepare('INSERT INTO collect_batch_items(batch_id, position, url) VALUES (?, ?, ?)');
      [...new Set(urls)].forEach((url, index) => insert.run(id, index, url));
    })();
    return id;
  },

  list(offset: number, limit: number): CollectBatchSummary[] {
    return getDb().prepare(`${summaryQuery}
      WHERE b.id IN (SELECT id FROM collect_batches ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?)
      GROUP BY b.id ORDER BY b.created_at DESC, b.rowid DESC`).all(limit, offset) as CollectBatchSummary[];
  },

  get(id: string): CollectBatchDetail | undefined {
    const db = getDb();
    const summary = db.prepare(`${summaryQuery} WHERE b.id = ? GROUP BY b.id`).get(id) as CollectBatchSummary | undefined;
    if (!summary) return undefined;
    const items = db.prepare('SELECT url, status, reason, product_id AS productId FROM collect_batch_items WHERE batch_id = ? ORDER BY position')
      .all(id) as CollectBatchItem[];
    return { ...summary, items };
  },

  productIds(id: string): string[] | undefined {
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM collect_batches WHERE id = ?').get(id)) return undefined;
    return db.prepare(`SELECT product_id FROM collect_batch_items WHERE batch_id = ? AND product_id IS NOT NULL
      GROUP BY product_id ORDER BY min(position)`).pluck().all(id) as string[];
  },

  contains(id: string, url: string, source: SourcePlatform): boolean {
    return Boolean(getDb().prepare(`SELECT 1 FROM collect_batch_items i JOIN collect_batches b ON b.id = i.batch_id
      WHERE b.id = ? AND i.url = ? AND b.source = ?`).get(id, url, source));
  },

  success(id: string, url: string, result: CollectResponse) {
    getDb().prepare(`UPDATE collect_batch_items SET status = ?, product_id = ?, reason = NULL
      WHERE batch_id = ? AND url = ? AND status IN ('pending', 'failed')`)
      .run(result.duplicate ? 'duplicate' : 'collected', result.id, id, url);
  },

  failures(id: string, urls: string[], reason: string): boolean {
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM collect_batches WHERE id = ?').get(id)) return false;
    const update = db.prepare(`UPDATE collect_batch_items SET status = 'failed', reason = ?
      WHERE batch_id = ? AND url = ? AND status IN ('pending', 'failed')`);
    db.transaction(() => { for (const url of urls) update.run(reason, id, url); })();
    return true;
  },
};

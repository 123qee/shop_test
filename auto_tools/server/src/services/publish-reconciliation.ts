import { randomUUID } from 'node:crypto';
import type { ProductRecord, PublishJobItemStatus, PublishReviewAction } from '@shared/types';
import { getDb } from '../db/index.js';
import { collectionKeys } from '../db/collection-keys.js';
import { marketplaceRegistry } from '../marketplaces/registry.js';
import { MarketplaceError, type RemoteProduct } from '../marketplaces/types.js';
import { productRepository } from '../repositories/product-repository.js';
import { shopService, PublishShopError } from './shop-service.js';
import { syncService } from './sync-service.js';
import { auditService } from './audit-service.js';

interface Submission {
  sku: string;
  remoteId?: string;
  storeId?: string;
  editedAt?: string;
}

export function requireNoPendingPublishReview(productId: string) {
  const shop = getDb().prepare(`SELECT j.shop_id FROM publish_job_items i JOIN publish_jobs j ON i.job_id = j.id
    WHERE i.product_id = ? AND i.status = 'needs_review' LIMIT 1`).pluck().get(productId) as string | undefined;
  if (shop) {
    throw new PublishShopError('该商品有一笔发布结果待核对，请先到「' + (shopService.getProfile(shop)?.name || shop) + '」的发布清单核对线上结果。', 409);
  }
}

// Persist the actual outgoing identifiers before the remote write, including direct API calls.
export function beginPublishSubmission(productId: string, shopId: string, submission: Submission, queuedJob?: string): string {
  const db = getDb();
  return db.transaction(() => {
    requireNoPendingPublishReview(productId);
    const json = JSON.stringify(submission);
    if (queuedJob) {
      const updated = db.prepare("UPDATE publish_job_items SET submission = ? WHERE job_id = ? AND product_id = ? AND status = 'running'").run(json, queuedJob, productId);
      if (!updated.changes) throw new PublishShopError('发布任务状态已更改，请刷新后查看。', 409);
      return queuedJob;
    }
    if (db.prepare("SELECT 1 FROM publish_job_items WHERE product_id = ? AND status IN ('queued', 'running')").get(productId)) {
      throw new PublishShopError('商品已有发布任务，请等待完成。', 409);
    }
    const jobId = randomUUID();
    db.prepare('INSERT INTO publish_jobs (id, shop_id, created_at) VALUES (?, ?, ?)').run(jobId, shopId, new Date().toISOString());
    db.prepare("INSERT INTO publish_job_items (job_id, product_id, status, position, submission) VALUES (?, ?, 'running', 0, ?)").run(jobId, productId, json);
    return jobId;
  })();
}

export function finishPublishSubmission(jobId: string, productId: string, status: PublishJobItemStatus, error?: string, remoteId?: string) {
  getDb().prepare('UPDATE publish_job_items SET status = ?, error = ?, joom_product_id = ? WHERE job_id = ? AND product_id = ?')
    .run(status, error ?? null, remoteId ?? null, jobId, productId);
}

interface ReviewRow { shop_id: string; created_at: string; status: PublishJobItemStatus; submission: string | null; joom_product_id: string | null }

function reviewRow(jobId: string, productId: string, requestedShop: unknown): ReviewRow {
  const row = getDb().prepare(`SELECT j.shop_id, j.created_at, i.status, i.submission, i.joom_product_id FROM publish_jobs j
    JOIN publish_job_items i ON i.job_id = j.id WHERE j.id = ? AND i.product_id = ?`).get(jobId, productId) as ReviewRow | undefined;
  if (!row) throw new PublishShopError('发布任务不存在。', 404);
  if (shopService.confirmPublishTarget(requestedShop) !== row.shop_id) throw new PublishShopError('请切回此次提交的目标店铺核对。', 409);
  if (row.status !== 'needs_review') throw new PublishShopError('这笔任务已处理，请刷新发布清单。', 409);
  return row;
}

function submissionOf(row: ReviewRow, record: ProductRecord): Submission {
  if (row.submission) return JSON.parse(row.submission) as Submission;
  if (record.editedAt && record.editedAt > row.created_at) throw new PublishShopError('旧任务未记录提交 SKU，草稿后来有修改，请人工核对原店铺。', 409);
  const listings = record.joomListings?.filter((entry) => entry.shopId === row.shop_id && entry.present) ?? [];
  if (listings.length > 1 || (!listings.length && record.joomListings?.some((entry) => entry.present))) {
    throw new PublishShopError('旧任务缺少明确的原店铺刊登，请人工核对。', 409);
  }
  return {
    sku: record.edited?.sku || record.collected.generatedSku || record.collected.sourceProductId,
    remoteId: listings[0]?.joomProductId || record.joomProductId,
    storeId: shopService.getStoreId(row.shop_id),
    editedAt: record.editedAt,
  };
}

async function lookup(shopId: string, sent: Submission): Promise<RemoteProduct | undefined> {
  const adapter = marketplaceRegistry.require('joom', shopId);
  if (!await adapter.isConnected()) throw new PublishShopError('原店铺未连接，暂时无法核对。', 409);
  if (!sent.remoteId && !sent.sku) throw new PublishShopError('缺少提交时的商品 ID 和 SKU，请人工核对。', 409);
  const configuredStore = shopService.getStoreId(shopId);
  if (sent.storeId && configuredStore && sent.storeId !== configuredStore) {
    throw new PublishShopError('目标店铺的 storeId 在提交后有更改，请人工核对。', 409);
  }
  const expectedStore = sent.storeId || configuredStore;
  // An immutable remote ID identifies an existing listing without downloading the shop.
  if (sent.remoteId && adapter.getProduct) {
    let exact: RemoteProduct | undefined;
    try { exact = await adapter.getProduct({ id: sent.remoteId }); }
    catch (error) {
      if (!(error instanceof MarketplaceError) || !error.message.includes('Joom 请求失败 (404)')) throw error;
    }
    if (exact) {
      const raw = exact.raw as { id?: string; storeId?: string } | undefined;
      if (exact.shopId !== shopId || raw?.id !== sent.remoteId || (expectedStore && raw?.storeId !== expectedStore)
        || (sent.sku && exact.sku !== sent.sku)) {
        throw new PublishShopError('平台返回的商品 ID、SKU 或店铺与原提交不一致，请人工核对。', 409);
      }
      return exact;
    }
    if (!sent.sku) return undefined;
  }
  // A single SKU lookup cannot detect two matches. Partial pages and permission errors must propagate.
  if (!adapter.listProducts) throw new PublishShopError('无法按 SKU 完整核对目标店铺。', 409);
  const products = await adapter.listProducts(shopId);
  const byId = new Map<string, RemoteProduct>();
  for (const row of products) {
    if (!(sent.remoteId && row.id === sent.remoteId) && !(sent.sku && row.sku === sent.sku)) continue;
    const raw = row.raw as { storeId?: string } | undefined;
    if (!row.id || row.shopId !== shopId || (expectedStore && raw?.storeId !== expectedStore)) {
      throw new PublishShopError('平台返回的匹配记录无法确认店铺归属，请人工核对。', 409);
    }
    byId.set(row.id, row);
  }
  if (!byId.size) {
    if (products.some((item) => !item.sku)) throw new PublishShopError('店铺返回的部分刊登缺少 SKU，无法确定商品是否存在，请人工核对。', 409);
    return undefined;
  }
  const match = byId.values().next().value;
  if (!match || byId.size !== 1 || (sent.remoteId && match.id !== sent.remoteId) || (sent.sku && match.sku && sent.sku !== match.sku)) {
    throw new PublishShopError('线上商品 ID 与 SKU 存在多个或不一致的匹配，请人工核对。', 409);
  }
  return match;
}

function requireUniqueLocalOwner(productId: string, shopId: string, sent: Submission, remoteId: string) {
  const db = getDb();
  const other = db.prepare(`SELECT 1 FROM joom_shop_listings WHERE shop_id = ? AND joom_product_id = ?
    AND product_id IS NOT NULL AND product_id <> ?`).get(shopId, remoteId, productId);
  const otherId = db.prepare('SELECT 1 FROM products WHERE joom_product_id = ? AND id <> ?').get(remoteId, productId);
  const { editedSku, generatedSku, sourceId } = collectionKeys;
  const otherSku = !sent.remoteId && db.prepare(`SELECT 1 FROM products WHERE id <> @productId AND status <> 'discarded'
    AND (${editedSku} = @sku OR ${generatedSku} = @sku OR ${sourceId} = @sku)
    AND COALESCE(NULLIF(${editedSku}, ''), NULLIF(${generatedSku}, ''), ${sourceId}) = @sku LIMIT 1`).get({ productId, sku: sent.sku });
  if (other || otherId || otherSku) throw new PublishShopError('本地其他商品也使用此 SKU 或线上 ID，请人工核对归属。', 409);
}

function statusAfterLink(record: ProductRecord, sent: Submission) {
  return record.status === 'edited' || record.editedAt !== sent.editedAt ? 'edited' : 'published';
}

/** Reconciliation only reads Joom. Local linkage, task state and audit are committed together. */
export async function reconcilePublish(jobId: string, productId: string, requestedShop: unknown, action: PublishReviewAction): Promise<string> {
  const row = reviewRow(jobId, productId, requestedShop);
  const db = getDb();
  if (action === 'release') {
    const message = '已人工核对并结束本次任务。如需重新发布，请再次确认目标店铺。';
    db.transaction(() => {
      reviewRow(jobId, productId, requestedShop);
      finishPublishSubmission(jobId, productId, 'failed', message);
      if (productRepository.get(productId)?.status === 'failed') productRepository.update(productId, { lastError: message });
      auditService.record({ productId, action: 'product.reconcile', summary: message, after: { shopId: row.shop_id, jobId } });
    })();
    return message;
  }
  const record = productRepository.get(productId);
  if (!record || record.status === 'discarded') throw new PublishShopError('该商品已删除或移入废弃箱。需要关联时请先恢复商品。', 409);
  const sent = submissionOf(row, record);
  if (action === 'confirm-update') {
    if (!row.joom_product_id || row.joom_product_id !== record.joomProductId) throw new PublishShopError('请先核对原店的线上刊登。', 409);
    const remoteId = row.joom_product_id;
    const message = '已人工确认原店铺的线上更新。';
    db.transaction(() => {
      reviewRow(jobId, productId, requestedShop);
      productRepository.update(productId, { status: statusAfterLink(record, sent), lastError: '' });
      finishPublishSubmission(jobId, productId, 'succeeded', undefined, remoteId);
      auditService.record({ productId, action: 'product.reconcile', summary: message, after: { shopId: row.shop_id, jobId, remoteId } });
    })();
    return message;
  }
  const match = await lookup(row.shop_id, sent);
  return db.transaction(() => {
    reviewRow(jobId, productId, requestedShop);
    const current = productRepository.get(productId);
    if (!current || current.status === 'discarded') throw new PublishShopError('本地商品已删除或废弃，请核对。', 409);
    let message: string;
    if (!match) {
      message = '原店铺暂未找到匹配商品。如已确认未提交，可手动重试。';
      finishPublishSubmission(jobId, productId, 'failed', message);
      if (current.status === 'failed' || current.status === 'publishing') productRepository.update(productId, { status: 'failed', lastError: message });
    } else {
      requireUniqueLocalOwner(productId, row.shop_id, sent, match.id);
      if ((current.joomProductId && current.joomProductId !== match.id) ||
        current.joomListings?.some((entry) => entry.shopId === row.shop_id && entry.present && entry.joomProductId !== match.id)) {
        throw new PublishShopError('该商品已关联其他线上 ID，请人工核对。', 409);
      }
      if (match.state === 'archived' || match.state === 'notFound') throw new PublishShopError('找到的刊登已归档或失效，请人工核对。', 409);
      syncService.saveRemoteStatus(current, match);
      if (sent.remoteId) {
        message = '已核对原店刊登 ' + match.id + '。线上商品存在，本次更新的字段是否生效仍需人工确认。';
        // Its existence predates the update. Keep the item visible for manual confirmation.
        finishPublishSubmission(jobId, productId, 'needs_review', message, match.id);
      } else {
        message = '已关联原店铺刊登 ' + match.id + '。';
        productRepository.update(productId, { status: statusAfterLink(current, sent), lastError: '' });
        finishPublishSubmission(jobId, productId, 'succeeded', undefined, match.id);
      }
    }
    auditService.record({ productId, action: 'product.reconcile', summary: message, after: { shopId: row.shop_id, jobId, remoteId: match?.id } });
    return message;
  })();
}

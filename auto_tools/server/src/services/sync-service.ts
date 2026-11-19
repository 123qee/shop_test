import type { JoomShopStatusSummary, JoomShopSyncResult, JoomSyncItem, ProductRecord } from '@shared/types';
import { productRepository, type ProductPatch, type ProductRepository } from '../repositories/product-repository.js';
import { joomListingRepository } from '../repositories/joom-listing-repository.js';
import { marketplaceRegistry } from '../marketplaces/registry.js';
import { MarketplaceError, type RemoteProduct } from '../marketplaces/types.js';
import { auditService } from './audit-service.js';
import { logger } from '../util/logger.js';
import { shopService } from './shop-service.js';

const FALLBACK_CONCURRENCY = 3;

function isListingCandidate(record: ProductRecord): boolean {
  if (record.joomProductId) return true;
  return record.status === 'published' || record.status === 'publishing' || record.status === 'failed';
}

function localSku(record: ProductRecord): string {
  return record.edited?.sku || record.collected.generatedSku || record.collected.sourceProductId || '';
}

export class SyncService {
  constructor(private readonly repo: ProductRepository = productRepository) {}

  /** 单商品状态同步：只写店铺快照，不覆盖本地草稿。 */
  async sync(id: string, marketplaceId = 'joom'): Promise<ProductRecord> {
    const record = this.repo.get(id);
    if (!record) throw new MarketplaceError('商品不存在');
    const adapter = marketplaceRegistry.require(marketplaceId);
    if (!adapter.getProduct) throw new MarketplaceError(`${adapter.name} 暂不支持商品同步`);
    const remote = await adapter.getProduct({
      id: record.joomProductId,
      sku: localSku(record),
    });
    return this.saveRemoteStatus(record, remote);
  }

  saveRemoteStatus(record: ProductRecord, remote: RemoteProduct): ProductRecord {
    const now = new Date().toISOString();
    if (remote.shopId) {
      joomListingRepository.upsertShopListing(
        remote.shopId,
        remote.shopName || shopService.getProfile(remote.shopId)?.name || remote.shopId,
        remote,
        record.id,
        now,
      );
    }
    const next = this.applyRemoteStatus(record, remote, now);
    auditService.record({
      productId: record.id,
      action: 'product.sync',
      summary: `同步 Joom 状态${remote.state ? `（${remote.state}）` : ''}`,
      before: { joomState: record.joomState, joomInventory: record.joomInventory },
      after: { joomState: next.joomState, joomInventory: next.joomInventory, joomIssues: next.joomIssues },
    });
    return next;
  }

  async syncMany(ids: string[], marketplaceId = 'joom'): Promise<JoomSyncItem[]> {
    const out: JoomSyncItem[] = [];
    for (const id of ids) {
      try {
        const r = await this.sync(id, marketplaceId);
        out.push({ id, ok: true, state: r.joomState });
      } catch (e) {
        out.push({ id, ok: false, error: (e as Error).message });
      }
    }
    return out;
  }

  /**
   * 按每个已连接店铺分别拉取完整商品快照。未在某一家店铺找到的本地商品
   * 不会因此被标记为全局下架；店铺总数按远端列表直接统计，含未采集商品。
   */
  async syncShop(marketplaceId = 'joom'): Promise<JoomShopSyncResult> {
    const adapter = marketplaceRegistry.require(marketplaceId);
    const now = new Date().toISOString();
    if (marketplaceId !== 'joom') {
      const locals = this.repo.list().filter(isListingCandidate);
      return this.syncShopByIds(locals, marketplaceId, now);
    }
    const listProducts = adapter.listProducts?.bind(adapter);
    if (!listProducts) throw new MarketplaceError(`${adapter.name} 暂不支持整店商品同步`);

    const profiles = shopService.getPublic().profiles;
    const connectedProfiles = profiles.filter((profile) => profile.connected);
    if (!connectedProfiles.length) throw new MarketplaceError('没有已连接的 Joom 店铺，请先完成授权');

    const locals = this.repo.list();
    const activeShopId = shopService.getActiveId();
    const bySku = new Map<string, ProductRecord | null>();
    const byLegacyId = new Map<string, ProductRecord>();
    const byShopId = new Map<string, ProductRecord>();
    for (const local of locals) {
      const sku = localSku(local).trim();
      if (sku) bySku.set(sku, bySku.has(sku) ? null : local);
      if (local.joomProductId) byLegacyId.set(local.joomProductId, local);
      for (const listing of local.joomListings ?? []) {
        byShopId.set(`${listing.shopId}\u0000${listing.joomProductId}`, local);
      }
    }

    const failedItems: JoomSyncItem[] = [];
    let matchedCount = 0;
    let unmatchedRemote = 0;
    for (const profile of connectedProfiles) {
      try {
        const remotes = (await listProducts(profile.id)).filter((remote) => remote.id);
        const snapshot = remotes.map((remote) => {
          const local = byShopId.get(`${profile.id}\u0000${remote.id}`)
            ?? (profile.id === activeShopId ? byLegacyId.get(remote.id) : undefined)
            ?? (remote.sku ? bySku.get(remote.sku.trim()) ?? undefined : undefined);
          if (local) {
            matchedCount++;
            if (profile.id === activeShopId && (!local.joomProductId || local.joomProductId === remote.id)) {
              this.applyRemoteStatus(local, remote, now);
            }
          } else {
            unmatchedRemote++;
          }
          return { remote, productId: local?.id };
        });
        joomListingRepository.replaceShopSnapshot(profile.id, profile.name, snapshot, now);
      } catch (error) {
        const message = (error as Error).message;
        logger.warn('Joom 店铺状态同步失败', { shopId: profile.id, shopName: profile.name, error: message });
        joomListingRepository.recordShopSyncError(profile.id, profile.name, message);
        failedItems.push({ id: profile.id, shopId: profile.id, shopName: profile.name, ok: false, error: message });
      }
    }

    const overview = this.getShopStatusSummary();
    auditService.record({
      action: 'product.sync-shop',
      summary: `同步 Joom 店铺状态：匹配 ${matchedCount} 个店铺刊登，另有 ${unmatchedRemote} 个商品未关联本地记录${failedItems.length ? `，${failedItems.length} 个店铺同步失败` : ''}`,
      after: { matchedCount, unmatchedRemote, failed: failedItems.length, lastSyncedAt: overview.lastSyncedAt },
    });

    return {
      ok: matchedCount,
      failed: failedItems.length,
      unmatchedLocal: 0,
      unmatchedRemote,
      lastSyncedAt: overview.lastSyncedAt ?? now,
      usedFallback: false,
      failedItems,
      overview,
    };
  }

  getShopStatusSummary(): JoomShopStatusSummary {
    const profiles = shopService.getPublic().profiles.map(({ id, name, connected }) => ({ id, name, connected }));
    return joomListingRepository.getSummary(profiles);
  }

  private async syncShopByIds(locals: ProductRecord[], marketplaceId: string, now: string): Promise<JoomShopSyncResult> {
    const failedItems: JoomSyncItem[] = [];
    let ok = 0;
    await mapPool(locals, FALLBACK_CONCURRENCY, async (local) => {
      try {
        await this.sync(local.id, marketplaceId);
        ok++;
      } catch (e) {
        failedItems.push({ id: local.id, ok: false, error: (e as Error).message });
      }
    });
    auditService.record({
      action: 'product.sync-shop',
      summary: `同步店铺状态（逐条）：成功 ${ok} 个，失败 ${failedItems.length} 个`,
      after: { ok, failed: failedItems.length, usedFallback: true, attemptedAt: now },
    });
    return {
      ok,
      failed: failedItems.length,
      unmatchedLocal: 0,
      unmatchedRemote: 0,
      lastSyncedAt: now,
      usedFallback: true,
      failedItems,
      overview: this.getShopStatusSummary(),
    };
  }

  private applyRemoteStatus(record: ProductRecord, remote: RemoteProduct, now: string): ProductRecord {
    const patch: ProductPatch = {
      joomProductId: remote.id || record.joomProductId,
      joomState: remote.state,
      joomUpdatedAt: remote.updateTimestamp,
      lastSyncedAt: now,
      joomInventory: remote.inventory ?? 0,
      joomHasActiveVersion: Boolean(remote.hasActiveVersion),
      joomIssues: remote.issues || '',
      joomIssueDetails: remote.issueDetails ?? [],
    };
    return this.repo.update(record.id, patch)!;
  }

}

async function mapPool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) || 0 }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export const syncService = new SyncService();

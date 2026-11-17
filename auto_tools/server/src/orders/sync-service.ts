import { v4 as uuid } from 'uuid';
import { chinaDayStartIso, isDateString, type OrderShopRef, type OrderSyncJob } from '@shared/orders';
import { config } from '../config/index.js';
import { MarketplaceError } from '../marketplaces/types.js';
import { orderRepository, shopKey, type OrderSyncState } from '../repositories/order-repository.js';
import { logger } from '../util/logger.js';
import { OrderInputError } from './errors.js';
import { orderSourceRegistry } from './registry.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 增量同步往回多拉一段，避免两端时钟差或接口延迟漏单；重复的订单按订单号覆盖。 */
const OVERLAP_MS = 10 * 60 * 1000;

export function errorText(error: unknown): string {
  if (error instanceof MarketplaceError) {
    const details = error.details?.map((detail) => detail.message).filter(Boolean) ?? [];
    return details.length ? `${error.message}：${details.join('；')}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 这次从什么时候开始拉：
 * - 首次：回溯 syncLookbackDays 天；
 * - 之后：从上次同步到的时间减重叠开始；
 * - 用户选的下单日期早于本地已覆盖范围时，从那天开始补拉（下单时间 ≤ 更新时间，所以用更新时间过滤不会漏）。
 */
export function syncSince(state: OrderSyncState | null, now: Date, from?: string): Date {
  const lookback = new Date(now.getTime() - config.orders.syncLookbackDays * DAY_MS);
  let since = state?.syncedUntil ? new Date(new Date(state.syncedUntil).getTime() - OVERLAP_MS) : lookback;
  if (from && isDateString(from)) {
    const wanted = new Date(chinaDayStartIso(from));
    const covered = state?.coveredFrom ? new Date(state.coveredFrom) : undefined;
    if (!covered || wanted < covered) since = new Date(Math.min(since.getTime(), wanted.getTime()));
  }
  return since;
}

/** 订单同步任务：串行执行，进度落库，刷新页面不丢；服务重启时进行中的任务标为中断。 */
export class OrderSyncService {
  private working = false;

  enqueue(shops: OrderShopRef[], from?: string): OrderSyncJob {
    const unique = [...new Map(shops.map((shop) => [shopKey(shop.platform, shop.shopId), shop])).values()];
    if (!unique.length) throw new OrderInputError('请至少选择一家店铺');
    const progress = unique.map(({ platform, shopId }) => {
      const source = orderSourceRegistry.get(platform);
      if (!source) throw new OrderInputError(`不支持的平台：${platform}`);
      const shop = source.listShops().find((item) => item.shopId === shopId);
      if (!shop) throw new OrderInputError(`店铺不存在：${shopId}`);
      if (!shop.connected) throw new OrderInputError(`「${shop.shopName}」还没有授权，请先到店铺设置里完成授权`);
      return { platform, shopId, shopName: shop.shopName, status: 'pending' as const, fetched: 0, pages: 0 };
    });
    const job: OrderSyncJob = { id: uuid(), status: 'queued', createdAt: new Date().toISOString(), shops: progress };
    orderRepository.createSyncJob(job, { ...(from && isDateString(from) ? { from } : {}) });
    this.schedule();
    return job;
  }

  get(id: string): OrderSyncJob | null {
    return orderRepository.getSyncJob(id);
  }

  /** 服务启动时调用：上次没跑完的任务标记中断，排队中的继续执行。 */
  start(): void {
    for (const job of orderRepository.listSyncJobs('running')) {
      job.status = 'interrupted';
      job.finishedAt = new Date().toISOString();
      for (const shop of job.shops) {
        if (shop.status === 'running' || shop.status === 'pending') {
          shop.status = 'failed';
          shop.error = '服务重启，同步被中断；重新同步即可（已拉到的订单不会重复）';
        }
      }
      orderRepository.saveSyncJob(job);
    }
    this.schedule();
  }

  private schedule(): void {
    setImmediate(() => {
      void this.run().catch((error) => logger.error('订单同步队列异常', { message: errorText(error) }));
    });
  }

  private async run(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const next = orderRepository.nextQueuedSyncJob();
        if (!next) break;
        const { job, params } = next;
        job.status = 'running';
        orderRepository.saveSyncJob(job);
        for (const shop of job.shops) {
          shop.status = 'running';
          orderRepository.saveSyncJob(job);
          try {
            await this.syncShop(shop, params.from, () => orderRepository.saveSyncJob(job));
            shop.status = 'succeeded';
          } catch (error) {
            shop.status = 'failed';
            shop.error = errorText(error);
            logger.warn('订单同步失败', { platform: shop.platform, shopId: shop.shopId, message: shop.error });
          }
          orderRepository.saveSyncJob(job);
        }
        const failed = job.shops.filter((shop) => shop.status === 'failed').length;
        job.status = failed === 0 ? 'succeeded' : failed === job.shops.length ? 'failed' : 'partial';
        job.finishedAt = new Date().toISOString();
        orderRepository.saveSyncJob(job);
      }
    } finally {
      this.working = false;
    }
  }

  private async syncShop(shop: OrderSyncJob['shops'][number], from: string | undefined, onProgress: () => void): Promise<void> {
    const source = orderSourceRegistry.require(shop.platform);
    const startedAt = new Date();
    const since = syncSince(orderRepository.getSyncState(shop.platform, shop.shopId), startedAt, from);
    shop.since = since.toISOString();
    try {
      for await (const page of source.fetchOrders(shop.shopId, { since })) {
        orderRepository.upsertOrders(page);
        shop.fetched += page.length;
        shop.pages += 1;
        onProgress();
      }
      orderRepository.markSyncSuccess(shop.platform, shop.shopId, {
        syncedUntil: startedAt.toISOString(),
        since: since.toISOString(),
        at: new Date().toISOString(),
      });
      logger.info('订单同步完成', { platform: shop.platform, shopId: shop.shopId, fetched: shop.fetched, pages: shop.pages });
    } catch (error) {
      orderRepository.markSyncFailure(shop.platform, shop.shopId, errorText(error), new Date().toISOString());
      throw error;
    }
  }
}

export const orderSyncService = new OrderSyncService();

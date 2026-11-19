import type {
  BatchPublishItem,
  BatchRemoveRemoteItem,
  BatchValidateItem,
  EditableProduct,
  JoomRemoveReason,
  ProductRecord,
  ValidationIssue,
} from '@shared/types';
import { productRepository, type ProductRepository } from '../repositories/product-repository.js';
import { joomListingRepository } from '../repositories/joom-listing-repository.js';
import { marketplaceRegistry } from '../marketplaces/registry.js';
import { MarketplaceError, PublishReceiptError, type MarketplaceAdapter } from '../marketplaces/types.js';
import { getDb } from '../db/index.js';
import { beginPublishSubmission, finishPublishSubmission, requireNoPendingPublishReview } from './publish-reconciliation.js';
import { transformPipeline, type TransformPipeline } from '../transforms/pipeline.js';
import { logger } from '../util/logger.js';
import { deriveEditable } from './product-service.js';
import { applyDefaults } from './defaults.js';
import { settingsService } from './settings-service.js';
import { PublishShopError, shopService } from './shop-service.js';
import { PublishValidationError, validateForPublish } from './validation.js';
import { auditService } from './audit-service.js';
import { loadOfficialJoomColors, normalizeProductColors } from './listing-language.js';
import { rewriteEditableImages } from './image-service.js';
import { syncService } from './sync-service.js';
import { joomVideoService } from './joom-video-service.js';

export interface PublishOutcome {
  record: ProductRecord;
}

export interface DuplicateVariantRepairItem {
  id: string;
  joomProductId?: string;
  ok: boolean;
  dryRun?: boolean;
  skipped?: boolean;
  duplicateGroups: number;
  removeCount: number;
  verified?: boolean;
  error?: string;
}

interface RawJoomVariant {
  id?: unknown;
  sku?: unknown;
  colors?: unknown;
  color?: unknown;
  size?: unknown;
  attributes?: unknown;
}

interface DuplicateVariantPlan {
  duplicateGroups: number;
  remove: Array<{ id?: string; sku?: string }>;
  repaired: EditableProduct;
}

function targetListing(record: ProductRecord, shopId?: string) {
  if (!shopId || !record.joomListings?.length) return undefined;
  const matches = record.joomListings.filter((entry) => entry.shopId === shopId && entry.present);
  const listing = matches.find((entry) => entry.joomProductId === record.joomProductId) ?? (matches.length === 1 ? matches[0] : undefined);
  if (!listing && matches.length > 1) throw new PublishShopError('目标店铺存在多个匹配的刊登，请先核对线上商品 ID。', 409);
  if (!listing && (record.joomProductId || record.joomListings.some((entry) => entry.present))) {
    throw new PublishShopError('目标店铺没有该商品的有效刊登，请核对店铺及商品状态后重试。', 409);
  }
  return listing;
}

/**
 * 发布编排:取可编辑数据 -> 过 transform 管线 -> 交给目标平台 adapter 发布 -> 回写状态。
 * 平台无关,通过 registry + adapter 抽象;加平台不改此处。
 */
export class PublishService {
  constructor(
    private readonly repo: ProductRepository = productRepository,
    private readonly pipeline: TransformPipeline = transformPipeline,
  ) {}

  /** 取商品的可编辑数据(优先 edited,否则采集派生并套用预设)。 */
  private editableOf(record: ProductRecord, shopId?: string): EditableProduct {
    const raw = record.edited
      ? record.edited
      : applyDefaults(deriveEditable(record.collected), settingsService.getDefaultsFor(record.templateId, shopId));
    const targetStore = shopService.getStoreId(shopId);
    if (shopId && !targetStore && raw.storeId && shopService.getConfig().profiles.some((p) => p.id !== shopId && p.storeId === raw.storeId)) {
      throw new PublishShopError('商品草稿的 storeId 属于其他店铺，请检查草稿中的店铺设置。', 409);
    }
    return rewriteEditableImages({
      ...raw,
      storeId: shopId ? targetStore || raw.storeId : raw.storeId || targetStore,
    });
  }

  /** 校验某商品是否可发布(字段 + 图片 + 类目必填属性),返回 issues。 */
  async validate(id: string, marketplaceId = 'joom'): Promise<ValidationIssue[]> {
    const record = this.repo.get(id);
    if (!record) throw new MarketplaceError('商品不存在');
    const adapter = marketplaceRegistry.require(marketplaceId);
    const editable = this.editableOf(record);
    const requiredAttributeIds = await this.gatherRequiredAttributes(adapter, editable);
    const allowedColors = marketplaceId === 'joom' ? await loadOfficialJoomColors() : undefined;
    const normalized = normalizeProductColors(editable, { officialColors: allowedColors }).product;
    return validateForPublish(normalized, { requiredAttributeIds, allowedColors });
  }

  private async gatherRequiredAttributes(
    adapter: MarketplaceAdapter,
    editable: EditableProduct,
  ): Promise<Array<{ id: string; name: string }>> {
    if (!editable.categoryId || !adapter.getRequiredAttributes) return [];
    try {
      return await adapter.getRequiredAttributes(editable.categoryId);
    } catch (e) {
      logger.warn('拉取类目必填属性失败,跳过该项校验', { message: (e as Error).message });
      return [];
    }
  }

  /** 批量校验:逐个校验,互不影响,返回每个商品的结果。 */
  async validateMany(ids: string[], marketplaceId = 'joom'): Promise<BatchValidateItem[]> {
    const out: BatchValidateItem[] = [];
    for (const id of ids) {
      try {
        const issues = await this.validate(id, marketplaceId);
        out.push({ id, issues, ok: !issues.some((i) => i.severity === 'error') });
      } catch (e) {
        out.push({ id, issues: [{ field: '', message: (e as Error).message, severity: 'error' }], ok: false });
      }
    }
    return out;
  }

  /**
   * 批量发布:顺序执行(尊重 Joom 限流),单个失败不影响其余,返回每项结果。
   * 每个商品仍会先经过发布前校验(publish 内置)。
   */
  async publishMany(ids: string[], marketplaceId = 'joom', shopId = marketplaceId === 'joom' ? shopService.getActiveId() : undefined): Promise<BatchPublishItem[]> {
    const out: BatchPublishItem[] = [];
    for (const id of ids) {
      try {
        const rec = await this.publish(id, marketplaceId, shopId);
        out.push({ id, ok: true, joomProductId: rec.joomProductId });
      } catch (e) {
        if (e instanceof PublishValidationError) {
          out.push({ id, ok: false, error: e.message, issues: e.issues });
        } else {
          const message =
            e instanceof MarketplaceError
              ? e.message + (e.details?.length ? ': ' + e.details.map((d) => d.message).join('; ') : '')
              : (e as Error).message;
          out.push({ id, ok: false, error: message });
        }
      }
    }
    return out;
  }

  /**
   * 批量修复线上重复变体：重新提交本地保留的 SKU 后，只删除当前 Joom
   * 商品中重复规格的多余变体，并在删除后重新读取确认。
   */
  async repairDuplicateVariantsMany(
    ids?: string[],
    marketplaceId = 'joom',
    dryRun = false,
    shopId = marketplaceId === 'joom' ? shopService.getActiveId() : undefined,
  ): Promise<DuplicateVariantRepairItem[]> {
    const records = (ids?.length
      ? ids.map((id) => this.repo.get(id)).filter((record): record is ProductRecord => Boolean(record))
      : this.repo.list().filter(hasDuplicateVariantIssue));
    const adapter = marketplaceRegistry.require(marketplaceId, shopId);
    if (!(await adapter.isConnected())) {
      throw new MarketplaceError(`尚未连接 ${adapter.name},请先完成授权`);
    }
    if (!dryRun && !adapter.removeVariants) {
      throw new MarketplaceError(`${adapter.name} 暂不支持删除商品变体`);
    }

    const out: DuplicateVariantRepairItem[] = [];
    for (const record of records) {
      out.push(await this.repairDuplicateVariantsOne(record, adapter, marketplaceId, dryRun, shopId));
    }
    return out;
  }

  private async repairDuplicateVariantsOne(
    record: ProductRecord,
    adapter: MarketplaceAdapter,
    marketplaceId: string,
    dryRun: boolean,
    shopId?: string,
  ): Promise<DuplicateVariantRepairItem> {
    const base: DuplicateVariantRepairItem = {
      id: record.id,
      joomProductId: record.joomProductId,
      ok: false,
      dryRun,
      duplicateGroups: 0,
      removeCount: 0,
    };
    let step = '读取线上商品';
    try {
      const remoteId = targetListing(record, shopId)?.joomProductId ?? record.joomProductId;
      if (!remoteId) throw new MarketplaceError('缺少 Joom 商品 id');
      base.joomProductId = remoteId;
      if (!adapter.getProduct) throw new MarketplaceError(`${adapter.name} 暂不支持读取商品`);
      const remoteBefore = await adapter.getProduct({ id: remoteId });
      const plan = buildDuplicateVariantPlan(this.storedEditableOf(record, shopId), remoteBefore.raw);
      const planned = { ...base, duplicateGroups: plan.duplicateGroups, removeCount: plan.remove.length };
      if (!plan.duplicateGroups) return { ...planned, ok: true, skipped: true, verified: true };
      if (!plan.remove.length) throw new MarketplaceError('发现重复规格，但线上变体缺少可删除的 id/SKU，已跳过');
      if (dryRun) return { ...planned, ok: true };

      this.repo.update(record.id, { edited: plan.repaired, status: 'edited', lastError: '' });
      step = '更新 Joom 商品';
      await this.publish(record.id, marketplaceId, shopId);
      step = '删除 Joom 重复变体';
      await adapter.removeVariants!({ id: remoteId }, plan.remove);

      step = '复核线上商品';
      const remoteAfter = await adapter.getProduct!({ id: remoteId });
      const remaining = countDuplicateVariantGroups(remoteAfter.raw);
      try {
        syncService.saveRemoteStatus(record, remoteAfter);
      } catch (syncError) {
        logger.warn('重复变体修复后同步状态失败', { id: record.id, error: (syncError as Error).message });
      }
      auditService.record({
        productId: record.id,
        action: 'product.repairDuplicateVariants',
        summary: remaining ? `重复变体修复后仍剩余 ${remaining} 组` : '已修复线上重复变体',
        before: { duplicateGroups: plan.duplicateGroups, removeCount: plan.remove.length },
        after: { duplicateGroups: remaining },
      });
      return { ...planned, ok: remaining === 0, verified: remaining === 0, error: remaining ? `仍有 ${remaining} 组重复变体` : undefined };
    } catch (e) {
      return { ...base, error: `${step}: ${formatMarketplaceError(e)}` };
    }
  }

  /** 与 editableOf 相同的数据来源，但不重写图片，避免批量修复改动无关字段。 */
  private storedEditableOf(record: ProductRecord, shopId?: string): EditableProduct {
    return record.edited
      ? record.edited
      : applyDefaults(deriveEditable(record.collected), settingsService.getDefaultsFor(record.templateId, shopId));
  }

  /**
   * 批量从 Joom 删除线上商品。顺序执行以尊重限流；单条失败不影响其余。
   * `ids` 为本地采集箱 id；`extraRemoteIds` 为未入库的 Joom 商品 id（例如 ID 检索未命中）。
   * 删除不可恢复。成功后默认把本地记录移入废弃箱并清空 joomProductId，以便之后可重新发布。
   */
  async removeMany(
    ids: string[],
    options: { reason: JoomRemoveReason; deleteLocal?: boolean; extraRemoteIds?: string[] },
    marketplaceId = 'joom',
    shopId = marketplaceId === 'joom' ? shopService.getActiveId() : undefined,
  ): Promise<BatchRemoveRemoteItem[]> {
    const adapter = marketplaceRegistry.require(marketplaceId, shopId);
    if (!(await adapter.isConnected())) {
      throw new MarketplaceError(`尚未连接 ${adapter.name},请先完成授权`);
    }
    if (!adapter.remove) {
      throw new MarketplaceError(`${adapter.name} 暂不支持删除线上商品`);
    }

    const out: BatchRemoveRemoteItem[] = [];
    const processedRemote = new Set<string>();

    for (const id of ids) {
      const record = this.repo.get(id);
      if (!record) {
        out.push({ id, ok: false, error: '商品不存在' });
        continue;
      }
      const sku = record.edited?.sku || record.collected.generatedSku || record.collected.sourceProductId || '';
      let joomId: string;
      try {
        joomId = targetListing(record, shopId)?.joomProductId || record.joomProductId?.trim() || '';
      } catch (error) {
        out.push({ id, ok: false, error: formatMarketplaceError(error) });
        continue;
      }
      if (!joomId && !sku) {
        out.push({ id, ok: false, error: '没有 Joom 商品 id 或 SKU，无法删除线上商品' });
        continue;
      }
      if (!joomId && record.status !== 'published' && record.status !== 'publishing' && record.status !== 'failed') {
        out.push({ id, ok: false, error: '未发布到 Joom，没有线上商品可删' });
        continue;
      }
      const item = await this.removeOne(adapter, record, { id: joomId || undefined, sku: joomId ? undefined : sku }, options, shopId);
      if (joomId) processedRemote.add(joomId);
      out.push(item);
    }

    const localCandidates = options.extraRemoteIds?.length ? this.repo.list() : [];
    for (const remoteId of options.extraRemoteIds ?? []) {
      const joomId = remoteId.trim();
      if (!joomId || processedRemote.has(joomId)) continue;
      const local = localCandidates.find((p) => p.joomProductId === joomId || p.joomListings?.some((l) => l.joomProductId === joomId));
      if (local && ids.includes(local.id)) continue;
      if (shopId && local?.joomListings?.length && !local.joomListings.some((l) => l.shopId === shopId && l.joomProductId === joomId && l.present)) {
        out.push({ id: local.id, joomProductId: joomId, ok: false, error: '指定的线上商品不在目标店铺的有效刊登中' });
        continue;
      }
      const item = await this.removeOne(
        adapter,
        local ?? null,
        { id: joomId },
        options,
        shopId,
        local?.id ?? joomId,
      );
      processedRemote.add(joomId);
      out.push(item);
    }

    return out;
  }

  private async removeOne(
    adapter: MarketplaceAdapter,
    record: ProductRecord | null,
    reference: { id?: string; sku?: string },
    options: { reason: JoomRemoveReason; deleteLocal?: boolean },
    shopId?: string,
    resultId = record?.id ?? reference.id ?? reference.sku ?? '',
  ): Promise<BatchRemoveRemoteItem> {
    const joomProductId = reference.id || record?.joomProductId;
    try {
      await adapter.remove!(reference, options.reason);
      return this.afterRemoteRemoved(record, {
        id: resultId,
        ok: true,
        joomProductId,
        deleteLocal: options.deleteLocal,
      }, shopId);
    } catch (e) {
      if (isRemoteAlreadyGone(e)) {
        if (shopId && record && !record.joomListings?.some((entry) => entry.shopId === shopId && entry.joomProductId === joomProductId)) {
          return { id: resultId, ok: false, joomProductId, error: '目标店铺未找到该商品，无法确认归属，本地记录已保留。' };
        }
        return this.afterRemoteRemoved(record, {
          id: resultId,
          ok: true,
          joomProductId,
          alreadyGone: true,
          deleteLocal: options.deleteLocal,
        }, shopId);
      }
      return { id: resultId, ok: false, joomProductId, error: formatMarketplaceError(e) };
    }
  }

  private afterRemoteRemoved(
    record: ProductRecord | null,
    base: { id: string; ok: true; joomProductId?: string; alreadyGone?: boolean; deleteLocal?: boolean },
    shopId?: string,
  ): BatchRemoveRemoteItem {
    if (shopId && base.joomProductId) joomListingRepository.markAbsent(shopId, base.joomProductId);
    if (!record) {
      return { id: base.id, ok: true, joomProductId: base.joomProductId, alreadyGone: base.alreadyGone };
    }
    const now = new Date().toISOString();
    if (base.deleteLocal) {
      this.repo.delete(record.id);
      auditService.record({
        productId: record.id,
        action: 'product.removeRemote',
        summary: base.alreadyGone ? 'Joom 商品已不存在，已删除本地记录' : '已从 Joom 删除并删除本地记录',
        before: { status: record.status, joomProductId: record.joomProductId },
        after: undefined,
      });
      logger.info('已从 Joom 删除商品（含本地）', { id: record.id, joomProductId: base.joomProductId, alreadyGone: base.alreadyGone });
      return { ...base, deletedLocal: true };
    }

    const remaining = shopId ? record.joomListings?.find((l) => l.present && (l.shopId !== shopId || l.joomProductId !== base.joomProductId)) : undefined;
    if (remaining) {
      this.repo.update(record.id, { joomProductId: remaining.joomProductId, joomState: remaining.state,
        joomInventory: remaining.inventory, joomHasActiveVersion: remaining.hasActiveVersion, joomIssues: remaining.issues || '', joomIssueDetails: remaining.issueDetails ?? [] });
      auditService.record({ productId: record.id, action: 'product.removeRemote', summary: '已从目标店铺删除，保留其他线上刊登', after: { shopId, joomProductId: base.joomProductId } });
      return base;
    }
    this.repo.update(record.id, {
      status: 'discarded',
      joomProductId: '',
      joomState: 'archived',
      joomHasActiveVersion: false,
      joomInventory: 0,
      joomIssues: '',
      joomIssueDetails: [],
      lastError: '',
      lastSyncedAt: now,
    });
    auditService.record({
      productId: record.id,
      action: 'product.removeRemote',
      summary: base.alreadyGone ? 'Joom 商品已不存在，本地已移入废弃箱' : '已从 Joom 删除，本地已移入废弃箱',
      before: { status: record.status, joomProductId: record.joomProductId, joomState: record.joomState },
      after: { status: 'discarded', joomState: 'archived' },
    });
    logger.info('已从 Joom 删除商品', { id: record.id, joomProductId: base.joomProductId, alreadyGone: base.alreadyGone });
    return { ...base, discarded: true };
  }

  async publish(id: string, marketplaceId = 'joom', shopId = marketplaceId === 'joom' ? shopService.getActiveId() : undefined, queuedJob?: string): Promise<ProductRecord> {
    const record = this.repo.get(id);
    if (!record) throw new MarketplaceError('商品不存在');
    if (record.status === 'discarded') {
      throw new MarketplaceError('商品已在废弃箱，请先恢复后再发布');
    }
    if (marketplaceId === 'joom') requireNoPendingPublishReview(id);

    const adapter = marketplaceRegistry.require(marketplaceId, shopId);
    if (!(await adapter.isConnected())) {
      throw new MarketplaceError(`尚未连接 ${adapter.name},请先完成授权`);
    }

    // 发布前校验:存在 error 级问题则不调用 Joom,直接返回问题清单
    const listing = targetListing(record, shopId);
    const remoteId = listing?.joomProductId ?? record.joomProductId;
    let editable = this.editableOf(record, shopId);
    const requiredAttributeIds = await this.gatherRequiredAttributes(adapter, editable);
    const allowedColors = marketplaceId === 'joom' ? await loadOfficialJoomColors(false, shopId) : undefined;
    editable = normalizeProductColors(editable, { officialColors: allowedColors }).product;
    const issues = await validateForPublish(editable, { requiredAttributeIds, allowedColors });
    if (issues.some((i) => i.severity === 'error')) {
      throw new PublishValidationError(issues);
    }

    let trackingId: string | undefined;
    let accepted = false;
    try {
      const processed = await this.pipeline.run(editable, { record, marketplaceId });
      if (marketplaceId === 'joom' && shopId) {
        trackingId = beginPublishSubmission(id, shopId, { sku: processed.sku, remoteId, storeId: processed.storeId, editedAt: record.editedAt }, queuedJob);
      }
      this.repo.update(id, { status: 'publishing', lastError: '' });
      let result;
      if (remoteId) {
        if (!adapter.update) {
          throw new MarketplaceError(`${adapter.name} 暂不支持更新已发布商品`);
        }
        // Joom 优先使用稳定的平台商品 id；若未来某平台没有 id，则可回退到商家 SKU。
        result = await adapter.update(processed, { id: remoteId, sku: processed.sku });
      } else {
        result = await adapter.publish(processed);
      }
      accepted = true;
      return getDb().transaction(() => {
        if (shopId && marketplaceId === 'joom' && result.marketplaceProductId && !listing) {
          joomListingRepository.linkPublishedProduct(
            shopId, shopService.getProfile(shopId)?.name ?? shopId, result.marketplaceProductId, id, processed.title, processed.sku,
          );
        }
        const updated = this.repo.update(id, {
          status: 'published',
          joomProductId: result.marketplaceProductId,
          lastError: '', // 清除上次失败的错误(空串 -> 仓库写入 NULL)
        })!;
        if (marketplaceId === 'joom' && processed.video) {
          const ownerShopId = record.joomListings?.find((listing) => listing.joomProductId === updated.joomProductId)?.shopId;
          joomVideoService.enqueue(updated, processed, shopId || ownerShopId || shopService.getActiveId());
        }
        auditService.record({ productId: id, action: remoteId ? 'product.update' : 'product.publish', summary: remoteId ? '更新 Joom 商品成功' : '发布到 Joom 成功', before: { status: record.status, joomProductId: record.joomProductId }, after: { status: updated.status, joomProductId: updated.joomProductId, shopId } });
        if (trackingId) finishPublishSubmission(trackingId, id, 'succeeded', undefined, result.marketplaceProductId);
        logger.info('发布成功', { id, marketplace: marketplaceId, productId: result.marketplaceProductId });
        return updated;
      })();
    } catch (err) {
      if (err instanceof PublishShopError) {
        if (trackingId) getDb().transaction(() => {
          this.repo.update(id, { status: record.status, lastError: record.lastError ?? '' });
          finishPublishSubmission(trackingId!, id, 'failed', err.message);
        })();
        throw err;
      }
      const message =
        err instanceof MarketplaceError
          ? err.message + (err.details?.length ? ': ' + err.details.map((d) => d.message).join('; ') : '')
          : (err as Error).message;
      const needsReview = err instanceof PublishReceiptError || accepted;
      getDb().transaction(() => {
        this.repo.update(id, { status: 'failed', lastError: message });
        if (trackingId) finishPublishSubmission(trackingId, id, needsReview ? 'needs_review' : 'failed', message);
        auditService.record({
          productId: id,
          action: 'product.publishFailed',
          summary: needsReview ? '发布回执不明确，请核对原店铺' : '发布/更新 Joom 失败',
          before: { status: record.status },
          after: { status: 'failed', error: message, shopId, jobId: trackingId },
        });
      })();
      logger.error('发布失败', { id, message });
      throw err;
    }
  }
}

export const publishService = new PublishService();

function formatMarketplaceError(e: unknown): string {
  if (e instanceof MarketplaceError) {
    return e.message + (e.details?.length ? ': ' + e.details.map((d) => d.message).join('; ') : '');
  }
  return (e as Error).message;
}

/** Joom 返回 404 / 已归档时，线上商品已经不在，视为删除成功。 */
function isRemoteAlreadyGone(e: unknown): boolean {
  const details = e instanceof MarketplaceError ? e.details ?? [] : [];
  const text = [formatMarketplaceError(e), ...details.map((d) => `${d.code ?? ''} ${d.message}`)].join(' ');
  return /404|not[\s_-]*found|找不到|does not exist|already.?removed|archived/i.test(text);
}

function hasDuplicateVariantIssue(record: ProductRecord): boolean {
  if (!record.joomProductId) return false;
  return (record.joomIssueDetails ?? []).some(
    (issue) => issue.code === 'J1140' || /duplicate variants|重复变体/i.test(`${issue.title ?? ''} ${issue.message}`),
  );
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizedText(value: unknown): string {
  if (Array.isArray(value)) return value.map(normalizedText).filter(Boolean).sort().join('&');
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function attributesKey(value: unknown): string {
  const object = asObject(value);
  if (!object) return '';
  return Object.entries(object)
    .map(([key, item]) => `${normalizedText(key)}=${normalizedText(item)}`)
    .filter((item) => !item.endsWith('='))
    .sort()
    .join('&');
}

function variantKey(variant: RawJoomVariant): string {
  return [normalizedText(variant.colors ?? variant.color), normalizedText(variant.size), attributesKey(variant.attributes)].join('|');
}

function rawVariants(raw: unknown): RawJoomVariant[] {
  const root = asObject(raw);
  const data = asObject(root?.data);
  const variants = root?.variants ?? data?.variants;
  return Array.isArray(variants) ? variants.filter((item): item is RawJoomVariant => Boolean(asObject(item))) : [];
}

function variantSku(variant: RawJoomVariant): string {
  return typeof variant.sku === 'string' ? variant.sku.trim() : '';
}

function variantId(variant: RawJoomVariant): string {
  return typeof variant.id === 'string' ? variant.id.trim() : '';
}

function duplicateVariantGroups(raw: unknown): Map<string, RawJoomVariant[]> {
  const groups = new Map<string, RawJoomVariant[]>();
  for (const variant of rawVariants(raw)) {
    const key = variantKey(variant);
    const group = groups.get(key) ?? [];
    group.push(variant);
    groups.set(key, group);
  }
  return new Map([...groups].filter(([, group]) => group.length > 1));
}

function countDuplicateVariantGroups(raw: unknown): number {
  return duplicateVariantGroups(raw).size;
}

function buildDuplicateVariantPlan(editable: EditableProduct, raw: unknown): DuplicateVariantPlan {
  const groups = duplicateVariantGroups(raw);
  const localSkus = new Set(editable.variants.map((variant) => variant.sku.trim()).filter(Boolean));
  const keepByKey = new Map<string, RawJoomVariant>();
  const remove: Array<{ id?: string; sku?: string }> = [];

  for (const [key, group] of groups) {
    const keep = group.find((variant) => localSkus.has(variantSku(variant))) ?? group[0];
    keepByKey.set(key, keep);
    for (const variant of group) {
      if (variant === keep) continue;
      const id = variantId(variant);
      const sku = variantSku(variant);
      if (id || sku) remove.push(id ? { id } : { sku });
    }
  }

  const remoteSkus = new Set(rawVariants(raw).map(variantSku).filter(Boolean));
  const repaired: EditableProduct = {
    ...editable,
    variants: editable.variants.map((variant) => {
      const keep = keepByKey.get(variantKey(variant));
      const keepSku = keep ? variantSku(keep) : '';
      if (!keepSku || remoteSkus.has(variant.sku.trim())) return variant;
      return { ...variant, sku: keepSku };
    }),
  };
  return { duplicateGroups: groups.size, remove, repaired };
}

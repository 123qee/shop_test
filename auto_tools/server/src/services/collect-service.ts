import type { CollectedProduct, CollectTemplateOutcome, GroupTemplateBinding, PresetsConfig, ProductRecord } from '@shared/types';
import { inferProductGrouping } from '@shared/product-grouping';
import { reviewTemplates } from '@shared/template-fit';
import { productRepository, type ProductRepository } from '../repositories/product-repository.js';
import { getDb } from '../db/index.js';
import { settingsService } from './settings-service.js';
import { auditService } from './audit-service.js';
import { logger } from '../util/logger.js';
import { normalizeCollectedImages } from './image-service.js';
import { dedupeCollectedProduct } from './variant-dedupe.js';
import { randomProductSku } from '../util/sku.js';
import { cachePrimaryCollectedVideo } from './video-asset-service.js';

export interface CollectOptions {
  /** picked=用户在采集栏主动选了模板;不传则视为没选(旧版插件也不传)。 */
  templateSource?: 'picked';
}

export interface CollectResult {
  record: ProductRecord;
  /** 同来源同商品已经采过,返回已有记录。 */
  duplicate: boolean;
  /** 新建时的模板处理结果;重复采集时为空。 */
  template?: CollectTemplateOutcome;
}

/**
 * 入库时决定模板:
 * - 采集栏主动选了模板:核对没有矛盾就直接确认,有矛盾留在待确认并记下原因;
 * - 没选:按商品特征推荐一个模板,留待分拣确认;
 * - 旧版插件带来的模板:照旧使用,但不确认(分不清是主动选的还是默认值)。
 */
export function chooseCollectTemplate(
  product: CollectedProduct,
  config: PresetsConfig,
  templateId: string | undefined,
  options: CollectOptions & { bindings?: GroupTemplateBinding[] } = {},
): CollectTemplateOutcome {
  const nameOf = (id: string) => config.templates.find((t) => t.id === id)?.name;
  // 插件页面可能在模板被删除后仍持有旧 ID,此时当作没选。
  const known = templateId && config.templates.some((t) => t.id === templateId) ? templateId : undefined;
  if (known && options.templateSource !== 'picked') {
    return { templateId: known, templateName: nameOf(known), source: 'fallback', confirmed: false, issues: [] };
  }
  const review = reviewTemplates(product, config.templates, {
    grouping: inferProductGrouping(product),
    bindings: options.bindings,
    preferredId: known,
  });
  if (known) {
    const issues = review.fits.find((fit) => fit.templateId === known)?.issues.map((issue) => issue.message) ?? [];
    return { templateId: known, templateName: nameOf(known), source: 'picked', confirmed: !issues.length, issues };
  }
  const suggested = review.suggestion?.templateId;
  if (suggested) return { templateId: suggested, templateName: nameOf(suggested), source: 'suggested', confirmed: false, issues: [] };
  return { templateId: config.activeId, templateName: nameOf(config.activeId), source: 'fallback', confirmed: false, issues: [] };
}

function outcomeSummary(outcome: CollectTemplateOutcome): string {
  const name = `「${outcome.templateName ?? outcome.templateId}」`;
  if (outcome.source === 'picked') {
    return outcome.confirmed
      ? `采集时指定预设${name}，核对无矛盾，已确认`
      : `采集时指定预设${name}，有矛盾待确认：${outcome.issues.join('；')}`;
  }
  if (outcome.source === 'suggested') return `采集时未指定预设，系统推荐${name}，待确认`;
  return `采集时沿用预设${name}，待确认`;
}

/** 接收插件采集数据并入库。 */
export class CollectService {
  constructor(private readonly repo: ProductRepository = productRepository) {}

  async collect(product: CollectedProduct, templateId?: string, options: CollectOptions = {}): Promise<CollectResult> {
    const duplicate = this.repo.findCollected(product);
    if (duplicate && (duplicate.collected.images.length > 0 || product.images.length === 0)) {
      return { record: duplicate, duplicate: true };
    }

    const withImages = await normalizeCollectedImages(dedupeCollectedProduct(product));
    const normalized = duplicate ? withImages : await cachePrimaryCollectedVideo(withImages);

    // Media work can yield to another tab or server process. Make the final lookup,
    // SKU reservation, product insert and audit one write transaction.
    return getDb().transaction((): CollectResult => {
      const existing = this.repo.findCollected(product);
      if (existing) {
        if (existing.collected.images.length || !normalized.images.length) return { record: existing, duplicate: true };
        const repaired = this.repo.update(existing.id, {
          collected: { ...normalized, generatedSku: existing.collected.generatedSku },
        })!;
        logger.info('重复采集补全空图片', { id: repaired.id, imageCount: normalized.images.length });
        return { record: repaired, duplicate: true };
      }
      normalized.generatedSku = randomProductSku((sku) => this.repo.hasSku(sku));
      const template = chooseCollectTemplate(normalized, settingsService.getConfig(), templateId, {
        ...options,
        bindings: settingsService.getGroupTemplateBindings(),
      });
      const record = this.repo.create(normalized, template.templateId, { templateConfirmed: template.confirmed });
      auditService.record({ productId: record.id, action: 'collect.template', summary: outcomeSummary(template), after: template });
      logger.info('采集入库', { id: record.id, title: product.title, source: product.source, template: template.templateId, confirmed: template.confirmed });
      return { record, duplicate: false, template };
    }).immediate();
  }
}

export const collectService = new CollectService();

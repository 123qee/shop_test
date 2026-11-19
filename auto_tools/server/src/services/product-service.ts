import type { CollectDefaults, CollectedProduct, EditableProduct, EditableVariant, ProductRecord, ProductStatus, ProductVideo } from '@shared/types';
import { productRepository, type ProductRepository } from '../repositories/product-repository.js';
import { applyDefaults } from './defaults.js';
import { settingsService } from './settings-service.js';
import { auditService } from './audit-service.js';
import { scoreProduct } from './quality.js';
import { imagesForCollectedSource } from './image-service.js';
import { randomVariantSku } from '../util/sku.js';
import { DEFAULT_JOOM_COLOR, listingHasLanguageRisk, normalizeProductColors } from './listing-language.js';
import { dedupeCollectedVariants, dedupeEditableProduct } from './variant-dedupe.js';
import { cachePrimaryCollectedVideo } from './video-asset-service.js';
import { IMAGE_DELETE_ACTION, snapshot } from './undo-snapshot.js';

/** 草稿图片操作的业务错误(请求参数与当前草稿不一致),由 errorHandler 转为 400。 */
export class DraftImageError extends Error {}

const COLOR_KEYS = ['color', 'colour', '颜色', '色', 'цвет'];
const SIZE_KEYS = ['size', '尺码', '尺寸', 'размер'];

/** 把采集到的通用规格 options 拆成 Joom 的 colors / size / 其他 attributes。 */
function splitOptions(options: Record<string, string>): {
  colors?: string;
  size?: string;
  attributes?: Record<string, string>;
} {
  let colors: string | undefined;
  let size: string | undefined;
  const attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(options)) {
    const kl = k.toLowerCase();
    if (!colors && COLOR_KEYS.some((c) => kl.includes(c))) colors = v;
    else if (!size && SIZE_KEYS.some((s) => kl.includes(s))) size = v;
    else attributes[k] = v;
  }
  return { colors, size, attributes: Object.keys(attributes).length ? attributes : undefined };
}

/**
 * 由采集数据生成默认可编辑草稿:用户未编辑时,发布/后台展示以此为默认值。
 * 集中在此,保证「采集 -> 可编辑」的默认映射一处可改。
 */
export function deriveEditable(collected: CollectedProduct): EditableProduct {
  const productSku = collected.generatedSku || collected.sourceProductId || `sku-${Date.now()}`;
  const usedVariantSkus = new Set<string>();
  const sourceVariants = dedupeCollectedVariants(collected.variants).variants;
  const variants: EditableVariant[] = sourceVariants.length
    ? sourceVariants.map((v) => {
        const { colors, size, attributes } = splitOptions(v.options);
        return {
          sku: randomVariantSku(usedVariantSkus),
          price: v.price ?? collected.price?.value ?? 0,
          inventory: v.stock ?? 999,
          colors: colors ?? DEFAULT_JOOM_COLOR,
          size,
          attributes,
          image: v.image,
        };
      })
    : [
        {
          sku: randomVariantSku(usedVariantSkus),
          price: collected.price?.value ?? 0,
          inventory: 999,
        },
      ];
  return {
    title: collected.title,
    sku: productSku,
    description: collected.description ?? '',
    images: imagesForCollectedSource(collected.images, collected.source),
    video: collected.videos?.[0],
    currency: collected.price?.currency ?? 'USD',
    variants,
  };
}

function variantIdentity(variant: EditableVariant): string {
  const attributes = Object.entries(variant.attributes ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key.trim().toLowerCase(), value.trim().toLowerCase()]);
  return JSON.stringify([
    variant.colors?.trim().toLowerCase() ?? '',
    variant.size?.trim().toLowerCase() ?? '',
    attributes,
  ]);
}

/**
 * 重新套用预设时保留已有变体 SKU。
 * SKU 是 Joom 识别变体的唯一键；同一个颜色/尺码如果被重新生成 SKU，Joom
 * 可能会把它当成新变体追加，而不是更新原变体。
 */
export function preserveVariantSkus(next: EditableVariant[], previous: EditableVariant[]): EditableVariant[] {
  const candidates = new Map<string, EditableVariant[]>();
  for (const variant of previous) {
    const list = candidates.get(variantIdentity(variant)) ?? [];
    list.push(variant);
    candidates.set(variantIdentity(variant), list);
  }

  const usedSkus = new Set<string>();
  return next.map((variant) => {
    const list = candidates.get(variantIdentity(variant)) ?? [];
    const previousVariant = list.find((candidate) => candidate.sku && !usedSkus.has(candidate.sku));
    let sku = previousVariant?.sku || variant.sku;
    if (!sku || usedSkus.has(sku)) sku = randomVariantSku(usedSkus);
    else usedSkus.add(sku);
    return { ...variant, sku };
  });
}

/** 商品的查询/编辑/删除业务。 */
export class ProductService {
  constructor(private readonly repo: ProductRepository = productRepository) {}

  count(): number {
    return this.repo.count();
  }

  list(status?: ProductStatus): ProductRecord[] {
    const validTemplates = new Set(settingsService.getConfig().templates.map((t) => t.id));
    return this.repo.list(status ? { status } : undefined).map((r) => this.withScores(r, validTemplates));
  }

  byIds(ids: string[]): ProductRecord[] {
    const templates = new Set(settingsService.getConfig().templates.map((template) => template.id));
    const defaults = new Map<string | undefined, CollectDefaults>();
    return this.repo.byIds(ids).map((record) => {
      if (!record.edited && !defaults.has(record.templateId)) {
        defaults.set(record.templateId, settingsService.getDefaultsFor(record.templateId));
      }
      return this.withScores(record, templates, defaults.get(record.templateId));
    });
  }

  get(id: string): ProductRecord | null {
    const r = this.repo.get(id);
    return r ? this.withScores(r) : null;
  }

  videoBackfillCandidates(options: { source?: CollectedProduct['source']; since?: string; limit?: number } = {}) {
    const sinceMs = options.since ? Date.parse(options.since) : 0;
    const limit = Math.min(Math.max(options.limit || 500, 1), 5000);
    return this.repo.list()
      .filter((record) => record.status !== 'discarded')
      .filter((record) => !options.source || record.collected.source === options.source)
      .filter((record) => !record.collected.videos?.length)
      .filter((record) => !sinceMs || Date.parse(record.createdAt) >= sinceMs)
      .slice(0, limit)
      .map((record) => ({
        id: record.id,
        source: record.collected.source,
        sourceUrl: record.collected.sourceUrl,
        title: record.collected.title,
        createdAt: record.createdAt,
      }));
  }

  /** 旧商品补采仅合并视频字段，不覆盖标题、图片、变体或其他人工编辑。 */
  async backfillVideos(id: string, videos: ProductVideo[]): Promise<ProductRecord | null> {
    const before = this.repo.get(id);
    if (!before) return null;
    const unique = videos.filter((video, index, all) =>
      all.findIndex((candidate) => candidate.url.replace(/[?#].*$/, '') === video.url.replace(/[?#].*$/, '')) === index,
    ).slice(0, 10);
    const collected = await cachePrimaryCollectedVideo({ ...before.collected, videos: unique });
    const first = collected.videos?.[0];
    const edited = before.edited && first && !before.edited.video
      ? { ...before.edited, video: first }
      : before.edited;
    const saved = this.repo.update(id, { collected, ...(edited !== before.edited ? { edited } : {}) });
    if (saved) {
      auditService.record({
        productId: id,
        action: 'product.video.backfill',
        summary: `补采商品视频 ${unique.length} 个`,
        before: { videos: before.collected.videos ?? [] },
        after: { videos: collected.videos ?? [] },
      });
    }
    return saved;
  }

  private withScores(r: ProductRecord, validTemplates = new Set(settingsService.getConfig().templates.map((t) => t.id)), defaults?: CollectDefaults): ProductRecord {
    const editable = this.getEditable(r, defaults);
    return { ...r, templateConfirmed: Boolean(r.templateConfirmed && validTemplates.has(r.templateId ?? '')), qualityScore: scoreProduct(editable, r), languageRisk: listingHasLanguageRisk(editable) };
  }

  /** 返回用于编辑的数据:优先已编辑,否则由采集派生草稿并套用该商品模板的预设。 */
  getEditable(record: ProductRecord, defaults?: CollectDefaults): EditableProduct {
    const editable = record.edited
      ? record.edited
      : applyDefaults(deriveEditable(record.collected), defaults ?? settingsService.getDefaultsFor(record.templateId));
    // 已保存的旧草稿也要走内置颜色规范化,否则会绕过采集时的默认映射。
    return normalizeProductColors(editable).product;
  }

  saveEdited(id: string, edited: EditableProduct, confirmTemplate = false): ProductRecord | null {
    const before = this.repo.get(id);
    const cleaned = dedupeEditableProduct(normalizeProductColors(edited).product);
    const saved = this.repo.update(id, { edited: cleaned, status: 'edited', templateConfirmed: confirmTemplate && Boolean(before?.templateId && settingsService.getConfig().templates.some((t) => t.id === before.templateId)) ? true : before?.templateConfirmed });
    if (saved) auditService.record({ productId: id, action: 'product.save', summary: '保存商品编辑', before: before ? this.getEditable(before) : undefined, after: cleaned });
    return saved;
  }

  /** 从母库原始数据和可编辑草稿中删除同一张通用图片，避免后续建刊登时图片重新出现。 */
  deleteImage(id: string, imageUrl: string): ProductRecord | null {
    const before = this.repo.get(id);
    if (!before) return null;
    const editable = this.getEditable(before);
    const collected = {
      ...before.collected,
      images: before.collected.images.filter((image) => image !== imageUrl),
      variants: before.collected.variants.map((variant) => variant.image === imageUrl ? { ...variant, image: undefined } : variant),
    };
    const edited = {
      ...editable,
      images: editable.images.filter((image) => image !== imageUrl),
      variants: editable.variants.map((variant) => variant.image === imageUrl ? { ...variant, image: undefined } : variant),
    };
    const saved = this.repo.update(id, { collected, edited, status: 'edited' });
    if (saved) {
      auditService.record({
        productId: id,
        action: 'product.image.delete',
        summary: '删除通用商品图片',
        before: { imageUrl, images: editable.images },
        after: { images: edited.images },
      });
    }
    return saved;
  }

  /**
   * 分拣时删除单张图片：只从可编辑草稿里去掉，采集原始数据保持不变（与编辑页的删除一致）。
   * 草稿会被固化到 edited，之后换模板时这张图不会重新出现。
   */
  removeDraftImage(id: string, imageUrl: string): ProductRecord | null {
    const before = this.repo.get(id);
    if (!before) return null;
    const editable = this.getEditable(before);
    if (!editable.images.includes(imageUrl)) return before;
    const edited: EditableProduct = {
      ...editable,
      images: editable.images.filter((image) => image !== imageUrl),
      variants: editable.variants.map((variant) => variant.image === imageUrl ? { ...variant, image: undefined } : variant),
    };
    const saved = this.repo.update(id, { edited, status: 'edited' });
    if (saved) {
      // 完整前后状态写进审计，撤销时据此还原图片、变体上的图片引用和草稿状态。
      auditService.record({
        productId: id,
        action: IMAGE_DELETE_ACTION,
        summary: '分拣删除商品图片',
        before: { imageUrl, images: editable.images, ...snapshot(before) },
        after: { images: edited.images, ...snapshot(saved) },
      });
    }
    return saved;
  }

  /**
   * 分拣时调整图片顺序(只改可编辑草稿,第一张为主图)。
   * imageUrls 必须与当前草稿是同一组图片,只允许改变顺序;不一致时抛出 DraftImageError。
   */
  reorderDraftImages(id: string, imageUrls: string[]): ProductRecord | null {
    const before = this.repo.get(id);
    if (!before) return null;
    const editable = this.getEditable(before);
    const sortedDraft = [...editable.images].sort();
    const sameSet = imageUrls.length === sortedDraft.length
      && [...imageUrls].sort().every((url, index) => url === sortedDraft[index]);
    if (!sameSet) throw new DraftImageError('图片列表已变化，请刷新后再调整顺序');
    if (imageUrls.every((url, index) => url === editable.images[index])) return before;
    const edited: EditableProduct = { ...editable, images: [...imageUrls] };
    const saved = this.repo.update(id, { edited, status: 'edited' });
    if (saved) {
      auditService.record({
        productId: id,
        action: 'product.image.reorder',
        summary: '分拣调整图片顺序',
        before: { images: editable.images },
        after: { images: edited.images },
      });
    }
    return saved;
  }

  /**
   * 切换商品的预设模板:重置已编辑草稿(按新模板重新生成),状态回到 collected。
   * 返回记录 + 按新模板派生的可编辑草稿。
   */
  setTemplate(id: string, templateId: string): { record: ProductRecord; editable: EditableProduct } | null {
    if (!settingsService.getConfig().templates.some((t) => t.id === templateId)) throw new Error('预设模板不存在');
    const before = this.repo.get(id);
    const previousEditable = before ? this.getEditable(before) : undefined;
    const rec = this.repo.update(id, { templateId, templateConfirmed: true, edited: null, status: 'collected' });
    if (!rec) return null;
    auditService.record({ productId: id, action: 'product.template', summary: `切换预设模板：${templateId}`, before: before?.templateId, after: templateId });
    const fresh = this.getEditable(rec);
    return {
      record: rec,
      editable: previousEditable ? { ...fresh, variants: preserveVariantSkus(fresh.variants, previousEditable.variants) } : fresh,
    };
  }

  /**
   * 手动「应用预设」:用当前模板重新套预设(价格按来源价正确重算),
   * 但保留用户已改的展示字段(标题/SKU/品牌/标签/图片)。不落库,交前端检查后保存。
   */
  applyPresetTo(id: string): { editable: EditableProduct } | null {
    const rec = this.repo.get(id);
    if (!rec) return null;
    const defaults = settingsService.getDefaultsFor(rec.templateId);
    const fresh = applyDefaults(deriveEditable(rec.collected), defaults); // 预设已套、价格从来源价算
    const current = rec.edited ?? fresh;
    const editable: EditableProduct = {
      ...fresh,
      title: current.title,
      sku: current.sku,
      brand: current.brand,
      tags: current.tags,
      images: current.images,
      video: current.video,
      variants: rec.edited ? preserveVariantSkus(fresh.variants, current.variants) : fresh.variants,
    };
    return { editable };
  }

  delete(id: string): boolean {
    const before = this.repo.get(id);
    const ok = this.repo.delete(id);
    if (ok) auditService.record({ productId: id, action: 'product.delete', summary: '删除本地商品', before, after: undefined });
    return ok;
  }

  /** 移入废弃箱：只改本地状态，不影响 Joom 在线商品。 */
  discard(id: string): ProductRecord | null {
    const before = this.repo.get(id);
    if (!before || before.status === 'discarded') return null;
    const discarded = this.repo.update(id, { status: 'discarded' });
    if (discarded) {
      auditService.record({
        productId: id,
        action: 'product.discard',
        summary: '移入废弃箱',
        before: { status: before.status },
        after: { status: discarded.status },
      });
    }
    return discarded ? this.withScores(discarded) : null;
  }

  /** 从废弃箱恢复商品，恢复后回到未发布状态。 */
  restore(id: string): ProductRecord | null {
    const before = this.repo.get(id);
    if (!before || before.status !== 'discarded') return null;
    const restored = this.repo.update(id, { status: 'edited', lastError: '' });
    if (restored) {
      auditService.record({
        productId: id,
        action: 'product.restore',
        summary: '从废弃箱恢复商品',
        before: { status: before.status, lastError: before.lastError },
        after: { status: restored.status },
      });
    }
    return restored;
  }

  rollback(id: string, logId: string): ProductRecord | null {
    const log = auditService.get(logId);
    if (!log || log.productId !== id || !log.before || typeof log.before !== 'object' || !('title' in log.before)) return null;
    const current = this.repo.get(id);
    if (!current) return null;
    const restored = this.repo.update(id, { edited: log.before as EditableProduct, status: 'edited' });
    if (restored) auditService.record({ productId: id, action: 'product.rollback', summary: `恢复到历史版本（${log.summary}）`, before: current.edited, after: log.before });
    return restored;
  }
}

export const productService = new ProductService();

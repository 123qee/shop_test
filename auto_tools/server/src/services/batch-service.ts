import type { BatchOperation, BatchOperationItem } from '@shared/types';
import { productRepository, type ProductRepository } from '../repositories/product-repository.js';
import { settingsService } from './settings-service.js';
import { auditService } from './audit-service.js';
import { normalizeProductColors } from './listing-language.js';
import { inferProductGrouping, isProductGroup, isProductMaterial } from '@shared/product-grouping';
import { currentDraft, rebuildDraftForTemplate } from './template-draft.js';

export class BatchService {
  constructor(private readonly repo: ProductRepository = productRepository) {}

  run(ids: string[], operation: BatchOperation): BatchOperationItem[] {
    return ids.map((id) => {
      const record = this.repo.get(id);
      if (!record) return { id, ok: false, error: '商品不存在' };
      try {
        if (operation.type === 'grouping') {
          if (record.status === 'publishing') throw new Error('商品正在发布，请完成后再调整分组');
          if (record.status === 'discarded') throw new Error('废弃箱商品不能调整分组');
          if (!isProductGroup(operation.groupId) || (operation.material !== undefined && !isProductMaterial(operation.material))) throw new Error('分组或材质无效');
          const before = record.grouping ?? inferProductGrouping(record.collected);
          const next = { groupId: operation.groupId, material: operation.material ?? before.material, source: 'manual' as const, reason: '已手动确认分组' };
          const changed = next.groupId !== before.groupId || next.material !== before.material;
          const saved = this.repo.update(id, { grouping: next, templateConfirmed: changed ? false : record.templateConfirmed });
          if (!saved) throw new Error('商品不存在');
          auditService.record({ productId: id, action: 'batch.grouping', summary: '手动调整商品分组', before, after: next });
          return { id, ok: true };
        }
        if (operation.type === 'template') {
          if (record.status === 'publishing') throw new Error('商品正在发布，请完成后再套用模板');
          if (record.status === 'discarded') throw new Error('废弃箱商品不能套用模板');
          if (!settingsService.getConfig().templates.some((t) => t.id === operation.templateId)) throw new Error('预设模板已删除或不存在，请刷新后重试');
        }
        const before = currentDraft(record);
        let next = before;
        if (operation.type === 'price') {
          next = { ...before, variants: before.variants.map((v) => ({ ...v, price: operation.mode === 'multiply' ? Math.round(v.price * operation.value * 100) / 100 : operation.value })) };
        } else if (operation.type === 'inventory') {
          next = { ...before, variants: before.variants.map((v) => ({ ...v, inventory: Math.max(0, Math.floor(operation.value)) })) };
        } else if (operation.type === 'dangerInfo') {
          next = { ...before, dangerInfo: operation.value };
        } else if (operation.type === 'template') {
          next = rebuildDraftForTemplate(record.collected, before, operation.templateId);
        } else if (operation.type === 'title') {
          const patch = operation.items.find((item) => item.id === id);
          if (!patch?.title?.trim()) throw new Error('缺少新标题');
          next = {
            ...before,
            title: patch.title.trim(),
            tags: patch.tags && patch.tags.length ? patch.tags : before.tags,
          };
        } else if (operation.type === 'normalizeColors') {
          const defaults = settingsService.getDefaultsFor(record.templateId);
          const result = normalizeProductColors(before, {
            colorMap: defaults.colorMap,
            officialColors: operation.officialColors,
          });
          next = result.product;
          this.repo.update(id, { edited: next, status: 'edited', templateId: record.templateId });
          auditService.record({ productId: id, action: 'batch.normalizeColors', summary: `批量规范化颜色：映射 ${result.mappedCount} 个，补齐 ${result.defaultedCount} 个`, before, after: next });
          const extra =
            result.unresolved.length
              ? `未识别：${result.unresolved.join('、')}`
              : result.mappedCount || result.defaultedCount
                ? `映射 ${result.mappedCount} 个颜色，自动补齐 ${result.defaultedCount} 个颜色`
                : '颜色已是英文';
          return {
            id,
            ok: true,
            mappedCount: result.mappedCount,
            defaultedCount: result.defaultedCount,
            unresolved: result.unresolved,
            error: result.unresolved.length ? extra : undefined,
          };
        }
        this.repo.update(id, { edited: next, status: 'edited', templateId: operation.type === 'template' ? operation.templateId : record.templateId, templateConfirmed: operation.type === 'template' ? true : record.templateConfirmed });
        auditService.record({ productId: id, action: `batch.${operation.type}`, summary: `批量操作：${operation.type}`, before, after: next });
        return { id, ok: true };
      } catch (e) { return { id, ok: false, error: (e as Error).message }; }
    });
  }
}

export const batchService = new BatchService();

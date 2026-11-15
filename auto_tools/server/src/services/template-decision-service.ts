import type { ProductRecord, TemplateDecisionResult } from '@shared/types';
import { productRepository, type ProductRepository } from '../repositories/product-repository.js';
import { settingsService } from './settings-service.js';
import { auditService } from './audit-service.js';
import { productService } from './product-service.js';
import { currentDraft, rebuildDraftForTemplate } from './template-draft.js';
import {
  IMAGE_DELETE_ACTION,
  TEMPLATE_DECISION_ACTION,
  UNDO_ACTION,
  findUndoTarget,
  isSnapshot,
  sameState,
  snapshot,
} from './undo-snapshot.js';

export { TEMPLATE_DECISION_ACTION };
export const TEMPLATE_DECISION_UNDO_ACTION = UNDO_ACTION;

/** 分拣操作的业务错误；status 对应 HTTP 状态码。 */
export class TemplateDecisionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * 采集箱分拣：一次确认一件商品的模板。
 * - 选的就是当前模板：只标记确认，草稿不动；
 * - 换模板且没编辑过：只换模板，草稿继续跟随模板实时生成；
 * - 换模板且编辑过：和快捷模板一样重建草稿，标题、SKU、图片保持不变。
 */
export class TemplateDecisionService {
  constructor(private readonly repo: ProductRepository = productRepository) {}

  decide(id: string, templateId: string): TemplateDecisionResult {
    const record = this.repo.get(id);
    if (!record) throw new TemplateDecisionError('商品不存在', 404);
    if (record.status === 'publishing') throw new TemplateDecisionError('商品正在发布，请完成后再确认模板', 409);
    if (record.status === 'discarded') throw new TemplateDecisionError('废弃箱商品不能确认模板');
    const template = settingsService.getConfig().templates.find((t) => t.id === templateId);
    if (!template) throw new TemplateDecisionError('预设模板已删除或不存在，请刷新后重试');

    const before = snapshot(record);
    const action: TemplateDecisionResult['action'] = record.templateId === templateId ? 'confirmed' : 'changed';
    const saved = action === 'confirmed'
      ? this.repo.update(id, { templateConfirmed: true })
      : record.edited
        ? this.repo.update(id, {
          templateId,
          templateConfirmed: true,
          edited: rebuildDraftForTemplate(record.collected, currentDraft(record), templateId),
          status: 'edited',
        })
        : this.repo.update(id, { templateId, templateConfirmed: true });
    if (!saved) throw new TemplateDecisionError('商品不存在', 404);
    auditService.record({
      productId: id,
      action: TEMPLATE_DECISION_ACTION,
      summary: action === 'confirmed' ? `分拣确认预设「${template.name}」` : `分拣改用预设「${template.name}」`,
      before,
      after: snapshot(saved),
    });
    return { record: productService.get(id)!, action };
  }

  /**
   * 撤销这件商品最近一次可撤销的操作（分拣套模板，或分拣时删图）。
   * 按审计日志的栈顺序取目标；商品之后又被改过时拒绝，避免覆盖新的修改。
   */
  undo(id: string): ProductRecord {
    const record = this.repo.get(id);
    if (!record) throw new TemplateDecisionError('商品不存在', 404);
    if (record.status === 'publishing') throw new TemplateDecisionError('商品正在发布，不能撤销', 409);
    const target = findUndoTarget(auditService.list({ productId: id, limit: 200 }));
    if (!target || !isSnapshot(target.before) || !isSnapshot(target.after)) {
      throw new TemplateDecisionError('没有可以撤销的记录', 409);
    }
    if (!sameState(snapshot(record), target.after)) throw new TemplateDecisionError('这件商品之后又被修改过，不能撤销', 409);
    const restored = this.repo.update(id, {
      templateId: target.before.templateId,
      templateConfirmed: target.before.templateConfirmed,
      status: target.before.status,
      edited: target.before.edited,
      editedAt: target.before.editedAt,
    });
    if (!restored) throw new TemplateDecisionError('商品不存在', 404);
    auditService.record({
      productId: id,
      action: UNDO_ACTION,
      summary: target.action === IMAGE_DELETE_ACTION ? '撤销删图' : '撤销分拣',
      before: target.after,
      after: target.before,
    });
    return productService.get(id)!;
  }
}

export const templateDecisionService = new TemplateDecisionService();

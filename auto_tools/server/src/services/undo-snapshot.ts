import type { AuditLogEntry, EditableProduct, ProductRecord, ProductStatus } from '@shared/types';

/** 撤销标记：每条撤销都会写一条，用来抵消一条可撤销动作。 */
export const UNDO_ACTION = 'sort.undo';
export const TEMPLATE_DECISION_ACTION = 'sort.template';
export const IMAGE_DELETE_ACTION = 'product.image.delete';

/** 可以撤销的动作。撤销所需的完整状态记在审计日志的 before / after 里，撤销时由服务端读取，不信任前端传值。 */
export const UNDOABLE_ACTIONS = new Set<string>([TEMPLATE_DECISION_ACTION, IMAGE_DELETE_ACTION]);

export interface UndoSnapshot {
  templateId: string | null;
  templateConfirmed: boolean;
  status: ProductStatus;
  edited: EditableProduct | null;
  editedAt: string | null;
}

export function snapshot(record: ProductRecord): UndoSnapshot {
  return {
    templateId: record.templateId ?? null,
    templateConfirmed: Boolean(record.templateConfirmed),
    status: record.status,
    edited: record.edited,
    editedAt: record.editedAt ?? null,
  };
}

export function sameState(a: UndoSnapshot, b: UndoSnapshot): boolean {
  return a.templateId === b.templateId
    && a.templateConfirmed === b.templateConfirmed
    && a.status === b.status
    && JSON.stringify(a.edited) === JSON.stringify(b.edited);
}

export function isSnapshot(value: unknown): value is UndoSnapshot {
  return Boolean(value && typeof value === 'object' && 'templateConfirmed' in value && 'status' in value && 'edited' in value);
}

/**
 * 从审计日志（按时间倒序）里找出现在应该撤销的那一条。
 * 像栈一样处理：每条撤销标记抵消最近一条还没被抵消的可撤销动作，剩下的第一条就是目标。
 * 找不到返回 null。
 */
export function findUndoTarget(entries: AuditLogEntry[]): AuditLogEntry | null {
  let cancelled = 0;
  for (const entry of entries) {
    if (entry.action === UNDO_ACTION) {
      cancelled += 1;
      continue;
    }
    if (!UNDOABLE_ACTIONS.has(entry.action)) continue;
    if (cancelled > 0) {
      cancelled -= 1;
      continue;
    }
    return entry;
  }
  return null;
}

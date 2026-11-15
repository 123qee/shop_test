import type { CollectedProduct, EditableProduct, ProductRecord, ProductStatus } from '@shared/types';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/index.js';
import { inferProductGrouping } from '@shared/product-grouping';
import { joomListingRepository } from './joom-listing-repository.js';

/** update 可改字段(edited 传 null 显式清空;templateId 用于切换模板) */
export type ProductPatch = Partial<
  Pick<
    ProductRecord,
    | 'status'
    | 'joomProductId'
    | 'lastError'
    | 'grouping'
    | 'templateConfirmed'
    | 'joomState'
    | 'joomUpdatedAt'
    | 'lastSyncedAt'
    | 'joomInventory'
    | 'joomHasActiveVersion'
    | 'joomIssues'
    | 'joomIssueDetails'
    | 'joomVideo'
  >
> & {
  collected?: CollectedProduct;
  edited?: EditableProduct | null;
  /** null 显式清空(撤销分拣时还原没有模板的旧记录)。 */
  templateId?: string | null;
  /** 显式还原编辑时间;不传时,修改 edited 会把编辑时间记为当前时间。 */
  editedAt?: string | null;
};

export interface ProductCreateOptions {
  /** 采集栏主动选择的模板核对无矛盾时,入库即确认。 */
  templateConfirmed?: boolean;
}

/** 数据访问接口。业务层只依赖接口,便于替换存储实现或做测试。 */
export interface ProductRepository {
  create(collected: CollectedProduct, templateId?: string, options?: ProductCreateOptions): ProductRecord;
  list(filter?: { status?: ProductStatus }): ProductRecord[];
  get(id: string): ProductRecord | null;
  update(id: string, patch: ProductPatch): ProductRecord | null;
  delete(id: string): boolean;
}

interface Row {
  id: string;
  status: string;
  collected: string;
  edited: string | null;
  joom_product_id: string | null;
  last_error: string | null;
  template_id: string | null;
  grouping: string | null;
  template_confirmed: number;
  joom_state: string | null;
  joom_updated_at: string | null;
  last_synced_at: string | null;
  joom_inventory: number | null;
  joom_has_active_version: number | null;
  joom_issues: string | null;
  joom_issue_details: string | null;
  joom_video: string | null;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
}

function rowToRecord(row: Row): ProductRecord {
  const collected = JSON.parse(row.collected) as CollectedProduct;
  return {
    id: row.id,
    status: row.status as ProductStatus,
    collected,
    grouping: row.grouping ? JSON.parse(row.grouping) : inferProductGrouping(collected),
    templateConfirmed: Boolean(row.template_confirmed),
    edited: row.edited ? (JSON.parse(row.edited) as EditableProduct) : null,
    joomProductId: row.joom_product_id ?? undefined,
    lastError: row.last_error ?? undefined,
    templateId: row.template_id ?? undefined,
    joomState: row.joom_state ?? undefined,
    joomUpdatedAt: row.joom_updated_at ?? undefined,
    lastSyncedAt: row.last_synced_at ?? undefined,
    joomInventory: row.joom_inventory ?? undefined,
    joomHasActiveVersion: row.joom_has_active_version == null ? undefined : Boolean(row.joom_has_active_version),
    joomIssues: row.joom_issues ?? undefined,
    joomIssueDetails: row.joom_issue_details ? JSON.parse(row.joom_issue_details) : undefined,
    joomVideo: row.joom_video ? JSON.parse(row.joom_video) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    editedAt: row.edited_at ?? undefined,
  };
}

function attachJoomListings(records: ProductRecord[]): ProductRecord[] {
  const listings = joomListingRepository.listForProducts(records.map((record) => record.id));
  return records.map((record) => ({ ...record, joomListings: listings.get(record.id) ?? [] }));
}

export class SqliteProductRepository implements ProductRepository {
  create(collected: CollectedProduct, templateId?: string, options: ProductCreateOptions = {}): ProductRecord {
    const now = new Date().toISOString();
    const id = uuid();
    getDb()
      .prepare(
        `INSERT INTO products (id, status, collected, edited, template_id, grouping, template_confirmed, created_at, updated_at)
         VALUES (?, 'collected', ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        JSON.stringify(collected),
        templateId ?? null,
        JSON.stringify(inferProductGrouping(collected)),
        options.templateConfirmed && templateId ? 1 : 0,
        now,
        now,
      );
    return this.get(id)!;
  }

  list(filter?: { status?: ProductStatus }): ProductRecord[] {
    const rows = filter?.status
      ? (getDb().prepare(`SELECT * FROM products WHERE status = ? ORDER BY created_at DESC`).all(filter.status) as Row[])
      : (getDb().prepare(`SELECT * FROM products ORDER BY created_at DESC`).all() as Row[]);
    return attachJoomListings(rows.map(rowToRecord));
  }

  get(id: string): ProductRecord | null {
    const row = getDb().prepare(`SELECT * FROM products WHERE id = ?`).get(id) as Row | undefined;
    return row ? attachJoomListings([rowToRecord(row)])[0] : null;
  }

  update(id: string, patch: ProductPatch): ProductRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next = {
      status: patch.status ?? existing.status,
      collected: patch.collected ?? existing.collected,
      edited: patch.edited !== undefined ? patch.edited : existing.edited,
      joomProductId: patch.joomProductId !== undefined ? patch.joomProductId : existing.joomProductId,
      lastError: patch.lastError !== undefined ? patch.lastError : existing.lastError,
      templateId: patch.templateId !== undefined ? patch.templateId ?? undefined : existing.templateId,
      grouping: patch.grouping ?? existing.grouping ?? inferProductGrouping(existing.collected),
      templateConfirmed: patch.templateConfirmed ?? existing.templateConfirmed ?? false,
      joomState: patch.joomState !== undefined ? patch.joomState : existing.joomState,
      joomUpdatedAt: patch.joomUpdatedAt !== undefined ? patch.joomUpdatedAt : existing.joomUpdatedAt,
      lastSyncedAt: patch.lastSyncedAt !== undefined ? patch.lastSyncedAt : existing.lastSyncedAt,
      joomInventory: patch.joomInventory !== undefined ? patch.joomInventory : existing.joomInventory,
      joomHasActiveVersion: patch.joomHasActiveVersion !== undefined ? patch.joomHasActiveVersion : existing.joomHasActiveVersion,
      joomIssues: patch.joomIssues !== undefined ? patch.joomIssues : existing.joomIssues,
      joomIssueDetails: patch.joomIssueDetails !== undefined ? patch.joomIssueDetails : existing.joomIssueDetails,
      joomVideo: patch.joomVideo !== undefined ? patch.joomVideo : existing.joomVideo,
      editedAt: patch.editedAt !== undefined
        ? patch.editedAt ?? undefined
        : patch.edited !== undefined ? new Date().toISOString() : existing.editedAt,
    };
    getDb()
      .prepare(
        `UPDATE products SET status = ?, collected = ?, edited = ?, joom_product_id = ?, last_error = ?, template_id = ?, grouping = ?, template_confirmed = ?, joom_state = ?, joom_updated_at = ?, last_synced_at = ?, joom_inventory = ?, joom_has_active_version = ?, joom_issues = ?, joom_issue_details = ?, joom_video = ?, updated_at = ?, edited_at = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        JSON.stringify(next.collected),
        next.edited ? JSON.stringify(next.edited) : null,
        next.joomProductId || null,
        next.lastError || null,
        next.templateId ?? null,
        JSON.stringify(next.grouping),
        next.templateConfirmed ? 1 : 0,
        next.joomState ?? null,
        next.joomUpdatedAt ?? null,
        next.lastSyncedAt ?? null,
        next.joomInventory ?? null,
        next.joomHasActiveVersion == null ? null : next.joomHasActiveVersion ? 1 : 0,
        next.joomIssues || null,
        next.joomIssueDetails ? JSON.stringify(next.joomIssueDetails) : null,
        next.joomVideo ? JSON.stringify(next.joomVideo) : null,
        new Date().toISOString(),
        next.editedAt ?? null,
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    const info = getDb().prepare(`DELETE FROM products WHERE id = ?`).run(id);
    return info.changes > 0;
  }
}

/** 默认单例(SQLite 实现)。 */
export const productRepository: ProductRepository = new SqliteProductRepository();

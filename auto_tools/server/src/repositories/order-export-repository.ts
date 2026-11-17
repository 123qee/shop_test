import { v4 as uuid } from 'uuid';
import type { ProductMaterial } from '@shared/types';
import type { OrderExportRecord, OrderMaterialRule } from '@shared/orders';
import { getDb } from '../db/index.js';

export interface ExportMark {
  lineUid: string;
  material: ProductMaterial;
}

interface ExportRow {
  id: string;
  profile_id: string;
  profile_name: string;
  query: string;
  summary: string;
  files: string;
  zip_name: string;
  files_expired: number;
  created_at: string;
}

interface RuleRow {
  id: string;
  platform: string;
  product_id: string | null;
  product_sku: string | null;
  title: string | null;
  material: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: ExportRow): OrderExportRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    profileName: row.profile_name,
    createdAt: row.created_at,
    query: JSON.parse(row.query),
    summary: JSON.parse(row.summary),
    files: JSON.parse(row.files),
    zipName: row.zip_name,
    filesExpired: Boolean(row.files_expired),
  };
}

function rowToRule(row: RuleRow): OrderMaterialRule {
  return {
    id: row.id,
    platform: row.platform,
    productId: row.product_id ?? undefined,
    productSku: row.product_sku ?? undefined,
    title: row.title ?? undefined,
    material: row.material as ProductMaterial,
    updatedAt: row.updated_at,
  };
}

export class OrderExportRepository {
  /** 导出记录与「已导出」标记在同一个事务里写入，不会出现标记了但没有记录的情况。 */
  create(record: OrderExportRecord, marks: ExportMark[]): void {
    const db = getDb();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO order_exports (id, profile_id, profile_name, query, summary, files, zip_name, files_expired, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(
        record.id,
        record.profileId,
        record.profileName,
        JSON.stringify(record.query),
        JSON.stringify(record.summary),
        JSON.stringify(record.files),
        record.zipName,
        record.createdAt,
      );
      const mark = db.prepare(`
        INSERT INTO order_export_marks (profile_id, line_uid, export_id, material, exported_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, line_uid) DO UPDATE SET
          export_id = excluded.export_id, material = excluded.material, exported_at = excluded.exported_at
      `);
      for (const item of marks) mark.run(record.profileId, item.lineUid, record.id, item.material, record.createdAt);
    })();
  }

  list(limit = 50): OrderExportRecord[] {
    const rows = getDb()
      .prepare('SELECT * FROM order_exports ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(200, Math.max(1, limit))) as ExportRow[];
    return rows.map(rowToRecord);
  }

  get(id: string): OrderExportRecord | null {
    const row = getDb().prepare('SELECT * FROM order_exports WHERE id = ?').get(id) as ExportRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** 某方案在某时间之后的导出次数，用于文件名 {seq}。 */
  countSince(profileId: string, sinceIso: string): number {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM order_exports WHERE profile_id = ? AND created_at >= ?')
      .get(profileId, sinceIso) as { n: number };
    return row.n;
  }

  listExpirable(beforeIso: string): string[] {
    const rows = getDb()
      .prepare('SELECT id FROM order_exports WHERE files_expired = 0 AND created_at < ?')
      .all(beforeIso) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  markFilesExpired(id: string): void {
    getDb().prepare('UPDATE order_exports SET files_expired = 1 WHERE id = ?').run(id);
  }

  // ---- 记住的商品材质 ----

  listRules(): OrderMaterialRule[] {
    const rows = getDb()
      .prepare('SELECT * FROM order_material_rules ORDER BY updated_at DESC')
      .all() as RuleRow[];
    return rows.map(rowToRule);
  }

  getRule(id: string): OrderMaterialRule | null {
    const row = getDb().prepare('SELECT * FROM order_material_rules WHERE id = ?').get(id) as RuleRow | undefined;
    return row ? rowToRule(row) : null;
  }

  /** 先按平台商品 id 找，再按商品 SKU 找（同一商品刊登在多个店铺时 SKU 相同）。 */
  findRule(platform: string, productId?: string, productSku?: string): OrderMaterialRule | null {
    const db = getDb();
    if (productId) {
      const row = db
        .prepare('SELECT * FROM order_material_rules WHERE platform = ? AND product_id = ?')
        .get(platform, productId) as RuleRow | undefined;
      if (row) return rowToRule(row);
    }
    if (productSku) {
      const row = db
        .prepare('SELECT * FROM order_material_rules WHERE platform = ? AND product_sku = ? ORDER BY updated_at DESC LIMIT 1')
        .get(platform, productSku) as RuleRow | undefined;
      if (row) return rowToRule(row);
    }
    return null;
  }

  upsertRule(input: { platform: string; productId?: string; productSku?: string; title?: string; material: ProductMaterial }): OrderMaterialRule {
    const db = getDb();
    const now = new Date().toISOString();
    const existing = input.productId
      ? (db.prepare('SELECT * FROM order_material_rules WHERE platform = ? AND product_id = ?').get(input.platform, input.productId) as RuleRow | undefined)
      : (db.prepare('SELECT * FROM order_material_rules WHERE platform = ? AND product_id IS NULL AND product_sku = ?').get(input.platform, input.productSku ?? '') as RuleRow | undefined);
    if (existing) {
      db.prepare('UPDATE order_material_rules SET material = ?, product_sku = COALESCE(?, product_sku), title = COALESCE(?, title), updated_at = ? WHERE id = ?')
        .run(input.material, input.productSku ?? null, input.title ?? null, now, existing.id);
      return this.getRule(existing.id)!;
    }
    const id = uuid();
    db.prepare(`
      INSERT INTO order_material_rules (id, platform, product_id, product_sku, title, material, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.platform, input.productId ?? null, input.productSku ?? null, input.title ?? null, input.material, now, now);
    return this.getRule(id)!;
  }

  updateRuleMaterial(id: string, material: ProductMaterial): OrderMaterialRule | null {
    getDb()
      .prepare('UPDATE order_material_rules SET material = ?, updated_at = ? WHERE id = ?')
      .run(material, new Date().toISOString(), id);
    return this.getRule(id);
  }

  deleteRule(id: string): boolean {
    return getDb().prepare('DELETE FROM order_material_rules WHERE id = ?').run(id).changes > 0;
  }
}

export const orderExportRepository = new OrderExportRepository();

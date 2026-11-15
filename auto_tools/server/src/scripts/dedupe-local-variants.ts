import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import type { CollectedProduct, EditableProduct } from '@shared/types';
import { config } from '../config/index.js';
import { dedupeCollectedProduct, dedupeEditableProduct } from '../services/variant-dedupe.js';

interface ProductRow {
  id: string;
  collected: string;
  edited: string | null;
}

const db = new Database(config.dbPath);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${config.dbPath}.before-variant-dedupe-${stamp}`;
fs.mkdirSync(path.dirname(backupPath), { recursive: true });
await db.backup(backupPath);

const rows = db
  .prepare(`SELECT id, collected, edited FROM products WHERE COALESCE(joom_product_id, '') = ''`)
  .all() as ProductRow[];
const update = db.prepare(`UPDATE products SET collected = ?, edited = ?, updated_at = ? WHERE id = ?`);
const audit = db.prepare(`
  INSERT INTO audit_logs (id, product_id, action, summary, before_json, after_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

let changedProducts = 0;
let removedCollected = 0;
let removedEdited = 0;
const now = new Date().toISOString();

const repair = db.transaction(() => {
  for (const row of rows) {
    const collected = dedupeCollectedProduct(JSON.parse(row.collected) as CollectedProduct);
    const previousCollected = JSON.parse(row.collected) as CollectedProduct;
    const edited = row.edited ? dedupeEditableProduct(JSON.parse(row.edited) as EditableProduct) : null;
    const previousEdited = row.edited ? JSON.parse(row.edited) as EditableProduct : null;
    const collectedRemoved = previousCollected.variants.length - collected.variants.length;
    const editedRemoved = (previousEdited?.variants.length ?? 0) - (edited?.variants.length ?? 0);
    if (!collectedRemoved && !editedRemoved) continue;

    update.run(JSON.stringify(collected), edited ? JSON.stringify(edited) : null, now, row.id);
    audit.run(
      uuid(),
      row.id,
      'product.dedupeVariants',
      `清理本地重复变体：采集数据 ${collectedRemoved} 条，编辑数据 ${editedRemoved} 条`,
      JSON.stringify({ collected: previousCollected.variants.length, edited: previousEdited?.variants.length ?? 0 }),
      JSON.stringify({ collected: collected.variants.length, edited: edited?.variants.length ?? 0 }),
      now,
    );
    changedProducts++;
    removedCollected += collectedRemoved;
    removedEdited += editedRemoved;
  }
});

repair();
db.close();
console.log(JSON.stringify({
  scannedProducts: rows.length,
  changedProducts,
  removedCollected,
  removedEdited,
  removedTotal: removedCollected + removedEdited,
  backupPath,
}, null, 2));

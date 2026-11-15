import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CollectedProduct, EditableProduct } from '../../shared/types.js';
import { restoreAsosOriginalUrl } from '../src/services/image-service.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(scriptDir, '../data/app.db');
const apply = process.argv.includes('--apply');
const db = new Database(dbPath);

interface ProductRow {
  id: string;
  collected: string;
  edited: string | null;
}

function restoreProductImages<T extends { images: string[]; variants: Array<{ image?: string }> }>(product: T): { product: T; changed: number } {
  let changed = 0;
  const restore = (value: string): string => {
    const next = restoreAsosOriginalUrl(value);
    if (next !== value) changed += 1;
    return next;
  };
  return {
    product: {
      ...product,
      images: product.images.map(restore),
      variants: product.variants.map((variant) => ({
        ...variant,
        image: variant.image ? restore(variant.image) : variant.image,
      })),
    },
    changed,
  };
}

const rows = db.prepare(`SELECT id, collected, edited FROM products`).all() as ProductRow[];
const update = db.prepare(`UPDATE products SET collected = ?, edited = ? WHERE id = ?`);
let recordsChanged = 0;
let urlsChanged = 0;

const migrate = db.transaction(() => {
  for (const row of rows) {
    const collected = JSON.parse(row.collected) as CollectedProduct;
    if (collected.source !== 'asos') continue;

    const restoredCollected = restoreProductImages(collected);
    const edited = row.edited ? (JSON.parse(row.edited) as EditableProduct) : null;
    const restoredEdited = edited ? restoreProductImages(edited) : null;
    const changed = restoredCollected.changed + (restoredEdited?.changed ?? 0);
    if (!changed) continue;

    recordsChanged += 1;
    urlsChanged += changed;
    if (apply) {
      update.run(
        JSON.stringify(restoredCollected.product),
        restoredEdited ? JSON.stringify(restoredEdited.product) : null,
        row.id,
      );
    }
  }
});

migrate();
db.close();
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', recordsChanged, urlsChanged, dbPath }, null, 2));

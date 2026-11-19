import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { CollectedProduct } from '@shared/types';

function product(sourceProductId: string, sourceUrl: string, source: CollectedProduct['source'] = 'asos'): CollectedProduct {
  return { source, sourceProductId, sourceUrl, title: 'Cotton T-Shirt', images: [], variants: [], attributes: {} };
}

test('旧库按来源查重、并发只建一件、废弃后重采和补图均无需加载商品列表', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'collect-lookup-'));
  process.env.DB_PATH = join(dir, 'old.db');
  const old = new Database(process.env.DB_PATH);
  old.exec(`CREATE TABLE products (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, collected TEXT NOT NULL, edited TEXT, joom_product_id TEXT,
    last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const oldItem = product('', '\t https://source.test/t/old///?from=list#x \n');
  oldItem.generatedSku = '1000000000000001';
  old.prepare("INSERT INTO products VALUES ('legacy','edited',?,?,NULL,NULL,'2025-01-01','2025-01-02')")
    .run(JSON.stringify({ ...oldItem, sourceProductId: undefined }), JSON.stringify({ sku: '1000000000000002' }));
  old.close();
  const { getDb } = await import('../src/db/index');
  const { productRepository: repo } = await import('../src/repositories/product-repository');
  const { collectService } = await import('../src/services/collect-service');
  const { productService } = await import('../src/services/product-service');
  const db = getDb();
  try {
    t.mock.method(repo, 'list', () => { throw new Error('collection loaded every product'); });
    const retry = product('id-later', 'https://source.test/t/old#new');
    retry.images = ['https://images.asos-media.com/products/example/8-1'];
    const repaired = await collectService.collect(retry);
    assert.equal(repaired.duplicate, true);
    assert.equal(repaired.record.id, 'legacy');
    assert.equal(repaired.record.collected.generatedSku, oldItem.generatedSku);
    assert.deepEqual(repaired.record.collected.images, retry.images);
    assert.equal(repaired.record.edited?.sku, '1000000000000002');
    assert.equal(repo.hasSku('1000000000000001'), true);
    assert.equal(repo.hasSku('1000000000000002'), true);
    assert.equal(repo.hasSku('1000000000000003'), false);
    // Two nonempty and different source IDs must stay distinct, even with the same URL.
    const incoming = product('1000000000000003', retry.sourceUrl);
    const results = await Promise.all(Array.from({ length: 8 }, () => collectService.collect(incoming)));
    const id = results[0].record.id;
    assert.notEqual(id, 'legacy');
    assert.equal(new Set(results.map((r) => r.record.id)).size, 1);
    assert.equal(results.filter((r) => !r.duplicate).length, 1);
    assert.equal(repo.hasSku('1000000000000003'), true);
    assert.equal(db.prepare("SELECT count(*) FROM audit_logs WHERE product_id=? AND action='collect.template'").pluck().get(id), 1);
    const otherUrl = await collectService.collect(product(' 1000000000000003\t', 'https://source.test/changed/'));
    assert.equal(otherUrl.record.id, id);
    // Incoming links without an ID may match a stored nonempty ID by normalized URL.
    assert.equal((await collectService.collect(product('', 'https://source.test/t/old///?p=2'))).record.id, id);
    const otherShop = await collectService.collect(product(incoming.sourceProductId, incoming.sourceUrl, 'allegro'));
    assert.equal(otherShop.duplicate, false);
    repo.update(id, { status: 'discarded' });
    const recollected = await collectService.collect(incoming);
    assert.equal(recollected.duplicate, false);
    assert.notEqual(recollected.record.id, id);
    assert.equal(productService.count(), 4);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

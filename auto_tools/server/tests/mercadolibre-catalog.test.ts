import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { MercadoLibreListingIndexItem } from '@shared/types';

test('美客多管理索引保留筛选和 SKU 搜索，省略完整草稿；升级后重建旧商品摘要', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mercadolibre-catalog-'));
  process.env.DB_PATH = join(directory, 'app.db');
  const { createApp } = await import('../src/app');
  const { getDb } = await import('../src/db');
  const { mercadoLibreRepository: listings } = await import('../src/repositories/mercadolibre-repository');
  const { productRepository: products } = await import('../src/repositories/product-repository');
  const { productCatalogIndex } = await import('../src/services/product-catalog');
  const db = getDb();
  const server = createApp().listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const product = products.create({ source: 'asos', sourceProductId: 'source-id', sourceUrl: 'https://fixture.test/source',
      title: 'Source shirt', images: ['https://fixture.test/image'], attributes: {},
      variants: [{ sourceSkuId: 'Original-SKU-XL', options: { Size: 'XL' } }] });
    const draft = listings.createListing({ productId: product.id, siteId: 'MLM', status: 'draft', title: 'Camisa',
      description: 'Large listing description '.repeat(1000), currency: 'USD', categoryId: 'MLM123',
      attributes: [{ id: 'MATERIAL', valueName: 'Cotton' }], images: ['https://fixture.test/picture'],
      variants: [{ sku: 'Listing-SKU-XL', price: 15, inventory: 10, attributes: [] }],
      logisticType: 'remote', priceMode: 'set', language: 'spanish' });
    listings.updateListing(draft.id, { status: 'failed', lastError: 'Fixture failure' });
    const response = await fetch(base + '/mercadolibre/listing-index');
    assert.equal(response.status, 200);
    const index = await response.json() as MercadoLibreListingIndexItem[];
    assert.equal(index.length, 1);
    assert.deepEqual(index[0], { id: draft.id, productId: product.id, siteId: 'MLM', status: 'failed',
      title: 'Camisa', categoryId: 'MLM123', updatedAt: listings.getListing(draft.id)!.updatedAt,
      lastError: 'Fixture failure', skuSearchText: 'listing-sku-xl' });
    const serialized = JSON.stringify(index);
    for (const omitted of ['description', 'images', 'variants', 'attributes', 'Large listing description', 'fixture.test/picture']) {
      assert(!serialized.includes(omitted), `Management index must omit ${omitted}`);
    }
    assert(serialized.length < JSON.stringify(listings.listListings()).length / 10);
    const oldEndpoint = await fetch(base + `/mercadolibre/listings?productId=${product.id}`);
    assert.equal(((await oldEndpoint.json()) as Array<{ description: string }>)[0].description, draft.description);
    listings.updateListing(draft.id, { title: 'Updated shirt', variants: [{ sku: 'Changed-SKU', price: 16, inventory: 5, attributes: [] }] });
    assert.equal(listings.listListingIndex()[0].skuSearchText, 'changed-sku');
    assert.equal(listings.listListingIndex()[0].title, 'Updated shirt');

    // Simulate a persisted cache from the previous app, then initialize a new process.
    const before = productCatalogIndex();
    db.prepare("UPDATE product_catalog_index SET summary = json_remove(summary, '$.sourceSkuSearchText')").run();
    db.prepare('UPDATE product_catalog_version SET schema_version = 1').run();
    const restarted = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      "const {getDb}=await import('./src/db/index.ts');getDb().close();"], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null' }, encoding: 'utf8',
    });
    assert.equal(restarted.status, 0, restarted.stderr);
    const after = productCatalogIndex(before.version);
    assert.notEqual(after.version, before.version);
    assert.equal(after.items?.[0].sourceSkuSearchText, 'original-sku-xl');
    assert.equal(db.prepare('SELECT schema_version FROM product_catalog_version').pluck().get(), 2);
    assert.deepEqual(productCatalogIndex(after.version), { version: after.version });
  } finally {
    server.close();
    server.closeAllConnections();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('商品索引跨页筛选，卡片省略大字段，商品、刊登和预设的修改会更新索引', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'product-catalog-'));
  process.env.DB_PATH = join(dir, 'app.db');
  const { getDb } = await import('../src/db/index');
  const { productCatalogCards, productCatalogIndex, productSortCandidates } = await import('../src/services/product-catalog');
  const { productRepository } = await import('../src/repositories/product-repository');
  const { settingsService } = await import('../src/services/settings-service');
  const db = getDb();
  try {
    const count = 35;
    const ids = Array.from({ length: count }, (_, i) => productRepository.create({
      source: i % 2 ? 'allegro' : 'asos', title: `T-Shirt ${i}`, sourceUrl: 'https://example.test/', sourceProductId: String(i),
      description: 'original description', images: ['https://example.test/main'], variants: [
        { sourceSkuId: `Source-SKU-${i}-M`, image: 'https://example.test/main', options: { Size: 'M' } }, { image: 'https://example.test/back', options: { Size: 'L' } },
      ], attributes: { Material: 'Cotton' }, raw: { unused: 'large source payload' },
    }, 'default', { templateConfirmed: true }).id);
    const first = productCatalogIndex();
    assert.equal(first.items?.length, count);
    assert.equal(first.items?.filter((item) => item.collected.source === 'asos').length, 18);
    assert.equal(first.items?.every((item) => item.templateConfirmed), true);
    assert.equal(first.items?.find((item) => item.id === ids[30])?.sourceSkuSearchText, 'source-sku-30-m');
    assert.deepEqual(productCatalogIndex(first.version), { version: first.version });
    assert.equal(db.prepare('SELECT count(*) FROM product_catalog_index').pluck().get(), count);
    const secondPage = productCatalogCards(ids.slice(30));
    assert.deepEqual(secondPage.map((item) => item.id), ids.slice(30));
    assert.equal(secondPage[0].imageCount, 2);
    assert.equal(secondPage[0].variantCount, 2);
    assert.equal(secondPage[0].sourceUrl, 'https://example.test/');
    for (const items of [first.items, secondPage]) {
      const payload = JSON.stringify(items);
      assert(!payload.includes('original description') && !payload.includes('large source payload'));
      assert(!payload.includes('"variants"') && !payload.includes('"images"'));
    }
    assert.equal(productSortCandidates(ids).length, 0);
    productRepository.update(ids[0], { status: 'discarded' });
    assert.equal(db.prepare('SELECT count(*) FROM product_catalog_index').pluck().get(), count - 1);
    const edited = productCatalogIndex(first.version);
    assert.equal(edited.items?.find((item) => item.id === ids[0])?.status, 'discarded');
    db.prepare(`INSERT INTO joom_shop_listings(shop_id,joom_product_id,product_id,state,inventory,last_synced_at)
      VALUES ('shop-A','listing',?,'active',5,'2026-01-01')`).run(ids[1]);
    const listed = productCatalogIndex(edited.version);
    assert.deepEqual(listed.items?.find((item) => item.id === ids[1])?.listingBuckets, ['active']);
    const presets = settingsService.getConfig();
    settingsService.saveConfig({ ...presets, activeId: 'other', templates: [{ ...presets.templates[0], id: 'other' }] });
    const afterPresets = productCatalogIndex(listed.version);
    assert.equal(afterPresets.items?.every((item) => !item.templateConfirmed), true);
    const candidates = productSortCandidates(ids);
    assert.equal(candidates.length, count - 1);
    assert.equal(candidates[0].image, 'https://example.test/main');
    assert(!JSON.stringify(candidates).includes('original description'));
    productRepository.delete(ids[0]);
    assert.equal(productCatalogIndex(afterPresets.version).items?.length, count - 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

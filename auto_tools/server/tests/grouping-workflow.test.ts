import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { ProductRecord } from '../../shared/types';

test('采集、旧库迁移、纠正、套预设和绑定的完整流程', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tools-grouping-'));
  process.env.DB_PATH = join(dir, 'test.db');
  const legacy = new Database(process.env.DB_PATH);
  const source = { source: 'joom', sourceUrl: 'https://example.test/item', sourceProductId: 'legacy', title: "Men's Polyester T-Shirt", images: [], variants: [{ options: { Size: 'M', Color: 'Black' }, price: 3 }], attributes: {}, price: { value: 3, currency: 'USD' } };
  legacy.exec('CREATE TABLE products (id TEXT PRIMARY KEY, status TEXT NOT NULL, collected TEXT NOT NULL, edited TEXT, joom_product_id TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  legacy.prepare("INSERT INTO products VALUES ('old', 'collected', ?, NULL, NULL, NULL, ?, ?)").run(JSON.stringify(source), new Date().toISOString(), new Date().toISOString());
  legacy.close();
  const { createApp } = await import('../src/app');
  const { getDb } = await import('../src/db/index');
  const { productRepository } = await import('../src/repositories/product-repository');
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api`;
  async function request(path: string, method = 'GET', body?: unknown) {
    const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() as any };
  }
  try {
    let id = '';
    await t.test('旧商品自动分组，默认预设未确认', async () => {
      const record = (await request('/products/old')).data.record as ProductRecord;
      assert.equal(record.grouping?.groupId, 'men-short');
      assert.equal(record.templateConfirmed, false);
      assert.equal(productRepository.get('old')?.collected.title, source.title);
    });
    await t.test('新采集保存自动分组，无需改动插件', async () => {
      const collected = await request('/collect', 'POST', { product: { ...source, sourceProductId: 'new' } });
      assert.equal(collected.status, 201);
      id = collected.data.id;
      const record = productRepository.get(id)!;
      assert.equal(record.grouping?.material, 'polyester');
      assert.equal(record.templateConfirmed, false);
      assert.ok(getDb().prepare('SELECT grouping FROM products WHERE id = ?').get(id));
    });
    await t.test('套用模板记录确认，保留标题、SKU、图片和人工编辑', async () => {
      const detail = (await request(`/products/${id}`)).data;
      const edited = { ...detail.editable, title: 'User edited title', sku: 'custom-product', images: ['https://example.test/image.jpg'], variants: detail.editable.variants.map((v: any) => ({ ...v, sku: `custom-${v.size}` })) };
      assert.equal((await request(`/products/${id}`, 'PUT', edited)).status, 200);
      const result = await request('/products/batch/operate', 'POST', { ids: [id], operation: { type: 'template', templateId: 'default' } });
      assert.equal(result.data[0].ok, true);
      const record = productRepository.get(id)!;
      assert.equal(record.templateConfirmed, true);
      assert.equal(record.edited?.title, edited.title);
      assert.equal(record.edited?.sku, edited.sku);
      assert.deepEqual(record.edited?.images, edited.images);
      assert.equal(record.grouping?.groupId, 'men-short');
      assert.equal(record.collected.title, source.title);
      assert.deepEqual(record.edited?.variants.map((v) => v.sku), edited.variants.map((v: any) => v.sku));
    });
    await t.test('修改价格保留预设确认，编辑器套用后保存也能确认预设', async () => {
      const result = await request('/products/batch/operate', 'POST', { ids: [id], operation: { type: 'price', mode: 'set', value: 19.99 } });
      assert.equal(result.data[0].ok, true);
      assert.equal(productRepository.get(id)?.templateConfirmed, true);
      const editable = (await request('/products/old/apply-preset', 'POST', {})).data.editable;
      // 历史记录尚未指定模板，先选择一个有效预设。
      assert.equal((await request('/products/old/template', 'POST', { templateId: 'default' })).status, 200);
      productRepository.update('old', { templateConfirmed: false });
      assert.equal((await request('/products/old', 'PUT', { ...editable, templateConfirmed: true })).status, 200);
      assert.equal(productRepository.get('old')?.templateConfirmed, true);
    });
    await t.test('批量纠正仅修改分组，确认状态重置并持久保存', async () => {
      const before = productRepository.get(id)!;
      const result = await request('/products/batch/operate', 'POST', { ids: [id], operation: { type: 'grouping', groupId: 'kids-short', material: 'cotton' } });
      assert.equal(result.data[0].ok, true);
      const record = productRepository.get(id)!;
      assert.equal(record.grouping?.source, 'manual');
      assert.equal(record.grouping?.groupId, 'kids-short');
      assert.equal(record.grouping?.material, 'cotton');
      assert.equal(record.templateConfirmed, false);
      assert.deepEqual(record.collected, before.collected);
      assert.deepEqual(record.edited, before.edited);
      assert.equal(record.editedAt, before.editedAt);
      assert.equal((await request('/products')).data.find((p: ProductRecord) => p.id === id).grouping.groupId, 'kids-short');
    });
    await t.test('无效分组、未知模板和废弃箱商品不能误改', async () => {
      assert.equal((await request('/products/batch/operate', 'POST', { ids: [id], operation: { type: 'grouping', groupId: 'invalid' } })).status, 400);
      const before = productRepository.get(id);
      assert.equal((await request('/products/batch/operate', 'POST', { ids: [id], operation: { type: 'template', templateId: 'deleted' } })).data[0].ok, false);
      assert.deepEqual(productRepository.get(id), before);
      productRepository.update(id, { status: 'publishing' });
      assert.equal((await request('/products/batch/operate', 'POST', { ids: [id], operation: { type: 'grouping', groupId: 'pants' } })).data[0].ok, false);
      productRepository.update(id, { status: 'edited' });
      assert.equal((await request(`/products/${id}/template`, 'POST', { templateId: 'missing' })).status, 400);
      productRepository.update('old', { status: 'discarded' });
      assert.equal((await request('/products/batch/operate', 'POST', { ids: ['old'], operation: { type: 'grouping', groupId: 'pants' } })).data[0].ok, false);
    });
    await t.test('常用预设独立保存，保存采集预设不丢绑定，删除模板后不推荐', async () => {
      const binding = { groupId: 'kids-short', material: 'cotton', templateId: 'default' };
      assert.equal((await request('/settings/group-templates', 'PUT', binding)).status, 200);
      const settings = (await request('/settings')).data;
      assert.equal((await request('/settings', 'PUT', settings)).status, 200);
      assert.deepEqual((await request('/settings/group-templates')).data, [binding]);
      assert.equal((await request('/settings/group-templates', 'PUT', { ...binding, material: 'unknown' })).status, 400);
      assert.equal((await request('/settings/group-templates', 'PUT', { ...binding, templateId: 'missing' })).status, 400);
      assert.equal((await request('/settings', 'PUT', { ...settings, activeId: 'new', templates: [{ ...settings.templates[0], id: 'new' }] })).status, 200);
      assert.deepEqual((await request('/settings/group-templates')).data, []);
      assert.equal((await request('/products/old')).data.record.templateConfirmed, false);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    getDb().close();
    rmSync(dir, { recursive: true, force: true });
  }
});

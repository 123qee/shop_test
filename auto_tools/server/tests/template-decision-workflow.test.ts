import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { CollectResponse, PresetsConfig, ProductRecord } from '../../shared/types';

const defaults = (material: string, targetSizes: string[]) => ({
  currency: 'USD', priceMode: 'fixed', priceMultiplier: 1, fixedPrice: 5, inventory: 999, attributes: { material }, targetSizes,
});
const config = {
  activeId: 'adult-cotton',
  templates: [
    { id: 'adult-cotton', name: '成人棉短袖', defaults: defaults('Cotton', ['S', 'M', 'L', 'XL']) },
    { id: 'kids-cotton', name: '童装短袖棉', defaults: defaults('Cotton', ['100', '110', '120', '130']) },
    { id: 'adult-poly', name: '聚酯纤维成人短袖', defaults: { ...defaults('Polyster', ['S', 'M', 'L', 'XL', '2XL']), fixedPrice: 4.5 } },
  ],
};

let seq = 0;
function product(title: string, sizes: string[]) {
  seq += 1;
  return {
    source: 'aliexpress',
    sourceUrl: `https://example.test/item/${seq}.html`,
    sourceProductId: `p${seq}`,
    title,
    images: ['https://example.test/1.jpg'],
    price: { value: 3, currency: 'USD' },
    variants: sizes.map((size) => ({ options: { Color: 'Black', Size: size }, price: 3 })),
    attributes: {},
  };
}

test('采集时指定模板自动确认，分拣确认与撤销', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tools-sort-'));
  process.env.DB_PATH = join(dir, 'test.db');
  const { createApp } = await import('../src/app');
  const { getDb } = await import('../src/db/index');
  const { productRepository } = await import('../src/repositories/product-repository');
  const { auditService } = await import('../src/services/audit-service');
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  async function request(path: string, method = 'GET', body?: unknown) {
    const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => undefined) as any };
  }
  const collect = async (body: unknown) => (await request('/collect', 'POST', body)).data as CollectResponse;

  try {
    assert.equal((await request('/settings', 'PUT', config)).status, 200);

    await t.test('主动选择且核对无矛盾：入库即确认，并记录原因', async () => {
      const res = await collect({ product: product("Men's Cotton T-Shirt", ['S', 'M', 'L', 'XL']), templateId: 'adult-cotton', templateSource: 'picked' });
      assert.equal(res.template?.source, 'picked');
      assert.equal(res.template?.confirmed, true);
      assert.equal(productRepository.get(res.id)?.templateConfirmed, true);
      assert.equal(auditService.list({ productId: res.id })[0].action, 'collect.template');
    });

    await t.test('主动选择但尺码是童装：留在待确认，写明原因', async () => {
      const res = await collect({ product: product('Kids Cartoon T-Shirt', ['100', '110', '120', '130']), templateId: 'adult-cotton', templateSource: 'picked' });
      assert.equal(res.template?.confirmed, false);
      assert.equal(res.template?.templateId, 'adult-cotton');
      assert.match(res.template?.issues[0] ?? '', /尺码 100–130，像童装/);
      assert.equal(productRepository.get(res.id)?.templateConfirmed, false);
    });

    await t.test('不指定：系统推荐模板，待确认；旧版插件带来的模板照旧使用但不确认', async () => {
      const suggested = await collect({ product: product('Kids Dino T-Shirt', ['100', '110', '120']) });
      assert.deepEqual([suggested.template?.source, suggested.template?.templateId, suggested.template?.confirmed], ['suggested', 'kids-cotton', false]);
      const legacy = await collect({ product: product("Men's Cotton T-Shirt Classic", ['S', 'M', 'L']), templateId: 'adult-poly' });
      assert.deepEqual([legacy.template?.source, legacy.template?.templateId, legacy.template?.confirmed], ['fallback', 'adult-poly', false]);
      const again = await collect({ product: { ...product('dup', ['S']), sourceProductId: 'p1', sourceUrl: 'https://example.test/item/1.html' } });
      assert.equal(again.duplicate, true);
    });

    await t.test('分拣确认当前模板只标记确认，撤销后恢复原样', async () => {
      const { id } = await collect({ product: product('Kids Shark T-Shirt', ['100', '110', '120']) });
      const before = productRepository.get(id)!;
      const decided = await request(`/products/${id}/template-decision`, 'POST', { templateId: 'kids-cotton' });
      assert.equal(decided.status, 200);
      assert.equal(decided.data.action, 'confirmed');
      const record = decided.data.record as ProductRecord;
      assert.equal(record.templateConfirmed, true);
      assert.equal(record.edited, null);
      assert.equal(record.status, 'collected');

      const undone = await request(`/products/${id}/template-decision/undo`, 'POST', {});
      assert.equal(undone.status, 200);
      const restored = productRepository.get(id)!;
      assert.equal(restored.templateConfirmed, false);
      assert.equal(restored.templateId, before.templateId);
      assert.equal((await request(`/products/${id}/template-decision/undo`, 'POST', {})).status, 409);
    });

    await t.test('编辑过的商品换模板：保留标题和 SKU，撤销还原草稿与编辑时间', async () => {
      const { id } = await collect({ product: product('3D Print T-Shirt Men', ['S', 'M', 'L']) });
      const detail = (await request(`/products/${id}`)).data;
      assert.equal((await request(`/products/${id}`, 'PUT', { ...detail.editable, title: 'User Title' })).status, 200);
      const edited = productRepository.get(id)!;

      const decided = await request(`/products/${id}/template-decision`, 'POST', { templateId: 'adult-cotton' });
      assert.equal(decided.data.action, 'changed');
      const changed = productRepository.get(id)!;
      assert.equal(changed.templateId, 'adult-cotton');
      assert.equal(changed.templateConfirmed, true);
      assert.equal(changed.edited?.title, 'User Title');
      assert.equal(changed.edited?.sku, edited.edited?.sku);
      assert.equal(changed.edited?.variants[0].price, 5);

      assert.equal((await request(`/products/${id}/template-decision/undo`, 'POST', {})).status, 200);
      const restored = productRepository.get(id)!;
      assert.equal(restored.templateId, edited.templateId);
      assert.equal(restored.templateConfirmed, false);
      assert.deepEqual(restored.edited, edited.edited);
      assert.equal(restored.editedAt, edited.editedAt);
      assert.equal(restored.status, edited.status);
    });

    await t.test('分拣后又改过的商品不能撤销；无效请求给出明确错误', async () => {
      const { id } = await collect({ product: product('Kids Cat T-Shirt', ['100', '110', '120']) });
      await request(`/products/${id}/template-decision`, 'POST', { templateId: 'kids-cotton' });
      const detail = (await request(`/products/${id}`)).data;
      await request(`/products/${id}`, 'PUT', { ...detail.editable, title: 'Changed later' });
      const undo = await request(`/products/${id}/template-decision/undo`, 'POST', {});
      assert.equal(undo.status, 409);
      assert.match(undo.data.error, /又被修改过/);

      assert.equal((await request(`/products/${id}/template-decision`, 'POST', { templateId: 'missing' })).status, 400);
      assert.equal((await request('/products/nope/template-decision', 'POST', { templateId: 'kids-cotton' })).status, 404);
      productRepository.update(id, { status: 'discarded' });
      assert.equal((await request(`/products/${id}/template-decision`, 'POST', { templateId: 'kids-cotton' })).status, 400);
    });

    await t.test('跨标签保存描述时保留其他窗口的采集默认，提示同一模板的编辑或删除冲突', async () => {
      const read = async (): Promise<PresetsConfig> => (await request('/settings')).data;
      const save = (draft: PresetsConfig, base: PresetsConfig) => request('/settings', 'PUT', { ...draft, base });
      const initial = await read();
      const tabA = structuredClone(initial);
      tabA.templates[0].defaults.description = '窗口 A 的描述';
      assert.equal((await save({ ...initial, activeId: 'kids-cotton' }, initial)).status, 200);
      const merged = await save(tabA, initial);
      assert.equal(merged.status, 200);
      assert.equal(merged.data.activeId, 'kids-cotton');
      assert.equal(merged.data.templates[0].defaults.description, '窗口 A 的描述');
      assert.deepEqual(await read(), merged.data);

      const stale = structuredClone(initial);
      stale.templates[0].defaults.description = '同时修改的另一份描述';
      const conflict = await save(stale, initial);
      assert.equal(conflict.status, 409);
      assert.match(conflict.data.error, /成人棉短袖/);
      assert.deepEqual(await read(), merged.data);

      const beforeDelete = await read();
      const afterDelete = { ...beforeDelete, templates: beforeDelete.templates.filter(t => t.id !== 'kids-cotton'), activeId: 'adult-poly' };
      assert.equal((await save(afterDelete, beforeDelete)).status, 200);
      const editingDeleted = structuredClone(beforeDelete);
      editingDeleted.templates.find(t => t.id === 'kids-cotton')!.name = '正在重命名';
      assert.equal((await save(editingDeleted, beforeDelete)).status, 409);
      assert.deepEqual(await read(), afterDelete);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    getDb().close();
    rmSync(dir, { recursive: true, force: true });
  }
});

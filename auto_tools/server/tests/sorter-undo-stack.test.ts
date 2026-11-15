import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { CollectResponse, ProductRecord } from '../../shared/types';

const defaults = (material: string, targetSizes: string[]) => ({
  currency: 'USD', priceMode: 'fixed', priceMultiplier: 1, fixedPrice: 5, inventory: 999, attributes: { material }, targetSizes,
});
const config = {
  activeId: 'adult-cotton',
  templates: [
    { id: 'adult-cotton', name: '成人棉短袖', defaults: defaults('Cotton', ['S', 'M', 'L', 'XL']) },
    { id: 'kids-cotton', name: '童装短袖棉', defaults: defaults('Cotton', ['100', '110', '120', '130']) },
  ],
};

const IMG = (n: number) => `https://example.test/stack-${n}.jpg`;

function product(title: string) {
  return {
    source: 'aliexpress',
    sourceUrl: `https://example.test/undo-stack/${title.replace(/\s+/g, '-')}.html`,
    sourceProductId: `undo-stack-${title.replace(/\s+/g, '-')}`,
    title,
    images: [IMG(1), IMG(2), IMG(3)],
    price: { value: 3, currency: 'USD' },
    variants: [
      { options: { Color: 'Black', Size: 'S' }, price: 3, image: IMG(2) },
      { options: { Color: 'Black', Size: 'M' }, price: 3 },
    ],
    attributes: {},
  };
}

test('分拣删图可以撤销，并与分拣撤销按栈的顺序配合', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tools-undo-stack-'));
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
  const collect = async (title: string) => (await request('/collect', 'POST', { product: product(title) }).then((r) => r.data)) as CollectResponse;
  const undo = (id: string) => request(`/products/${id}/template-decision/undo`, 'POST', {});

  try {
    assert.equal((await request('/settings', 'PUT', config)).status, 200);

    await t.test('删图后撤销：图片回到原位，变体上被清掉的图片引用恢复', async () => {
      const { id } = await collect('Undo Stack Plain Tee');
      const baseline = (await request(`/products/${id}`)).data.editable;
      // 挑变体正在引用的那张图删，这样能验证变体引用也被恢复。
      const target = baseline.variants[0].image as string;
      assert.ok(target && baseline.images.includes(target));

      const deleted = await request(`/products/${id}/images`, 'DELETE', { imageUrl: target });
      assert.equal(deleted.status, 200);
      assert.equal(deleted.data.edited.variants[0].image, undefined);

      const undone = await undo(id);
      assert.equal(undone.status, 200);
      assert.equal(undone.data.record.edited, null);
      assert.equal(productRepository.get(id)!.edited, null);
      assert.equal(productRepository.get(id)!.status, 'collected');
      const detail = (await request(`/products/${id}`)).data.editable;
      assert.deepEqual(detail.images, baseline.images);
      assert.equal(detail.variants[0].image, target);

      const latest = auditService.list({ productId: id })[0];
      assert.equal(latest.action, 'sort.undo');
      assert.equal(latest.summary, '撤销删图');
      // 没有可以撤销的记录了，再撤销返回 409。
      assert.equal((await undo(id)).status, 409);
    });

    await t.test('编辑过的商品删图再撤销：标题等编辑内容保留，变体引用恢复', async () => {
      const { id } = await collect('Undo Stack Edited Tee');
      const detail = (await request(`/products/${id}`)).data;
      assert.equal((await request(`/products/${id}`, 'PUT', { ...detail.editable, title: 'Undo Stack Title' })).status, 200);
      const edited = (await request(`/products/${id}`)).data.editable;
      const target = edited.variants[0].image as string;

      assert.equal((await request(`/products/${id}/images`, 'DELETE', { imageUrl: target })).status, 200);
      assert.equal((await undo(id)).status, 200);
      const restored = (await request(`/products/${id}`)).data.editable;
      assert.equal(restored.title, 'Undo Stack Title');
      assert.deepEqual(restored.images, edited.images);
      assert.equal(restored.variants[0].image, target);
    });

    await t.test('分拣确认、删图、再撤销：先撤销删图，再撤销分拣，每一步都能撤销', async () => {
      const { id } = await collect('Undo Stack Decided Tee');
      const before = productRepository.get(id)!;
      const decided = await request(`/products/${id}/template-decision`, 'POST', { templateId: 'kids-cotton' });
      assert.equal(decided.status, 200);

      const image = (await request(`/products/${id}`)).data.editable.images[0] as string;
      assert.equal((await request(`/products/${id}/images`, 'DELETE', { imageUrl: image })).status, 200);

      const undoImage = await undo(id);
      assert.equal(undoImage.status, 200);
      assert.equal(undoImage.data.record.templateConfirmed, true);
      assert.equal(undoImage.data.record.templateId, 'kids-cotton');
      assert.ok((await request(`/products/${id}`)).data.editable.images.includes(image));

      const undoDecision = await undo(id);
      assert.equal(undoDecision.status, 200);
      const restored = productRepository.get(id)!;
      assert.equal(restored.templateConfirmed, before.templateConfirmed);
      assert.equal(restored.templateId, before.templateId);
      assert.equal((await undo(id)).status, 409);
    });

    await t.test('删图后又被编辑：撤销被拒绝，并给出明确原因', async () => {
      const { id } = await collect('Undo Stack Later Edit Tee');
      const target = (await request(`/products/${id}`)).data.editable.images[0] as string;
      assert.equal((await request(`/products/${id}/images`, 'DELETE', { imageUrl: target })).status, 200);
      const detail = (await request(`/products/${id}`)).data;
      assert.equal((await request(`/products/${id}`, 'PUT', { ...detail.editable, title: 'Changed after delete' })).status, 200);

      const res = await undo(id);
      assert.equal(res.status, 409);
      assert.match(res.data.error, /又被修改过/);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    getDb().close();
    rmSync(dir, { recursive: true, force: true });
  }
});

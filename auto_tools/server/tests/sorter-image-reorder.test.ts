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

const IMG = (n: number) => `https://example.test/img-${n}.jpg`;

function product(title: string) {
  return {
    source: 'aliexpress',
    sourceUrl: `https://example.test/sorter-reorder/${title.replace(/\s+/g, '-')}.html`,
    sourceProductId: `sorter-reorder-${title.replace(/\s+/g, '-')}`,
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

test('分拣调整图片顺序：只改草稿，换模板后顺序保留，非法列表被拒绝', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tools-sorter-reorder-'));
  process.env.DB_PATH = join(dir, 'test.db');
  const { createApp } = await import('../src/app');
  const { productRepository } = await import('../src/repositories/product-repository');
  const { auditService } = await import('../src/services/audit-service');
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  async function request(path: string, method = 'GET', body?: unknown) {
    const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => undefined) as any };
  }

  try {
    assert.equal((await request('/settings', 'PUT', config)).status, 200);
    const { id } = (await request('/collect', 'POST', { product: product('Adult Reorder Tee') }).then((r) => r.data)) as CollectResponse;
    const [U1, U2, U3] = productRepository.get(id)!.collected.images;

    await t.test('调整顺序：草稿按新顺序保存，采集原图和变体图引用不变', async () => {
      const res = await request(`/products/${id}/images/order`, 'PUT', { imageUrls: [U3, U1, U2] });
      assert.equal(res.status, 200);
      const record = res.data as ProductRecord;
      assert.deepEqual(record.edited?.images, [U3, U1, U2]);
      assert.equal(record.status, 'edited');
      const stored = productRepository.get(id)!;
      assert.deepEqual(stored.collected.images, [U1, U2, U3]);
      assert.equal(stored.collected.variants[0].image, U2);
      assert.equal(auditService.list({ productId: id })[0].action, 'product.image.reorder');
    });

    await t.test('顺序保存后换模板，新的图片顺序不会被重置', async () => {
      const decided = await request(`/products/${id}/template-decision`, 'POST', { templateId: 'kids-cotton' });
      assert.equal(decided.status, 200);
      assert.deepEqual((decided.data.record as ProductRecord).edited?.images, [U3, U1, U2]);
    });

    await t.test('与当前草稿顺序相同：原样返回，不写审计', async () => {
      const before = auditService.list({ productId: id }).length;
      const res = await request(`/products/${id}/images/order`, 'PUT', { imageUrls: [U3, U1, U2] });
      assert.equal(res.status, 200);
      assert.deepEqual((res.data as ProductRecord).edited?.images, [U3, U1, U2]);
      assert.equal(auditService.list({ productId: id }).length, before);
    });

    await t.test('图片集合不一致（缺图、多图、陌生图）返回 400，草稿不变', async () => {
      for (const imageUrls of [[U3, U1], [U3, U1, U2, U1], [U3, U1, IMG(99)]]) {
        const res = await request(`/products/${id}/images/order`, 'PUT', { imageUrls });
        assert.equal(res.status, 400);
      }
      assert.deepEqual(productRepository.get(id)!.edited?.images, [U3, U1, U2]);
    });

    await t.test('缺少 imageUrls 或为空返回 400；商品不存在返回 404', async () => {
      assert.equal((await request(`/products/${id}/images/order`, 'PUT', {})).status, 400);
      assert.equal((await request(`/products/${id}/images/order`, 'PUT', { imageUrls: [] })).status, 400);
      assert.equal((await request('/products/no-such-id/images/order', 'PUT', { imageUrls: [U1] })).status, 404);
    });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    sourceUrl: `https://example.test/sorter-image/${title.replace(/\s+/g, '-')}.html`,
    sourceProductId: `sorter-${title.replace(/\s+/g, '-')}`,
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

test('分拣删除图片：只改草稿，采集原图保留，换模板后不回来', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tools-sorter-image-'));
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
    const { id } = (await request('/collect', 'POST', { product: product('Adult Plain Tee') }).then((r) => r.data)) as CollectResponse;
    // 采集会把图片地址改写成代理地址，测试用实际存入的地址。草稿里主图是第 2 张（速卖通来源会交换前两张）。
    const [U1, U2, U3] = productRepository.get(id)!.collected.images;

    await t.test('删除一张图：草稿少了这张，变体上的引用清空，采集原图不动', async () => {
      const res = await request(`/products/${id}/images`, 'DELETE', { imageUrl: U2 });
      assert.equal(res.status, 200);
      const record = res.data as ProductRecord;
      assert.deepEqual(record.edited?.images, [U1, U3]);
      assert.equal(record.edited?.variants[0].image, undefined);
      assert.equal(record.status, 'edited');
      const stored = productRepository.get(id)!;
      assert.deepEqual(stored.collected.images, [U1, U2, U3]);
      assert.equal(stored.collected.variants[0].image, U2);
      assert.equal(auditService.list({ productId: id })[0].action, 'product.image.delete');
    });

    await t.test('删过的图换模板后不会重新出现', async () => {
      const decided = await request(`/products/${id}/template-decision`, 'POST', { templateId: 'kids-cotton' });
      assert.equal(decided.status, 200);
      assert.equal(decided.data.action, 'changed');
      assert.deepEqual((decided.data.record as ProductRecord).edited?.images, [U1, U3]);
    });

    await t.test('图片不在草稿里：原样返回，不报错', async () => {
      const res = await request(`/products/${id}/images`, 'DELETE', { imageUrl: IMG(99) });
      assert.equal(res.status, 200);
      assert.deepEqual((res.data as ProductRecord).edited?.images, [U1, U3]);
    });

    await t.test('缺少 imageUrl 返回 400；商品不存在返回 404', async () => {
      assert.equal((await request(`/products/${id}/images`, 'DELETE', {})).status, 400);
      assert.equal((await request('/products/no-such-id/images', 'DELETE', { imageUrl: U1 })).status, 404);
    });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

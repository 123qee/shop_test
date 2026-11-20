import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Joom 订单来源：分页、limit 回退、storeId 过滤、商品缓存与已删除商品兜底', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tools-joom-orders-'));
  process.env.DB_PATH = join(dir, 'test.db');
  const { getDb } = await import('../src/db');
  const { shopService } = await import('../src/services/shop-service');
  const { productRepository } = await import('../src/repositories/product-repository');
  const { orderRepository } = await import('../src/repositories/order-repository');
  const { MarketplaceError } = await import('../src/marketplaces/types');
  const { JoomOrderSource } = await import('../src/marketplaces/joom/orders');
  try {
    shopService.save({ profiles: [{ id: 'default', name: '店铺A', storeId: 'S1' }], activeId: 'default' });

    // 已从 Joom 删除的商品：本地商品库里有刊登记录，商品接口 404 时用本地数据补标题/颜色/尺码
    const local = productRepository.create({
      source: 'joom', sourceUrl: 'https://example.test/gone', sourceProductId: 'gone',
      title: 'Local Gone Tee', images: ['https://img.test/local.jpg'], variants: [], attributes: {},
    } as any);
    productRepository.update(local.id, {
      edited: {
        title: 'Edited Gone Tee', sku: 'GONE', description: '', images: ['https://img.test/edited.jpg'], currency: 'USD',
        variants: [{ sku: 'GONE-RED-S', price: 3, inventory: 1, colors: 'red', size: 'S' }],
      },
    });
    getDb().prepare(`
      INSERT INTO joom_shop_listings (shop_id, joom_product_id, product_id, shop_name, sku, present, last_synced_at)
      VALUES ('default', 'P-GONE', ?, '店铺A', 'GONE', 1, ?)
    `).run(local.id, new Date().toISOString());

    const order = (id: string, productId: string, variantId: string, variantSku: string, storeId = 'S1') => ({
      id, status: 'approved', quantity: 1, currency: 'USD',
      orderTimestamp: '2026-11-15T08:00:00Z', updateTimestamp: '2026-11-15T09:00:00Z',
      priceInfo: { unitPrice: '3', shippingPrice: '0', commissionAmount: '0' },
      product: { id: productId, sku: productId, variant: { id: variantId, sku: variantSku } },
      shippingAddress: { country: 'RU', zipCode: '101000' }, shippingAddressNative: { country: 'RU', zipCode: '101000' },
      shippingAddressHash: 'h', storeId,
    });
    const calls: string[] = [];
    orderRepository.setCachedProduct('joom', 'default', 'P1', {
      name: 'Old cached tee', imageUrls: ['https://img.test/400.jpg'],
      variants: { V1: { sku: 'TEE-BLK-M' }, V2: { sku: 'TEE-WHT-L' } }, variantsBySku: {},
    });
    const client = {
      async requestEnvelope(_method: string, path: string) {
        calls.push(path);
        if (path.includes('limit=500')) {
          throw new MarketplaceError('Joom 请求失败 (400)', [{ code: 'invalid_argument', field: 'limit', message: 'limit too large' }]);
        }
        if (path.startsWith('/orders/multi')) {
          return {
            data: { items: [order('AAAA0001', 'P1', 'V1', 'TEE-BLK-M'), order('AAAA0002', 'P1', 'V2', 'TEE-WHT-L', 'S2')] },
            paging: { next: 'https://api-merchant.joom.com/api/v3/orders/multi?page=2' },
          };
        }
        if (path.endsWith('page=2')) {
          return { data: { items: [order('AAAA0003', 'P-GONE', 'VG', 'GONE-RED-S'), order('AAAA0004', 'P1', 'V1', 'TEE-BLK-M')] } };
        }
        throw new Error(`unexpected ${path}`);
      },
      async request(_method: string, path: string) {
        calls.push(path);
        if (path === '/products?id=P1') {
          return {
            id: 'P1', name: 'Basic Tee', attributes: [{ key: '1001', value: '100% Cotton' }],
            mainImage: { origUrl: 'https://img.test/original.jpg' },
            variants: [{ id: 'V1', sku: 'TEE-BLK-M', colors: 'black', size: 'M' }, { id: 'V2', sku: 'TEE-WHT-L', colors: 'white', size: 'L' }],
          };
        }
        if (path === '/products?id=P-GONE') throw new MarketplaceError('Joom 请求失败 (404)', [{ message: 'not found' }]);
        throw new Error(`unexpected ${path}`);
      },
    };
    const source = new JoomOrderSource({ isShopConnected: () => true, clientForShop: () => client } as any);

    const pages: any[][] = [];
    for await (const page of source.fetchOrders('default', { since: new Date('2026-11-01T00:00:00.123Z') })) pages.push(page);

    assert.equal(calls[0], '/orders/multi?limit=500&updatedFrom=2026-11-01T00%3A00%3A00Z', '去掉毫秒，按 RFC3339 传 updatedFrom');
    assert.equal(calls[1], '/orders/multi?limit=100&updatedFrom=2026-11-01T00%3A00%3A00Z', 'limit 被拒后降到 100 重试');
    assert.equal(calls.filter((path) => path === '/products?id=P1').length, 1, '同一商品第二页直接用缓存');
    assert.equal(pages.length, 2);
    assert.deepEqual(pages[0].map((o) => o.orderId), ['AAAA0001'], '其他 storeId 的订单被过滤');
    const first = pages[0][0];
    assert.equal(first.shopId, 'default');
    assert.equal(first.shopName, '店铺A');
    assert.equal(first.lines[0].title, 'Basic Tee');
    assert.equal(first.lines[0].color, 'black');
    assert.equal(first.lines[0].size, 'M');
    assert.equal(first.lines[0].materialHint, '100% Cotton');
    assert.equal(first.lines[0].imageUrl, 'https://img.test/original.jpg', '旧低清缓存会在同步时更新为原图');
    const gone = pages[1][0];
    assert.equal(gone.lines[0].title, 'Edited Gone Tee', '商品已删除时用本地商品库补信息');
    assert.equal(gone.lines[0].color, 'red');
    assert.equal(gone.lines[0].size, 'S');
    assert.equal(gone.lines[0].imageUrl, 'https://img.test/edited.jpg');
    assert.ok(orderRepository.getCachedProduct('joom', 'default', 'P1'), '商品信息写入缓存');

    assert.equal(source.findCatalogProductId({ lineId: 'main', quantity: 1, productId: 'P-GONE' }, 'default'), local.id);
    assert.equal(source.findCatalogProductId({ lineId: 'main', quantity: 1, productId: 'unknown', productSku: 'GONE' }, 'default'), local.id);
    assert.equal(source.findCatalogProductId({ lineId: 'main', quantity: 1, productId: 'unknown' }, 'default'), undefined);

    const offline = new JoomOrderSource({ isShopConnected: () => false, clientForShop: () => client } as any);
    await assert.rejects(async () => {
      for await (const _page of offline.fetchOrders('default', { since: new Date() })) { /* 不会执行 */ }
    }, /还没有授权/);
    assert.deepEqual(offline.listShops().map((shop) => shop.shopName), ['店铺A']);
  } finally {
    getDb().close();
    rmSync(dir, { recursive: true, force: true });
  }
});

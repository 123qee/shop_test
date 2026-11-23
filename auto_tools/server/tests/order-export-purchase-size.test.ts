import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { OrderQueryInput } from '../../shared/orders';
import { unzip } from './helpers/zip-reader';

test('童装短袖、卫衣、裤装：预览与 Excel 的拿货尺码一致，平台尺码保持原值', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tools-purchase-size-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.ORDER_EXPORT_DIR = join(dir, 'exports');
  const { orderSourceRegistry } = await import('../src/orders/registry');
  const { orderRepository } = await import('../src/repositories/order-repository');
  const { orderExportService } = await import('../src/orders/export-service');
  const { getDb } = await import('../src/db');
  const image = await sharp({ create: { width: 240, height: 240, channels: 3, background: 'white' } }).jpeg().toBuffer();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return url.hostname === 'sizes.test' ? new Response(image) : originalFetch(input, init);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  orderSourceRegistry.register({
    platform: 'sizes', label: '尺码测试',
    listShops: () => [{ shopId: 'A', shopName: '测试店', configured: true, connected: true }],
    async *fetchOrders() {},
  });
  const cases = [
    { title: '儿童短袖', materialHint: 'cotton', size: '100', expected: '110' },
    { title: '儿童卫衣', materialHint: 'cotton', size: '150', expected: '160' },
    { title: '儿童裤装', materialHint: 'cotton', size: '160', expected: '160' },
    { title: '儿童短袖', materialHint: 'polyester', size: '130', expected: '130' },
    { title: '儿童卫衣', materialHint: 'polyester', size: '150', expected: '150' },
    { title: '儿童卫衣', materialHint: 'polyester', size: '160', expected: '160' },
    { title: '男装短袖', materialHint: 'cotton', size: 'M', expected: 'XL' },
    { title: '男装卫衣', materialHint: 'cotton', size: '2XS', expected: '160' },
  ];
  const query: OrderQueryInput = {
    profileId: 'daily', shops: [{ platform: 'sizes', shopId: 'A' }],
    statuses: ['to_ship'], onlyNew: true,
    polyesterTypes: Object.fromEntries(cases.map((_, i) => [`sizes:A:order-${i}#main`, i % 2 ? 'flat' as const : 'pinhole' as const])),
  };
  try {
    orderRepository.upsertOrders(cases.map((item, i) => ({
      platform: 'sizes', shopId: 'A', shopName: '测试店', orderId: `order-${i}`,
      status: 'to_ship' as const, rawStatus: 'approved',
      orderedAt: '2026-11-23T00:00:00Z', updatedAt: '2026-11-23T00:00:00Z',
      lines: [{ lineId: 'main', productId: `product-${i}`, title: item.title,
        materialHint: item.materialHint, size: item.size, quantity: 1, imageUrl: 'https://sizes.test/front.jpg' }],
    })));
    const preview = orderExportService.preview(query);
    const lines = preview.buckets.flatMap((bucket) => bucket.lines);
    for (const [i, item] of cases.entries()) {
      const line = lines.find((line) => line.orderId === `order-${i}`)!;
      assert.equal(line.size, item.size);
      assert.equal(line.purchaseSize, item.expected);
    }
    const exported = await orderExportService.export(query);
    const sheets = exported.files.map((file) => unzip(readFileSync(orderExportService.filePath(exported.id, file.id).path))
      .get('xl/worksheets/sheet1.xml')!.toString());
    for (const [i, item] of cases.entries()) {
      const row = sheets.flatMap((sheet) => [...sheet.matchAll(/<row\b[^>]*>(.*?)<\/row>/g)].map((match) => match[1]))
        .find((row) => row.includes(`>order-${i}</t>`))!;
      assert.ok(row, `缺少订单 order-${i}`);
      assert.match(row, new RegExp(`<c r="C\\d+"[^>]*><is><t>${item.size}</t></is></c>`));
      assert.match(row, new RegExp(`<c r="E\\d+"[^>]*><is><t>${item.expected}</t></is></c>`));
    }
  } finally {
    getDb().close();
    rmSync(dir, { recursive: true, force: true });
  }
});

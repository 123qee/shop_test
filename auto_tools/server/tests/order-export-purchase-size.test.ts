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
  const { orderProfileService } = await import('../src/orders/profile-service');
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
        materialHint: item.materialHint, size: item.size, quantity: 1, imageUrl: 'https://sizes.test/front.jpg', imageUrls: ['https://sizes.test/front.jpg', 'https://sizes.test/back.jpg'] }],
    })));
    const preview = orderExportService.preview(query);
    const lines = preview.buckets.flatMap((bucket) => bucket.lines);
    for (const [i, item] of cases.entries()) {
      const line = lines.find((line) => line.orderId === `order-${i}`)!;
      assert.equal(line.size, item.size);
      assert.equal(line.purchaseSize, item.expected);
    }
    const exported = await orderExportService.export(query);
    assert.equal(exported.files.length, 4, '自用棉、聚酯原文件以及成人、童装供应商文件');
    const checkSuppliers = (record: typeof exported) => {
      for (const [label, indexes] of [['成人', [6]], ['童装', [0, 1, 2, 7]]] as const) {
        const file = record.files.find(file => file.name.endsWith(`_供应商拿货_${label}.xlsx`))!;
        assert.ok(file, `缺少${label}供应商文件`);
        assert.equal(file.orderCount, indexes.length);
        assert.equal(file.quantity, indexes.length);
        const entries = unzip(readFileSync(orderExportService.filePath(record.id, file.id).path));
        assert.ok(entries.has('xl/media/image1.jpeg'));
        const xml = entries.get('xl/worksheets/sheet1.xml')!.toString();
        assert.doesNotMatch(xml, /平台本身尺码/);
        const actualIds = [...xml.matchAll(/>order-(\d+)<\/t>/g)].map(match => Number(match[1]));
        assert.deepEqual(actualIds, indexes, '按最终拿货尺码分流；标题是男装但拿货160的 order-7 也进入童装');
      }
    };
    checkSuppliers(exported);
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM order_export_marks').get()!.n, cases.length);
    assert.equal(orderExportService.preview(query).files.length, 0, '自用文件和供应商文件共用一次导出标记');
    const sheets = exported.files.map((file) => unzip(readFileSync(orderExportService.filePath(exported.id, file.id).path))
      .get('xl/worksheets/sheet1.xml')!.toString());
    for (const [i, item] of cases.entries()) {
      const row = sheets.flatMap((sheet) => [...sheet.matchAll(/<row\b[^>]*>(.*?)<\/row>/g)].map((match) => match[1]))
        .find((row) => row.includes(`>order-${i}</t>`))!;
      assert.ok(row, `缺少订单 order-${i}`);
      assert.match(row, new RegExp(`<c r="C\\d+"[^>]*><is><t>${item.expected}</t></is></c>`));
      assert.match(row, new RegExp(`<c r="D\\d+"[^>]*><is><t>${item.size}</t></is></c>`));
    }
    const profile = orderProfileService.require('daily');
    orderProfileService.save({ ...profile, layout: 'sheet-per-material' });
    const mixed = await orderExportService.export({ ...query, onlyNew: false,
      selectedImages: { 'sizes:A:order-3#main': ['https://sizes.test/front.jpg', 'https://sizes.test/back.jpg'] },
    });
    assert.equal(mixed.files.length, 3);
    checkSuppliers(mixed);
    const supplier = mixed.files.find(file => file.name.includes('_供应商拿货'))!;
    const supplierEntries = unzip(readFileSync(orderExportService.filePath(mixed.id, supplier.id).path));
    const supplierSheet = supplierEntries.get('xl/worksheets/sheet1.xml')!.toString();
    assert.match(supplierSheet, /图片 2/, '多工作表原文件的图片列数由所有材质决定，棉副本也保留这些列');
    assert.doesNotMatch(supplierSheet, /平台本身尺码/);
    assert.doesNotMatch(supplierSheet, />order-[345]<\/t>/, '供应商文件不含聚酯订单');
    const polyOnly = orderExportService.preview({ ...query, onlyNew: false, excludedLineUids: cases.flatMap((item, i) => item.materialHint === 'cotton' ? [`sizes:A:order-${i}#main`] : []) });
    assert.equal(polyOnly.files.length, 1, '只有聚酯订单时不生成供应商副本');
    const kidsOnly = orderExportService.preview({ ...query, onlyNew: false, excludedLineUids: ['sizes:A:order-6#main'] });
    assert.ok(!kidsOnly.files.some(file => file.name.endsWith('_成人.xlsx')), '没有成人订单时不生成空成人文件');
    orderRepository.upsertOrders(['missing', 'custom'].map(id => ({
      platform: 'sizes', shopId: 'A', shopName: '测试店', orderId: id,
      status: 'to_ship' as const, rawStatus: 'approved', orderedAt: '2026-11-24T00:00:00Z', updatedAt: '2026-11-24T00:00:00Z',
      lines: [{ lineId: 'main', materialHint: 'cotton', size: id === 'custom' ? 'custom' : undefined, quantity: 1, imageUrl: 'https://sizes.test/front.jpg' }],
    })));
    const unknownSizes = orderExportService.preview(query);
    assert.equal(unknownSizes.files.length, 1, '不明确的尺码仅进入自用文件');
    assert.ok(!unknownSizes.files[0].name.includes('_供应商拿货'));
    assert.ok(unknownSizes.warnings.some(warning => warning.includes('2 行棉订单的拿货尺码')));
  } finally {
    getDb().close();
    rmSync(dir, { recursive: true, force: true });
  }
});

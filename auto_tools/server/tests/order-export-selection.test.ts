import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import sharp from 'sharp';
import type { OrderQueryInput, UnifiedOrder } from '../../shared/orders';
import { unzip } from './helpers/zip-reader';

test('逐行选择导出：时间顺序、跳过图片、部分订单标记与重新同步后补导', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tools-order-selection-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.ORDER_EXPORT_DIR = join(dir, 'exports');
  const { createApp } = await import('../src/app');
  const { orderSourceRegistry } = await import('../src/orders/registry');
  const { orderRepository } = await import('../src/repositories/order-repository');
  const { orderExportService } = await import('../src/orders/export-service');
  const { getDb } = await import('../src/db');
  orderSourceRegistry.register({
    platform: 'selection', label: '测试',
    listShops: () => ['A', 'Z'].map((shopId) => ({ shopId, shopName: shopId, configured: true, connected: true })),
    async *fetchOrders() {},
  });
  const orders: UnifiedOrder[] = [
    { platform: 'selection', shopId: 'Z', shopName: 'Z', orderId: 'oldest', status: 'to_ship', rawStatus: 'approved', orderedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', lines: [
      { lineId: 'main', productId: 'same', productSku: 'ZZZ', materialHint: 'cotton', size: 'M', quantity: 2, imageUrl: 'https://selection.test/large' },
      { lineId: 'gift', productId: 'gift', materialHint: 'polyester', quantity: 1, isGift: true, imageUrl: 'https://selection.test/unavailable' },
    ] },
    { platform: 'selection', shopId: 'A', shopName: 'A', orderId: 'middle', status: 'to_ship', rawStatus: 'approved', orderedAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', lines: [
      { lineId: 'main', productId: 'same', productSku: 'AAA', materialHint: 'cotton', size: 'M', quantity: 1, imageUrl: 'https://selection.test/small' },
    ] },
    { platform: 'selection', shopId: 'A', shopName: 'A', orderId: 'newest', status: 'to_ship', rawStatus: 'approved', orderedAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z', lines: [
      { lineId: 'main', productId: 'new', materialHint: 'polyester', quantity: 4, imageUrl: 'https://selection.test/large' },
    ] },
    { platform: 'selection', shopId: 'A', shopName: 'A', orderId: 'pending', status: 'to_ship', rawStatus: 'approved', orderedAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z', lines: [
      { lineId: 'main', quantity: 1, imageUrl: 'https://selection.test/unavailable' },
    ] },
  ];
  orderRepository.upsertOrders(orders);
  const large = await sharp({ create: { width: 1600, height: 1600, channels: 3, background: '#135789' } }).jpeg().toBuffer();
  const small = await sharp({ create: { width: 100, height: 160, channels: 3, background: '#987531' } }).png().toBuffer();
  const originalFetch = globalThis.fetch;
  const downloads: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'selection.test') return originalFetch(input, init);
    downloads.push(url.pathname);
    return url.pathname === '/unavailable' ? new Response('missing', { status: 503 }) : new Response(url.pathname === '/large' ? large : small);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  async function request(endpoint: string, input: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}/api/orders/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    return { status: res.status, data: await res.json() as any };
  }
  const uid = (shop: string, order: string, line = 'main') => `selection:${shop}:${order}#${line}`;
  const giftUid = uid('Z', 'oldest', 'gift');
  const middleUid = uid('A', 'middle');
  const query: OrderQueryInput = {
    profileId: 'daily', shops: [{ platform: 'selection', shopId: 'A' }, { platform: 'selection', shopId: 'Z' }], statuses: ['to_ship'], onlyNew: true,
    polyesterTypes: { [giftUid]: 'flat', [uid('A', 'newest')]: 'pinhole' },
  };
  const allLines = (preview: any) => preview.buckets.flatMap((bucket: any) => bucket.lines);
  try {
    const preview = (await request('preview', query)).data;
    assert.deepEqual(preview.totals, { orders: 4, lines: 5, quantity: 9 });
    assert.deepEqual(preview.buckets[0].lines.map((line: any) => line.orderId), ['oldest', 'middle'], '店铺和 SKU 不影响时间排序');
    const newestFirst = (await request('preview', { ...query, sortOrder: 'newest' })).data;
    assert.deepEqual(newestFirst.buckets[0].lines.map((line: any) => line.orderId), ['middle', 'oldest']);
    assert.equal((await request('preview', { ...query, sortOrder: 'invalid' })).status, 400);

    const none = { ...query, excludedLineUids: allLines(preview).map((line: any) => line.uid) };
    assert.deepEqual((await request('preview', none)).data.files, []);
    assert.equal((await request('exports', none)).status, 400, '全部取消时禁止生成空文件');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM order_exports').get()!.n, 0);

    const selectedQuery = { ...query, excludedLineUids: [giftUid, middleUid] };
    const selected = (await request('preview', selectedQuery)).data;
    assert.equal(allLines(selected).length, 5, '跳过行仍在预览中，可以重新勾选');
    assert.equal(allLines(selected).find((line: any) => line.uid === giftUid).exportSelected, false);
    assert.equal(allLines(selected).find((line: any) => line.uid === uid('Z', 'oldest')).exportSelected, true, '同一订单可以只导出其中一件商品');
    assert.deepEqual(selected.files.map((file: any) => file.quantity), [2, 4, 2]);
    const exported = await request('exports', selectedQuery);
    assert.equal(exported.status, 201, JSON.stringify(exported.data));
    assert.deepEqual(downloads, ['/large'], '不下载被跳过的坏图、未选图和待确认商品图片');
    assert.deepEqual(exported.data.files.map((file: any) => [file.orderCount, file.quantity, file.lowResolutionImages]), [[1, 2, 0], [1, 4, 0], [1, 2, 0]]);
    assert.deepEqual(exported.data.summary.filter((item: any) => item.exported).map((item: any) => item.quantity), [2, 4]);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM order_export_marks').get()!.n, 2);
    const cotton = unzip(readFileSync(orderExportService.filePath(exported.data.id, '1').path));
    const picture = await sharp(cotton.get('xl/media/image1.jpeg')!).metadata();
    assert.equal(picture.width, 1200, 'Excel 内嵌图片保留 1200px');
    const extent = cotton.get('xl/drawings/drawing1.xml')!.toString().match(/<xdr:ext cx="(\d+)" cy="(\d+)"/)!;
    assert.deepEqual([Number(extent[1]), Number(extent[2])], [240 * 9525, 240 * 9525], '列宽和行高容纳 240px 正方形大图');

    const remaining = (await request('preview', query)).data;
    assert.deepEqual(allLines(remaining).map((line: any) => line.uid).sort(), [giftUid, middleUid, uid('A', 'pending')].sort(), '未导出的同行商品仍可继续处理');
    orders[0].lines[1].imageUrl = 'https://selection.test/small';
    orderRepository.upsertOrders(orders);
    const afterSync = (await request('preview', selectedQuery)).data;
    assert.ok(allLines(afterSync).filter((line: any) => line.uid !== uid('A', 'pending')).every((line: any) => !line.exportSelected), '重新同步仍遵循本次跳过名单');
    const retry = await request('exports', query);
    assert.equal(retry.status, 201, JSON.stringify(retry.data));
    assert.deepEqual(retry.data.files.map((file: any) => [file.quantity, file.lowResolutionImages]), [[1, 1], [1, 1], [1, 1]], '低清源图不伪造像素，供应商副本同样给出提示');
    assert.equal(allLines((await request('preview', query)).data).length, 1, '仅待确认商品保留');

    const descending = await request('exports', { ...query, onlyNew: false, sortOrder: 'newest', excludedLineUids: [giftUid, uid('A', 'newest')] });
    assert.equal(descending.status, 201);
    const sheet = unzip(readFileSync(orderExportService.filePath(descending.data.id, '1').path)).get('xl/worksheets/sheet1.xml')!.toString();
    assert.ok(sheet.indexOf('>middle</t>') < sheet.indexOf('>oldest</t>'), '文件内部与页面使用相同的最新在前顺序');
    assert.equal(descending.data.query.sortOrder, 'newest');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    getDb().close();
    rmSync(dir, { recursive: true, force: true });
  }
});

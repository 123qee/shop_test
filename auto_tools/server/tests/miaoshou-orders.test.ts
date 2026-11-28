import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { OrderQueryInput } from '../../shared/orders';
import { unzip } from './helpers/zip-reader';

function pkg(id: number, patch: any = {}) {
  return {
    platform: 'mercadolibre', shopId: 123, site: 'MX', opOrderPackageId: id,
    appPackageStatus: 'wait_seller_send', appPackageStatusText: '待发货',
    orderInfo: { platformOrderSn: 'ML-ORDER', gmtOrderStart: '2026-11-25 10:30:00', gmtOrderModified: '2026-11-26 09:00:00', currency: 'USD', platformOrderStatus: 'paid' },
    consigneeInfo: { country: 'MX', state: 'Mexico', city: 'City' },
    logisticsNo: 'TRACK', logisticsAgentProductInfo: { logisticsCompany: 'Carrier' },
    items: [{ opOrderPackageItemId: id * 10, platformItemId: 'MLM-100', platformSkuId: String(id), platformOuterSkuId: 'source-110',
      title: 'Camiseta de algodon', skuSubName: 'Talla:M;Color:Negro;', quantity: 2, discountedPrice: 5.5,
      originalPicUrl: 'https://orders.test/original.jpg', picUrl: 'https://orders.test/thumbnail.jpg' }], giftItems: [],
    ...patch,
  };
}

function cell(xml: string, header: string, row: number): string | number | undefined {
  const column = [...xml.matchAll(/<c r="([A-Z]+)1"[^>]*><is><t>(.*?)<\/t>/g)].find(match => match[2] === header)?.[1];
  assert.ok(column, `缺少列：${header}`);
  const content = xml.match(new RegExp(`<c r="${column}${row}"[^>]*>(.*?)</c>`))?.[1];
  if (!content) return undefined;
  const number = content.match(/<v>(.*?)<\/v>/)?.[1];
  return number === undefined ? content.match(/<t>(.*?)<\/t>/)?.[1] : Number(number);
}

test('妙手美客多订单：规格、拆包、分页与独立 Excel 完整流程', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'miaoshou-orders-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.ORDER_EXPORT_DIR = join(dir, 'exports');
  const { MiaoshouOrderSource, mapMiaoshouPackage, mapMiaoshouOrderStatus, miaoshouOrderOptions, miaoshouOrderTime } = await import('../src/marketplaces/miaoshou/orders');
  const { MiaoshouClient, MiaoshouError, MIAOSHOU_PATHS } = await import('../src/marketplaces/miaoshou/client');
  const { MiaoshouService } = await import('../src/services/miaoshou-service');
  const { orderSourceRegistry } = await import('../src/orders/registry');
  const { orderRepository } = await import('../src/repositories/order-repository');
  const { orderExportService } = await import('../src/orders/export-service');
  const { orderProfileService } = await import('../src/orders/profile-service');
  const { settingsRepository } = await import('../src/repositories/settings-repository');
  const { getDb } = await import('../src/db');
  const { createApp } = await import('../src/app');
  t.after(() => { getDb().close(); rmSync(dir, { recursive: true, force: true }); });
  const shop = { shopId: '123', shopName: '美客多测试店' };

  await t.test('西葡英中文规格取平台尺码；原图优先，数量与金额只计一次', () => {
    for (const key of ['Talla', 'Talle', 'Tamanho', 'Size', '尺码']) {
      assert.deepEqual(miaoshouOrderOptions(`${key}:150;Cor:Azul;`), { size: '150', color: 'Azul' });
    }
    assert.deepEqual(miaoshouOrderOptions('Color:Black;尺寸：2XL；'), { color: 'Black', size: '2XL' });
    assert.deepEqual(miaoshouOrderOptions('M'), {}, '不从未标明含义的文本猜测尺码');
    assert.equal(miaoshouOrderTime('2026-11-25 10:30:00'), '2026-11-25T02:30:00.000Z');
    const mapped = mapMiaoshouPackage(pkg(100), shop);
    assert.equal(mapped.orderId, 'ML-ORDER');
    assert.equal(mapped.sourceId, 'package:100');
    assert.equal(mapped.lines[0].size, 'M', 'SKU source-110 不得覆盖平台 M 码');
    assert.equal(mapped.lines[0].quantity, 2);
    assert.equal(mapped.lines[0].unitPrice, 5.5);
    assert.equal(mapped.lines[0].amount, 11);
    assert.deepEqual(mapped.lines[0].imageUrls, ['https://orders.test/original.jpg', 'https://orders.test/thumbnail.jpg']);
    assert.deepEqual(mapped.address, { country: 'MX', state: 'Mexico', city: 'City' });
    assert.equal(mapped.address?.phone, undefined);
    assert.throws(() => mapMiaoshouPackage(pkg(100, { shopId: 999 }), shop), /店铺不符/);
    assert.throws(() => mapMiaoshouPackage(pkg(100, { items: [{ quantity: 2 }] }), shop), /明细 ID/);
    assert.throws(() => mapMiaoshouPackage(pkg(100, { items: [pkg(100).items[0], pkg(100).items[0]] }), shop), /重复/);
    assert.throws(() => mapMiaoshouPackage(pkg(100, { items: [{ ...pkg(100).items[0], quantity: -1 }] }), shop), /数量无效/);
    const gift = mapMiaoshouPackage(pkg(100, { giftItems: [{ opOrderPackageGiftId: 1000, goodsName: 'Gift', goodsSkuSubName: 'Size:S;', quantity: 1 }] }), shop);
    assert.equal(gift.lines.length, 2);
    assert.equal(gift.lines[1].isGift, true);
    assert.equal(gift.lines[1].quantity, 1);
    assert.equal(gift.lines[1].size, 'S');
  });
  await t.test('履约状态不使用付款状态代替，退款和退货分别处理', () => {
    assert.equal(mapMiaoshouOrderStatus('wait_seller_send'), 'to_ship');
    assert.equal(mapMiaoshouOrderStatus('wait_receiver_confirm'), 'shipped');
    assert.equal(mapMiaoshouOrderStatus('finished'), 'shipped');
    assert.equal(mapMiaoshouOrderStatus('cancelled'), 'cancelled');
    assert.equal(mapMiaoshouOrderStatus('returned', '已退款'), 'refunded');
    assert.equal(mapMiaoshouOrderStatus('returned', '已退货'), 'returned');
    assert.equal(mapMiaoshouOrderStatus('paid'), 'other');
    assert.equal(mapMiaoshouOrderStatus('unpaid'), 'other');
  });

  await t.test('分页传入店铺与北京时间增量范围；重复或残缺分页不算成功', async () => {
    const queries: any[] = [];
    let mode = 'normal';
    const source = new MiaoshouOrderSource({
      publicConfig: () => ({ configured: true } as any), orderConnectionId: () => 'pagination-test',
      shops: async () => [{ shopId: '123', name: shop.shopName, site: 'CBT', status: 'normal' }],
      orderPackages: async query => {
        queries.push(query);
        return { page: query.page, total: 2, orderPackageList: mode === 'incomplete' && query.page === 2 ? [] : [pkg(mode === 'duplicate' ? 1 : query.page)] };
      },
    });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fetched: any[] = [];
    for await (const batch of source.fetchOrders('123', { since })) fetched.push(...batch);
    assert.deepEqual(fetched.map(order => order.sourceId), ['package:1', 'package:2']);
    assert.deepEqual(queries.map(q => q.page), [1, 2]);
    assert.equal(queries[0].gmtModifiedFrom, new Date(since.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '));
    assert.equal(queries[0].gmtModifiedTo, queries[1].gmtModifiedTo);
    assert.deepEqual(queries[0].shopIds, [123]);
    assert.equal(queries[0].platform, 'mercadolibre');
    const collect = async () => { for await (const _ of source.fetchOrders('123', { since })) { /* consume */ } };
    mode = 'duplicate'; await assert.rejects(collect(), /重复包裹/);
    mode = 'incomplete'; await assert.rejects(collect(), /提前结束/);
  });

  await t.test('本机时钟快五秒仍可查询；一分钟余量内的订单由下次重叠同步补齐', async (t) => {
    const { syncSince } = await import('../src/orders/sync-service');
    const now = new Date('2026-11-28T00:55:00Z').getTime();
    t.mock.method(Date, 'now', () => now);
    const queries: any[] = [];
    const source = new MiaoshouOrderSource({
      publicConfig: () => ({ configured: true } as any), orderConnectionId: () => 'clock-skew-test',
      shops: async () => [{ shopId: '123', name: shop.shopName, site: 'CBT', status: 'normal' }],
      orderPackages: async query => {
        queries.push(query);
        const end = new Date(query.gmtModifiedTo.replace(' ', 'T') + '+08:00').getTime();
        if (end > now - 5000) throw new MiaoshouError('妙手接口返回：订单修改时间结束时间不能晚于当前时间');
        return { page: query.page, total: 0, orderPackageList: [] };
      },
    });
    for await (const _ of source.fetchOrders('123', { since: new Date(now - 86400_000) })) { /* consume */ }
    assert.equal(queries[0].gmtModifiedTo, '2026-11-28 08:54:00');
    const nextSince = syncSince({ platform: 'mercadolibre', shopId: '123', syncedUntil: new Date(now).toISOString() }, new Date(now + 120_000));
    assert.ok(nextSince.getTime() < now - 60_000, '下次查询起点必须覆盖留出的整段时间');
  });

  await t.test('妙手频率超限会重试；查询时间和页码保持一致', async () => {
    const queries: any[] = [];
    const source = new MiaoshouOrderSource({
      publicConfig: () => ({ configured: true } as any), orderConnectionId: () => 'rate-limit-test',
      shops: async () => [{ shopId: '123', name: shop.shopName, site: 'CBT', status: 'normal' }],
      orderPackages: async query => {
        queries.push(query);
        if (queries.length === 1) throw new MiaoshouError('妙手接口返回：账户接口每秒请求频率超限');
        return { page: query.page, total: 1, orderPackageList: [pkg(1)] };
      },
    });
    const orders: any[] = [];
    for await (const batch of source.fetchOrders('123', { since: new Date(Date.now() - 86400_000) })) orders.push(...batch);
    assert.equal(queries.length, 2);
    assert.deepEqual(queries[0], queries[1]);
    assert.equal(orders.length, 1);
  });

  await t.test('超过十五天自动分段；相邻时间段的边界包裹只产出一次，空段不提前结束', async () => {
    const queries: any[] = [];
    const source = new MiaoshouOrderSource({
      publicConfig: () => ({ configured: true } as any), orderConnectionId: () => 'window-test',
      shops: async () => [{ shopId: '123', name: shop.shopName, site: 'CBT', status: 'normal' }],
      orderPackages: async query => {
        queries.push(query);
        const batch = queries.length === 1 ? [] : [pkg(1)];
        return { page: query.page, total: batch.length, orderPackageList: batch };
      },
    });
    const orders: any[] = [];
    for await (const batch of source.fetchOrders('123', { since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) })) orders.push(...batch);
    assert.equal(queries.length, 3);
    assert.equal(orders.length, 1);
    for (const [index, query] of queries.entries()) {
      assert.equal(query.page, 1);
      assert.ok(new Date(query.gmtModifiedTo).getTime() - new Date(query.gmtModifiedFrom).getTime() <= 14 * 24 * 60 * 60 * 1000);
      if (index) assert.equal(query.gmtModifiedFrom, queries[index - 1].gmtModifiedTo);
    }
  });

  let deny = false;
  let packages = [pkg(100), pkg(101, { items: [{ ...pkg(101).items[0], platformItemId: 'MLM-KIDS', skuSubName: 'Cor:Branco;Tamanho:110;', quantity: 3 }] }),
    pkg(102, { appPackageStatus: 'wait_receiver_confirm' }),
    pkg(103, { orderInfo: { ...pkg(103).orderInfo, platformOrderSn: 'ML-POLY' }, items: [{ ...pkg(103).items[0], title: 'Camiseta de poliester', skuSubName: 'Talla:S;Color:Negro;', quantity: 1 }] }),
    pkg(104, { orderInfo: { ...pkg(104).orderInfo, platformOrderSn: 'ML-UNKNOWN' }, items: [{ ...pkg(104).items[0], title: 'Basic Tee', quantity: 1 }] })];
  const requests: any[] = [];
  const service = new MiaoshouService((key, secret) => new MiaoshouClient(key, secret, async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body)); requests.push({ path, body });
    assert.equal((init?.headers as any)['x-app-key'], 'ak-orders-test');
    if (deny) return Response.json({ result: 'fail', code: 'appNoPermission', message: '应用没有订单权限' });
    if (path === MIAOSHOU_PATHS.shops) return Response.json({ result: 'success', code: 'success', data: { shopList: [
      { shopId: 123, shopNick: shop.shopName, site: 'CBT', status: 'normal' },
      { shopId: 456, shopNick: 'UP 不接入', site: 'UP', status: 'normal' },
    ] } });
    assert.equal(path, MIAOSHOU_PATHS.orderPackages, '只允许店铺与订单查询，不调用任何发布或发货接口');
    return Response.json({ result: 'success', code: 'success', data: { page: body.page, pageSize: body.pageSize, total: packages.length, orderPackageList: packages } });
  }, 0));
  service.saveConfig({ appKey: 'ak-orders-test', appSecret: 'private-orders-secret' });
  const source = new MiaoshouOrderSource(service);
  orderSourceRegistry.register(source);
  orderSourceRegistry.register({
    platform: 'joom', label: 'Joom', listShops: () => [{ shopId: 'J', shopName: 'Joom测试店', configured: true, connected: true }],
    async *fetchOrders() { yield [{ platform: 'joom', shopId: 'J', shopName: 'Joom测试店', orderId: 'JOOM-ORDER', status: 'to_ship', rawStatus: 'approved',
      orderedAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z', lines: [{ lineId: 'main', title: 'Cotton Tee', size: 'L', quantity: 7, imageUrl: 'https://orders.test/original.jpg' }] }]; },
  });
  const originalFetch = globalThis.fetch;
  const photo = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#315f86' } }).jpeg().toBuffer();
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return url.hostname === 'orders.test' ? new Response(photo) : originalFetch(input, init);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/orders`;
  async function request(path: string, body?: unknown) {
    const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() as any };
  }
  async function sync() {
    const start = await request('/sync', { shops: [{ platform: 'mercadolibre', shopId: '123' }, { platform: 'joom', shopId: 'J' }] });
    assert.equal(start.status, 202, JSON.stringify(start.data));
    for (let n = 0; n < 200; n++) {
      const job = (await request('/sync/' + start.data.id)).data;
      if (!['queued', 'running'].includes(job.status)) return job;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('同步超时');
  }
  const query: OrderQueryInput = { profileId: 'daily', shops: [{ platform: 'joom', shopId: 'J' }, { platform: 'mercadolibre', shopId: '123' }], statuses: ['to_ship'], onlyNew: true };

  await t.test('来源发现与同步：复用授权，只列传统店铺，重复同步不丢拆包明细', async () => {
    const sources = (await request('/sources')).data;
    assert.equal(sources.platforms.find((p: any) => p.platform === 'mercadolibre').shops.length, 1);
    assert.ok(!JSON.stringify(sources).includes('private-orders-secret'));
    assert.equal((await sync()).status, 'succeeded');
    assert.equal((await sync()).status, 'succeeded');
    const preview = (await request('/preview', query)).data;
    const cotton = preview.buckets.find((b: any) => b.key === 'cotton');
    const ml = cotton.lines.filter((line: any) => line.platform === 'mercadolibre');
    assert.equal(ml.length, 2);
    assert.deepEqual(ml.map((line: any) => [line.orderId, line.size, line.purchaseSize, line.quantity]), [['ML-ORDER', 'M', 'XL', 2], ['ML-ORDER', '110', '120', 3]]);
    assert.equal(cotton.orderCount, 2, 'Joom 一单 + 美客多一单（两包裹）');
    assert.equal(cotton.quantity, 12);
    assert.equal(preview.buckets.find((b: any) => b.key === 'unknown').excluded, true);
    const lines = preview.buckets.flatMap((b: any) => b.lines);
    query.polyesterTypes = Object.fromEntries(lines.filter((line: any) => line.material === 'polyester').map((line: any) => [line.uid, 'flat']));
    query.selectedImages = { [ml[0].uid]: ml[0].imageUrls };
    // 一个包裹更新后，另一个包裹仍保留；导出标识使用包裹 ID，平台订单号不改。
    orderRepository.upsertOrders([mapMiaoshouPackage(pkg(100), shop)]);
    assert.equal(orderExportService.preview(query).buckets.find(b => b.key === 'cotton')?.lines.length, 3);
  });

  await t.test('自用文件分平台，供应商文件跨平台合并成人棉和童装棉；保留图片与数量', async () => {
    const preview = orderExportService.preview(query);
    assert.equal(preview.files.length, 5);
    const response = await request('/exports', query);
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const record = response.data;
    assert.equal(record.files.length, 5);
    assert.deepEqual(record.files.map((file: any) => [file.name, file.quantity]), preview.files.map(file => [file.name, file.quantity]));
    for (const file of record.files) {
      const xlsx = readFileSync(orderExportService.filePath(record.id, file.id).path);
      const entries = unzip(xlsx);
      const xml = entries.get('xl/worksheets/sheet1.xml')!.toString();
      const supplier = file.name.includes('_供应商拿货');
      assert.match(xml, /图片/); assert.match(xml, /数量/); assert.match(xml, /拿货尺码/);
      if (supplier) assert.doesNotMatch(xml, /平台本身尺码/);
      else assert.match(xml, /平台本身尺码/);
      assert.ok(entries.has('xl/media/image1.jpeg'));
      if (supplier) {
        assert.doesNotMatch(file.name, /Joom|美客多/, '供应商文件名不按平台命名');
        assert.match(xml, /图片 2/);
        if (file.name.includes('_成人')) {
          assert.equal(file.orderCount, 2);
          assert.equal(file.quantity, 9);
          assert.match(xml, /JOOM-ORDER/); assert.match(xml, /ML-ORDER/);
          assert.match(xml, /Joom测试店/); assert.match(xml, /美客多测试店/);
          assert.equal(cell(xml, '拿货尺码', 2), '2XL');
          assert.equal(cell(xml, '拿货尺码', 3), 'XL');
          assert.equal(cell(xml, '数量', 2), 7);
          assert.equal(cell(xml, '数量', 3), 2);
        } else {
          assert.equal(file.orderCount, 1); assert.equal(file.quantity, 3);
          assert.equal(cell(xml, '拿货尺码', 2), '120'); assert.equal(cell(xml, '数量', 2), 3);
          assert.doesNotMatch(xml, /JOOM-ORDER/);
        }
      } else {
        assert.ok(!(xml.includes('JOOM-ORDER') && xml.includes('ML-ORDER')), '自用文件仍按平台拆分');
        if (xml.includes('ML-ORDER')) {
          assert.match(file.name, /美客多/); assert.equal(file.orderCount, 1); assert.equal(file.quantity, 5);
          assert.equal(cell(xml, '拿货尺码', 2), 'XL'); assert.equal(cell(xml, '平台本身尺码', 2), 'M');
          assert.equal(cell(xml, '拿货尺码', 3), '120'); assert.equal(cell(xml, '平台本身尺码', 3), '110');
        }
      }
      if (process.env.ORDER_EXPORT_QA_DIR) {
        mkdirSync(process.env.ORDER_EXPORT_QA_DIR, { recursive: true });
        copyFileSync(orderExportService.filePath(record.id, file.id).path, join(process.env.ORDER_EXPORT_QA_DIR, file.name));
      }
    }
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM order_export_marks').get()!.n, 4, '只标记实际导出的四行，不标记未确认或已发货商品');
    assert.equal(orderExportService.preview(query).files.length, 0, '再次只导新订单不会重复导出');
  });

  await t.test('多工作表方案自用文件按平台拆分，供应商仍只生成成人棉与童装棉两份', async () => {
    const profile = orderProfileService.require('daily');
    orderProfileService.save({ ...profile, layout: 'sheet-per-material', fileName: '发厂订单' });
    const again = { ...query, onlyNew: false };
    const preview = orderExportService.preview(again);
    assert.equal(preview.files.length, 4);
    assert.equal(preview.files.filter(file => file.name.includes('美客多')).length, 1);
    const record = await orderExportService.export(again);
    for (const file of record.files) {
      const entries = unzip(readFileSync(orderExportService.filePath(record.id, file.id).path));
      const sheets = [...entries].filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).map(([, data]) => data.toString()).join('');
      if (file.name.includes('_供应商拿货')) {
        assert.ok(!sheets.includes('ML-POLY'));
        assert.doesNotMatch(sheets, /平台本身尺码/);
        if (file.name.includes('_成人')) { assert.ok(sheets.includes('JOOM-ORDER')); assert.ok(sheets.includes('ML-ORDER')); }
        else { assert.ok(!sheets.includes('JOOM-ORDER')); assert.ok(sheets.includes('ML-ORDER')); }
      } else if (file.name.includes('美客多')) {
        assert.ok(!sheets.includes('JOOM-ORDER')); assert.ok(sheets.includes('ML-ORDER'));
        assert.ok(sheets.includes('ML-POLY'));
      }
      else { assert.ok(sheets.includes('JOOM-ORDER')); assert.ok(!sheets.includes('ML-ORDER')); }
    }
    const joomOnly = orderExportService.preview({ ...again, shops: [{ platform: 'joom', shopId: 'J' }] });
    assert.equal(joomOnly.files[0].name, '发厂订单.xlsx', '仅导 Joom 时旧自定义文件名保持原样');
  });

  await t.test('童装跨平台合并：同订单号不丢行，遵循排序、跳过选择及已导出标记', async () => {
    orderRepository.upsertOrders([{
      platform: 'joom', shopId: 'J', shopName: 'Joom测试店', orderId: 'ML-ORDER', status: 'to_ship', rawStatus: 'approved',
      orderedAt: '2026-11-24T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z',
      lines: [{ lineId: 'main', title: 'Cotton Kids', size: '110', quantity: 4, imageUrl: 'https://orders.test/original.jpg' }],
    }]);
    const again = { ...query, onlyNew: false };
    const preview = orderExportService.preview(again);
    const suppliers = preview.files.filter(file => file.name.includes('_供应商拿货'));
    assert.equal(suppliers.length, 2);
    assert.equal(suppliers.find(file => file.name.includes('_成人'))!.quantity, 9);
    assert.equal(suppliers.find(file => file.name.includes('_童装'))!.quantity, 7);
    assert.equal(suppliers.find(file => file.name.includes('_童装'))!.orderCount, 2, '平台不同但订单号相同也算两单');
    const record = await orderExportService.export({ ...again, sortOrder: 'newest' });
    const kids = record.files.find(file => file.name.includes('_供应商拿货_童装'))!;
    const entries = unzip(readFileSync(orderExportService.filePath(record.id, kids.id).path));
    const xml = entries.get('xl/worksheets/sheet1.xml')!.toString();
    assert.equal((xml.match(/>ML-ORDER<\/t>/g) ?? []).length, 2);
    assert.equal(cell(xml, '数量', 2), 3); assert.equal(cell(xml, '数量', 3), 4);
    assert.equal(cell(xml, '店铺', 2), shop.shopName); assert.equal(cell(xml, '店铺', 3), 'Joom测试店');
    const mlKids = preview.buckets.flatMap(bucket => bucket.lines).find(line => line.platform === 'mercadolibre' && line.purchaseSize === '120')!;
    const skipped = orderExportService.preview({ ...again, excludedLineUids: [mlKids.uid] });
    assert.equal(skipped.files.find(file => file.name.includes('_供应商拿货_童装'))!.quantity, 4);
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM order_export_marks').get()!.n, 5, '自用和供应商文件不会重复计数');
    assert.equal(orderExportService.preview(query).files.length, 0);
    const zip = unzip(orderExportService.buildZip(record.id).buffer);
    assert.ok(zip.has(kids.name), '合并后的供应商文件也进入打包下载');
  });

  await t.test('妙手在任务内刷新失败只影响该店铺，Joom 仍正常同步', async () => {
    const cache = settingsRepository.get<any>('miaoshou.orderShops');
    settingsRepository.set('miaoshou.orderShops', { ...cache, fetchedAt: 0 });
    deny = true;
    const job = await sync();
    assert.equal(job.status, 'partial');
    assert.equal(job.shops.find((s: any) => s.platform === 'joom').status, 'succeeded');
    assert.equal(job.shops.find((s: any) => s.platform === 'mercadolibre').status, 'failed');
    deny = false;
    await source.refreshShops();
  });

  await t.test('更换妙手凭证立即隔离店铺缓存，来源查询失败仍保留 Joom', async () => {
    service.saveConfig({ appSecret: 'rotated-secret' }); deny = true;
    assert.deepEqual(source.listShops(), []);
    const response = await request('/sources');
    assert.equal(response.status, 200);
    assert.equal(response.data.platforms.find((p: any) => p.platform === 'joom').shops.length, 1);
    assert.match(response.data.platforms.find((p: any) => p.platform === 'mercadolibre').error, /权限/);
    assert.ok(requests.every(r => [MIAOSHOU_PATHS.shops, MIAOSHOU_PATHS.orderPackages].includes(r.path)));
  });
});

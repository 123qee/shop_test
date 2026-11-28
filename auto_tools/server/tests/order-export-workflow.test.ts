import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import sharp from 'sharp';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { OrderLine, UnifiedOrder } from '../../shared/orders';
import { chinaDate, chinaDayStartIso } from '../../shared/orders';
import { unzip } from './helpers/zip-reader';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

interface OrderInput {
  shopId: 'A' | 'B';
  orderId: string;
  status?: UnifiedOrder['status'];
  rawStatus?: string;
  orderedAgo: number;
  updatedAgo?: number;
  lines: Array<Partial<OrderLine> & { productId: string }>;
}

function order(input: OrderInput): UnifiedOrder {
  return {
    platform: 'fake',
    shopId: input.shopId,
    shopName: input.shopId === 'A' ? '店铺A（旧名）' : '店铺B',
    orderId: input.orderId,
    status: input.status ?? 'to_ship',
    rawStatus: input.rawStatus ?? 'approved',
    orderedAt: ago(input.orderedAgo),
    updatedAt: ago(input.updatedAgo ?? input.orderedAgo),
    currency: 'USD',
    address: { name: `买家 ${input.orderId}`, phone: '0012345678', country: 'RU', city: 'Moscow', zipCode: '010203', line1: 'Lenina 10' },
    lines: input.lines.map((line, index) => ({
      lineId: index ? `l${index}` : 'main',
      quantity: 1,
      size: 'M',
      imageUrl: 'https://example.test/front.jpg',
      productSku: `${line.productId}-SKU`,
      variantSku: `${line.productId}-V`,
      ...line,
    })),
  };
}

function rawGet(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('订单导出：多店铺同步、材质判定、按材质分文件、只导新订单、方案与本机限制', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tools-orders-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.ORDER_EXPORT_DIR = join(dir, 'exports');
  const { createApp } = await import('../src/app');
  const { getDb } = await import('../src/db');
  const { orderSourceRegistry } = await import('../src/orders/registry');
  const { orderExportService } = await import('../src/orders/export-service');
  const { productRepository } = await import('../src/repositories/product-repository');
  const front = await sharp({ create: { width: 40, height: 60, channels: 3, background: '#e00000' } }).webp().toBuffer();
  const back = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#0000e0' } }).png().toBuffer();
  const originalFetch = globalThis.fetch;
  const imageCalls: string[] = [];
  let imageFailure = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'example.test') return originalFetch(input, init);
    imageCalls.push(url.pathname);
    if (imageFailure || url.pathname === '/must-not-download.jpg') return new Response('unavailable', { status: 503 });
    return new Response(url.pathname === '/back.jpg' ? back : front, { headers: { 'Content-Type': 'image/webp' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  // 商品库里人工确认为「棉」的商品
  const local = productRepository.create({
    source: 'joom', sourceUrl: 'https://example.test/local', sourceProductId: 'local',
    title: 'Basic Tee', images: ['https://example.test/front.jpg', 'https://example.test/back.jpg'], variants: [], attributes: {},
  } as any);
  productRepository.update(local.id, { grouping: { groupId: 'men-short', material: 'cotton', source: 'manual', reason: '人工确认' } });

  const orders: UnifiedOrder[] = [
    order({ shopId: 'A', orderId: 'A-1', orderedAgo: 5 * HOUR, lines: [{ productId: 'P-LOCAL', title: 'Basic Tee', imageUrl: 'https://example.test/front.jpg', quantity: 2, color: 'black', size: 'M' }] }),
    order({ shopId: 'A', orderId: 'A-2', orderedAgo: 4 * HOUR, lines: [{ productId: 'P-ATTR', title: 'Classic Tee', materialHint: '100% Cotton' }] }),
    order({ shopId: 'A', orderId: 'A-3', orderedAgo: 3 * HOUR, lines: [{ productId: 'P-POLY', title: 'Polyester Sport T-Shirt' }] }),
    order({ shopId: 'B', orderId: 'B-1', orderedAgo: 2 * HOUR, lines: [{ productId: 'P-BLEND', title: 'Soft Tee', materialHint: '65% polyester, 35% cotton' }] }),
    order({
      shopId: 'B', orderId: 'B-2', orderedAgo: 1 * HOUR,
      lines: [{ productId: 'P-NONE', title: 'Mystery item', imageUrl: 'https://example.test/must-not-download.jpg' }, { productId: 'P-POLY', title: 'Polyester Sport T-Shirt', isGift: true }],
    }),
    order({ shopId: 'B', orderId: 'B-3', status: 'cancelled', rawStatus: 'cancelled', orderedAgo: HOUR, lines: [{ productId: 'P-POLY', title: 'Polyester Sport T-Shirt' }] }),
    order({ shopId: 'A', orderId: 'A-OLD', orderedAgo: 40 * DAY, lines: [{ productId: 'P-ATTR', title: 'Classic Tee', materialHint: '100% Cotton' }] }),
  ];
  const sinceCalls: Array<{ shopId: string; since: Date }> = [];
  let failShopB = false;
  orderSourceRegistry.register({
    platform: 'fake',
    label: '测试平台',
    listShops: () => [
      { shopId: 'A', shopName: '店铺A', configured: true, connected: true },
      { shopId: 'B', shopName: '店铺B', configured: true, connected: true },
      { shopId: 'C', shopName: '店铺C', configured: true, connected: false },
    ],
    async *fetchOrders(shopId, { since }) {
      sinceCalls.push({ shopId, since });
      if (shopId === 'B' && failShopB) throw new Error('授权已过期');
      const matched = orders.filter((o) => o.shopId === shopId && new Date(o.updatedAt) >= since);
      for (let i = 0; i < matched.length; i += 2) yield structuredClone(matched.slice(i, i + 2));
    },
    findCatalogProductId: (line) => (line.productId === 'P-LOCAL' ? local.id : undefined),
  });

  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api/orders`;
  async function request(path: string, method = 'GET', body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: res.status === 204 ? null : (await res.json()) as any };
  }
  async function sync(body: unknown) {
    const started = await request('/sync', 'POST', body);
    assert.equal(started.status, 202, JSON.stringify(started.data));
    for (let i = 0; i < 200; i++) {
      const job = (await request(`/sync/${started.data.id}`)).data;
      if (!['queued', 'running'].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('同步任务超时');
  }
  const shops = [{ platform: 'fake', shopId: 'A' }, { platform: 'fake', shopId: 'B' }];
  const today = chinaDate().replace(/-/g, '');
  const lineUid = (shopId: string, orderId: string, lineId = 'main') => `fake:${shopId}:${orderId}#${lineId}`;
  const daily = { profileId: 'daily', shops, statuses: ['to_ship'], onlyNew: true, polyesterTypes: {
    [lineUid('A', 'A-3')]: 'flat', [lineUid('B', 'B-2', 'l1')]: 'pinhole', [lineUid('A', 'A-4')]: 'flat',
  } };
  const bucket = (preview: any, key: string) => preview.buckets.find((b: any) => b.key === key);
  const orderIds = (b: any) => [...new Set(b.lines.map((line: any) => line.orderId))].sort();

  try {
    await t.test('来源列表与同步校验', async () => {
      const sources = (await request('/sources')).data;
      assert.equal(sources.lookbackDays, 30);
      assert.deepEqual(sources.platforms.map((p: any) => p.label), ['测试平台']);
      assert.deepEqual(sources.platforms[0].shops.map((s: any) => [s.shopName, s.connected, s.orderCount]), [['店铺A', true, 0], ['店铺B', true, 0], ['店铺C', false, 0]]);
      const offline = await request('/sync', 'POST', { shops: [{ platform: 'fake', shopId: 'C' }] });
      assert.equal(offline.status, 400);
      assert.match(offline.data.error, /还没有授权/);
      assert.equal((await request('/sync', 'POST', { shops: [] })).status, 400);
    });

    await t.test('首次同步回溯 30 天，逐店铺记录进度', async () => {
      const job = await sync({ shops });
      assert.equal(job.status, 'succeeded');
      assert.deepEqual(job.shops.map((s: any) => [s.shopId, s.status, s.fetched]), [['A', 'succeeded', 3], ['B', 'succeeded', 3]]);
      const since = sinceCalls.at(-1)!.since.getTime();
      assert.ok(Math.abs(since - (Date.now() - 30 * DAY)) < 60_000, '首次回溯 30 天');
      const sources = (await request('/sources')).data;
      assert.deepEqual(sources.platforms[0].shops.map((s: any) => s.orderCount), [3, 3, 0]);
      assert.ok(sources.platforms[0].shops[0].lastSyncedAt);
    });

    await t.test('预览：按判定链拆分材质，取消的订单不进待发货', async () => {
      const { status, data } = await request('/preview', 'POST', daily);
      assert.equal(status, 200, JSON.stringify(data));
      assert.deepEqual(data.buckets.map((b: any) => [b.label, b.orderCount, b.quantity]), [['棉', 2, 3], ['聚酯纤维', 2, 2], ['待确认', 2, 2]]);
      assert.deepEqual(data.totals, { orders: 5, lines: 6, quantity: 7 });
      const cotton = bucket(data, 'cotton');
      // 默认按下单时间从早到晚，SKU 不再影响顺序。
      assert.deepEqual(cotton.lines.map((l: any) => [l.orderId, l.materialSource]), [['A-1', 'catalog-manual'], ['A-2', 'platform-attribute']]);
      assert.equal(cotton.lines[0].shopName, '店铺A', '店铺名用当前名称');
      assert.deepEqual(bucket(data, 'polyester').lines.map((l: any) => [l.orderId, l.isGift, l.materialSource]), [['A-3', false, 'title'], ['B-2', true, 'title']]);
      const unknown = bucket(data, 'unknown');
      assert.deepEqual(unknown.lines.map((l: any) => [l.orderId, l.material]), [['B-1', 'blend'], ['B-2', 'unknown']]);
      assert.match(unknown.lines[0].materialEvidence, /65% polyester/);
      assert.deepEqual(data.files.map((f: any) => f.name), [`${today}_棉_测试平台订单.xlsx`, `${today}_聚酯纤维_测试平台订单.xlsx`, `${today}_棉_订单_供应商拿货_成人.xlsx`]);
      assert.equal(bucket(data, 'unknown').excluded, true);
      assert.match(data.warnings[0], /本次不导出/);
    });

    await t.test('本次临时改材质与记住商品材质', async () => {
      const overridden = (await request('/preview', 'POST', { ...daily, overrides: { [lineUid('B', 'B-2')]: 'polyester' } })).data;
      assert.deepEqual(orderIds(bucket(overridden, 'polyester')), ['A-3', 'B-2']);
      assert.equal(bucket(overridden, 'polyester').lines.length, 3);
      assert.deepEqual(orderIds(bucket(overridden, 'unknown')), ['B-1']);

      const missing = await request('/material-rules', 'POST', { platform: 'fake', material: 'cotton' });
      assert.equal(missing.status, 400);
      const rule = await request('/material-rules', 'POST', { platform: 'fake', productId: 'P-BLEND', productSku: 'P-BLEND-SKU', title: 'Soft Tee', material: 'cotton' });
      assert.equal(rule.status, 201);
      const again = await request('/material-rules', 'POST', { platform: 'fake', productId: 'P-BLEND', material: 'cotton' });
      assert.equal(again.data.id, rule.data.id, '同一商品只保留一条');
      const preview = (await request('/preview', 'POST', daily)).data;
      assert.deepEqual(bucket(preview, 'cotton').lines.map((l: any) => [l.orderId, l.materialSource]), [['A-1', 'catalog-manual'], ['A-2', 'platform-attribute'], ['B-1', 'rule']]);
      assert.deepEqual(orderIds(bucket(preview, 'unknown')), ['B-2']);
      assert.equal((await request('/material-rules')).data.length, 1);
    });

    await t.test('旧方案也不能导出待确认材质；选图必须属于该商品', async () => {
      const db = getDb();
      const profiles = (await request('/profiles')).data;
      profiles[0].unknown.handling = 'separate';
      db.prepare("UPDATE settings SET value = ? WHERE key = 'order_export_profiles'").run(JSON.stringify(profiles));
      const data = (await request('/preview', 'POST', daily)).data;
      assert.equal(bucket(data, 'unknown').excluded, true);
      assert.ok(data.files.every((file: any) => !file.sheets.includes('待确认')));
      const localLine = bucket(data, 'cotton').lines.find((line: any) => line.orderId === 'A-1');
      assert.deepEqual(localLine.imageUrls, ['https://example.test/front.jpg', 'https://example.test/back.jpg']);
      assert.deepEqual(localLine.selectedImages, ['https://example.test/front.jpg']);
      const invalid = await request('/exports', 'POST', { ...daily, selectedImages: { [localLine.uid]: ['https://example.test/unrelated.jpg'] } });
      assert.equal(invalid.status, 400);
      assert.match(invalid.data.error, /选图已失效/);
      assert.equal((await request('/exports', 'POST', { ...daily, selectedImages: { [localLine.uid]: [] } })).status, 400);
    });

    await t.test('聚酯类型：必选、校验、临时选择、记忆与切换材质清除', async () => {
      const noTypes = { ...daily, polyesterTypes: {} };
      const preview = (await request('/preview', 'POST', noTypes)).data;
      assert.ok(preview.warnings.some((warning: string) => warning.includes('2 行聚酯纤维')));
      assert.equal(bucket(preview, 'cotton').lines[0].purchaseSize, 'XL');
      const missing = await request('/exports', 'POST', noTypes);
      assert.equal(missing.status, 400);
      assert.match(missing.data.error, /请选择平板或针眼/);
      assert.deepEqual((await request('/exports')).data, []);
      assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM order_export_marks').get() as any).n, 0);
      const invalid = await request('/preview', 'POST', { ...daily, polyesterTypes: { [lineUid('A', 'A-3')]: 'invalid' } });
      assert.equal(invalid.status, 400);
      const selected = (await request('/preview', 'POST', daily)).data;
      assert.deepEqual(bucket(selected, 'polyester').lines.map((line: any) => line.polyesterType), ['flat', 'pinhole']);
      const skipped = (await request('/preview', 'POST', { ...noTypes, excludedLineUids: [lineUid('A', 'A-3'), lineUid('B', 'B-2', 'l1')] })).data;
      assert.ok(!skipped.warnings.some((warning: string) => warning.includes('尚未选择')));
      assert.equal(skipped.files.length, 2, '跳过缺类型商品后仍能导出棉质原文件及供应商副本');

      const rule = await request('/material-rules', 'POST', { platform: 'fake', productId: 'P-POLY', material: 'polyester', polyesterType: 'pinhole' });
      assert.equal(rule.status, 201);
      const remembered = (await request('/preview', 'POST', noTypes)).data;
      assert.ok(bucket(remembered, 'polyester').lines.every((line: any) => line.polyesterType === 'pinhole'));
      assert.equal((await request('/material-rules')).data.find((item: any) => item.id === rule.data.id).polyesterType, 'pinhole');
      const cleared = (await request('/preview', 'POST', { ...noTypes, polyesterTypes: { [lineUid('A', 'A-3')]: null } })).data;
      assert.equal(bucket(cleared, 'polyester').lines[0].polyesterType, undefined, '本次明确清除覆盖记住的类型');
      const override = (await request('/preview', 'POST', { ...noTypes, overrides: { [lineUid('A', 'A-3')]: 'cotton' } })).data;
      assert.equal(bucket(override, 'cotton').lines.find((line: any) => line.orderId === 'A-3').polyesterType, undefined);
      const updated = await request(`/material-rules/${rule.data.id}`, 'PUT', { material: 'polyester', polyesterType: 'flat' });
      assert.equal(updated.data.polyesterType, 'flat');
      const cotton = await request(`/material-rules/${rule.data.id}`, 'PUT', { material: 'cotton' });
      assert.equal(cotton.data.polyesterType, undefined);
      const polyester = await request(`/material-rules/${rule.data.id}`, 'PUT', { material: 'polyester' });
      assert.equal(polyester.data.polyesterType, undefined, '切回聚酯时不恢复之前的类型');
      assert.equal((await request(`/material-rules/${rule.data.id}`, 'DELETE')).status, 204);
    });

    await t.test('图片缺失或下载失败时不生成记录、不标记订单，重试仍可导出', async () => {
      const db = getDb();
      const uid = lineUid('A', 'A-2');
      db.prepare('UPDATE order_lines SET image_url = NULL WHERE uid = ?').run(uid);
      const missing = await request('/exports', 'POST', daily);
      assert.equal(missing.status, 400);
      assert.match(missing.data.error, /没有可导出的图片/);
      db.prepare('UPDATE order_lines SET image_url = ? WHERE uid = ?').run('https://example.test/front.jpg', uid);
      imageFailure = true;
      const failed = await request('/exports', 'POST', daily);
      imageFailure = false;
      assert.equal(failed.status, 400);
      assert.match(failed.data.error, /图片下载或处理失败/);
      assert.deepEqual((await request('/exports')).data, []);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM order_export_marks').get() as any).n, 0);
      assert.equal((await request('/preview', 'POST', daily)).data.totals.lines, 6);
      imageCalls.length = 0;
    });

    let exportId = '';
    await t.test('导出：每种材质一个文件，内容、文件名和下载头正确', async () => {
      const { status, data } = await request('/exports', 'POST', { ...daily, selectedImages: { [lineUid('A', 'A-1')]: ['https://example.test/back.jpg', 'https://example.test/front.jpg'] } });
      assert.equal(status, 201, JSON.stringify(data));
      exportId = data.id;
      assert.deepEqual(data.files.map((f: any) => [f.name, f.orderCount, f.quantity]), [
        [`${today}_棉_测试平台订单.xlsx`, 3, 4],
        [`${today}_聚酯纤维_测试平台订单.xlsx`, 2, 2],
        [`${today}_棉_订单_供应商拿货_成人.xlsx`, 3, 4],
      ]);
      assert.equal(data.zipName, `${today}_每日发厂_01.zip`);
      assert.deepEqual(data.query.shops.map((s: any) => s.shopName), ['店铺A', '店铺B']);

      assert.equal((await fetch(`${base}/exports/${exportId}/files/4`)).status, 404, '只生成两个原文件及棉供应商副本');
      assert.equal(data.summary.find((item: any) => item.key === 'unknown').exported, false);
      const cotton = unzip(Buffer.from(await (await fetch(`${base}/exports/${exportId}/files/1`)).arrayBuffer()));
      const cottonSheet = cotton.get('xl/worksheets/sheet1.xml')!.toString();
      assert.ok(cottonSheet.includes('图片 2'));
      const headers = [...cottonSheet.match(/<row r="1"[^>]*>(.*?)<\/row>/)![1].matchAll(/<t[^>]*>(.*?)<\/t>/g)].map((item) => item[1]);
      assert.deepEqual(headers.slice(0, 8), ['图片', '图片 2', '数量', '拿货尺码', '平台本身尺码', '聚酯类型', '店铺', '材质'], '旧方案也固定把发厂字段放前面，拿货尺码紧邻平台尺码之前');
      assert.match(cottonSheet, /<c r="C2" s="0"><v>2<\/v>/, '件数仍是衣服件数');
      assert.match(cottonSheet, /<c r="D2"[^>]*><is><t>XL<\/t>/, '棉质 M 的拿货尺码为 XL');
      assert.match(cottonSheet, /<c r="E2"[^>]*><is><t>M<\/t>/, '平台尺码与衣服对应');
      assert.doesNotMatch(cottonSheet, /<c r="F2"/, '非聚酯的类型列留空');
      assert.match(cottonSheet, /<c r="G2"[^>]*><is><t>店铺A<\/t>/, '店铺归属与衣服对应');
      const polyester = unzip(Buffer.from(await (await fetch(`${base}/exports/${exportId}/files/2`)).arrayBuffer()));
      const polyesterSheet = polyester.get('xl/worksheets/sheet1.xml')!.toString();
      assert.match(polyesterSheet, /<c r="E2"[^>]*><is><t>平板<\/t>/);
      assert.match(polyesterSheet, /<c r="E3"[^>]*><is><t>针眼<\/t>/);

      assert.ok(!cottonSheet.includes('https://example.test/'), '图片列不再写入链接');
      assert.match(cottonSheet, /<drawing r:id="rIdDrawing"\/>/);
      const media = [...cotton.keys()].filter((name) => name.startsWith('xl/media/'));
      assert.equal(media.length, 2, '重复选中的图片只嵌入一次媒体内容');
      for (const name of media) assert.equal((await sharp(cotton.get(name)!).metadata()).format, 'jpeg', 'WebP 和 PNG 统一转成兼容图片');
      const drawing = cotton.get('xl/drawings/drawing1.xml')!.toString();
      assert.equal((drawing.match(/<xdr:oneCellAnchor>/g) ?? []).length, 4, '3 行订单，共 4 张选图');
      const rels = cotton.get('xl/drawings/_rels/drawing1.xml.rels')!.toString();
      assert.match(rels, /Id="rId1"[^>]*image1.jpeg/);
      assert.match(rels, /Id="rId2"[^>]*image2.jpeg/, '同一行第二张图为选中的正面图');
      assert.match(rels, /Id="rId3"[^>]*image2.jpeg/, '下一行正面图复用已有媒体');
      assert.deepEqual(imageCalls.sort(), ['/back.jpg', '/front.jpg'], '仅下载已选图片，同一图片只下载一次，不下载待确认订单图片');
      assert.equal((cottonSheet.match(/>A-1<\/t>/g) ?? []).length, 1, '多图不重复订单行');
      assert.ok(!cottonSheet.includes('Mystery item'));
      assert.ok(cottonSheet.includes('已记住的商品材质') && cottonSheet.includes('商品库分组（人工确认）'));
      assert.match(cotton.get('xl/workbook.xml')!.toString(), /<sheet name="棉"/);

      const supplier = unzip(Buffer.from(await (await fetch(`${base}/exports/${exportId}/files/3`)).arrayBuffer()));
      const supplierSheet = supplier.get('xl/worksheets/sheet1.xml')!.toString();
      // 比较所有单元格内容（含空格位），确保副本只删除平台尺码，行顺序、数量、选图等保持一致。
      const cells = (xml: string, width: number) => [...xml.matchAll(/<row\b[^>]*>(.*?)<\/row>/g)].map(row => {
        const values = Array<string>(width).fill('');
        for (const cell of row[1].matchAll(/<c r="([A-Z]+)\d+"[^>]*>(.*?)<\/c>/g)) {
          const index = [...cell[1]].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;
          values[index] = cell[2];
        }
        return values;
      });
      const sizeIndex = headers.indexOf('平台本身尺码');
      assert.doesNotMatch(supplierSheet, /平台本身尺码/);
      assert.deepEqual(cells(supplierSheet, headers.length - 1), cells(cottonSheet, headers.length).map(row => row.filter((_, i) => i !== sizeIndex)));
      for (const name of [...media, 'xl/drawings/drawing1.xml', 'xl/drawings/_rels/drawing1.xml.rels']) {
        assert.ok(supplier.get(name)!.equals(cotton.get(name)!), `供应商副本图片及位置保持一致：${name}`);
      }

      const zip = await fetch(`${base}/exports/${exportId}/zip`);
      assert.equal(zip.status, 200);
      assert.equal(zip.headers.get('content-type'), 'application/zip');
      assert.deepEqual([...unzip(Buffer.from(await zip.arrayBuffer())).keys()], data.files.map((f: any) => f.name));
      assert.equal((await fetch(`${base}/exports/${exportId}/files/9`)).status, 404);
    });

    await t.test('只导新订单：导过的不再出现；关掉后能看到导出时间', async () => {
      const preview = (await request('/preview', 'POST', daily)).data;
      assert.deepEqual(preview.totals, { orders: 1, lines: 1, quantity: 1 });
      assert.deepEqual(orderIds(bucket(preview, 'unknown')), ['B-2']);
      assert.deepEqual(preview.files, []);
      const empty = await request('/exports', 'POST', daily);
      assert.equal(empty.status, 400);
      assert.match(empty.data.error, /没有需要导出的订单/);
      const all = (await request('/preview', 'POST', { ...daily, onlyNew: false })).data;
      assert.equal(all.totals.lines, 6);
      assert.ok(all.buckets.every((b: any) => b.lines.every((l: any) => b.excluded ? !l.exportedAt : l.exportedAt)));
      const profile = (await request('/profiles')).data.find((p: any) => p.id === 'daily');
      assert.deepEqual(profile.defaults, { shops, statuses: ['to_ship'], onlyNew: true }, '导出后记住勾选条件');
    });

    await t.test('增量同步：新订单进入，状态变更覆盖旧数据', async () => {
      const previousSyncEnd = Date.now();
      orders.push(order({ shopId: 'A', orderId: 'A-4', orderedAgo: 0, lines: [{ productId: 'P-POLY', title: 'Polyester Sport T-Shirt' }] }));
      const b1 = orders.find((o) => o.orderId === 'B-1')!;
      b1.status = 'shipped';
      b1.rawStatus = 'shipped';
      b1.updatedAt = new Date().toISOString();
      const job = await sync({ shops });
      assert.equal(job.status, 'succeeded');
      const since = sinceCalls.at(-1)!.since.getTime();
      assert.ok(since > previousSyncEnd - 11 * 60_000 && since < previousSyncEnd, '从上次同步时间减 10 分钟开始');
      const preview = (await request('/preview', 'POST', daily)).data;
      assert.deepEqual(preview.buckets.flatMap((b: any) => b.lines.map((l: any) => l.orderId)), ['A-4', 'B-2']);
      const all = (await request('/preview', 'POST', { ...daily, onlyNew: false })).data;
      assert.ok(!all.buckets.some((b: any) => b.lines.some((l: any) => l.orderId === 'B-1')), '已发货的不在待发货里');
      const shipped = (await request('/preview', 'POST', { ...daily, statuses: ['shipped'], onlyNew: false })).data;
      assert.deepEqual(shipped.buckets.flatMap((b: any) => b.lines.map((l: any) => l.orderId)), ['B-1']);
    });

    await t.test('选更早的日期时补拉，日期按北京时间过滤', async () => {
      const oldDay = chinaDate(new Date(Date.now() - 40 * DAY));
      const job = await sync({ shops: [shops[0]], from: oldDay });
      assert.equal(job.status, 'succeeded');
      assert.ok(sinceCalls.at(-1)!.since.getTime() <= new Date(chinaDayStartIso(oldDay)).getTime());
      const preview = (await request('/preview', 'POST', { ...daily, from: oldDay, to: oldDay })).data;
      assert.deepEqual(preview.buckets.flatMap((b: any) => b.lines.map((l: any) => l.orderId)), ['A-OLD']);
      const bad = await request('/preview', 'POST', { ...daily, from: '2026-11-16', to: '2026-11-15' });
      assert.equal(bad.status, 400);
    });

    await t.test('某个店铺同步失败不影响其他店铺，并在预览里提示', async () => {
      failShopB = true;
      const job = await sync({ shops });
      assert.equal(job.status, 'partial');
      assert.deepEqual(job.shops.map((s: any) => s.status), ['succeeded', 'failed']);
      assert.match(job.shops[1].error, /授权已过期/);
      const preview = (await request('/preview', 'POST', daily)).data;
      assert.ok(preview.warnings.some((w: string) => w.includes('店铺B') && w.includes('授权已过期')));
      const sources = (await request('/sources')).data;
      assert.match(sources.platforms[0].shops[1].lastError, /授权已过期/);
      failShopB = false;
      assert.equal((await sync({ shops })).status, 'succeeded');
      assert.ok(!(await request('/preview', 'POST', daily)).data.warnings.some((w: string) => w.includes('授权已过期')), '恢复后不再提示同步错误');
    });

    await t.test('方案：校验、一个文件多工作表、未识别跳过且不标记', async () => {
      const invalid = await request('/profiles/sheet', 'PUT', {
        name: '对账', layout: 'sheet-per-material', fileName: '{profile}_{date}',
        buckets: [{ material: 'cotton', label: '待确认' }], unknown: { handling: 'skip', label: '待确认' },
        columns: ['orderId'], defaults: { shops: [], statuses: ['to_ship'], onlyNew: true },
      });
      assert.equal(invalid.status, 400);
      assert.match(invalid.data.error, /不能重复/);
      const saved = await request('/profiles/sheet', 'PUT', {
        name: '对账', layout: 'sheet-per-material', fileName: '{profile}_{date}_{count}单',
        buckets: [{ material: 'cotton', label: '全棉' }, { material: 'polyester', label: '涤纶' }],
        unknown: { handling: 'skip', label: '待确认' },
        columns: ['orderId', 'material', 'quantity', 'unitPrice'], defaults: { shops: [], statuses: ['to_ship'], onlyNew: true },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.data));
      assert.deepEqual(saved.data.map((p: any) => p.id), ['daily', 'sheet']);

      const query = { ...daily, profileId: 'sheet' };
      const preview = (await request('/preview', 'POST', query)).data;
      assert.equal(bucket(preview, 'unknown').excluded, true);
      assert.ok(preview.warnings.some((w: string) => w.includes('本次不导出')));
      // 新方案没有导出过：棉 A-1、A-2、A-OLD，涤纶 A-3、A-4、B-2 赠品，共 6 单
      assert.deepEqual(preview.files.map((f: any) => [f.name, f.sheets]), [[`对账_${today}_6单.xlsx`, ['全棉', '涤纶']], [`对账_${today}_3单_供应商拿货_成人.xlsx`, ['全棉']]]);

      const exported = (await request('/exports', 'POST', query)).data;
      assert.equal(exported.files.length, 2);
      assert.deepEqual(exported.summary.map((s: any) => [s.label, s.exported]), [['全棉', true], ['涤纶', true], ['待确认', false]]);
      const workbook = unzip(Buffer.from(await (await fetch(`${base}/exports/${exported.id}/files/1`)).arrayBuffer()));
      assert.match(workbook.get('xl/workbook.xml')!.toString(), /<sheet name="全棉".*<sheet name="涤纶"/);
      assert.ok(workbook.get('xl/worksheets/sheet1.xml')!.toString().includes('单价'));
      const customHeaders = [...workbook.get('xl/worksheets/sheet1.xml')!.toString().match(/<row r="1"[^>]*>(.*?)<\/row>/)![1].matchAll(/<t[^>]*>(.*?)<\/t>/g)].map((item) => item[1]);
      assert.deepEqual(customHeaders, ['图片', '数量', '拿货尺码', '平台本身尺码', '聚酯类型', '店铺', '材质', '订单号', '单价'], '自定义方案缺少必需字段时自动补齐并放在前面');
      const supplier = unzip(Buffer.from(await (await fetch(`${base}/exports/${exported.id}/files/2`)).arrayBuffer()));
      assert.match(supplier.get('xl/workbook.xml')!.toString(), /<sheet name="全棉"/);
      assert.doesNotMatch(supplier.get('xl/workbook.xml')!.toString(), /涤纶/);
      assert.ok(!supplier.has('xl/worksheets/sheet2.xml'));
      assert.doesNotMatch(supplier.get('xl/worksheets/sheet1.xml')!.toString(), /平台本身尺码/);

      const remaining = (await request('/preview', 'POST', query)).data;
      assert.deepEqual(remaining.buckets.flatMap((b: any) => b.lines.map((l: any) => l.orderId)), ['B-2'], '跳过的未识别订单下次仍会出现');
      const dailyLeft = (await request('/preview', 'POST', daily)).data;
      assert.deepEqual(dailyLeft.buckets.flatMap((b: any) => b.lines.map((l: any) => l.orderId)).sort(), ['A-4', 'A-OLD', 'B-2'], '不同方案的「已导出」互不影响');

      assert.equal((await request('/profiles/daily', 'DELETE')).status, 200);
      assert.equal((await request('/profiles/sheet', 'DELETE')).status, 400, '至少保留一个方案');
    });

    await t.test('导出记录与过期清理', async () => {
      const history = (await request('/exports')).data;
      assert.equal(history.length, 2);
      assert.equal(history[1].id, exportId);
      const removed = orderExportService.cleanupExpired(new Date(Date.now() + 31 * DAY));
      assert.equal(removed, 2);
      assert.equal((await fetch(`${base}/exports/${exportId}/files/1`)).status, 410);
      assert.equal((await fetch(`${base}/exports/${exportId}/zip`)).status, 410);
      assert.equal((await request('/exports')).data[1].filesExpired, true);
    });

    await t.test('只允许本机访问：经隧道转发或外部域名的请求被拒绝', async () => {
      assert.equal((await rawGet(port, '/api/orders/sources', { Host: `127.0.0.1:${port}` })).status, 200);
      assert.equal((await rawGet(port, '/api/orders/sources', { Host: `localhost:${port}` })).status, 200);
      const forwarded = await rawGet(port, '/api/orders/sources', { Host: `localhost:${port}`, 'X-Forwarded-For': '203.0.113.9' });
      assert.equal(forwarded.status, 403);
      assert.match(JSON.parse(forwarded.body).error, /买家/);
      assert.equal((await rawGet(port, '/api/orders/exports', { Host: 'java-suburb-kettle.ngrok-free.dev' })).status, 403);
      assert.equal((await rawGet(port, '/api/health', { Host: 'java-suburb-kettle.ngrok-free.dev' })).status, 200, '其他接口不受影响');
    });

    await t.test('订单与标记数据结构', () => {
      const db = getDb();
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM orders').get() as any).n, 8);
      const marks = db.prepare("SELECT profile_id, COUNT(*) AS n FROM order_export_marks GROUP BY profile_id ORDER BY profile_id").all();
      assert.deepEqual(marks, [{ profile_id: 'daily', n: 5 }, { profile_id: 'sheet', n: 6 }]);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    getDb().close();
    rmSync(dir, { recursive: true, force: true });
  }
});

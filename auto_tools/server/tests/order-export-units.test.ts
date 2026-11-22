import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chinaDate,
  chinaDayStartIso,
  formatChinaDateTime,
  rangeForPreset,
  renderFileName,
  sanitizeFileName,
  orderExportColumns,
  purchaseSizeFor,
} from '../../shared/orders';
import { inferMaterialFromText } from '../../shared/product-grouping';
import { crc32, createZip } from '../src/util/zip';
import { unzip } from './helpers/zip-reader';
import { buildXlsx, columnLetter, sheetNames } from '../src/orders/writers/xlsx';
import { extractJoomProductInfo, mapJoomOrder, mapJoomOrderStatus } from '../src/marketplaces/joom/orders';

test('拿货尺码：棉质逐档映射，其他材质与未知尺码保留原值', () => {
  const sizes = ['2XS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];
  assert.deepEqual(sizes.map((size) => purchaseSizeFor('cotton', size)), ['160', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '4XL', '4XL']);
  for (const material of ['polyester', 'blend', 'other', 'unknown'] as const) {
    assert.deepEqual(sizes.map((size) => purchaseSizeFor(material, size)), sizes);
  }
  for (const size of ['100', '160', '5XL', 'M / L', 'custom', '', undefined]) {
    assert.equal(purchaseSizeFor('cotton', size), size);
  }
  assert.equal(purchaseSizeFor('cotton', ' xxl '), '4XL');
  assert.equal(purchaseSizeFor('cotton', 'XXS'), '160');
  assert.equal(purchaseSizeFor('cotton', 'XXXL'), '4XL');
  assert.equal(purchaseSizeFor('cotton', 'XXXXL'), '4XL');
  assert.deepEqual(orderExportColumns(['orderId', 'size', 'material']), ['imageUrl', 'quantity', 'size', 'polyesterType', 'purchaseSize', 'shop', 'material', 'orderId']);
});

test('北京时间日期与预设范围', () => {
  assert.equal(chinaDate(new Date('2026-11-15T15:59:59Z')), '2026-11-15');
  assert.equal(chinaDate(new Date('2026-11-15T16:00:00Z')), '2026-11-16');
  assert.equal(chinaDayStartIso('2026-11-16'), '2026-11-15T16:00:00.000Z');
  assert.equal(formatChinaDateTime('2026-11-15T16:05:00Z'), '2026-11-16 00:05');
  assert.equal(formatChinaDateTime('not a date'), '');
  assert.deepEqual(rangeForPreset('today', '2026-11-16'), { from: '2026-11-16', to: '2026-11-16' });
  assert.deepEqual(rangeForPreset('yesterday', '2026-03-01'), { from: '2026-02-28', to: '2026-02-28' });
  assert.deepEqual(rangeForPreset('last7', '2026-11-16'), { from: '2026-11-10', to: '2026-11-16' });
  assert.deepEqual(rangeForPreset('last30', '2026-11-16'), { from: '2026-10-18', to: '2026-11-16' });
  assert.deepEqual(rangeForPreset('all', '2026-11-16'), {});
});

test('文件名模板：变量、日期格式、清理与兜底', () => {
  const ctx = {
    platforms: ['Joom'],
    shops: ['店铺A', '店铺B'],
    material: '棉',
    profile: '每日发厂',
    now: new Date('2026-11-15T17:30:00Z'), // 北京时间 11-16 01:30
    from: '2026-11-15',
    to: '2026-11-16',
    count: 32,
    qty: 41,
    seq: 2,
  };
  assert.equal(renderFileName('{date}_{material}_{platform}订单', ctx), '20261116_棉_Joom订单');
  assert.equal(renderFileName('{date:YYYY-MM-DD}-{time}', ctx), '2026-11-16-0130');
  assert.equal(renderFileName('{shops}_{from}-{to:MMDD}_{count}单{qty}件_{seq}_{profile}', ctx), '店铺A+店铺B_20261115-1116_32单41件_02_每日发厂');
  assert.equal(renderFileName('{unknownVar}_{material}', ctx), '{unknownVar}_棉', '未知变量原样保留，方便发现拼写错误');
  // 未选日期时 {from}{to} 为空，留下的分隔符被压缩
  assert.equal(sanitizeFileName(renderFileName('{from}-{to}_{material}', { ...ctx, from: undefined, to: undefined })), '棉');
  assert.equal(sanitizeFileName('a/b:c*?"<>|d'), 'a_b_c_d');
  assert.equal(sanitizeFileName('  __  '), '订单导出');
  assert.equal(sanitizeFileName('CON'), '_CON');
  assert.equal(sanitizeFileName('x'.repeat(300)).length, 120);
});

test('材质关键词与采集分组规则一致', () => {
  assert.equal(inferMaterialFromText('100% Cotton'), 'cotton');
  assert.equal(inferMaterialFromText('Хлопок 100%'), 'cotton');
  assert.equal(inferMaterialFromText('Polyester sports tee'), 'polyester');
  assert.equal(inferMaterialFromText('65% polyester, 35% cotton'), 'blend');
  assert.equal(inferMaterialFromText('cotton feel polyester tee'), 'polyester', '“棉感”不算棉');
  assert.equal(inferMaterialFromText('Classic tee'), 'unknown');
});

test('Joom 订单状态映射', () => {
  assert.equal(mapJoomOrderStatus('approved'), 'to_ship');
  assert.equal(mapJoomOrderStatus('fulfilledOnline'), 'to_ship');
  assert.equal(mapJoomOrderStatus('shipped'), 'shipped');
  assert.equal(mapJoomOrderStatus('cancelled'), 'cancelled');
  assert.equal(mapJoomOrderStatus('refunded'), 'refunded');
  assert.equal(mapJoomOrderStatus('paidByJoomRefund'), 'refunded');
  for (const status of ['returnInitiated', 'returnArrived', 'returnCompleted', 'returnDeclined', 'returnExpired']) {
    assert.equal(mapJoomOrderStatus(status), 'returned');
  }
  assert.equal(mapJoomOrderStatus('somethingNew'), 'other');
});

test('Joom 商品信息：变体颜色尺码图片与材质原文', () => {
  const info = extractJoomProductInfo({
    id: 'P1',
    name: 'Basic Tee',
    mainImage: { imageState: 'processed', origUrl: 'https://img.test/orig.jpg', processed: [
      { url: 'https://img.test/1000.jpg', width: 1000, height: 1000 },
      { url: 'https://img.test/200.jpg', width: 200, height: 200 },
      { url: 'https://img.test/500.jpg', width: 500, height: 500 },
    ] },
    extraImages: [{ origUrl: 'https://img.test/back.jpg' }, { origUrl: 'https://img.test/detail.jpg' }],
    // 本系统发布时类目属性的 key 是属性 id，靠纤维词兜底
    attributes: [{ key: '1001', value: '100% Cotton' }, { key: 'Season', value: 'Summer' }],
    variants: [
      { id: 'V1', sku: 'TEE-BLK-M', colors: 'black', size: 'M', mainImage: { imageState: 'processed', origUrl: 'https://img.test/v1.jpg' } },
      { id: 'V2', sku: 'TEE-WHT-L', colors: 'white', size: 'L', attributes: [{ key: 'Material', value: '95% polyester, 5% elastane' }] },
    ],
  });
  assert.equal(info.name, 'Basic Tee');
  assert.equal(info.imageUrl, 'https://img.test/orig.jpg', '优先原图，保留放大观看的清晰度');
  assert.deepEqual(info.imageUrls, ['https://img.test/orig.jpg', 'https://img.test/back.jpg', 'https://img.test/detail.jpg']);
  assert.equal(extractJoomProductInfo({ mainImage: { processed: [
    { url: 'https://img.test/400.jpg', width: 400 }, { url: 'https://img.test/1200.jpg', width: 1200 },
  ] } }).imageUrl, 'https://img.test/1200.jpg', '没有原图时选择最大的处理图');
  assert.equal(info.materialHint, '100% Cotton');
  assert.deepEqual(info.variants.V1, { sku: 'TEE-BLK-M', color: 'black', size: 'M', imageUrl: 'https://img.test/v1.jpg', materialHint: undefined });
  assert.equal(info.variantsBySku['TEE-WHT-L'].materialHint, '95% polyester, 5% elastane');

  const parsed = extractJoomProductInfo({ name: 'x', parsedAttributes: [{ key: 'material', values: [{ text: 'polyester' }] }], attributes: [{ key: 'Care', value: 'Hand wash' }] });
  assert.equal(parsed.materialHint, 'polyester', 'Joom 解析出的材质优先于纤维词兜底');
});

test('Joom 订单映射：按官方文档字段，含赠品、地址、物流、金额', () => {
  const products = new Map([['P1', extractJoomProductInfo({
    name: 'Basic Tee',
    attributes: [{ key: 'material', value: '100% cotton' }],
    variants: [{ id: 'V1', sku: 'TEE-BLK-M', colors: 'black', size: 'M' }],
  })]]);
  const order = mapJoomOrder({
    id: 'ABCD1234',
    currency: 'USD',
    orderTimestamp: '2026-11-15T08:00:00Z',
    updateTimestamp: '2026-11-15T09:30:00Z',
    status: 'approved',
    quantity: 2,
    priceInfo: { unitPrice: '4.52', shippingPrice: '1.00', commissionAmount: '0.5', orderPrice: '8.04' },
    product: { id: 'P1', sku: 'TEE', variant: { id: 'V1', sku: 'TEE-BLK-M' } },
    giftProduct: { id: 'P9', sku: 'GIFT', variant: { id: 'V9', sku: 'GIFT-1' } },
    shippingAddress: { name: 'Ivan Petrov', phoneNumber: '0012345678', country: 'RU', state: 'Moscow', city: 'Moscow', street: 'Lenina', house: '10', flat: '5', zipCode: '010203' },
    shippingAddressNative: { name: 'Иван Петров', country: 'RU', zipCode: '010203', email: 'buyer@example.test' },
    shippingAddressHash: 'hash',
    shipment: { provider: 'Joom Logistics', providerId: 'jl', trackingNumber: 'JL000123', timestamp: '2026-11-15T10:00:00Z' },
    storeId: 'S1',
  }, { shopId: 'shop-1', shopName: '店铺A' }, products);
  assert.ok(order);
  assert.equal(order.status, 'to_ship');
  assert.equal(order.rawStatus, 'approved');
  assert.equal(order.orderedAt, '2026-11-15T08:00:00.000Z');
  assert.equal(order.updatedAt, '2026-11-15T09:30:00.000Z');
  assert.deepEqual(order.tracking, { carrier: 'Joom Logistics', number: 'JL000123' });
  assert.equal(order.address?.name, 'Ivan Petrov', '面单优先用拉丁字母地址');
  assert.equal(order.address?.email, 'buyer@example.test', '缺的字段用本地语言地址补');
  assert.equal(order.address?.line1, 'Lenina, 10, 5');
  assert.equal(order.address?.phone, '0012345678');
  assert.equal(order.lines.length, 2);
  assert.deepEqual(
    { ...order.lines[0] },
    {
      lineId: 'main', productId: 'P1', productSku: 'TEE', variantId: 'V1', variantSku: 'TEE-BLK-M',
      title: 'Basic Tee', color: 'black', size: 'M', imageUrl: undefined, imageUrls: [], quantity: 2,
      unitPrice: 4.52, amount: 8.04, materialHint: '100% cotton',
    },
  );
  assert.equal(order.lines[1].lineId, 'gift');
  assert.equal(order.lines[1].isGift, true);
  assert.equal(order.lines[1].quantity, 2);
  assert.equal(order.lines[1].title, undefined, '赠品商品信息没拉到时留空，不影响入库');
  assert.equal(mapJoomOrder({ status: 'approved' }, { shopId: 's', shopName: 's' }, new Map()), null, '没有订单号的跳过');
});

test('CRC32 与 ZIP：标准校验值、UTF-8 文件名、可解压', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const zip = createZip([
    { name: '20261116_棉_Joom订单.xlsx', data: Buffer.from('hello hello hello hello') },
    { name: 'empty.txt', data: '' },
  ]);
  const entries = unzip(zip);
  assert.deepEqual([...entries.keys()], ['20261116_棉_Joom订单.xlsx', 'empty.txt']);
  assert.equal(entries.get('20261116_棉_Joom订单.xlsx')!.toString(), 'hello hello hello hello');
  assert.equal(entries.get('empty.txt')!.length, 0);
});

test('xlsx：文本不丢开头的 0、数字列为数字、特殊字符转义、工作表名合法', () => {
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(26), 'AA');
  assert.equal(columnLetter(701), 'ZZ');
  assert.deepEqual(sheetNames(['棉', '棉', 'a/b:c', "'quoted'", 'x'.repeat(40)]), ['棉', '棉 (2)', 'a_b_c', 'quoted', 'x'.repeat(31)]);

  const file = buildXlsx([
    {
      name: '棉',
      columns: [{ header: '订单号', width: 12 }, { header: '电话' }, { header: '数量', numeric: true }, { header: '备注' }],
      rows: [
        ['ABCD1234', '0012345678', 2, 'Tom & Jerry <b> "q"'],
        ['EFGH5678', undefined, 1, ' 前后空格 '],
        ['CTRL', 'a\u0001b', null, '\ud800坏代理项'],
      ],
    },
    { name: '聚酯纤维', columns: [{ header: '订单号' }], rows: [] },
  ], new Date('2026-11-16T01:02:03.456Z'));
  const entries = unzip(file);
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'docProps/core.xml']) {
    assert.ok(entries.has(part), `缺少 ${part}`);
  }
  const workbook = entries.get('xl/workbook.xml')!.toString();
  assert.match(workbook, /<sheet name="棉" sheetId="1" r:id="rId1"\/><sheet name="聚酯纤维" sheetId="2" r:id="rId2"\/>/);
  assert.match(entries.get('docProps/core.xml')!.toString(), /2026-11-16T01:02:03Z/);
  const sheet = entries.get('xl/worksheets/sheet1.xml')!.toString();
  const styles = entries.get('xl/styles.xml')!.toString();
  assert.equal((styles.match(/<sz val="16"\/>/g) ?? []).length, 2, '表头和正文均为 16 号字');
  assert.match(sheet, /<row r="1" ht="30" customHeight="1">/);
  assert.match(sheet, /defaultRowHeight="24"/);
  assert.match(styles, /wrapText="1"/);
  assert.match(sheet, /<c r="B2" t="inlineStr" s="2"><is><t>0012345678<\/t><\/is><\/c>/, '电话按文本写入');
  assert.match(sheet, /<c r="C2" s="0"><v>2<\/v><\/c>/, '数量是数字');
  assert.match(sheet, /Tom &amp; Jerry &lt;b&gt; &quot;q&quot;/);
  assert.match(sheet, /<t xml:space="preserve"> 前后空格 <\/t>/);
  assert.match(sheet, /<t>ab<\/t>/, '去掉 XML 不允许的控制字符');
  assert.match(sheet, /<t>坏代理项<\/t>/, '去掉孤立代理项');
  assert.doesNotMatch(sheet, /r="B3"/, '空单元格不写');
  assert.match(sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(sheet, /<autoFilter ref="A1:D4"\/>/);
  assert.match(sheet, /<dimension ref="A1:D4"\/>/);
  assert.match(sheet, /tabSelected="1"/);
  assert.doesNotMatch(entries.get('xl/worksheets/sheet2.xml')!.toString(), /tabSelected/);
});

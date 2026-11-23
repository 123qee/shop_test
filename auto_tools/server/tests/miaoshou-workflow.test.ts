import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { emptyMiaoshouFields, miaoshouDraftIssues, type MiaoshouDraft, type MiaoshouRules, type MiaoshouTemplate } from '../../shared/miaoshou';
import { MiaoshouClient, MiaoshouError, miaoshouSignature, MIAOSHOU_PATHS } from '../src/marketplaces/miaoshou/client';

const rules: MiaoshouRules = {
  productAttributeRules: [{ id: 'BRAND', name: 'Brand', displayName: '品牌', tags: { required: '1' } }], skuAttributeRules: [],
  saleAttributeRules: [{ id: 'COLOR', name: 'Color', displayName: '颜色', tags: { required: '1', definesPicture: '1' } }, { id: 'SIZE', name: 'Size', displayName: '尺码', tags: { required: '0' } }],
};
const complete = { ...emptyMiaoshouFields(), shopId: '123', categoryId: '101109042', netProceeds: 7.25, description: 'Cotton short sleeve t-shirt.', stock: 20, weightKg: 0.25, lengthCm: 15, widthCm: 10, heightCm: 1, warrantyType: 'noWarranty' as const, attributes: [{ name: 'Brand', values: [{ name: 'Generic' }] }] };

test('妙手签名使用同一份 JSON 字节，请求仅使用官方接口与签名头', async () => {
  const body = '{"title":"Café Shirt","price":7.25}';
  const expected = createHmac('sha256', 'test-secret').update('test-secret/open/example1700000000ak-test' + body + 'test-secret').digest('hex');
  assert.equal(miaoshouSignature('test-secret', '/open/example', '1700000000', 'ak-test', body), expected);
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://openapi-erp.91miaoshou.com' + MIAOSHOU_PATHS.shops);
    assert.equal(init?.redirect, 'error');
    const headers = init!.headers as Record<string, string>;
    assert.equal(headers['x-app-key'], 'ak-test');
    assert.equal(headers['x-sign'], miaoshouSignature('test-secret', MIAOSHOU_PATHS.shops, headers['x-timestamp'], 'ak-test', String(init!.body)));
    assert.equal(headers.Cookie, undefined);
    return Response.json({ result: 'success', code: 'success', data: { shopList: [] } });
  };
  assert.deepEqual(await new MiaoshouClient('ak-test', 'test-secret', fetcher, 0).call(MIAOSHOU_PATHS.shops, { platform: 'mercadolibre' }), { shopList: [] });
});

test('妙手创建请求网络失败或响应含糊时保留结果待核对，读取失败可直接报告', async () => {
  const client = new MiaoshouClient('key', 'secret', async () => { throw new TypeError('network failed'); }, 0);
  await assert.rejects(client.call(MIAOSHOU_PATHS.create, {}), (e: unknown) => e instanceof MiaoshouError && e.uncertain);
  await assert.rejects(client.call(MIAOSHOU_PATHS.shops, {}), (e: unknown) => e instanceof MiaoshouError && !e.uncertain);
  const broken = new MiaoshouClient('key', 'secret', async () => new Response('<html>upstream failed</html>', { status: 502 }), 0);
  await assert.rejects(broken.call(MIAOSHOU_PATHS.create, {}), (e: unknown) => e instanceof MiaoshouError && e.uncertain);
  const partial = new MiaoshouClient('key', 'secret', async () => Response.json({ result: 'success', data: { collectBoxDetailId: 123 } }), 0);
  await assert.rejects(partial.call(MIAOSHOU_PATHS.create, {}), (e: unknown) => e instanceof MiaoshouError && e.uncertain);
});

test('独立分拣、模板、校验、提交、冲突与中断恢复，不改变 Joom 和采集记录', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'miaoshou-workflow-'));
  process.env.DB_PATH = join(dir, 'test.db');
  const { getDb } = await import('../src/db/index');
  const { productRepository } = await import('../src/repositories/product-repository');
  const { MiaoshouService, buildMiaoshouPayload } = await import('../src/services/miaoshou-service');
  const { createApp } = await import('../src/app');
  let createCount = 0;
  let mode: 'success' | 'timeout' = 'success';
  let detail: any = {};
  const seenPayloads: any[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    let data: unknown;
    const path = String(url).replace('https://openapi-erp.91miaoshou.com', '');
    if (path === MIAOSHOU_PATHS.shops) { assert.equal(JSON.parse(String(init!.body)).site, 'CBT'); data = { shopList: [{ shopId: 123, shopNick: '传统店铺', site: 'CBT', status: 'normal' }] }; }
    else if (path === MIAOSHOU_PATHS.sites) data = { siteAndSiteNameMap: { CL: '智利', MX: '墨西哥', CO: '哥伦比亚', BR: '巴西' } };
    else if (path === MIAOSHOU_PATHS.rules) data = rules;
    else if (path === MIAOSHOU_PATHS.detail) data = { siteCollectItemInfo: detail };
    else if (path === MIAOSHOU_PATHS.search) data = { detailList: [{ collectBoxDetailId: 3344, title: 'Matching candidate', collectBoxDetailShop: { shopId: '123' } }, { collectBoxDetailId: 5566, title: 'Other shop', collectBoxDetailShop: { shopId: '456' } }] };
    else if (path === MIAOSHOU_PATHS.create) { createCount++; seenPayloads.push(JSON.parse(String(init!.body))); if (mode === 'timeout') throw new TypeError('timeout'); data = { collectBoxDetailId: 998877 }; }
    else throw new Error('Unexpected remote write: ' + path);
    return Response.json({ result: 'success', code: 'success', data });
  };
  const service = new MiaoshouService((key, secret) => new MiaoshouClient(key, secret, fetcher, 0));
  service.saveConfig({ appKey: 'ak-local-test', appSecret: 'private-test-secret', defaultShopId: '123' });
  const source = (id: string) => productRepository.create({ source: 'aliexpress', sourceProductId: id, sourceUrl: `https://source.example/${id}`, title: 'Cotton T-Shirt ' + id, description: 'Source description.', images: ['https://img.example/a.jpg', 'https://img.example/b.jpg'], price: { value: 999, currency: 'CNY' }, attributes: {}, variants: [{ sourceSkuId: id + '-S', options: { Color: 'Black', Size: 'S' }, image: 'https://img.example/a.jpg', stock: 12 }, { sourceSkuId: id + '-M', options: { Color: 'Black', Size: 'M' }, stock: 13 }] });
  const p1 = source('one'), p2 = source('two'), p3 = source('three');
  const before = getDb().prepare('SELECT * FROM products ORDER BY id').all();
  let d1 = service.open(p1.id), d2 = service.open(p2.id), d3 = service.open(p3.id);
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/miaoshou`;
  async function request(path: string, method = 'GET', body?: unknown, extra: Record<string,string> = {}) { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) as any }; }
  async function settled(id: string) { const until = Date.now() + 3000; while (Date.now() < until) { const d = service.get(id); if (!['queued', 'submitting'].includes(d.status)) return d; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Worker did not settle'); }
  try {
    await t.test('草稿留空不自动使用来源价格；同一商品只创建一个独立草稿', () => {
      assert.equal(d1.netProceeds, null); assert.equal(d1.variants[0].sourcePrice, null);
      assert.equal(service.open(p1.id).id, d1.id); assert.equal(d1.variants.length, 2);
      assert.ok(miaoshouDraftIssues(d1).some(i => /净收益/.test(i)));
    });
    await t.test('模板允许不完整，确认与跳过独立保存，撤销只恢复对应版本', () => {
      const template: MiaoshouTemplate = { ...emptyMiaoshouFields(), id: randomUUID(), name: '童装待完善模板', groupId: 'kids-short', material: 'cotton' };
      service.saveTemplate(template);
      d1 = service.decide(d1.id, d1.version, 'ready', template.id);
      assert.equal(d1.templateId, template.id); assert.equal(d1.netProceeds, null); assert.equal(d1.description, 'Source description.');
      d1 = service.undo(service.workspace().undoId!); assert.equal(d1.status, 'pending'); assert.equal(d1.templateId, '');
      d2 = service.decide(d2.id, d2.version, 'skipped');
      const undo = service.workspace().undoId!;
      d2 = service.update(d2.id, d2.version, { title: 'A later edit' });
      assert.throws(() => service.undo(undo), /版本|修改/); assert.equal(service.get(d2.id).title, 'A later edit');
    });
    await t.test('API 不允许修改内部状态；拒绝远程转发、错误站点和旧版本', async () => {
      assert.equal((await request(`/drafts/${d1.id}`, 'PATCH', { version: d1.version, patch: { status: 'submitted' } })).status, 400);
      assert.equal((await request(`/drafts/${d1.id}`, 'PATCH', { version: 1, patch: { title: 'Stale overwrite' } })).status, 409);
      assert.equal((await request('/workspace', 'GET', undefined, { 'x-forwarded-host': 'public.example' })).status, 403);
      assert.equal((await request('/config', 'PUT', { defaultSites: ['AR'] })).status, 400);
      const publicData = (await request('/workspace')).data;
      assert.ok(!JSON.stringify(publicData).includes('private-test-secret'));
      assert.equal((await request(`/drafts/${d1.id}`, 'PATCH', { version: d1.version, patch: { sitePrices: { BR: null } } })).status, 400);
    });
    await t.test('净收益与来源价格分离，按真实 SKU 组合生成妙手结构，按规则要求属性', () => {
      d1 = service.update(d1.id, d1.version, complete);
      const payload = buildMiaoshouPayload(d1, rules).siteCollectItemInfo;
      assert.equal(payload.pricingMode, 'netProceeds'); assert.equal(payload.price, 7.25);
      assert.deepEqual(payload.siteAndPriceMap, { CL: 7.25, MX: 7.25, CO: 7.25, BR: 7.25 });
      assert.equal(Object.keys(payload.skuMap).length, 2); assert.ok(Object.keys(payload.skuMap).every(k => /^;\d+;\d+;$/.test(k)));
      assert.equal(payload.firstSkuKey, ';1;'); assert.ok(!JSON.stringify(payload).includes('999'));
      assert.throws(() => buildMiaoshouPayload({ ...d1, attributes: [] }, rules), /品牌/);
      assert.throws(() => buildMiaoshouPayload({ ...d1, sizeMap: { S: 'L', M: 'L' } }, rules), /重复规格/);
      assert.throws(() => buildMiaoshouPayload({ ...d1, variants: [...d1.variants, { ...d1.variants[0], sku: 'extra', options: { Pattern: 'Plain' } }] }, rules), /来源规格|销售属性|规格/);
    });
    await t.test('批量入队失败整体回滚，成功提交一次，重复点击不会再次创建', async () => {
      d1 = service.decide(d1.id, d1.version, 'ready'); d2 = service.decide(d2.id, d2.version, 'ready');
      assert.throws(() => service.enqueue([{ id: d1.id, version: d1.version }, { id: d2.id, version: d2.version }]), /净收益|类目/);
      assert.equal(service.get(d1.id).status, 'ready');
      service.enqueue([{ id: d1.id, version: d1.version }]);
      assert.throws(() => service.enqueue([{ id: d1.id, version: d1.version }]), /版本|状态/);
      d1 = await settled(d1.id); assert.equal(d1.status, 'submitted'); assert.equal(d1.remoteId, '998877'); assert.equal(createCount, 1);
      assert.throws(() => service.enqueue([{ id: d1.id, version: d1.version }]), /状态/);
      assert.equal(seenPayloads[0].siteCollectItemInfo.shopId, '123');
    });
    await t.test('请求超时进入待核对，禁止直接重试，核对身份一致才关联', async () => {
      d2 = service.update(d2.id, d2.version, complete); mode = 'timeout';
      service.enqueue([{ id: d2.id, version: d2.version }]); d2 = await settled(d2.id);
      assert.equal(d2.status, 'needs_review'); assert.equal(createCount, 2);
      assert.throws(() => service.enqueue([{ id: d2.id, version: d2.version }]), /状态/);
      const candidates = await service.reviewCandidates(d2.id, d2.version); assert.equal(candidates.length, 1); assert.equal(candidates[0].remoteId, '3344');
      detail = { sourceItemUrl: d2.sourceUrl, shopId: 'wrong', title: d2.title, skuMap: Object.fromEntries(d2.variants.map((v,i) => [i, { itemNum: v.sku }])), sites: d2.sites, pricingMode: 'netProceeds', price: d2.netProceeds };
      await assert.rejects(service.reconcile(d2.id, d2.version, '3344'), /不一致/);
      assert.equal(service.get(d2.id).status, 'needs_review'); detail.shopId = '123';
      d2 = await service.reconcile(d2.id, d2.version, '3344'); assert.equal(d2.status, 'submitted'); assert.equal(d2.remoteId, '3344');
    });
    await t.test('重启把正在提交的商品保留为待核对；所有商品与 Joom 字段保持原值', async () => {
      getDb().prepare('UPDATE miaoshou_drafts SET status=?,data=? WHERE id=?').run('submitting', JSON.stringify({ ...d3, status: 'submitting' }), d3.id);
      service.start(); await service.drain();
      assert.equal(service.get(d3.id).status, 'needs_review'); assert.equal(createCount, 2);
      assert.deepEqual(getDb().prepare('SELECT * FROM products ORDER BY id').all(), before);
      assert.equal((getDb().prepare('SELECT count(*) n FROM mercadolibre_listings').get() as { n: number }).n, 0);
    });
    await t.test('远端已创建但本机保存回执失败时保留待核对和远端 ID，禁止重复创建', async () => {
      const p4 = source('receipt-error'), original = productRepository.get(p4.id);
      let d4 = service.open(p4.id); d4 = service.update(d4.id, d4.version, complete); d4 = service.decide(d4.id, d4.version, 'ready'); mode = 'success';
      getDb().exec(`CREATE TRIGGER fail_miaoshou_receipt BEFORE UPDATE ON miaoshou_drafts WHEN NEW.id='${d4.id}' AND NEW.status='submitted' BEGIN SELECT RAISE(ABORT,'simulated receipt write failure'); END`);
      service.enqueue([{ id: d4.id, version: d4.version }]); d4 = await settled(d4.id);
      assert.equal(d4.status, 'needs_review'); assert.equal(d4.remoteId, '998877'); assert.equal(createCount, 3);
      assert.throws(() => service.enqueue([{ id: d4.id, version: d4.version }]), /状态/);
      assert.throws(() => service.release(d4.id, d4.version), /不能直接重试/);
      assert.deepEqual(productRepository.get(p4.id), original);
    });
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); getDb().close(); rmSync(dir, { recursive: true, force: true }); }
});

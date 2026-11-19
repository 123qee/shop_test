import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

test('发布核对前台目标，入队后切店仍用原店的凭证、storeId 与远端商品', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'publish-shop-'));
  process.env.DB_PATH = join(directory, 'test.db');
  const { createApp } = await import('../src/app');
  const { getDb } = await import('../src/db');
  const { productRepository } = await import('../src/repositories/product-repository');
  const { joomListingRepository } = await import('../src/repositories/joom-listing-repository');
  const { tokenRepository } = await import('../src/repositories/token-repository');
  const { shopService } = await import('../src/services/shop-service');
  const { publishJobService } = await import('../src/services/publish-job-service');
  const { marketplaceRegistry } = await import('../src/marketplaces/registry');
  const { JoomAdapter } = await import('../src/marketplaces/joom/adapter');

  shopService.save({ activeId: 'A', profiles: ['A', 'B'].map(id => ({ id, name: id, clientId: id, clientSecret: 'fixture', storeId: 'store-' + id })) });
  for (const id of ['A', 'B']) tokenRepository.save({ marketplace: 'joom:' + id, env: 'sandbox', accessToken: 'test-' + id });
  marketplaceRegistry.register(new JoomAdapter());
  const seed = (sku: string) => productRepository.create({
    source: 'asos', sourceProductId: sku, sourceUrl: 'https://fixture.test/' + sku,
    title: 'Test shirt', images: ['https://fixture.test/shirt.png'], variants: [{ options: {}, price: 10 }], attributes: {},
  });
  const fresh = seed('new');
  const existing = seed('existing');
  const legacy = seed('legacy');
  productRepository.update(existing.id, { status: 'published', joomProductId: 'remote-A' });
  productRepository.update(legacy.id, { status: 'published', joomProductId: 'remote-legacy' });

  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const writes: Array<{ path: string; token: string | null; storeId?: string }> = [];
  let remoteStore: string | undefined = 'store-A';
  let switchOnRead = false;
  const variants = [{ id: 'v1', sku: 'variant-1' }, { id: 'v2', sku: 'variant-2' }];
  let unblock!: () => void;
  const holdImage = new Promise<void>((resolve) => { unblock = resolve; });
  const nativeFetch = globalThis.fetch;
  async function post(path: string, body: unknown) {
    return nativeFetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'HEAD') {
      await holdImage;
      return new Response(null, { headers: { 'content-type': 'image/png' } });
    }
    if (url.pathname.endsWith('/productColors') || url.pathname.includes('/productCategories/')) return Response.json({ data: [] });
    if (init?.method === 'GET' && url.pathname.endsWith('/products')) {
      if (switchOnRead) {
        switchOnRead = false;
        assert.equal((await post('/shops/active', { id: 'B' })).status, 200);
      }
      return Response.json({ data: { id: url.searchParams.get('id'), storeId: remoteStore, variants } });
    }
    if (init?.method !== 'POST' || !/\/products\/(create|update|remove|removeVariations)$/.test(url.pathname)) throw new Error('Unexpected test request: ' + url.pathname);
    if (url.pathname.endsWith('/removeVariations')) {
      assert.deepEqual(JSON.parse(String(init.body)), [{ id: 'v2' }]);
      variants.pop();
    }
    writes.push({ path: url.pathname.split('/').pop() + url.search, token: new Headers(init.headers).get('Authorization'), storeId: JSON.parse(String(init.body)).storeId });
    return Response.json({ data: { id: url.searchParams.get('id') ?? 'new-A' } });
  };
  try {
    assert.equal((await post('/products/publish-jobs', { ids: [fresh.id] })).status, 400);
    assert.equal((await post('/products/publish-jobs', { ids: [fresh.id], shopId: 'B' })).status, 409);
    assert.equal((await post('/products/' + fresh.id + '/publish', { shopId: 'B' })).status, 409);
    assert.equal((await post('/products/batch/publish', { ids: [fresh.id], shopId: 'B' })).status, 409);
    assert.equal((await post('/products/batch/operate', { ids: [existing.id], shopId: 'B', operation: { type: 'inventory', value: 17 }, syncRemote: true })).status, 409);
    assert.equal((await post('/products/batch/repair-duplicate-variants', { ids: [existing.id], shopId: 'B' })).status, 409);
    assert.equal((await post('/products/batch/remove-remote', { ids: [existing.id], shopId: 'B' })).status, 409);
    assert.equal(publishJobService.recent().length, 0);
    const response = await post('/products/publish-jobs', { ids: [fresh.id, existing.id], shopId: 'A' });
    assert.equal(response.status, 202);
    const job = await response.json() as { id: string; shopId: string };
    assert.equal(job.shopId, 'A');
    assert.equal((await post('/shops/active', { id: 'B' })).status, 200);
    assert.equal(shopService.getActiveId(), 'B');
    assert.equal(shopService.getCredentials('removed-profile'), null);
    unblock();
    for (let i = 0; i < 100 && publishJobService.hasActive(); i++) await delay(20);
    assert.deepEqual(publishJobService.get(job.id)!.items.map(item => item.status), ['succeeded', 'succeeded']);
    assert.deepEqual(writes, [
      { path: 'create', token: 'Bearer test-A', storeId: 'store-A' },
      { path: 'update?id=remote-A', token: 'Bearer test-A', storeId: undefined },
    ]);
    assert.equal(productRepository.get(fresh.id)?.joomListings?.[0]?.shopId, 'A');
    assert.equal(productRepository.get(existing.id)?.joomListings?.[0]?.shopId, 'A');
    const differentListing = await post('/products/' + fresh.id + '/publish', { shopId: 'B' });
    assert.equal(differentListing.status, 409);
    const wrongStore = await post('/products/' + legacy.id + '/publish', { shopId: 'B' });
    assert.equal(wrongStore.status, 409);
    assert.match((await wrongStore.json() as { error: string }).error, /线上商品属于其他店铺/);
    remoteStore = undefined;
    const unknownStore = await post('/products/' + legacy.id + '/publish', { shopId: 'B' });
    assert.equal(unknownStore.status, 409);
    assert.match((await unknownStore.json() as { error: string }).error, /无法确认目标店铺/);
    assert.equal(productRepository.get(legacy.id)?.status, 'published');
    assert.equal(writes.length, 2);

    // 修复期间在读商品后切店，更新、删除重复变体、复核和快照仍应属于 A。
    remoteStore = 'store-A';
    assert.equal((await post('/shops/active', { id: 'A' })).status, 200);
    switchOnRead = true;
    const repair = await post('/products/batch/repair-duplicate-variants', { ids: [existing.id], shopId: 'A' });
    assert.equal(repair.status, 200);
    assert.equal((await repair.json() as Array<{ verified: boolean }>)[0].verified, true);
    assert.equal(shopService.getActiveId(), 'B');
    assert.deepEqual(writes.slice(2), [
      { path: 'update?id=remote-A', token: 'Bearer test-A', storeId: undefined },
      { path: 'removeVariations?id=remote-A', token: 'Bearer test-A', storeId: undefined },
    ]);

    // 同一条本地记录在两店都有刊登。仅删 A，切换标签后保留 B 及本地记录。
    joomListingRepository.linkPublishedProduct('B', 'B', 'fresh-B', fresh.id, 'Test shirt');
    productRepository.update(fresh.id, { joomProductId: 'fresh-B' });
    assert.equal((await post('/shops/active', { id: 'A' })).status, 200);
    switchOnRead = true;
    const remove = await post('/products/batch/remove-remote', { ids: [fresh.id], shopId: 'A' });
    assert.equal(remove.status, 200);
    assert.equal((await remove.json() as Array<{ ok: boolean }>)[0].ok, true);
    assert.deepEqual(writes.slice(4), [{ path: 'remove?id=new-A', token: 'Bearer test-A', storeId: undefined }]);
    const retained = productRepository.get(fresh.id)!;
    assert.equal(retained.status, 'published');
    assert.equal(retained.joomProductId, 'fresh-B');
    assert.deepEqual(retained.joomListings?.map((l) => [l.shopId, l.present]), [['A', false], ['B', true]]);
  } finally {
    unblock();
    // 等待后台协程退出后再恢复网络，测试始终使用模拟平台。
    while (publishJobService.hasActive()) await delay(10);
    globalThis.fetch = nativeFetch;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    getDb().close();
    rmSync(directory, { recursive: true, force: true });
  }
});

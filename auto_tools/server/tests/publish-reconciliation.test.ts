import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('发布回执核对原店的提交快照，重试前区分已关联、未找到、歧义和读失败', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'publish-reconciliation-'));
  process.env.DB_PATH = join(directory, 'test.db');
  const { getDb } = await import('../src/db');
  const { productRepository } = await import('../src/repositories/product-repository');
  const { tokenRepository } = await import('../src/repositories/token-repository');
  const { shopService } = await import('../src/services/shop-service');
  const { publishJobService } = await import('../src/services/publish-job-service');
  const { publishService } = await import('../src/services/publish-service');
  const { beginPublishSubmission, reconcilePublish } = await import('../src/services/publish-reconciliation');
  const { marketplaceRegistry } = await import('../src/marketplaces/registry');
  const { JoomAdapter } = await import('../src/marketplaces/joom/adapter');
  shopService.save({ activeId: 'A', profiles: ['A', 'B'].map(id => ({ id, name: id, clientId: id, clientSecret: 'fixture', storeId: 'store-' + id })) });
  for (const id of ['A','B']) tokenRepository.save({ marketplace: 'joom:' + id, env: 'sandbox', accessToken: 'fixture-' + id });
  marketplaceRegistry.register(new JoomAdapter());
  const seed = (sku: string) => productRepository.create({ source: 'asos', sourceProductId: sku, generatedSku: sku,
    sourceUrl: 'https://fixture.test/' + sku, title: 'Test shirt', images: ['https://fixture.test/p.png'], variants: [{ options: {}, price: 10 }], attributes: {} });
  const row = (id: string, sku: string) => ({ id, sku, storeId: 'store-A', state: 'active' });
  let page1: ReturnType<typeof row>[] = [], page2: typeof page1 = [];
  let exact: ReturnType<typeof row> | undefined;
  let listError = 0, writes = 0, firstPages = 0, lookups = 0;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-type': 'image/png' } });
    if (url.pathname.includes('productCategories') || url.pathname.endsWith('productColors')) return Response.json({ data: [] });
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-A');
    if (init?.method === 'POST' && url.pathname.endsWith('/products/create')) {
      writes++;
      return Response.json({ errors: [{ code: 'alreadyExists', message: 'Item exists' }] }, { status: 400 });
    }
    assert.equal(init?.method, 'GET');
    if (url.pathname.endsWith('/products/multi')) {
      if (listError) return Response.json({}, { status: listError });
      if (url.searchParams.has('next')) return Response.json({ data: { items: page2 } });
      firstPages++;
      return Response.json({ data: { items: page1 }, paging: page2.length ? { next: '/products/multi?next=2' } : {} });
    }
    assert.equal(url.pathname.endsWith('/products'), true);
    lookups++;
    return exact ? Response.json({ data: exact }) : Response.json({}, { status: 404 });
  };
  try {
    const fresh = seed('original-sku');
    await assert.rejects(publishService.publish(fresh.id, 'joom', 'A'), /Joom 请求失败/);
    const job = publishJobService.recent()[0];
    assert.equal(job.items[0].status, 'needs_review');
    assert.equal(productRepository.get(fresh.id)?.status, 'failed');
    assert.throws(() => publishJobService.enqueue([fresh.id], 'A'), /待核对/);
    await assert.rejects(publishService.publish(fresh.id, 'joom', 'A'), /待核对/);
    assert.equal(writes, 1);
    shopService.setActive('B');
    await assert.rejects(reconcilePublish(job.id, fresh.id, 'A', 'check'), /店铺已切换/);
    shopService.setActive('A');
    listError = 403;
    await assert.rejects(reconcilePublish(job.id, fresh.id, 'A', 'check'), /403/);
    listError = 0;
    page1 = [row('first', 'original-sku')];
    page2 = [row('second', 'original-sku')];
    await assert.rejects(reconcilePublish(job.id, fresh.id, 'A', 'check'), /多个/);
    assert.equal(publishJobService.get(job.id)?.items[0].status, 'needs_review');
    page2 = [];
    const duplicate = seed('original-sku');
    await assert.rejects(reconcilePublish(job.id, fresh.id, 'A', 'check'), /本地其他商品/);
    productRepository.delete(duplicate.id);
    await reconcilePublish(job.id, fresh.id, 'A', 'check');
    assert.equal(publishJobService.get(job.id)?.items[0].status, 'succeeded');
    assert.equal(productRepository.get(fresh.id)?.joomListings?.[0]?.joomProductId, 'first');
    assert.equal(productRepository.get(fresh.id)?.status, 'published');
    await assert.rejects(reconcilePublish(job.id, fresh.id, 'A', 'check'), /已处理/);

    const update = beginPublishSubmission(fresh.id, 'A', { sku: 'original-sku', remoteId: 'first', storeId: 'store-A' });
    publishJobService.start();
    exact = row('first', 'original-sku');
    const before = firstPages;
    await reconcilePublish(update, fresh.id, 'A', 'check');
    assert.equal(firstPages, before);
    assert.equal(lookups, 1);
    assert.equal(publishJobService.get(update)?.items[0].status, 'needs_review');
    await reconcilePublish(update, fresh.id, 'A', 'confirm-update');
    assert.equal(publishJobService.get(update)?.items[0].status, 'succeeded');

    const missing = seed('missing-sku');
    const interrupted = beginPublishSubmission(missing.id, 'A', { sku: 'missing-sku', storeId: 'store-A' });
    publishJobService.start();
    assert.match(await reconcilePublish(interrupted, missing.id, 'A', 'check'), /未找到/);
    assert.equal(publishJobService.get(interrupted)?.items[0].status, 'failed');
    assert.equal(writes, 1);
    // Let scheduled queue runners observe that no retry has been enqueued.
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally {
    globalThis.fetch = fetchBefore;
    getDb().close();
    rmSync(directory, { recursive: true, force: true });
  }
});

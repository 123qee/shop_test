import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProductIndexItem } from '../../shared/product-catalog';
import type { MercadoLibreListingIndexItem } from '../../shared/types';
import { BULK_CONCURRENCY, productSearchText, remainingSelectedProducts, runListingBatch, selectedListingTargets } from '../../web/src/pages/mercadolibre-workspace';

function listing(id: string, productId = id, siteId = 'MLC'): MercadoLibreListingIndexItem {
  return { id, productId, siteId, title: `Product ${productId}`, status: 'draft', updatedAt: '2026-11-26T00:00:00Z' } as MercadoLibreListingIndexItem;
}

test('批量发布最多同时处理三个站点；单项失败继续队列，且不会自动重发', async () => {
  const targets = Array.from({ length: 8 }, (_, i) => listing(String(i)));
  const started: string[] = [];
  const pending = new Map<string, { resolve(): void; reject(error: Error): void }>();
  const progress: number[] = [];
  let active = 0;
  let peak = 0;
  const running = runListingBatch('publish', targets, {
    validateMercadoLibreListing: async () => { throw new Error('unexpected validation'); },
    publishMercadoLibreListing(id) {
      started.push(id);
      active++;
      peak = Math.max(peak, active);
      return new Promise<void>((resolve, reject) => pending.set(id, {
        resolve() { active--; resolve(); },
        reject(error) { active--; reject(error); },
      }));
    },
  }, (completed, total) => { assert.equal(total, targets.length); progress.push(completed); });
  assert.equal(started.length, BULK_CONCURRENCY);
  pending.get('1')!.reject(new Error('connection lost after submitting'));
  pending.delete('1');
  await new Promise(setImmediate);
  assert.equal(started.length, 4, '失败也会释放一个并发槽');
  while (pending.size) {
    const batch = [...pending.values()];
    pending.clear();
    batch.forEach((item) => item.resolve());
    await new Promise(setImmediate);
  }
  const results = await running;
  assert.equal(peak, BULK_CONCURRENCY);
  assert.deepEqual(started, targets.map((item) => item.id));
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(results.map((result) => result.listing.id), targets.map((item) => item.id), '乱序完成仍保留原站点对应关系');
  assert.equal(results.filter((result) => result.ok).length, 7);
  assert.equal(results[1].error, 'connection lost after submitting');
});

test('校验接口 HTTP 成功但 ok=false 时仍计为失败，展示错误并允许人工重新校验', async () => {
  const calls: string[] = [];
  const client = {
    publishMercadoLibreListing: async () => { throw new Error('validation must never publish'); },
    validateMercadoLibreListing: async (id: string) => {
      calls.push(id);
      return id === 'bad' ? { ok: false, issues: [
        { severity: 'warning' as const, field: 'language', message: 'check language' },
        { severity: 'error' as const, field: 'categoryId', message: '请选择类目' },
      ] } : { ok: true, issues: [{ severity: 'warning' as const, field: 'language', message: 'check language' }] };
    },
  };
  const results = await runListingBatch('validate', [listing('good'), listing('bad')], client);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error, '请选择类目');
  await runListingBatch('validate', results.filter((result) => !result.ok).map((result) => result.listing), client);
  assert.deepEqual(calls, ['good', 'bad', 'bad'], '人工重试只处理失败站点，成功站点不重复执行');
});

test('跨页和筛选外的选择保留，操作覆盖所选商品全部站点，混合结果仅移除全成功商品', () => {
  const listings = [listing('page1-cl', 'page1'), listing('page1-mx', 'page1', 'MLM'), listing('page3-cl', 'page3'), listing('other')];
  const selected = new Set(['page1', 'page3', 'new-selection']);
  const targets = selectedListingTargets(listings, selected);
  assert.deepEqual(targets.map((item) => item.id), ['page1-cl', 'page1-mx', 'page3-cl']);
  const remaining = remainingSelectedProducts(selected, [
    { listing: targets[0], ok: true },
    { listing: targets[1], ok: false, error: 'failed' },
    { listing: targets[2], ok: true },
  ]);
  assert.deepEqual([...remaining], ['page1', 'new-selection']);
});

test('轻量索引仍可按原始变体 SKU、商品 SKU、标题和来源 ID 检索', () => {
  const product = {
    collected: { title: 'Cotton Shirt', sourceProductId: 'source-123', generatedSku: 'generated-456', store: { name: 'Store Name' } },
    edited: { sku: 'edited-789', title: 'Edited Title' },
    sourceSkuSearchText: 'variant-red-xl variant-blue-l',
  } as ProductIndexItem;
  const text = productSearchText(product);
  for (const keyword of ['cotton shirt', 'source-123', 'generated-456', 'edited-789', 'edited title', 'variant-red-xl', 'store name']) {
    assert.ok(text.includes(keyword), keyword);
  }
});

test('空批次不发请求', async () => {
  const unexpected = async () => { throw new Error('unexpected request'); };
  assert.deepEqual(await runListingBatch('publish', [], { publishMercadoLibreListing: unexpected, validateMercadoLibreListing: unexpected }), []);
});

test('离开页面后不再发出排队中的请求，已经发出的请求不盲目取消或重发', async () => {
  const controller = new AbortController();
  const started: string[] = [];
  const complete: Array<() => void> = [];
  const targets = Array.from({ length: 8 }, (_, i) => listing(String(i)));
  const running = runListingBatch('publish', targets, {
    validateMercadoLibreListing: async () => { throw new Error('unexpected validation'); },
    publishMercadoLibreListing(id) {
      started.push(id);
      return new Promise<void>((resolve) => complete.push(resolve));
    },
  }, undefined, controller.signal);
  controller.abort();
  complete.forEach((resolve) => resolve());
  const results = await running;
  assert.equal(started.length, BULK_CONCURRENCY);
  assert.equal(results.filter((result) => result.ok).length, BULK_CONCURRENCY);
  assert.ok(results.slice(BULK_CONCURRENCY).every((result) => !result.ok && result.error?.startsWith('未执行')));
});

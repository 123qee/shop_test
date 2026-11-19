import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CollectBatchDetail } from '@shared/collect-batches';

test('采集批次保留未处理项与失败原因，重试只更新相应项，分拣入口按原顺序去重', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collect-batches-'));
  process.env.DB_PATH = join(dir, 'app.db');
  const { createApp } = await import('../src/app');
  const { getDb } = await import('../src/db/index');
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
  const send = (path: string, body: unknown) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const urls = [1, 2, 3, 4].map(n => 'https://www.asos.com/test/prd/' + n);
  try {
    assert.equal((await send('/collect/batches', { source: 'asos', urls: ['file:///foo'] })).status, 400);
    const created = await send('/collect/batches', { source: 'asos', urls: [...urls, urls[0]] });
    assert.equal(created.status, 201);
    const {id} = await created.json() as {id: string};
    const path = '/collect/batches/' + id;
    const detail = async () => (await (await fetch(base + path)).json()) as CollectBatchDetail;
    const collect = (url: string, productId: string) => send('/collect', {
      batch: { id, url }, product: { source: 'asos', sourceUrl: url, sourceProductId: productId, title: 'Cotton T-Shirt', images: [], variants: [{ options: { Size: 'M' } }] },
    });
    assert.equal((await detail()).pending, 4);
    assert.equal((await collect('https://www.asos.com/other', 'wrong')).status, 400);
    const first = await collect(urls[0], 'one');
    assert.equal(first.status, 201);
    const firstId = (await first.json() as {id:string}).id;
    const dup = await (await collect(urls[2], 'one')).json() as {id:string;duplicate:boolean};
    assert.equal(dup.duplicate, true);
    assert.equal(dup.id, firstId);
    await send(path + '/failures', { urls: [urls[1], urls[0]], reason: '详情页未找到' });
    const interrupted = await detail();
    assert.deepEqual(interrupted.items.map(x => x.status), ['collected', 'failed', 'duplicate', 'pending']);
    assert.equal(interrupted.items[1].reason, '详情页未找到');
    const secondId = (await (await collect(urls[1], 'two')).json() as {id:string}).id;
    await collect(urls[1], 'two');
    const retried = await detail();
    assert.equal(retried.items[1].reason, null);
    assert.deepEqual([retried.collected, retried.duplicate, retried.pending, retried.failed], [2, 1, 1, 0]);
    assert.deepEqual(await (await fetch(base + path + '/products')).json(), { id, productIds: [firstId, secondId] });
    assert.equal((await (await fetch(base + '/collect/batches')).json() as {id:string}[])[0].id, id);
    assert.equal((await fetch(base + '/collect/batches/missing/products')).status, 404);
    getDb().prepare('DELETE FROM products WHERE id = ?').run(firstId);
    assert.deepEqual(await (await fetch(base + path + '/products')).json(), { id, productIds: [secondId] });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    getDb().close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadFiles } from '../../web/src/pages/orders/download-files';

test('导出后自动逐个下载独立 Excel，保留文件名；单份失败不阻断其余文件', async (t) => {
  const env = globalThis as any;
  const saved = { window: env.window, document: env.document, fetch: env.fetch, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  t.after(() => {
    if (saved.window === undefined) delete env.window; else env.window = saved.window;
    if (saved.document === undefined) delete env.document; else env.document = saved.document;
    env.fetch = saved.fetch;
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  });
  const requested: string[] = [];
  const downloaded: string[] = [];
  const removed: string[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let timerId = 0;
  let failSecond = false;
  env.window = {
    setTimeout(fn: () => void, ms: number) { if (ms === 300) { queueMicrotask(fn); return ++timerId; } timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
  };
  env.document = {
    body: { appendChild() {} },
    createElement() {
      return { href: '', download: '', click() { downloaded.push(this.download); }, remove() { removed.push(this.download); } };
    },
  };
  let objectId = 0;
  const revoked: string[] = [];
  URL.createObjectURL = () => `blob:test-${++objectId}`;
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  env.fetch = async (url: string) => {
    requested.push(url);
    return failSecond && url === '/two.xlsx' ? new Response('failed', { status: 500 }) : new Response('test workbook');
  };
  const files = [
    { id: 'one', name: '棉订单.xlsx', url: '/one.xlsx' },
    { id: 'two', name: '涤纶订单.xlsx', url: '/two.xlsx' },
    { id: 'three', name: '混纺订单.xlsx', url: '/three.xlsx' },
  ];
  assert.deepEqual(await downloadFiles(files), []);
  assert.deepEqual(downloaded, files.map((file) => file.name));
  assert.deepEqual(requested, files.map((file) => file.url));
  assert.deepEqual(removed, downloaded);
  assert.equal(timers.size, 3, '清理请求超时，只保留 Blob 释放计时器');
  for (const timer of timers.values()) timer.fn();
  assert.equal(revoked.length, 3);
  timers.clear();
  downloaded.length = 0;
  failSecond = true;
  assert.deepEqual(await downloadFiles(files), ['two']);
  assert.deepEqual(downloaded, ['棉订单.xlsx', '混纺订单.xlsx']);
});

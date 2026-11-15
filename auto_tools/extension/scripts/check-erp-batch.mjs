import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/background/erp-batch.ts', import.meta.url))], bundle: true, format: 'cjs', write: false });
const code = bundle.outputFiles[0].text;
const listUrl = 'https://erp2.cnfth.com/#/product/aliexpress/acquisition/box?Platform=AliExpress';
const editUrl = id => `https://erp2.cnfth.com/#/product/aliexpress/add?id=${id}`;
const row = index => ({ index, key: `key-${index}`, title: `Cotton tee ${index}`, shop: 'test-shop' });
const event = () => {
  const listeners = new Set();
  return { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f), emit: (...args) => { for (const f of [...listeners]) f(...args); }, listeners };
};
function harness(options = {}) {
  const runtime = event(), created = event(), updated = event(), removed = event();
  const data = { erpFillBatch: options.seed ? structuredClone(options.seed) : null };
  const tabs = new Map([[1, { id: 1, windowId: 5, url: listUrl }], [88, { id: 88, windowId: 5, url: editUrl(999) }]]);
  const runs = [], opens = [], messages = [];
  let nextId = 100, active = 0, maxActive = 0;
  const chrome = {
    runtime: { onMessage: runtime },
    storage: { local: { get: async () => structuredClone(data), set: async value => { Object.assign(data, structuredClone(value)); } } },
    tabs: {
      onCreated: created, onUpdated: updated, onRemoved: removed,
      query: async () => [...tabs.values()],
      get: async id => { if (!tabs.has(id)) throw new Error('标签页已关闭'); return tabs.get(id); },
      update: async (id, props) => { if (!tabs.has(id)) throw new Error('No tab'); return { ...tabs.get(id), ...props }; },
      sendMessage: async (id, message) => {
        messages.push({ id, message });
        if (message.type === 'ERP_BATCH_OPEN_ROW') {
          if (options.listChanged) return { ok: false, error: '列表已变化，请恢复原筛选、排序和页码后重试' };
          const tab = { id: nextId++, windowId: options.movedWindow ? 6 : 5, openerTabId: options.noOpener ? undefined : 1, url: options.login ? 'https://erp2.cnfth.com/portal/' : editUrl(2000 + message.row.index), title: message.row.title };
          tabs.set(tab.id, tab); opens.push(tab);
          // 无关的旧页和其它来源新页，不得被捕获为当前商品。
          created.emit({ id: 88, openerTabId: 7, url: editUrl(999) });
          created.emit({ id: 89, windowId: 6, url: editUrl(998) });
          if (!options.noEvents) {
            created.emit({ ...tab, url: 'about:blank' });
            updated.emit(tab.id, { url: tab.url }, tab);
          }
          if (options.unrelated) tabs.set(89, { id: 89, windowId: 5, url: editUrl(998), title: 'Another product' });
          if (options.duplicate) tabs.set(90, { ...tab, id: 90 });
          return { ok: true };
        }
        if (message.type === 'ERP_DETAIL_READY') return { title: options.mismatch ? 'Wrong product' : tabs.get(id)?.title, ...(options.blockedId === id ? { blocked: '类目迁移弹窗待检查' } : options.specUpgrade && !tabs.get(id)?.prepared ? { blocked: '商品页有待处理弹窗：速卖通平台类目规格属性升级' } : { ready: true }) };
        if (message.type === 'ERP_DETAIL_PREPARE') {
          assert.equal(tabs.get(id)?.title, message.expectedTitle);
          tabs.get(id).prepared = true;
          return { ok: true };
        }
        if (message.type === 'ERP_DETAIL_CANCEL') return { ok: true };
        if (message.type === 'ERP_DETAIL_SAVE') return options.saveFailure ? { ok: false, error: 'ERP 未确认草稿保存' } : { ok: true, saved: true };
        if (message.type === 'ERP_DETAIL_RUN') {
          runs.push(message.productId); active++; maxActive = Math.max(maxActive, active);
          try {
            if (options.gate && runs.length === 1) await options.gate;
            if (options.timeout) return await new Promise(() => {});
            return { ok: true, report: { productId: message.productId, title: message.expectedTitle, skuCount: 8, complete: !options.partial, issues: options.partial ? ['缺少字段'] : [], log: ['已填写'] } };
          } finally { active--; }
        }
        throw new Error(`Unexpected message ${message.type}`);
      },
    },
  };
  vm.runInNewContext(code, {
    chrome, crypto: webcrypto, URL, URLSearchParams, structuredClone, console,
    setTimeout: (f, ms) => setTimeout(f, ms >= 10000 ? 180 : 1), clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
  });
  const send = (message, url = listUrl) => new Promise(resolve => {
    for (const listener of runtime.listeners) listener(message, { tab: { id: 1, url } }, resolve);
  });
  const state = () => data.erpFillBatch;
  async function until(predicate) {
    for (let i = 0; i < 800; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
    assert.fail(`状态未到达：${JSON.stringify(state())}`);
  }
  return { send, state, until, runs, opens, tabs, messages, options, maxActive: () => maxActive };
}

test('两件商品依次处理，结果绑定对应新编辑页，不复用或关闭原有页面', async () => {
  const h = harness();
  assert.equal((await h.send({ type: 'ERP_BATCH_START', rows: [row(0), row(1)] })).ok, true);
  await h.until(() => h.state()?.state === 'completed');
  assert.deepEqual(h.runs, ['2000', '2001']);
  assert.equal(h.maxActive(), 1);
  assert.deepEqual(h.state().items.map(item => item.state), ['saved', 'saved']);
  assert.deepEqual(h.state().items.map(item => item.tabId), [100, 101]);
  assert.equal(h.tabs.has(88), true);
  assert.equal(h.messages.filter(({ message }) => message.type === 'ERP_DETAIL_SAVE').length, 2);
  assert.ok(h.messages.every(({ message }) => !/PUBLISH/.test(message.type)));
});

test('ERP 未提供 opener 时按完整标题匹配新页', async () => {
  const h = harness({ noOpener: true });
  await h.send({ type: 'ERP_BATCH_START', rows: [row(0), row(1)] });
  await h.until(() => h.state()?.state === 'completed');
  assert.deepEqual(h.runs, ['2000', '2001']);
  assert.deepEqual(h.state().items.map(item => item.tabId), [100, 101]);
  assert.deepEqual(h.state().items.map(item => item.state), ['saved', 'saved']);
});

test('暂停等待本件结束，继续只处理排队商品', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ gate });
  await h.send({ type: 'ERP_BATCH_START', rows: [row(0), row(1)] });
  await h.until(() => h.runs.length === 1);
  await h.send({ type: 'ERP_BATCH_PAUSE' }); release();
  await h.until(() => h.state()?.state === 'paused');
  assert.deepEqual(h.state().items.map(item => item.state), ['saved', 'pending']);
  await new Promise(resolve => setTimeout(resolve, 2));
  await h.send({ type: 'ERP_BATCH_RESUME' });
  await h.until(() => h.state()?.state === 'completed');
  assert.deepEqual(h.runs, ['2000', '2001']);
});

test('单件弹窗阻塞单独报错，重试失败项不会重填成功项', async () => {
  const h = harness({ blockedId: 100 });
  await h.send({ type: 'ERP_BATCH_START', rows: [row(0), row(1)] });
  await h.until(() => h.state()?.state === 'completed');
  assert.deepEqual(h.state().items.map(item => item.state), ['failed', 'saved']);
  h.options.blockedId = undefined;
  await new Promise(resolve => setTimeout(resolve, 2));
  await h.send({ type: 'ERP_BATCH_RESUME', retryFailed: true });
  await h.until(() => h.state()?.state === 'completed');
  assert.deepEqual(h.runs, ['2001', '2000']);
  assert.equal(h.state().items[0].attempt, 2);
});

test('登录失效暂停整个队列，避免连续打开登录页', async () => {
  const h = harness({ login: true });
  await h.send({ type: 'ERP_BATCH_START', rows: [row(0), row(1)] });
  await h.until(() => h.state()?.state === 'paused');
  assert.equal(h.opens.length, 1); assert.equal(h.runs.length, 0);
  assert.match(h.state().items[0].error, /登录已失效/);
  assert.equal(h.state().items[1].state, 'pending');
});

test('采集箱排序或筛选变化时停止，不猜商品 ID', async () => {
  const h = harness({ listChanged: true });
  await h.send({ type: 'ERP_BATCH_START', rows: [row(0), row(1)] });
  await h.until(() => h.state()?.state === 'paused');
  assert.equal(h.opens.length, 0); assert.equal(h.runs.length, 0);
  assert.equal(h.state().items[1].state, 'pending');
});

test('重启后暂停半成品，不自动重新写入', async () => {
  const h = harness({ seed: { id: 'old', sourceTabId: 1, state: 'running', createdAt: 1, updatedAt: 1, items: [{ ...row(0), state: 'running', attempt: 1 }, { ...row(1), state: 'pending', attempt: 0 }] } });
  await h.until(() => h.state()?.state === 'paused');
  assert.equal(h.state().items[0].state, 'failed');
  assert.equal(h.opens.length, 0);
  assert.equal(h.runs.length, 0);
});

test('超时停止后续商品，并通知编辑页中止剩余步骤', async () => {
  const h = harness({ timeout: true });
  await h.send({ type: 'ERP_BATCH_START', rows: [row(0), row(1)] });
  await h.until(() => h.state()?.state === 'paused');
  assert.equal(h.runs.length, 1);
  assert.ok(h.messages.some(({ message }) => message.type === 'ERP_DETAIL_CANCEL'));
  assert.equal(h.state().items[1].state, 'pending');
});

test('禁止从非 ERP 采集箱页面发起任务', async () => {
  const h = harness();
  assert.equal((await h.send({ type: 'ERP_BATCH_START', rows: [row(0)] }, 'https://example.com')).ok, false);
  assert.equal(h.opens.length, 0);
});

test('部分填充不会计为已填完成，保留具体缺项供重试', async () => {
  const h = harness({ partial: true });
  await h.send({ type: 'ERP_BATCH_START', rows: [row(0)] });
  await h.until(() => h.state()?.state === 'completed');
  assert.equal(h.state().items[0].state, 'failed');
  assert.match(h.state().items[0].error, /部分项目未完成/);
  assert.equal(h.state().items[0].report.complete, false);
});

test('必填项通过但 ERP 未确认保存时，不会显示为已保存', async () => {
  const h = harness({ saveFailure: true });
  await h.send({ type: 'ERP_BATCH_START', rows: [row(0)] });
  await h.until(() => h.state()?.state === 'completed');
  assert.equal(h.state().items[0].state, 'failed');
  assert.match(h.state().items[0].error, /ERP 未确认草稿保存/);
  assert.equal(h.messages.some(({ message }) => message.type === 'ERP_DETAIL_SAVE'), true);
});


test('新页移动窗口且没有创建事件时仍能定位，忽略无关商品', async () => {
  const h = harness({ noOpener: true, movedWindow: true, noEvents: true, unrelated: true });
  await h.send({ type: 'ERP_BATCH_START', rows: [row(0), row(1)] });
  await h.until(() => h.state()?.state === 'completed');
  assert.deepEqual(h.runs, ['2000', '2001']);
  assert.deepEqual(h.state().items.map(item => item.tabId), [100, 101]);
});

test('新页标题不匹配时不填写，并暂停后续商品', async () => {
  const h = harness({ mismatch: true });
  await h.send({ type: 'ERP_BATCH_START', rows: [row(0), row(1)] });
  await h.until(() => h.state()?.state === 'paused');
  assert.equal(h.runs.length, 0);
  assert.equal(h.state().items[1].state, 'pending');
});

test('同批出现多个同名新页时暂停，不任选一页填写', async () => {
  const h = harness({ duplicate: true });
  await h.send({ type: 'ERP_BATCH_START', rows: [row(0)] });
  await h.until(() => h.state()?.state === 'paused');
  assert.equal(h.runs.length, 0);
  assert.match(h.state().items[0].error, /同名/);
});

test('标题核对后先处理已知规格升级，再开始逐件填写', async () => {
  const h = harness({ specUpgrade: true });
  await h.send({ type: 'ERP_BATCH_START', rows: [row(0), row(1)] });
  await h.until(() => h.state()?.state === 'completed');
  assert.deepEqual(h.runs, ['2000', '2001']);
  assert.deepEqual(h.state().items.map(item => item.state), ['saved', 'saved']);
  for (const id of [100, 101]) {
    const types = h.messages.filter(message => message.id === id).map(({ message }) => message.type);
    assert.ok(types.indexOf('ERP_DETAIL_PREPARE') < types.indexOf('ERP_DETAIL_RUN'));
  }
});

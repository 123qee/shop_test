import { ERP_BATCH_STORAGE, isErpEditorUrl, isErpJobActive, isErpListUrl } from '../erp/batch-types.js';
import type { ErpBatchItem, ErpBatchMessage, ErpBatchState, ErpRunReport } from '../erp/batch-types.js';

let job: ErpBatchState | null = null;
let working = false;
let writeQueue = Promise.resolve();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 中断后不重新操作半成品页面，避免对用户已经检查的内容重复写入。
const initialized = (async () => {
  job = (await chrome.storage.local.get(ERP_BATCH_STORAGE))[ERP_BATCH_STORAGE] || null;
  if (isErpJobActive(job)) {
    job!.state = 'paused';
    for (const item of job!.items) {
      if (item.state === 'running' || item.state === 'opening' || item.state === 'saving') {
        const interruptedState = item.state;
        item.state = 'failed';
        item.error = interruptedState === 'saving'
          ? '保存状态未确认，草稿可能已保存；请先检查 ERP 草稿后再重试'
          : '任务中断，已打开的编辑页保留，请检查或重试';
      }
    }
    await persist();
  }
})();

function persist(): Promise<void> {
  if (!job) return Promise.resolve();
  job.updatedAt = Date.now();
  const snapshot = structuredClone(job);
  writeQueue = writeQueue.catch(() => undefined).then(() => chrome.storage.local.set({ [ERP_BATCH_STORAGE]: snapshot }));
  return writeQueue;
}

chrome.runtime.onMessage.addListener((message: ErpBatchMessage, sender, reply) => {
  if (message?.type !== 'ERP_BATCH_START' && message?.type !== 'ERP_BATCH_PAUSE' && message?.type !== 'ERP_BATCH_RESUME' && message?.type !== 'ERP_BATCH_FOCUS') return false;
  void (async () => {
    await initialized;
    if (sender.tab?.id == null || !isErpListUrl(sender.tab.url)) throw new Error('请从速卖通采集箱发起批量填写');
    if (message.type === 'ERP_BATCH_FOCUS') {
      if (!job?.items.some(item => item.tabId === message.tabId)) throw new Error('该编辑页不属于当前批次');
      try { await chrome.tabs.update(message.tabId, { active: true }); }
      catch { throw new Error('编辑页已关闭；未保存的填写内容无法恢复，请重新勾选填写'); }
      reply({ ok: true, job });
      return;
    }
    if (message.type === 'ERP_BATCH_START') {
      if (isErpJobActive(job) || working) throw new Error('已有批量任务，请先暂停');
      if (!Array.isArray(message.rows) || !message.rows.length || message.rows.length > 50) throw new Error('请选择 1–50 件商品');
      if (message.rows.some(row => typeof row.key !== 'string' || !row.key || typeof row.title !== 'string' || !row.title || !Number.isInteger(row.index) || row.index < 0)) throw new Error('商品列表信息不完整，请重新读取勾选项');
      if (new Set(message.rows.map(row => row.key + ':' + row.index)).size !== message.rows.length) throw new Error('队列里存在重复商品');
      job = {
        id: crypto.randomUUID(), state: 'running', sourceTabId: sender.tab.id,
        createdAt: Date.now(), updatedAt: Date.now(),
        items: message.rows.map(row => ({ ...row, state: 'pending', attempt: 0 })),
      };
    } else {
      if (!job) throw new Error('没有可继续的批量任务');
      if (job.sourceTabId !== sender.tab.id) {
        if (isErpJobActive(job) || working) throw new Error('请回到发起任务的采集箱页面操作');
        job.sourceTabId = sender.tab.id;
      }
      if (message.type === 'ERP_BATCH_PAUSE') job.state = working ? 'pausing' : 'paused';
      else {
        if (isErpJobActive(job) || working) throw new Error('当前任务仍在处理，请等待当前商品结束');
        if (message.retryFailed) {
          for (const item of job.items) if (item.state === 'failed') { item.state = 'pending'; item.error = undefined; }
        }
        job.state = 'running';
      }
    }
    await persist();
    reply({ ok: true, job });
    if (job.state === 'running') void runQueue().catch(error => {
      if (job) { job.state = 'paused'; const item = job.items.find(item => item.state === 'opening' || item.state === 'running' || item.state === 'saving');
        if (item) { item.state = 'failed'; item.error = `任务异常暂停：${(error as Error).message}`; }
        void persist().catch(() => undefined);
      }
    });
  })().catch(error => reply({ ok: false, error: (error as Error).message }));
  return true;
});

async function openSelectedRow(item: ErpBatchItem, sourceTabId: number): Promise<chrome.tabs.Tab> {
  // 先记住现有页，只核对本次点击后新建的页，保护用户的未保存内容。
  const existing = new Set((await chrome.tabs.query({})).map(tab => tab.id));
  const result = await chrome.tabs.sendMessage(sourceTabId, { type: 'ERP_BATCH_OPEN_ROW', row: item } satisfies ErpBatchMessage);
  if (!result?.ok) throw new Error(result?.error || '无法打开对应商品，请确认采集箱没有翻页或排序');
  let stopped = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();
  const locate = async (): Promise<chrome.tabs.Tab> => {
    while (!stopped) {
      const matches: chrome.tabs.Tab[] = [];
      const tabs = (await chrome.tabs.query({})).filter(tab => tab.id != null && !existing.has(tab.id));
      for (const tab of tabs) {
        if (tab.url?.startsWith('https://erp2.cnfth.com/portal')) throw new Error('ERP 登录已失效，请重新登录后重试');
        if (!isErpEditorUrl(tab.url)) continue;
        try {
          // 不依赖 opener 或窗口号；浏览器接管时这些信息可能变化。
          // 就绪消息只读取页面，商品身份匹配以后才会发送填写指令。
          const response = await chrome.tabs.sendMessage(tab.id!, { type: 'ERP_DETAIL_READY' } satisfies ErpBatchMessage);
          if (typeof response?.title === 'string' && normalized(response.title) === normalized(item.title)) matches.push(tab);
        } catch { /* 新页脚本可能尚未加载，下一轮再读。 */ }
      }
      if (stopped) break;
      if (matches.length > 1) throw new Error('出现多个同名新编辑页，请检查后重试');
      if (matches.length === 1) return matches[0];
      await sleep(400);
    }
    throw new Error('编辑页核对已停止');
  };
  try {
    return await Promise.race([
      locate(),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('未找到标题匹配的新编辑页，请检查登录、弹窗或扩展加载情况')), 45000); }),
    ]);
  } finally { stopped = true; clearTimeout(timeout); }
}

async function waitReady(tabId: number, productId: string, expectedTitle: string): Promise<void> {
  const until = Date.now() + 45000;
  let prepared = false;
  while (Date.now() < until) {
    try {
      const current = await chrome.tabs.get(tabId);
      if (current.url?.startsWith('https://erp2.cnfth.com/portal')) throw new Error('ERP 登录已失效，请重新登录后重试');
      const response = await chrome.tabs.sendMessage(tabId, { type: 'ERP_DETAIL_READY' } satisfies ErpBatchMessage);
      if (response?.blocked) {
        if (!prepared && response.blocked.includes('速卖通平台类目规格属性升级')) {
          prepared = true;
          const preparation = await chrome.tabs.sendMessage(tabId, { type: 'ERP_DETAIL_PREPARE', productId, expectedTitle } satisfies ErpBatchMessage);
          if (!preparation?.ok) throw new Error(preparation?.error || response.blocked);
          continue;
        }
        throw new Error(response.blocked);
      }
      if (response?.ready) return;
    } catch (error) {
      const text = (error as Error).message;
      if (!/Receiving end|Could not establish|message port/i.test(text)) throw error;
    }
    await sleep(600);
  }
  throw new Error('商品页未就绪，可能需要登录或重载扩展后重新打开');
}

async function runQueue(): Promise<void> {
  if (working || !job) return;
  working = true;
  // 保持 MV3 worker 活跃；中断恢复由上面的持久化记录负责。
  const heartbeat = setInterval(() => { void chrome.storage.local.get(ERP_BATCH_STORAGE); }, 15000);
  try {
    while (job.state === 'running') {
      const item = job.items.find(item => item.state === 'pending');
      if (!item) { job.state = 'completed'; break; }
      item.state = 'opening'; item.attempt += 1;
      await persist();
      try {
        const source = await chrome.tabs.get(job.sourceTabId);
        if (!isErpListUrl(source.url)) throw new Error('采集箱已切换页面，请回到列表后继续');
        const tab = await openSelectedRow(item, job.sourceTabId);
        item.tabId = tab.id!; item.url = tab.url;
        await persist();
        const current = await chrome.tabs.get(tab.id!);
        if (!isErpEditorUrl(current.url)) throw new Error('商品页已被切换，未执行填写');
        const productId = new URLSearchParams(new URL(current.url!).hash.split('?')[1]).get('id')!;
        await waitReady(tab.id!, productId, item.title);
        item.state = 'running';
        await persist();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([
            chrome.tabs.sendMessage(tab.id!, { type: 'ERP_DETAIL_RUN', token: `${job.id}:${item.index}:${item.attempt}`, productId, expectedTitle: item.title } satisfies ErpBatchMessage),
            new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('处理超过 4 分钟，编辑页保留，请检查')), 240000); }),
          ]);
          if (!response?.ok) throw new Error(response?.error || '商品页未返回处理结果');
          if (response.report?.productId !== productId || !Array.isArray(response.report?.issues)) throw new Error('商品处理结果无法核对，请检查编辑页');
          item.report = response.report as ErpRunReport;
          item.state = item.report.complete === false ? 'failed' : 'saving';
          if (item.state === 'failed') item.error = '部分项目未完成，请查看缺项或重试';
          if (item.state === 'saving') {
            await persist();
            const saved = await chrome.tabs.sendMessage(tab.id!, {
              type: 'ERP_DETAIL_SAVE', productId, expectedTitle: item.title,
            } satisfies ErpBatchMessage);
            if (!saved?.ok || saved.saved !== true) throw new Error(saved?.error || 'ERP 未确认草稿保存');
            item.state = 'saved';
          }
        } finally { clearTimeout(timeout); }
      } catch (error) {
        item.state = 'failed'; item.error = (error as Error).message;
        if (/超过 4 分钟|采集箱已切换|标签页已关闭|登录|未就绪|列表已变化|弹窗提示|标题匹配|同名新编辑页/.test(item.error)) job.state = 'pausing';
        if (/超过 4 分钟/.test(item.error) && item.tabId != null) {
          await chrome.tabs.sendMessage(item.tabId, { type: 'ERP_DETAIL_CANCEL' } satisfies ErpBatchMessage).catch(() => undefined);
        }
      }
      await persist();
      if (job.state === 'running') await sleep(800);
    }
    if (job.state === 'pausing') job.state = 'paused';
    await persist();
  } finally { clearInterval(heartbeat); working = false; }
}

chrome.tabs.onRemoved.addListener(id => {
  if (!job || !isErpJobActive(job)) return;
  if (id === job.sourceTabId || job.items.some(item => item.tabId === id && (item.state === 'running' || item.state === 'opening'))) {
    job.state = 'pausing';
    void persist();
  }
});

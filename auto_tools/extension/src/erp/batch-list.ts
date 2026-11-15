import { ERP_BATCH_STORAGE, isErpJobActive, isErpListUrl } from './batch-types.js';
import type { ErpBatchMessage, ErpBatchState, ErpRowRef } from './batch-types.js';

const HOST = 'auto-tools-erp-batch';
const rows = () => [...document.querySelectorAll<HTMLTableRowElement>('tr.el-table__row')].filter(row => row.querySelector('input[type="checkbox"]') && [...row.querySelectorAll('button')].some(button => button.textContent?.trim() === '编辑'));
function ref(row: HTMLTableRowElement, index: number): ErpRowRef {
  const cells = row.querySelectorAll('td');
  const title = cells[2]?.querySelector('[title]')?.getAttribute('title') || '';
  const shop = cells[1]?.querySelector('[title]')?.getAttribute('title') || '';
  const photo = cells[1]?.querySelector<HTMLImageElement>('img')?.getAttribute('src') || '';
  return { index, title, shop, key: JSON.stringify([shop, title, photo]) };
}

// 编辑仍走 ERP 自己的按钮；不用猜商品 ID，也不读取页面框架的私有状态。
chrome.runtime.onMessage.addListener((message: ErpBatchMessage, sender, reply) => {
  if (message?.type !== 'ERP_BATCH_OPEN_ROW' || sender.id !== chrome.runtime.id) return false;
  try {
    if (!isErpListUrl(location.href)) throw new Error('采集箱已切换页面');
    const candidates = rows();
    const row = candidates[message.row.index];
    if (!row || candidates.filter((candidate, index) => ref(candidate, index).key === message.row.key).length !== 1 || ref(row, message.row.index).key !== message.row.key) throw new Error('列表已变化，请恢复原筛选、排序和页码后重试');
    const edit = [...row.querySelectorAll('button')].find(button => button.textContent?.trim() === '编辑');
    if (!edit || edit.disabled) throw new Error('商品编辑入口不可用');
    edit.click();
    reply({ ok: true });
  } catch (error) { reply({ ok: false, error: (error as Error).message }); }
  return false;
});

export function mountBatchList(): () => void {
  const host = document.createElement('div'); host.id = HOST;
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
:host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1e293b}*{box-sizing:border-box}button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:9px 12px;background:#eff6ff;color:#1d4ed8}button:disabled{opacity:.45;cursor:default}.launch{position:fixed;right:24px;bottom:90px;background:#2563eb;color:white;z-index:2147483647;border-radius:30px;padding:13px 18px;font-weight:700;box-shadow:0 8px 30px #0f172a33}.panel{display:none;position:fixed;right:24px;bottom:145px;width:min(490px,calc(100vw - 32px));max-height:78vh;overflow:auto;z-index:2147483647;background:white;border:1px solid #dbe3ef;border-radius:16px;padding:18px;box-shadow:0 14px 44px #0f172a33;font-size:13px;line-height:1.6}.panel.open{display:block}.head{display:flex;justify-content:space-between;align-items:center}.head b{font-size:18px}.sub{color:#64748b}.note{background:#fffbeb;color:#92400e;padding:10px;border-radius:8px;margin:12px 0}.actions{display:flex;flex-wrap:wrap;gap:8px}.start{background:#2563eb;color:white}.summary{font-weight:650;margin:12px 0}.items{padding:0;list-style:none}.items li{padding:10px 0;border-bottom:1px solid #e2e8f0}.title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.state{color:#15803d}.issue{color:#b45309;white-space:pre-line}.status{color:#b45309;white-space:pre-line}.version{font-size:11px;color:#94a3b8}
</style><button class="launch">批量填表</button><section class="panel" aria-label="批量填表助手"><div class="head"><b>采集箱批量填表</b><button class="close" aria-label="关闭批量填表助手">×</button></div><p class="sub">逐件按工作台字段规则填写；全部必填项核对通过后自动保存草稿。</p><div class="note">先勾选要处理的商品，再开始。系统按件填写并核对结果，通过后点击 ERP「保存」保存草稿，不会发布。检测到 COTTON 时只保留 COTTON 并按工作台比例填写；无法确认纯棉成分时会跳过该件，避免把 100% 棉标签用于混纺商品。不要在任务中切换列表筛选、排序或页码。</div><div class="summary"></div><div class="actions"><button class="start">填写并保存已勾选商品</button><button class="pause">本件结束后暂停</button><button class="resume">继续未处理商品</button><button class="retry">重试失败商品</button></div><p class="status" role="status"></p><ul class="items"></ul><p class="version">最多 50 件 · 保留 PC 原文 · 导入无线详情 · 生成 1:1 与 3:4 图 · 自动保存草稿 · 不发布</p></section>`;
  const $ = <T extends HTMLElement>(selector: string) => shadow.querySelector<T>(selector)!;
  let job: ErpBatchState | null = null;
  let busy = false;
  let disposed = false;
  const labels = { pending: '排队中', opening: '打开编辑页', running: '正在填写', saving: '正在保存草稿', saved: '已保存草稿', failed: '未完成' };
  const stateLabels = { running: '处理中', pausing: '当前商品结束后暂停', paused: '已暂停', completed: '队列结束' };
  function render(): void {
    if (disposed) return;
    const selected = rows().filter(row => row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).length;
    const done = job?.items.filter(item => item.state === 'saved').length || 0;
    $('.summary').textContent = `当前勾选 ${selected} 件` + (job ? ` · ${stateLabels[job.state]} · 已保存 ${done}/${job.items.length}` : '');
    $<HTMLButtonElement>('.start').disabled = busy || !selected || isErpJobActive(job);
    $<HTMLButtonElement>('.pause').disabled = busy || !job || job.state !== 'running';
    $<HTMLButtonElement>('.resume').disabled = busy || !job || isErpJobActive(job) || !job.items.some(item => item.state === 'pending');
    $<HTMLButtonElement>('.retry').disabled = busy || !job || isErpJobActive(job) || !job.items.some(item => item.state === 'failed');
    $('.items').replaceChildren();
    for (const item of job?.items || []) {
      const li = document.createElement('li');
      const title = document.createElement('div'); title.className = 'title'; title.textContent = item.title; title.title = item.title;
      const state = document.createElement('div'); state.className = 'state'; state.textContent = labels[item.state];
      li.append(title, state);
      if (item.error || item.report?.issues.length) {
        const issue = document.createElement('div'); issue.className = 'issue'; issue.textContent = [item.error, ...(item.report?.issues || [])].filter(Boolean).join('\n'); li.append(issue);
      }
      if (item.tabId != null) {
        const open = document.createElement('button'); open.textContent = '查看编辑页';
        open.onclick = () => { void send({ type: 'ERP_BATCH_FOCUS', tabId: item.tabId! }); };
        li.append(open);
      }
      $('.items').append(li);
    }
  }
  async function send(message: ErpBatchMessage): Promise<void> {
    busy = true; $('.status').textContent = ''; render();
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) throw new Error(response?.error || '扩展未返回结果，请重载扩展并刷新采集箱');
      job = response.job;
    } catch (error) { $('.status').textContent = (error as Error).message; }
    finally { busy = false; render(); }
  }
  $('.launch').onclick = () => { $('.panel').classList.toggle('open'); render(); };
  $('.close').onclick = () => $('.panel').classList.remove('open');
  $('.start').onclick = () => {
    const selected = rows().map((row, index) => ({ row, data: ref(row, index) })).filter(({ row }) => row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).map(({ data }) => data);
    void send({ type: 'ERP_BATCH_START', rows: selected });
  };
  $('.pause').onclick = () => void send({ type: 'ERP_BATCH_PAUSE' });
  $('.resume').onclick = () => void send({ type: 'ERP_BATCH_RESUME' });
  $('.retry').onclick = () => void send({ type: 'ERP_BATCH_RESUME', retryFailed: true });
  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[ERP_BATCH_STORAGE]) { job = changes[ERP_BATCH_STORAGE].newValue || null; render(); }
  };
  chrome.storage.onChanged.addListener(onStorage);
  void chrome.storage.local.get(ERP_BATCH_STORAGE).then(result => { if (!disposed) { job = result[ERP_BATCH_STORAGE] || null; render(); } });
  const timer = setInterval(render, 1500);
  return () => { disposed = true; clearInterval(timer); chrome.storage.onChanged.removeListener(onStorage); host.remove(); };
}

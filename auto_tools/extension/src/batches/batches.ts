import { isBatchProductUrl, type CollectBatchDetail, type CollectBatchItemStatus } from '@shared/collect-batches';
import { collectBatchApi, sortBatchUrl } from '../common/collect-batch-api.js';
import { getConfig } from '../common/config.js';
import { sendMessage, type Message } from '../common/messages.js';

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const button = (id: string) => element<HTMLButtonElement>(id);
const filter = element<HTMLSelectElement>('filter');
const labels: Record<CollectBatchItemStatus, string> = { failed: '失败', pending: '未处理', collected: '新增', duplicate: '重复' };
let selected = new URLSearchParams(location.search).get('batch') ?? '';
let offset = 0, page = 0, refreshId = 0;
let current: CollectBatchDetail | undefined;
let running = '';
const pageSize = 50;
let backendUrl = '';

function message(text: string) {
  element('message').textContent = text;
  element('message').hidden = !text;
}

function showItems() {
  if (!current) return;
  const items = current.items.filter(item => filter.value === 'all' || filter.value === item.status);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  page = Math.min(page, pageCount - 1);
  const rows = items.slice(page * pageSize, (page + 1) * pageSize).map(item => {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('strong');
    label.className = item.status;
    label.textContent = labels[item.status];
    const link = document.createElement('a');
    link.textContent = item.url;
    if (isBatchProductUrl(current!.source, item.url)) {
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    row.append(label, link);
    if (item.reason) {
      const reason = document.createElement('span');
      reason.className = 'reason';
      reason.textContent = item.reason;
      row.append(reason);
    }
    return row;
  });
  element('rows').replaceChildren(...rows);
  element('range').textContent = `${items.length} 件 · ${page + 1} / ${pageCount} 页`;
  button('prevItems').disabled = page === 0;
  button('nextItems').disabled = page + 1 >= pageCount;
}

function render() {
  element('empty').hidden = Boolean(current);
  element('detail').hidden = !current;
  if (!current) return;
  element('title').textContent = `${current.source.toUpperCase()} · ${new Date(current.createdAt).toLocaleString()}`;
  element('counts').textContent = `共 ${current.total} 件 · 新增 ${current.collected} · 重复 ${current.duplicate} · 失败 ${current.failed} · 未处理 ${current.pending}`;
  const sort = element<HTMLAnchorElement>('sort');
  sort.href = sortBatchUrl(backendUrl, current.id);
  sort.hidden = !current.items.some(item => item.productId);
  button('retry').disabled = Boolean(running) || !current.failed;
  button('resume').disabled = Boolean(running) || !current.pending;
  button('stop').hidden = running !== current.id;
  element('progress').hidden = running !== current.id;
  showItems();
}

async function refresh() {
  const request = ++refreshId;
  try {
    const [batches, config] = await Promise.all([collectBatchApi.list(offset), getConfig()]);
    if (request !== refreshId) return;
    backendUrl = config.backendUrl;
    selected ||= batches[0]?.id ?? '';
    const entries = batches.map(batch => {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.setAttribute('aria-current', String(batch.id === selected));
      entry.textContent = `${batch.source.toUpperCase()} · ${new Date(batch.createdAt).toLocaleString()}`;
      const counts = document.createElement('small');
      counts.textContent = `${batch.total} 件 · 已采 ${batch.collected + batch.duplicate} · 失败 ${batch.failed} · 未处理 ${batch.pending}`;
      entry.append(counts);
      entry.onclick = () => {
        selected = batch.id;
        page = 0; filter.value = 'all';
        history.replaceState(null, '', '?batch=' + encodeURIComponent(selected));
        void refresh();
      };
      return entry;
    });
    element('history').replaceChildren(...entries);
    if (!entries.length) element('history').textContent = offset ? '本页没有更多批次' : '还没有采集批次';
    button('newer').disabled = offset === 0;
    button('older').disabled = batches.length < 25;
    const detail = selected ? await collectBatchApi.detail(selected) : undefined;
    if (request !== refreshId) return;
    current = detail;
    render();
  } catch (error) {
    if (request === refreshId) { current = undefined; render(); message((error as Error).message); }
  }
}

async function run(target: 'failed' | 'pending') {
  if (!current || running) return;
  running = current.id;
  message('');
  element('progress').textContent = '准备采集…';
  render();
  try {
    const result = await sendMessage({ type: 'BATCH_RETRY', batchId: running, target });
    if (!result.ok) throw new Error(result.error);
  } catch (error) { message((error as Error).message); }
  finally { running = ''; await refresh(); }
}

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg.type === 'BATCH_PROGRESS' && msg.batchId === running && running === current?.id) {
    element('progress').textContent = msg.note || `已处理 ${msg.done} / ${msg.total} 件`;
  }
});
button('refresh').onclick = () => { message(''); void refresh(); };
button('newer').onclick = () => { offset = Math.max(0, offset - 25); void refresh(); };
button('older').onclick = () => { offset += 25; void refresh(); };
filter.onchange = () => { page = 0; showItems(); };
button('prevItems').onclick = () => { page--; showItems(); };
button('nextItems').onclick = () => { page++; showItems(); };
button('retry').onclick = () => { void run('failed'); };
button('resume').onclick = () => { void run('pending'); };
button('stop').onclick = () => {
  void sendMessage({ type: 'BATCH_STOP' }).then(result => {
    if (!result.ok) message(result.error);
  }).catch(error => message(error.message));
};
void refresh();

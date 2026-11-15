import type { CollectResponse, CollectedProduct, PresetsConfig } from '@shared/types';
import { getConfig } from '../common/config.js';
import './erp-batch.js';
import type { CollectTally, Message, MessageResponse, VideoBackfillStatus } from '../common/messages.js';
import {
  extractWildberriesProduct,
  extractWildberriesProducts,
  isWildberriesUrl,
  type JsonFetcher,
} from '../extractors/wildberries-api.js';

/** 后端请求集中在 background:有 host 权限、不受页面 CORS 限制。 */
chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  if (msg.type?.startsWith('ERP_')) return false;
  handle(msg, sender)
    .then(sendResponse)
    .catch((e: Error) => sendResponse({ ok: false, error: e.message } satisfies MessageResponse));
  return true; // 异步响应
});

/**
 * 上报采集结果。content 只在用户主动选了模板时才传 templateId，
 * 因此带 templateId 就标记为 picked：服务端核对无矛盾会直接确认。
 */
async function postCollect(product: CollectedProduct, templateId?: string, signal?: AbortSignal): Promise<CollectResponse> {
  const { backendUrl } = await getConfig();
  const res = await fetch(`${backendUrl}/api/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product, ...(templateId ? { templateId, templateSource: 'picked' } : {}) }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`后端 ${res.status}: ${text.slice(0, 120)}`);
  }
  return (await res.json()) as CollectResponse;
}

function emptyTally(): CollectTally {
  return { confirmed: 0, review: 0, duplicates: 0 };
}

function countCollect(tally: CollectTally, res: CollectResponse): void {
  if (res.duplicate) tally.duplicates += 1;
  else if (res.template?.confirmed) tally.confirmed += 1;
  else tally.review += 1;
}

/** 每个来源标签页一个独立任务；限制总数，避免同时打开过多详情页。 */
const MAX_CONCURRENT_BATCHES = 6;
const activeBatches = new Map<number, AbortController>();
const VIDEO_BACKFILL_KEY = 'videoBackfill';
const VIDEO_BACKFILL_ALARM = 'video-backfill-resume';
type VideoCandidate = { id: string; sourceUrl: string; title: string };
type StoredVideoBackfill = VideoBackfillStatus & { candidates: VideoCandidate[]; since?: string };
let videoBackfillController: AbortController | null = null;
let videoBackfillRunning = false;

chrome.tabs.onRemoved.addListener((tabId) => activeBatches.get(tabId)?.abort());

async function handle(msg: Message, sender: chrome.runtime.MessageSender): Promise<MessageResponse> {
  switch (msg.type) {
    case 'COLLECT_PRODUCT': {
      const res = await postCollect(msg.product, msg.templateId);
      return { ok: true, type: 'COLLECT_PRODUCT', id: res.id, duplicate: res.duplicate, template: res.template };
    }
    case 'BATCH_COLLECT': {
      const tabId = sender.tab?.id;
      if (tabId == null) throw new Error('无法识别发起采集的页面');
      if (activeBatches.has(tabId)) throw new Error('此页面已有批量采集在进行，请先停止当前任务');
      if (activeBatches.size >= MAX_CONCURRENT_BATCHES) {
        throw new Error(`最多同时运行 ${MAX_CONCURRENT_BATCHES} 个批量采集任务，请等待其中一个完成`);
      }
      const controller = new AbortController();
      activeBatches.set(tabId, controller);
      try {
        const summary = await batchCollect(msg.urls, tabId, msg.templateId, controller.signal);
        return { ok: true, type: 'BATCH_COLLECT', ...summary };
      } finally {
        if (activeBatches.get(tabId) === controller) activeBatches.delete(tabId);
      }
    }
    case 'GET_PRESETS': {
      const { backendUrl } = await getConfig();
      const res = await fetch(`${backendUrl}/api/settings`);
      if (!res.ok) throw new Error(`读取采集模板失败 (${res.status})`);
      const config = (await res.json()) as PresetsConfig;
      return {
        ok: true,
        type: 'GET_PRESETS',
        templates: (config.templates || []).map(({ id, name }) => ({ id, name })),
        activeId: config.activeId,
      };
    }
    case 'GET_ALIEXPRESS_AUTOFILL_CONFIG': {
      if (!sender.url?.startsWith('https://erp2.cnfth.com/')) throw new Error('只有速卖通 ERP 页面可以读取自动填充配置');
      const { backendUrl } = await getConfig();
      const res = await fetch(`${backendUrl}/api/aliexpress/auto-fill`);
      if (!res.ok) throw new Error(`读取速卖通自动填充配置失败 (${res.status})`);
      return { ok: true, type: 'GET_ALIEXPRESS_AUTOFILL_CONFIG', config: await res.json() };
    }
    case 'EXTRACT_BY_URL': {
      if (!isWildberriesUrl(msg.url)) throw new Error('当前仅 Wildberries 支持按链接提取');
      const product = await extractWildberriesProduct(msg.url, makeFetcher(sender.tab?.id));
      return { ok: true, type: 'EXTRACT_BY_URL', product };
    }
    case 'BATCH_STOP': {
      const controller = sender.tab?.id == null ? undefined : activeBatches.get(sender.tab.id);
      const active = Boolean(controller);
      controller?.abort();
      return { ok: true, type: 'BATCH_STOP', active };
    }
    case 'PING_BACKEND': {
      const { backendUrl } = await getConfig();
      const res = await fetch(`${backendUrl}/api/health`);
      if (!res.ok) throw new Error(`后端不可达 (${res.status})`);
      const data = (await res.json()) as { joomEnv: string };
      return { ok: true, type: 'PING_BACKEND', joomEnv: data.joomEnv };
    }
    case 'GET_STATS': {
      const { backendUrl } = await getConfig();
      const res = await fetch(`${backendUrl}/api/products`);
      if (!res.ok) throw new Error(`后端不可达 (${res.status})`);
      const data = (await res.json()) as unknown[];
      return { ok: true, type: 'GET_STATS', total: data.length };
    }
    case 'VIDEO_BACKFILL_START': {
      const current = await readVideoBackfill();
      if (current.state === 'running') return { ok: true, type: 'VIDEO_BACKFILL', status: current };
      const { backendUrl } = await getConfig();
      const url = `${backendUrl}/api/products/video-backfill-candidates?source=aliexpress&limit=5000&since=${encodeURIComponent(msg.since)}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`读取补采列表失败 (${response.status})`);
      const candidates = await response.json() as VideoCandidate[];
      const next: StoredVideoBackfill = {
        state: 'running', total: candidates.length, done: 0, found: 0, missing: 0, failed: 0,
        candidates, since: msg.since,
      };
      await writeVideoBackfill(next);
      chrome.alarms.create(VIDEO_BACKFILL_ALARM, { periodInMinutes: 1 });
      void continueVideoBackfill();
      return { ok: true, type: 'VIDEO_BACKFILL', status: next };
    }
    case 'VIDEO_BACKFILL_STATUS':
      return { ok: true, type: 'VIDEO_BACKFILL', status: await readVideoBackfill() };
    case 'VIDEO_BACKFILL_STOP': {
      videoBackfillController?.abort();
      const current = await readVideoBackfill();
      const stopped = { ...current, state: 'stopped' as const, currentTitle: undefined };
      await writeVideoBackfill(stopped);
      await chrome.alarms.clear(VIDEO_BACKFILL_ALARM);
      return { ok: true, type: 'VIDEO_BACKFILL', status: stopped };
    }
    default:
      throw new Error('unsupported message');
  }
}

async function readVideoBackfill(): Promise<StoredVideoBackfill> {
  const stored = await chrome.storage.local.get(VIDEO_BACKFILL_KEY);
  return (stored[VIDEO_BACKFILL_KEY] as StoredVideoBackfill | undefined) ?? {
    state: 'idle', total: 0, done: 0, found: 0, missing: 0, failed: 0, candidates: [],
  };
}

async function writeVideoBackfill(value: StoredVideoBackfill): Promise<void> {
  await chrome.storage.local.set({ [VIDEO_BACKFILL_KEY]: value });
}

async function saveBackfilledVideos(candidate: VideoCandidate, product: CollectedProduct): Promise<void> {
  const { backendUrl } = await getConfig();
  const response = await fetch(`${backendUrl}/api/products/${encodeURIComponent(candidate.id)}/videos`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videos: product.videos ?? [] }),
  });
  if (!response.ok) throw new Error(`保存视频失败 (${response.status})`);
}

async function continueVideoBackfill(): Promise<void> {
  if (videoBackfillRunning) return;
  videoBackfillRunning = true;
  videoBackfillController = new AbortController();
  try {
    let job = await readVideoBackfill();
    while (job.state === 'running' && job.done < job.total) {
      const candidate = job.candidates[job.done];
      job = { ...job, currentTitle: candidate.title };
      await writeVideoBackfill(job);
      try {
        const product = await extractViaTab(candidate.sourceUrl, undefined, undefined, videoBackfillController.signal);
        if (product?.videos?.length) {
          await saveBackfilledVideos(candidate, product);
          job.found += 1;
        } else {
          job.missing += 1;
        }
      } catch (error) {
        if (videoBackfillController.signal.aborted) break;
        job.failed += 1;
        job.error = `${candidate.title.slice(0, 40)}: ${(error as Error).message}`;
      }
      job.done += 1;
      job.currentTitle = undefined;
      await writeVideoBackfill(job);
    }
    const latest = await readVideoBackfill();
    if (latest.state === 'running' && latest.done >= latest.total) {
      await writeVideoBackfill({ ...latest, state: 'completed', currentTitle: undefined });
      await chrome.alarms.clear(VIDEO_BACKFILL_ALARM);
    }
  } finally {
    videoBackfillController = null;
    videoBackfillRunning = false;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === VIDEO_BACKFILL_ALARM) void continueVideoBackfill();
});
void readVideoBackfill().then((job) => {
  if (job.state === 'running') return continueVideoBackfill();
});

// ---- 批量采集:逐个后台开详情页 -> 提取 -> 入库 -> 关闭 ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('批量采集已停止', 'AbortError');
}

/** 当前页面操作不支持原生取消时，先结束等待，再由调用方关闭详情标签页。 */
function waitOrStop<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('批量采集已停止', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new DOMException('批量采集已停止', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
/** 验证码等待上限:超过则跳过该商品继续。 */
const CAPTCHA_WAIT_MS = 300_000;
/** 每个商品之间的间隔,放慢节奏、降低触发反爬概率。 */
const ITEM_GAP_MS = 1200;

/**
 * 只匹配明确的验证/拦截页标题。
 * 不能直接搜索 `robot`,否则 "robots graphic t-shirt" 等正常商品名也会被误判。
 */
const BLOCKED_TITLE_RE =
  /验证码|安全验证|人机验证|滑块验证|访问受限|访问被拒绝|проверяем браузер|доступ ограничен|\brobot check\b|\bare you (?:a )?robot\b|\bhuman verification\b|\bsecurity (?:check|verification)\b|\b(?:verify|confirm) (?:that )?you(?:'re| are) human\b|\b(?:complete|solve) (?:the )?captcha\b|\bcaptcha (?:challenge|verification)\b|\baccess denied\b/i;

function isBlockedTitle(title: string): boolean {
  return BLOCKED_TITLE_RE.test(title);
}

function notify(tabId: number | undefined, payload: Omit<Extract<Message, { type: 'BATCH_PROGRESS' }>, 'type'>) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'BATCH_PROGRESS', ...payload } satisfies Message).catch(() => {});
}

function makeFetcher(tabId?: number): JsonFetcher {
  const load = async (url: string): Promise<unknown> => {
    if (tabId != null && !/wbbasket\.ru/i.test(url)) {
      try {
        const [inj] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          args: [url],
          func: async (u: string) => {
            const res = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
            const text = await res.text();
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return JSON.parse(text) as unknown;
          },
        });
        if (inj?.result != null) return inj.result;
      } catch {
        /* 页面注入失败时改走扩展权限请求 */
      }
    }
    const headers = { Accept: 'application/json', Referer: 'https://www.wildberries.ru/' };
    let res = await fetch(url, { headers });
    if (res.status === 429 || res.status === 498) {
      await sleep(1600);
      res = await fetch(url, { headers });
    }
    if (!res.ok) throw new Error(`Wildberries 接口 ${res.status}`);
    return res.json() as Promise<unknown>;
  };
  return load;
}

function isCollectable(product: CollectedProduct | null | undefined): boolean {
  return Boolean(
    product?.title &&
    !isBlockedTitle(product.title) &&
    product.variants?.length,
  );
}

async function batchCollectWildberries(urls: string[], signal: AbortSignal, notifyTabId?: number, templateId?: string) {
  const total = urls.length;
  notify(notifyTabId, { done: 0, total, ok: 0, fail: 0, note: '正在通过 Wildberries 接口读取商品…' });
  let products: Map<string, CollectedProduct>;
  try {
    products = await waitOrStop(extractWildberriesProducts(urls, makeFetcher(notifyTabId), (done, n) => {
      if (!signal.aborted) notify(notifyTabId, { done, total: n, ok: 0, fail: 0, note: `读取商品 ${done}/${n}` });
    }), signal);
  } catch (e) {
    if (signal.aborted) {
      notify(notifyTabId, { done: 0, total, ok: 0, fail: 0, stopped: true });
      return { total, okCount: 0, fail: 0, stopped: true };
    }
    const reason = e instanceof Error ? e.message : String(e);
    notify(notifyTabId, { done: total, total, ok: 0, fail: total, note: `失败: ${reason}` });
    return { total, okCount: 0, fail: total, stopped: false };
  }

  let okCount = 0;
  let fail = 0;
  let done = 0;
  const tally = emptyTally();
  for (const url of urls) {
    if (signal.aborted) break;
    const product = products.get(url);
    try {
      if (isCollectable(product) && product) {
        countCollect(tally, await postCollect(product, templateId, signal));
        okCount++;
      } else {
        fail++;
        notify(notifyTabId, { done, total, ok: okCount, fail, note: '失败: 接口未返回该商品，可能已下架' });
      }
    } catch (e) {
      if (signal.aborted) break;
      const reason = e instanceof Error ? e.message : String(e);
      fail++;
      notify(notifyTabId, { done, total, ok: okCount, fail, note: `失败: ${reason.slice(0, 80)}` });
    }
    done += 1;
    notify(notifyTabId, { done, total, ok: okCount, fail, tally });
    if (!signal.aborted && done < total) await waitOrStop(sleep(200), signal).catch(() => {});
  }
  const stopped = signal.aborted;
  if (stopped || done < total) notify(notifyTabId, { done, total, ok: okCount, fail, stopped, tally });
  return { total, okCount, fail, stopped, tally };
}

async function batchCollect(urls: string[], notifyTabId: number | undefined, templateId: string | undefined, signal: AbortSignal) {
  if (urls.length && urls.every(isWildberriesUrl)) {
    return batchCollectWildberries(urls, signal, notifyTabId, templateId);
  }
  let okCount = 0;
  let fail = 0;
  let done = 0;
  const total = urls.length;
  const tally = emptyTally();
  for (let i = 0; i < urls.length; i++) {
    if (signal.aborted) break;
    try {
      const product = await extractViaTab(
        urls[i],
        (note) => notify(notifyTabId, { done, total, ok: okCount, fail, note }),
        notifyTabId,
        signal,
      );
      throwIfStopped(signal);
      if (isCollectable(product) && product) {
        countCollect(tally, await postCollect(product, templateId, signal));
        okCount++;
      } else {
        const reason = !product
          ? '详情页未返回商品数据'
          : !product.title
            ? '详情页标题为空'
            : !product.variants?.length
              ? '详情页未识别到变体'
              : '商品数据未通过校验';
        console.warn('[Joom采集助手] 商品采集失败', { url: urls[i], reason });
        notify(notifyTabId, { done, total, ok: okCount, fail, note: `失败: ${reason}` });
        fail++;
      }
    } catch (e) {
      if (signal.aborted) break;
      const reason = e instanceof Error ? e.message : String(e);
      console.warn('[Joom采集助手] 批量采集异常', { url: urls[i], error: reason });
      notify(notifyTabId, { done, total, ok: okCount, fail, note: `失败: ${reason.slice(0, 80)}` });
      fail++;
    }
    done = i + 1;
    notify(notifyTabId, { done, total, ok: okCount, fail, tally });
    if (i < urls.length - 1 && !signal.aborted) await waitOrStop(sleep(ITEM_GAP_MS), signal).catch(() => {});
  }
  const stopped = signal.aborted;
  if (stopped || done < total) notify(notifyTabId, { done, total, ok: okCount, fail, stopped, tally });
  return { total, okCount, fail, stopped, tally };
}

/** 标签页是否为验证码/风控拦截页(按 URL/标题特征判断)。 */
function isBlockedUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  // 匹配独立的拦截路径段，避免把商品 slug 中的 `punisher` 误判为 `/punish`。
  if (/(?:^|\/)(?:punish|captcha|slidecaptcha|nc)(?:\/|$)/i.test(url.pathname)) return true;
  return /_____tmd_____/i.test(`${url.pathname}${url.search}`) || url.searchParams.has('x5secdata');
}

async function isTabBlocked(tabId: number): Promise<boolean> {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t) return false;
  const u = t.url || '';
  const ti = t.title || '';
  return isBlockedUrl(u) || isBlockedTitle(ti);
}

/**
 * 后台打开详情页 -> 若命中验证码:切到前台、通知用户、轮询等待人工完成 ->
 * 提取结果 -> 关闭标签页。onBlocked 用于向列表页透出「等待验证」提示。
 */
async function extractViaTab(url: string, onBlocked: ((note: string) => void) | undefined, pageTabId: number | undefined, signal: AbortSignal): Promise<CollectedProduct | null> {
  throwIfStopped(signal);
  if (isWildberriesUrl(url)) {
    return waitOrStop(extractWildberriesProduct(url, makeFetcher(pageTabId)), signal);
  }
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id!;
  try {
    throwIfStopped(signal);
    await waitForComplete(tabId, 20000, signal);

    // 验证码处理:前台显示 + 等待用户完成(通过后页面会跳回商品页)
    if (await waitOrStop(isTabBlocked(tabId), signal)) {
      await waitOrStop(chrome.tabs.update(tabId, { active: true }).catch(() => {}), signal);
      onBlocked?.('检测到验证码,已暂停并切到该标签页,请手动完成验证…');
      let waited = 0;
      while (await waitOrStop(isTabBlocked(tabId), signal)) {
        await waitOrStop(sleep(2000), signal);
        waited += 2000;
        if (waited >= CAPTCHA_WAIT_MS) return null; // 超时放弃该商品
      }
      // 验证通过后等页面重新加载完成
      await waitForComplete(tabId, 20000, signal);
      onBlocked?.('验证已完成,继续采集…');
    }

    const res = await sendToTabWithRetry(tabId, { type: 'EXTRACT_DETAIL' }, 10, 700, signal);
    if (!res) throw new Error('详情页脚本未响应');
    if (!res.ok) throw new Error(res.error || '详情页提取失败');
    return res.type === 'EXTRACT_DETAIL' ? res.product : null;
  } finally {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

function waitForComplete(tabId: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfStopped(signal);
    let done = false;
    const finish = (stopped = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      signal.removeEventListener('abort', onStop);
      if (stopped) reject(new DOMException('批量采集已停止', 'AbortError'));
      else resolve();
    };
    const onStop = () => finish(true);
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    signal.addEventListener('abort', onStop, { once: true });
    // 已经是 complete 的兜底 + 超时
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && finish()).catch(() => {});
  });
}

/** content 脚本可能还没就绪,重试发送。 */
async function sendToTabWithRetry(
  tabId: number,
  msg: Message,
  tries: number,
  gapMs: number,
  signal: AbortSignal,
): Promise<MessageResponse | null> {
  for (let i = 0; i < tries; i++) {
    throwIfStopped(signal);
    try {
      const res = (await waitOrStop(chrome.tabs.sendMessage(tabId, msg), signal)) as MessageResponse;
      if (res) return res;
    } catch {
      throwIfStopped(signal);
      /* 未就绪,稍后重试 */
    }
    await waitOrStop(sleep(gapMs), signal);
  }
  return null;
}

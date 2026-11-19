import type { CollectResponse, CollectedProduct, PresetsConfig } from '@shared/types';
import { getConfig } from '../common/config.js';
import { collectBatchApi, sortBatchUrl } from '../common/collect-batch-api.js';
import { collectionSourceForUrl, isBatchProductUrl } from '@shared/collect-batches';
import type { SourcePlatform } from '@shared/types';
import './erp-batch.js';
import type { CollectTally, Message, MessageResponse, VideoBackfillStatus } from '../common/messages.js';
import { cleanOzonProductUrl, ozonProductId } from '../extractors/ozon.js';
import {
  extractWildberriesProduct,
  extractWildberriesProducts,
  isWildberriesUrl,
  type JsonFetcher,
} from '../extractors/wildberries-api.js';

/** 后端请求集中在 background:有 host 权限、不受页面 CORS 限制。 */
chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  if (msg.type?.startsWith('ERP_') || msg.type === 'BATCH_PROGRESS') return false;
  handle(msg, sender)
    .then(sendResponse)
    .catch((e: Error) => sendResponse({ ok: false, error: e.message } satisfies MessageResponse));
  return true; // 异步响应
});

/**
 * 上报采集结果。content 只在用户主动选了模板时才传 templateId，
 * 因此带 templateId 就标记为 picked：服务端核对无矛盾会直接确认。
 */
type BatchItemRef = { id: string; url: string };

async function postCollect(product: CollectedProduct, templateId?: string, signal?: AbortSignal, batch?: BatchItemRef): Promise<CollectResponse> {
  const { backendUrl } = await getConfig();
  const res = await fetch(`${backendUrl}/api/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product, batch, ...(templateId ? { templateId, templateSource: 'picked' } : {}) }),
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
const batchByTab = new Map<number, string>();
const ozonBatches = new Map<number, string>();
const historyTabs = new Set<number>();
const VIDEO_BACKFILL_KEY = 'videoBackfill';
const VIDEO_BACKFILL_ALARM = 'video-backfill-resume';
type VideoCandidate = { id: string; sourceUrl: string; title: string };
type StoredVideoBackfill = VideoBackfillStatus & { candidates: VideoCandidate[]; since?: string };
let videoBackfillController: AbortController | null = null;
let videoBackfillRunning = false;

chrome.tabs.onRemoved.addListener((tabId) => {
  activeBatches.get(tabId)?.abort();
  ozonBatches.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') ozonBatches.delete(tabId);
});

async function handle(msg: Message, sender: chrome.runtime.MessageSender): Promise<MessageResponse> {
  switch (msg.type) {
    case 'COLLECT_PRODUCT': {
      const res = await postCollect(msg.product, msg.templateId);
      return { ok: true, type: 'COLLECT_PRODUCT', id: res.id, duplicate: res.duplicate, template: res.template };
    }
    case 'BATCH_HISTORY': {
      const page = new URL(chrome.runtime.getURL('batches.html'));
      if (msg.batchId) page.searchParams.set('batch', msg.batchId);
      await chrome.tabs.create({ url: page.href });
      return { ok: true, type: 'BATCH_OPENED' };
    }
    case 'BATCH_SORT': {
      const { backendUrl } = await getConfig();
      await chrome.tabs.create({ url: sortBatchUrl(backendUrl, msg.batchId) });
      return { ok: true, type: 'BATCH_OPENED' };
    }
    case 'BATCH_BEGIN_OZON': {
      const tabId = sender.tab?.id;
      if (tabId == null || !isBatchProductUrl('ozon', sender.url ?? '')) throw new Error('无法识别 Ozon 来源页面');
      const { id } = await collectBatchApi.create('ozon', msg.urls, msg.templateId);
      ozonBatches.set(tabId, id);
      return { ok: true, type: 'BATCH_BEGIN_OZON', batchId: id };
    }
    case 'BATCH_END_OZON': {
      const tabId = sender.tab?.id;
      if (tabId != null && ozonBatches.get(tabId) === msg.batchId) ozonBatches.delete(tabId);
      return { ok: true, type: 'BATCH_END_OZON' };
    }
    case 'OZON_COLLECT_ITEM': {
      const tabId = sender.tab?.id;
      const url = cleanOzonProductUrl(msg.url);
      if (tabId == null || !url || !isBatchProductUrl('ozon', sender.url ?? '')) throw new Error('只有 Ozon 页面可以发起 Ozon 商品采集');
      return withBatch(tabId, async (signal) => {
        const stage = (note: string) => {
          chrome.tabs.sendMessage(tabId, { type: 'OZON_ITEM_STAGE', note } satisfies Message).catch(() => {});
        };
        try {
          const result = await collectOzonItem(url, tabId, msg.templateId, signal, stage, msg.batchId ? { id: msg.batchId, url: msg.url } : undefined);
          return { ok: true, type: 'OZON_COLLECT_ITEM', duplicate: Boolean(result.duplicate), confirmed: Boolean(result.template?.confirmed) };
        } catch (error) {
          if (msg.batchId && !signal.aborted) await recordFailures(msg.batchId, [msg.url], error);
          throw error;
        }
      });
    }
    case 'BATCH_COLLECT':
    case 'BATCH_RETRY': {
      const tabId = sender.tab?.id;
      if (tabId == null) throw new Error('无法识别发起采集的页面');
      return withBatch(tabId, async (signal) => {
        let urls: string[], batchId: string, source: SourcePlatform, templateId: string | undefined;
        if (msg.type === 'BATCH_RETRY') {
          if (sender.url?.split('?')[0] !== chrome.runtime.getURL('batches.html')) throw new Error('请从采集批次页面重试');
          const saved = await collectBatchApi.detail(msg.batchId);
          batchId = saved.id;
          if ([...batchByTab.values(), ...ozonBatches.values()].includes(batchId)) throw new Error('该批次仍在采集，请等本轮结束');
          urls = saved.items.filter(item => item.status === msg.target).map(item => item.url);
          if (!urls.length) throw new Error(msg.target === 'failed' ? '这批没有失败商品' : '这批没有未处理商品');
          source = saved.source;
          templateId = saved.templateId ?? undefined;
        } else {
          const pageSource = collectionSourceForUrl(sender.url ?? '');
          if (!pageSource || (msg.source && msg.source !== pageSource)) throw new Error('无法识别采集来源，请刷新来源页后重试');
          source = pageSource;
          urls = [...new Set(msg.urls)];
          templateId = msg.templateId;
          batchId = (await collectBatchApi.create(source, urls, templateId)).id;
        }
        if (urls.some(url => !isBatchProductUrl(source, url))) throw new Error('部分商品链接不属于本批来源平台');
        batchByTab.set(tabId, batchId);
        if (msg.type === 'BATCH_RETRY') historyTabs.add(tabId);
        try {
          const summary = await batchCollect(urls, tabId, templateId, signal, batchId, source);
          return { ok: true, type: 'BATCH_COLLECT', batchId, ...summary };
        } finally {
          batchByTab.delete(tabId);
          historyTabs.delete(tabId);
        }
      });
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
      const res = await fetch(`${backendUrl}/api/products/count`);
      if (!res.ok) throw new Error(`后端不可达 (${res.status})`);
      const data = (await res.json()) as { total: number };
      return { ok: true, type: 'GET_STATS', total: data.total };
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

async function withBatch(tabId: number, run: (signal: AbortSignal) => Promise<MessageResponse>): Promise<MessageResponse> {
  if (activeBatches.has(tabId)) throw new Error('此页面已有批量采集在进行，请先停止当前任务');
  if (activeBatches.size >= MAX_CONCURRENT_BATCHES) {
    throw new Error(`最多同时运行 ${MAX_CONCURRENT_BATCHES} 个批量采集任务，请等待其中一个完成`);
  }
  const controller = new AbortController();
  activeBatches.set(tabId, controller);
  try {
    return await run(controller.signal);
  } finally {
    activeBatches.delete(tabId);
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
  const message: Message = { type: 'BATCH_PROGRESS', ...payload };
  if (historyTabs.has(tabId)) chrome.runtime.sendMessage(message).catch(() => {});
  else chrome.tabs.sendMessage(tabId, message).catch(() => {});
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

async function recordFailures(batchId: string, urls: string[], error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  try {
    await collectBatchApi.fail(batchId, urls, reason || '读取商品失败');
  } catch (saveError) {
    throw new Error(`批次进度保存失败：${(saveError as Error).message}。可在采集批次中继续未处理商品。`);
  }
}

async function collectOzonItem(url: string, tabId: number, templateId: string | undefined, signal: AbortSignal,
  stage: (note: string) => void, batch?: BatchItemRef): Promise<CollectResponse> {
  const product = await extractViaTab(url, stage, tabId, signal, 120_000);
  if (!product || product.source !== 'ozon' || product.sourceProductId !== ozonProductId(url) || !isCollectable(product)) {
    throw new Error('详情页未返回对应的 Ozon 商品');
  }
  stage('正在保存到采集箱');
  const request = new AbortController();
  const cancel = () => request.abort();
  throwIfStopped(signal);
  signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 25_000);
  try {
    return await postCollect(product, templateId, request.signal, batch);
  } catch (error) {
    if (request.signal.aborted && !signal.aborted) throw new Error('保存商品超时，可重试');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}

async function batchCollect(urls: string[], tabId: number, templateId: string | undefined, signal: AbortSignal, batchId: string, source: SourcePlatform) {
  const total = urls.length;
  const tally = emptyTally();
  let okCount = 0, fail = 0, done = 0;
  const report = (note?: string, stopped?: boolean) => notify(tabId, { batchId, done, total, ok: okCount, fail, tally, note, stopped });
  report();
  let wbProducts: Map<string, CollectedProduct> | undefined;
  if (source === 'wildberries') {
    report('正在通过 Wildberries 接口读取商品…');
    try {
      wbProducts = await waitOrStop(extractWildberriesProducts(urls, makeFetcher(tabId), (read, size) => {
        if (!signal.aborted) report(`读取商品 ${read}/${size}`);
      }), signal);
    } catch (error) {
      if (signal.aborted) { report(undefined, true); return { total, okCount, fail, stopped: true, tally }; }
      await recordFailures(batchId, urls, error);
      fail = done = total;
      report(`读取失败：${(error as Error).message}`);
      return { total, okCount, fail, stopped: false, tally };
    }
  }
  for (const url of urls) {
    if (signal.aborted) break;
    try {
      const batch = { id: batchId, url };
      let result: CollectResponse;
      if (source === 'ozon') {
        result = await collectOzonItem(url, tabId, templateId, signal, report, batch);
      } else {
        const product = wbProducts ? wbProducts.get(url) : await extractViaTab(url, report, tabId, signal);
        throwIfStopped(signal);
        if (!product) throw new Error(wbProducts ? '接口未返回该商品，可能已下架' : '详情页未返回商品数据');
        if (!product.title) throw new Error('详情页标题为空');
        if (!product.variants?.length) throw new Error('详情页未识别到变体');
        if (!isCollectable(product)) throw new Error('商品数据未通过校验');
        result = await postCollect(product, templateId, signal, batch);
      }
      countCollect(tally, result);
      okCount++;
    } catch (error) {
      if (signal.aborted) break;
      await recordFailures(batchId, [url], error);
      fail++;
      report(`失败：${(error as Error).message}`);
    }
    done++;
    report();
    if (done < total && !signal.aborted) await waitOrStop(sleep(wbProducts ? 200 : ITEM_GAP_MS), signal).catch(() => {});
  }
  if (signal.aborted || done < total) report(undefined, true);
  return { total, okCount, fail, stopped: signal.aborted, tally };
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
async function extractViaTab(url: string, onBlocked: ((note: string) => void) | undefined, pageTabId: number | undefined, signal: AbortSignal, verificationWaitMs = CAPTCHA_WAIT_MS): Promise<CollectedProduct | null> {
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
        if (waited >= verificationWaitMs) throw new Error('等待手动验证超时，可重试');
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
      const res = await waitOrStop(sendDetailMessage(tabId, msg), signal);
      if (res) return res;
    } catch (error) {
      throwIfStopped(signal);
      if (error instanceof DetailResponseTimeout) throw error;
      /* 未就绪,稍后重试 */
    }
    await waitOrStop(sleep(gapMs), signal);
  }
  return null;
}

class DetailResponseTimeout extends Error {}

/** 页面脚本可能收到消息后不返回；超时后关闭详情页，由批次处理下一件。 */
async function sendDetailMessage(tabId: number, msg: Message): Promise<MessageResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, msg) as Promise<MessageResponse>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DetailResponseTimeout('读取商品详情超时')), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

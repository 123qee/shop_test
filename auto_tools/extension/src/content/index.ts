import type { CollectedProduct } from '@shared/types';
import { sendMessage } from '../common/messages.js';
import type { CollectTally, Message, MessageResponse } from '../common/messages.js';
import { resolveExtractor } from '../extractors/registry.js';
import {
  attachCardButton,
  attachCardCheckbox,
  attachFloatingButton,
  createBatchBar,
  toast,
  type BatchBar,
} from './ui.js';

const INJECTED_ATTR = 'data-joom-injected';

console.log(`[Joom采集助手] content 已加载 build ${__BUILD_ID__}`);

const extractor = resolveExtractor(location.href);

// 后台批量采集时会向本页(详情页)要提取结果;进度通知则更新批量条。
chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (msg.type === 'EXTRACT_DETAIL') {
    (async () => {
      try {
        const product = extractor ? await extractor.extractDetail() : null;
        sendResponse({ ok: true, type: 'EXTRACT_DETAIL', product } satisfies MessageResponse);
      } catch (e) {
        sendResponse({ ok: false, error: (e as Error).message } satisfies MessageResponse);
      }
    })();
    return true; // 异步
  }
  if (msg.type === 'BATCH_PROGRESS') {
    if (msg.note) {
      batchBar?.setStatus(`进度 ${msg.done}/${msg.total} · ${msg.note}`);
      toast(msg.note, msg.note.includes('验证') && !msg.note.includes('完成') ? 'err' : 'ok');
    } else {
      batchBar?.setStatus(`进度 ${msg.done}/${msg.total} · 成功 ${msg.ok}${msg.fail ? ` · 失败 ${msg.fail}` : ''}`);
    }
    if (msg.done === msg.total || msg.stopped) {
      batchBar?.setBusy(false);
      const head = msg.stopped ? '已停止' : '批量采集完成';
      toast(`${head}:成功 ${msg.ok}/${msg.total}${msg.fail ? `,失败 ${msg.fail}` : ''}${tallyText(msg.tally)}`, msg.fail ? 'err' : 'ok');
      if (msg.tally) batchBar?.setStatus(`${head} · 成功 ${msg.ok}${msg.fail ? ` · 失败 ${msg.fail}` : ''}${tallyText(msg.tally)}`);
      clearSelection();
    }
    return false;
  }
  return false;
});

/** 「模板已确认 / 待分拣 / 之前采过」的简短统计。 */
function tallyText(tally?: CollectTally): string {
  if (!tally) return '';
  const parts = [
    tally.confirmed ? `模板已确认 ${tally.confirmed}` : '',
    tally.review ? `待分拣 ${tally.review}` : '',
    tally.duplicates ? `之前采过 ${tally.duplicates}` : '',
  ].filter(Boolean);
  return parts.length ? `(${parts.join(' · ')})` : '';
}

// ---- 列表页多选状态 ----
const selected = new Set<string>(); // 选中的商品 URL
const cardHandles = new Map<string, { set: (v: boolean) => void }>(); // url -> 复选框句柄
let batchBar: BatchBar | null = null;

// 状态先初始化，再启动页面 UI 扫描；否则列表页首次 scanCards 会访问到未初始化的 selected。
if (extractor) init();

function init(): void {
  const url = location.href;
  const labels: Record<string, string> = {
    wildberries: 'Wildberries',
    aliexpress: 'AliExpress',
    allegro: 'Allegro',
    amazon: 'Amazon.de',
    asos: 'ASOS',
    george: 'George (ASDA)',
    joom: 'Joom',
    mercadolibre: 'Mercado Libre',
  };
  if (extractor!.isDetailPage(url)) {
    attachFloatingButton(async () => {
      try {
        const product = await extractor!.extractDetail();
        await collectDirect(product, '当前商品');
      } catch (e) {
        toast(`采集失败:${(e as Error).message}`, 'err');
        throw e;
      }
    });
  }
  // 列表页、以及详情页底部「More to love」等推荐卡，都注入勾选/采集按钮。
  batchBar = createBatchBar({
    onSelectAll: () => setAll(true),
    onClear: () => clearSelection(),
    onCollectSelected: () => runBatch([...selected]),
    onCollectPage: () => runBatch(currentCardUrls()),
    onStop: async () => {
      batchBar?.setStatus('停止中…');
      try {
        const res = await sendMessage({ type: 'BATCH_STOP' });
        if (!res.ok || res.type !== 'BATCH_STOP') throw new Error(res.ok ? '停止响应异常' : res.error);
        if (!res.active) {
          batchBar?.setBusy(false);
          batchBar?.setStatus('已停止');
        }
      } catch (e) {
        batchBar?.setBusy(false);
        batchBar?.setStatus(`停止失败：${(e as Error).message}`);
      }
    },
  }, labels[extractor!.id] ?? 'Joom');
  void loadPresets();
  scanCards();
  observe();
}

/** 从本地服务读取模板名称,只在采集栏展示选择项,模板内容仍由服务端统一管理。 */
async function loadPresets(): Promise<void> {
  try {
    const res = await sendMessage({ type: 'GET_PRESETS' });
    if (!res.ok || res.type !== 'GET_PRESETS') throw new Error(res.ok ? '模板响应格式错误' : res.error);
    batchBar?.setTemplates(res.templates);
  } catch (e) {
    // 模板服务暂时不可用时仍允许采集,入库后由后端推荐模板。
    batchBar?.setTemplates([]);
    batchBar?.setStatus(`模板读取失败,入库后由系统推荐模板: ${(e as Error).message.slice(0, 50)}`);
  }
}

/** 取卡片对应的商品详情 URL,由来源平台 extractor 负责识别链接。 */
function cardUrl(card: HTMLElement): string | null {
  return extractor!.getCardUrl(card);
}

function currentCardUrls(): string[] {
  return extractor!
    .findCards()
    .map((c) => cardUrl(c))
    .filter((u): u is string => !!u && !isCurrentProductCard(u));
}

/** 详情页上指向当前商品自己的链接，不重复注入卡片按钮。 */
function isCurrentProductCard(href: string): boolean {
  if (!extractor!.isDetailPage(location.href)) return false;
  try {
    const cardPath = new URL(href, location.href).pathname.replace(/\/+$/, '');
    const pagePath = new URL(location.href).pathname.replace(/\/+$/, '');
    if (cardPath === pagePath) return true;
    const idOf = (p: string) =>
      p.match(/\/item\/(\d+)/)?.[1] ??
      p.match(/\/products\/([^/]+)/)?.[1] ??
      p.match(/\/catalog\/(\d+)/)?.[1] ??
      p.match(/\/prd\/(\d+)/)?.[1] ??
      p.match(/\/oferta\/(?:.*-)?(\d+)$/)?.[1] ??
      p.match(/MLC[-_]?(\d+)/i)?.[1];
    const a = idOf(cardPath);
    const b = idOf(pagePath);
    return Boolean(a && b && a === b);
  } catch {
    return false;
  }
}

/** 扫描卡片:注入复选框 + 单个采集按钮(均走后台开详情页提取)。 */
function scanCards(): void {
  for (const card of extractor!.findCards()) {
    if (card.hasAttribute(INJECTED_ATTR)) continue;
    const url = cardUrl(card);
    if (!url || isCurrentProductCard(url)) continue;
    card.setAttribute(INJECTED_ATTR, '1');

    const ck = attachCardCheckbox(card, selected.has(url), (checked) => {
      if (checked) selected.add(url);
      else selected.delete(url);
      batchBar?.setCount(selected.size);
    });
    cardHandles.set(url, ck);

    attachCardButton(card, async () => {
      await runBatch([url]);
    });
  }
}

function setAll(on: boolean): void {
  if (!on) return clearSelection();
  scanCards(); // 确保所有卡片都已注入复选框
  for (const url of currentCardUrls()) {
    selected.add(url);
    cardHandles.get(url)?.set(true);
  }
  batchBar?.setCount(selected.size);
}

function clearSelection(): void {
  for (const url of selected) cardHandles.get(url)?.set(false);
  selected.clear();
  batchBar?.setCount(0);
}

/** 批量采集:交给 background 逐个开详情页提取全量数据。 */
async function runBatch(urls: string[]): Promise<void> {
  const list = Array.from(new Set(urls));
  if (!list.length) {
    toast('请先勾选商品', 'err');
    return;
  }
  batchBar?.setBusy(true);
  batchBar?.setStatus(`开始采集 ${list.length} 个…`);
  toast(`开始批量采集 ${list.length} 个(后台逐个打开详情页)`, 'ok');
  try {
    const res = await sendMessage({ type: 'BATCH_COLLECT', urls: list, templateId: batchBar?.getTemplateId() });
    if (!res.ok) {
      toast(`批量采集失败:${res.error}`, 'err');
      batchBar?.setBusy(false);
    } else if (res.type === 'BATCH_COLLECT') {
      // 进度消息可能因页面重载而丢失，最终响应也必须能收起停止按钮。
      batchBar?.setBusy(false);
      batchBar?.setStatus(res.stopped ? '已停止' : `采集完成 · 成功 ${res.okCount}${res.fail ? ` · 失败 ${res.fail}` : ''}${tallyText(res.tally)}`);
    }
    // 成功进度由 BATCH_PROGRESS 通知收尾
  } catch (e) {
    toast(`批量采集失败:${(e as Error).message}`, 'err');
    batchBar?.setBusy(false);
  }
}

/** 详情页单个采集:当前页直接提取上报。 */
async function collectDirect(product: CollectedProduct | null, label: string): Promise<void> {
  if (!product || !product.title) {
    toast(`未能识别${label}信息,可能页面结构有变`, 'err');
    throw new Error('extract failed');
  }
  const res = await sendMessage({ type: 'COLLECT_PRODUCT', product, templateId: batchBar?.getTemplateId() });
  if (res.ok && res.type === 'COLLECT_PRODUCT') {
    const title = `${product.title.slice(0, 20)}…`;
    if (res.duplicate) toast(`之前采过:${title}`, 'ok');
    else if (res.template?.confirmed) toast(`已采集:${title} · 模板已确认`, 'ok');
    else if (res.template?.issues.length) toast(`已采集:${title} · 待分拣:${res.template.issues[0]}`, 'ok');
    else toast(`已采集:${title} · 到采集箱分拣`, 'ok');
  } else {
    toast(`采集失败:${res.ok ? '未知' : res.error}`, 'err');
    throw new Error('collect failed');
  }
}

/** 监听懒加载/翻页新增的卡片 */
function observe(): void {
  let scheduled = false;
  const mo = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      scanCards();
    }, 400);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // 部分平台会先渲染页面框架，再异步填充商品卡片；仅依赖 MutationObserver
  // 在部分版本的页面上会漏掉后续卡片，因此在列表页加载阶段补充短时重试。
  let retries = 0;
  const retryTimer = window.setInterval(() => {
    scanCards();
    retries += 1;
    // Wildberries 搜索页是延迟渲染的 SPA,不能在扫到第一张卡后就停。
    if (retries >= 40) window.clearInterval(retryTimer);
  }, 500);

  // 列表使用虚拟滚动时，新卡片可能只在滚动后进入 DOM。
  window.addEventListener('scroll', scanCards, { passive: true });
}

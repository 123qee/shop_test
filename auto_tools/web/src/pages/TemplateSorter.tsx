import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { GroupTemplateBinding, PresetTemplate, ProductRecord, TemplateDecisionResult } from '@shared/types';
import { groupLabel, materialLabel } from '@shared/product-grouping';
import { productSizeEntries, reviewTemplates, templateTraits, type TemplateReview, type TemplateTraits } from '@shared/template-fit';
import { api } from '../api';
import { fallbackToAllegroOriginal, sizedImageSource } from '../image-utils';
import { addProductsToActionList, readProductActionLists, removeProductsFromActionList, type ProductActionListKind } from '../product-action-lists';
import { groupingOf } from './ProductGroupingPanel';

const SORTABLE_STATUSES = new Set<ProductRecord['status']>(['collected', 'edited', 'failed']);

/** 需要分拣的商品：模板还没确认，并且现在可以修改（未发布、未废弃、不在发布队列里）。 */
export function needsTemplateDecision(p: ProductRecord, activeIds?: Set<string>): boolean {
  return !p.templateConfirmed && SORTABLE_STATUSES.has(p.status) && !activeIds?.has(p.id);
}

interface QueueItem {
  product: ProductRecord;
  review: TemplateReview;
}

/** 同一建议的商品排在一起，有把握且建议就是当前模板的排最前，节奏最快。 */
function buildQueue(products: ProductRecord[], templates: PresetTemplate[], bindings: GroupTemplateBinding[], activeIds: Set<string>): QueueItem[] {
  const order = new Map(templates.map((t, index) => [t.id, index]));
  const rank = (item: QueueItem) => {
    const suggestion = item.review.suggestion;
    if (!suggestion) return 3;
    if (suggestion.confidence !== 'high') return 2;
    return suggestion.templateId === item.product.templateId ? 0 : 1;
  };
  return products
    .filter((product) => needsTemplateDecision(product, activeIds))
    .map((product) => ({
      product,
      review: reviewTemplates(product.collected, templates, { grouping: groupingOf(product), bindings, preferredId: product.templateId }),
    }))
    .sort((a, b) => {
      const ta = a.review.suggestion ? order.get(a.review.suggestion.templateId) ?? 98 : 99;
      const tb = b.review.suggestion ? order.get(b.review.suggestion.templateId) ?? 98 : 99;
      return ta - tb || rank(a) - rank(b) || b.product.createdAt.localeCompare(a.product.createdAt);
    });
}

interface Decision {
  status: 'saving' | 'saved' | 'error';
  templateId: string;
  action?: TemplateDecisionResult['action'];
}

/** 分拣出去的去向：发布清单、删除清单，或本地废弃箱。 */
type Parked = ProductActionListKind | 'discard';
const PARKED_LABEL: Record<Parked, string> = { publish: '发布清单', remove: '删除清单', discard: '废弃箱' };

/** 撤销栈的一项：一次套模板、一次进清单、或一次删图。Z 从最后一项开始撤销。key 唯一，用来对应异步保存的结果。 */
interface HistoryEntry {
  key: number;
  id: string;
  kind: 'decision' | 'park' | 'image';
}

interface SorterState {
  index: number;
  decisions: Record<string, Decision>;
  skipped: Record<string, true>;
  /** 按发生顺序排列，撤销从最后一项开始。废弃不进这里，不能撤销。 */
  history: HistoryEntry[];
  /** 本轮已离开待分拣队列的商品：进了发布清单、删除清单，或移入废弃箱。 */
  parked: Record<string, Parked>;
  /** 服务端返回的最新记录，用来显示当前模板。 */
  latest: Record<string, ProductRecord>;
  finished: boolean;
}

type SorterAction =
  | { type: 'decide'; id: string; templateId: string; key: number }
  | { type: 'saved'; record: ProductRecord; templateId: string; action: Decision['action'] }
  | { type: 'failed'; id: string; templateId: string; key: number }
  | { type: 'undone'; record: ProductRecord; entry: HistoryEntry }
  | { type: 'parked'; id: string; kind: Parked; key: number; record?: ProductRecord }
  | { type: 'unparked'; id: string; key: number }
  | { type: 'pushHistory'; entry: HistoryEntry }
  | { type: 'dropHistory'; key: number }
  | { type: 'latest'; record: ProductRecord }
  | { type: 'skip' }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'reviewSkipped' };

function makeReducer(ids: string[]) {
  const isOpen = (s: SorterState, id: string) => (!s.decisions[id] || s.decisions[id].status === 'error') && !s.skipped[id] && !s.parked[id];
  const advance = (s: SorterState): SorterState => {
    for (let i = s.index + 1; i < ids.length; i++) if (isOpen(s, ids[i])) return { ...s, index: i, finished: false };
    for (let i = 0; i <= s.index && i < ids.length; i++) if (isOpen(s, ids[i])) return { ...s, index: i, finished: false };
    return { ...s, finished: true };
  };
  const focus = (s: SorterState, id: string): SorterState => {
    const index = ids.indexOf(id);
    return index < 0 ? s : { ...s, index, finished: false };
  };
  return (s: SorterState, action: SorterAction): SorterState => {
    switch (action.type) {
      case 'decide': {
        const skipped = { ...s.skipped };
        delete skipped[action.id];
        return advance({
          ...s,
          skipped,
          decisions: { ...s.decisions, [action.id]: { status: 'saving', templateId: action.templateId } },
          history: [...s.history, { key: action.key, id: action.id, kind: 'decision' }],
        });
      }
      case 'saved':
        return {
          ...s,
          decisions: { ...s.decisions, [action.record.id]: { status: 'saved', templateId: action.templateId, action: action.action } },
          latest: { ...s.latest, [action.record.id]: action.record },
        };
      case 'failed': {
        // 保存失败的这一步不会在服务端留下记录，不能撤销，从栈里去掉。
        const next = {
          ...s,
          decisions: { ...s.decisions, [action.id]: { status: 'error' as const, templateId: action.templateId } },
          history: s.history.filter((entry) => entry.key !== action.key),
        };
        return s.finished ? focus(next, action.id) : next;
      }
      case 'undone': {
        const { record, entry } = action;
        const decisions = { ...s.decisions };
        if (entry.kind === 'decision') {
          // 同一件改过两次时，撤销后回到第一次的确认结果。
          if (record.templateConfirmed && record.templateId) decisions[record.id] = { status: 'saved', templateId: record.templateId, action: 'confirmed' };
          else delete decisions[record.id];
        }
        return focus({
          ...s,
          decisions,
          history: s.history.filter((item) => item.key !== entry.key),
          latest: { ...s.latest, [record.id]: record },
        }, record.id);
      }
      case 'parked': {
        const skipped = { ...s.skipped };
        delete skipped[action.id];
        const next: SorterState = {
          ...s,
          skipped,
          parked: { ...s.parked, [action.id]: action.kind },
          // 废弃不能撤销，这件的历史全部去掉；进清单的可以用 Z 撤销（会同时移出清单）。
          history: action.kind === 'discard'
            ? s.history.filter((entry) => entry.id !== action.id)
            : [...s.history, { key: action.key, id: action.id, kind: 'park' }],
          latest: action.record ? { ...s.latest, [action.record.id]: action.record } : s.latest,
        };
        return ids[s.index] === action.id ? advance(next) : next;
      }
      case 'unparked': {
        const parked = { ...s.parked };
        delete parked[action.id];
        return focus({ ...s, parked, history: s.history.filter((entry) => entry.key !== action.key) }, action.id);
      }
      case 'pushHistory':
        return { ...s, history: [...s.history, action.entry] };
      case 'dropHistory':
        return { ...s, history: s.history.filter((entry) => entry.key !== action.key) };
      case 'latest':
        return { ...s, latest: { ...s.latest, [action.record.id]: action.record } };
      case 'skip':
        return s.finished || !ids[s.index] ? s : advance({ ...s, skipped: { ...s.skipped, [ids[s.index]]: true } });
      case 'move':
        return { ...s, index: Math.min(ids.length - 1, Math.max(0, s.index + action.delta)), finished: false };
      case 'reviewSkipped': {
        const first = ids.findIndex((id) => s.skipped[id]);
        return first < 0 ? s : { ...s, skipped: {}, index: first, finished: false };
      }
    }
  };
}

const MATRIX_ROWS = [
  { key: 'adult-short', label: '成人 · 短袖' },
  { key: 'kids-short', label: '童装 · 短袖' },
  { key: 'adult-sweat', label: '成人 · 卫衣' },
  { key: 'kids-sweat', label: '童装 · 卫衣' },
];
const rowKeyOf = (traits: TemplateTraits) => (traits.audience && traits.kind ? `${traits.audience}-${traits.kind}` : 'other');
const COLOR_KEY = /colou?r|颜色|色|цвет|kolor|couleur/i;

function imagesOf(p: ProductRecord): string[] {
  return p.edited?.images?.length ? p.edited.images : p.collected.images;
}

export function TemplateSorter(props: {
  products: ProductRecord[];
  templates: PresetTemplate[];
  bindings: GroupTemplateBinding[];
  /** 不参与分拣的商品：发布中，或已在发布/删除清单里。 */
  activeIds: Set<string>;
  /** 清单按店铺分开保存，写入时用同一个范围。 */
  scope: string;
  /** updated：本次分拣改动过的商品（服务端返回的最新记录），列表据此就地更新。 */
  onClose: (updated: ProductRecord[]) => void;
}) {
  const { templates, scope } = props;
  const [queue] = useState(() => buildQueue(props.products, templates, props.bindings, props.activeIds));
  const ids = useMemo(() => queue.map((item) => item.product.id), [queue]);
  const reducer = useMemo(() => makeReducer(ids), [ids]);
  const [state, dispatch] = useReducer(reducer, undefined, (): SorterState => ({
    index: 0, decisions: {}, skipped: {}, history: [], parked: {}, latest: {}, finished: ids.length === 0,
  }));
  const [imageIndex, setImageIndex] = useState(0);
  /** 主图加载完成的地址，用来决定是否显示“加载图片…”。 */
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [closing, setClosing] = useState(false);
  /** 拖动缩略图调整顺序时：正在拖的那张，以及鼠标悬停的目标位置。 */
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 每件商品同一时间只有一个进行中的保存（按商品 id）。 */
  const pending = useRef(new Map<string, Promise<void>>());
  /** 每个撤销栈项的保存结果（按 key）：撤销前要确认这一步确实保存成功了。 */
  const outcomes = useRef(new Map<number, 'saved' | 'error'>());
  const keySeq = useRef(0);
  const nextKey = () => {
    keySeq.current += 1;
    return keySeq.current;
  };
  /** 同步记录服务端返回的最新商品，关闭时交给列表（state 可能还没来得及重新渲染）。 */
  const updated = useRef(new Map<string, ProductRecord>());
  const undoBusy = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const numbered = useMemo(() => templates.map((template, index) => ({ template, number: index + 1, traits: templateTraits(template) })), [templates]);
  const rows = useMemo(() => {
    const known = MATRIX_ROWS.map((row) => ({ ...row, items: numbered.filter((x) => rowKeyOf(x.traits) === row.key) })).filter((row) => row.items.length);
    const others = numbered.filter((x) => !MATRIX_ROWS.some((row) => row.key === rowKeyOf(x.traits)));
    return others.length ? [...known, { key: 'other', label: '其他', items: others }] : known;
  }, [numbered]);
  const nameOf = (id?: string) => templates.find((t) => t.id === id)?.name;

  const item = state.finished ? undefined : queue[state.index];
  const product = item ? state.latest[item.product.id] ?? item.product : undefined;
  const decision = item ? state.decisions[item.product.id] : undefined;
  const suggestion = item?.review.suggestion;
  const images = product ? imagesOf(product) : [];
  const shownImage = images[Math.min(imageIndex, Math.max(0, images.length - 1))];
  const shownSrc = shownImage ? sizedImageSource(shownImage, 'preview') : undefined;

  const decisionList = Object.values(state.decisions);
  const settledCount = new Set([
    ...Object.keys(state.parked),
    ...Object.keys(state.decisions).filter((id) => state.decisions[id].status !== 'error'),
  ]).size;
  const confirmedCount = decisionList.filter((d) => d.status === 'saved' && d.action === 'confirmed').length;
  const changedCount = decisionList.filter((d) => d.status === 'saved' && d.action === 'changed').length;
  const errorCount = decisionList.filter((d) => d.status === 'error').length;
  const skippedCount = Object.keys(state.skipped).length;
  const parkedList = Object.values(state.parked);
  const publishCount = parkedList.filter((k) => k === 'publish').length;
  const removeCount = parkedList.filter((k) => k === 'remove').length;
  const discardCount = parkedList.filter((k) => k === 'discard').length;

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    return () => { document.body.style.overflow = previous; };
  }, []);

  useEffect(() => { setImageIndex(0); }, [item?.product.id]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.tone === 'error' ? 9000 : 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 预加载后面几件的主图，切换时不用等图片。Image 对象要留住引用，否则可能在加载完成前被回收。
  const preloaded = useRef(new Map<string, HTMLImageElement>());
  useEffect(() => {
    const keep = new Map<string, HTMLImageElement>();
    for (const next of queue.slice(state.index + 1, state.index + 4)) {
      const src = imagesOf(next.product)[0];
      if (!src) continue;
      const url = sizedImageSource(src, 'preview');
      const img = preloaded.current.get(url) ?? new Image();
      if (!img.src) img.src = url;
      keep.set(url, img);
    }
    preloaded.current = keep;
  }, [queue, state.index]);

  /** 写入本地清单（与列表页共用同一份数据，互斥：进发布清单会移出删除清单，反之亦然）。 */
  function putInList(kind: ProductActionListKind, id: string) {
    addProductsToActionList(readProductActionLists(scope), kind, [id], scope);
  }
  function takeOutOfList(kind: ProductActionListKind, id: string) {
    removeProductsFromActionList(readProductActionLists(scope), kind, [id], scope);
  }

  /** 套模板并保存；then 为 publish 时保存成功后再加入发布清单。 */
  function decide(templateId: string, then?: 'publish') {
    const s = stateRef.current;
    const current = s.finished ? undefined : queue[s.index];
    if (!current) return;
    const id = current.product.id;
    const parked = s.parked[id];
    if (parked) {
      setNotice({ tone: 'info', text: `这件已在${PARKED_LABEL[parked]}，不能再套模板` });
      return;
    }
    if (s.decisions[id]?.status === 'saving') return;
    const key = nextKey();
    dispatch({ type: 'decide', id, templateId, key });
    const task = api.decideTemplate(id, templateId)
      .then((res) => {
        updated.current.set(id, res.record);
        outcomes.current.set(key, 'saved');
        dispatch({ type: 'saved', record: res.record, templateId, action: res.action });
        if (then) {
          putInList(then, id);
          dispatch({ type: 'parked', id, kind: then, key: nextKey() });
          setNotice({ tone: 'info', text: `「${current.product.collected.title.slice(0, 24)}」已确认模板，加入发布清单` });
        }
      })
      .catch((error: Error) => {
        outcomes.current.set(key, 'error');
        dispatch({ type: 'failed', id, templateId, key });
        setNotice({ tone: 'error', text: `「${current.product.collected.title.slice(0, 24)}」保存失败：${error.message}。这件还留在队列里。` });
      })
      .finally(() => pending.current.delete(id));
    pending.current.set(id, task);
  }

  /** Enter：按建议（或已选的模板）确认，并加入发布清单。 */
  function sendToPublish() {
    const s = stateRef.current;
    const current = s.finished ? undefined : queue[s.index];
    if (!current) return;
    const id = current.product.id;
    const parked = s.parked[id];
    if (parked) {
      setNotice({ tone: 'info', text: `这件已在${PARKED_LABEL[parked]}，按 Z 可以撤销` });
      return;
    }
    const existing = s.decisions[id];
    if (existing?.status === 'saving') return;
    if (existing?.status === 'saved') {
      // 已经在本轮确认过模板，直接加入发布清单。
      putInList('publish', id);
      dispatch({ type: 'parked', id, kind: 'publish', key: nextKey() });
      setNotice({ tone: 'info', text: `「${current.product.collected.title.slice(0, 24)}」已加入发布清单` });
      return;
    }
    const target = current.review.suggestion?.templateId;
    if (!target) {
      setNotice({ tone: 'info', text: '这件没有合适的模板：按数字键选一个再按 Enter，或按 X 加入删除清单' });
      return;
    }
    decide(target, 'publish');
  }

  /** X：加入删除清单。只改本地清单，不动模板，之后可在删除清单里统一处理。 */
  function sendToRemove() {
    const s = stateRef.current;
    const current = s.finished ? undefined : queue[s.index];
    if (!current) return;
    const id = current.product.id;
    const parked = s.parked[id];
    if (parked) {
      setNotice({ tone: 'info', text: `这件已在${PARKED_LABEL[parked]}，按 Z 可以撤销` });
      return;
    }
    if (s.decisions[id]?.status === 'saving' || pending.current.has(id)) return;
    putInList('remove', id);
    dispatch({ type: 'parked', id, kind: 'remove', key: nextKey() });
    setNotice({ tone: 'info', text: `「${current.product.collected.title.slice(0, 24)}」已加入删除清单，按 Z 可以撤销` });
  }

  /** 移入废弃箱：只改本地状态，可在废弃箱恢复，不能用 Z 撤销。 */
  function discard() {
    const s = stateRef.current;
    const current = s.finished ? undefined : queue[s.index];
    if (!current) return;
    const id = current.product.id;
    if (s.parked[id]) return;
    // 正在保存中（套模板或废弃）的商品先不动，等结果回来再说。
    if (pending.current.has(id)) return;
    const name = current.product.collected.title.slice(0, 24);
    const task = api.discardProduct(id)
      .then((record) => {
        updated.current.set(id, record);
        dispatch({ type: 'parked', id, kind: 'discard', key: nextKey(), record });
        setNotice({ tone: 'info', text: `「${name}」已移入废弃箱，可在废弃箱里恢复` });
      })
      .catch((error: Error) => {
        setNotice({ tone: 'error', text: `「${name}」移入废弃箱失败：${error.message}。这件还留在队列里。` });
      })
      .finally(() => pending.current.delete(id));
    pending.current.set(id, task);
  }

  /** D：删除当前显示的这张图（只改可编辑草稿，与编辑页删除一致）。已进清单或正在保存的商品先不动。 */
  function deleteImage() {
    const s = stateRef.current;
    const current = s.finished ? undefined : queue[s.index];
    if (!current) return;
    const id = current.product.id;
    const parked = s.parked[id];
    if (parked) {
      setNotice({ tone: 'info', text: `这件已在${PARKED_LABEL[parked]}，不能再删图片` });
      return;
    }
    if (pending.current.has(id)) {
      setNotice({ tone: 'info', text: '这件正在保存，稍等一下再删图' });
      return;
    }
    if (!shownImage) {
      setNotice({ tone: 'info', text: '这件没有图片可以删' });
      return;
    }
    // 删图入栈，Z 可以撤销；保存失败时从栈里去掉。
    const key = nextKey();
    dispatch({ type: 'pushHistory', entry: { key, id, kind: 'image' } });
    const task = api.deleteProductImage(id, shownImage)
      .then((record) => {
        updated.current.set(id, record);
        outcomes.current.set(key, 'saved');
        dispatch({ type: 'latest', record });
        setNotice({ tone: 'info', text: `已删除这张图，还剩 ${imagesOf(record).length} 张，按 Z 可以撤销` });
      })
      .catch((error: Error) => {
        outcomes.current.set(key, 'error');
        dispatch({ type: 'dropHistory', key });
        setNotice({ tone: 'error', text: `删除图片失败：${error.message}` });
      })
      .finally(() => pending.current.delete(id));
    pending.current.set(id, task);
  }

  /** 拖动缩略图：把 from 位置的图移到 to 位置（只改可编辑草稿，第一张为主图）。已进清单或正在保存的商品先不动。 */
  function reorderImages(from: number, to: number) {
    const s = stateRef.current;
    const current = s.finished ? undefined : queue[s.index];
    if (!current || from === to) return;
    const id = current.product.id;
    const parked = s.parked[id];
    if (parked) {
      setNotice({ tone: 'info', text: `这件已在${PARKED_LABEL[parked]}，不能再调整图片顺序` });
      return;
    }
    if (pending.current.has(id)) {
      setNotice({ tone: 'info', text: '这件正在保存，稍等一下再调整顺序' });
      return;
    }
    const list = imagesOf(s.latest[id] ?? current.product);
    if (from < 0 || to < 0 || from >= list.length || to >= list.length) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const task = api.reorderProductImages(id, next)
      .then((record) => {
        updated.current.set(id, record);
        dispatch({ type: 'latest', record });
        // 大图跟着被拖动的那张走；若期间已切到别的商品，就不动当前的大图位置。
        if (queue[stateRef.current.index]?.product.id === id) setImageIndex(to);
        setNotice({ tone: 'info', text: to === 0 ? '已调整顺序，这张现在是主图' : '已调整图片顺序' });
      })
      .catch((error: Error) => {
        setNotice({ tone: 'error', text: `调整图片顺序失败：${error.message}` });
      })
      .finally(() => pending.current.delete(id));
    pending.current.set(id, task);
  }

  /** Z：撤销栈顶的一步。清单操作只改本地；套模板和删图要等保存完成，再由服务端按同样的顺序撤销。 */
  async function undo() {
    if (undoBusy.current) return;
    const top = stateRef.current.history[stateRef.current.history.length - 1];
    if (!top) {
      setNotice({ tone: 'info', text: '没有可以撤销的操作' });
      return;
    }
    undoBusy.current = true;
    try {
      if (top.kind === 'park') {
        const list = stateRef.current.parked[top.id];
        // 进过清单的，先把它从清单里移出来。
        if (list === 'publish' || list === 'remove') takeOutOfList(list, top.id);
        dispatch({ type: 'unparked', id: top.id, key: top.key });
        if (list) setNotice({ tone: 'info', text: `已撤销，这件已从${PARKED_LABEL[list]}移出` });
        return;
      }
      // 这一步还在保存中：等它结束。保存失败的已经从栈里去掉，这里直接跳过。
      await pending.current.get(top.id);
      if (outcomes.current.get(top.key) !== 'saved') {
        setNotice({ tone: 'error', text: '上一步没有保存成功，已取消，没有撤销任何东西' });
        return;
      }
      const res = await api.undoTemplateDecision(top.id);
      updated.current.set(top.id, res.record);
      outcomes.current.delete(top.key);
      dispatch({ type: 'undone', record: res.record, entry: top });
      setNotice({ tone: 'info', text: top.kind === 'image' ? '已撤销删图，图片已恢复' : '已撤销，回到这件商品' });
    } catch (error) {
      setNotice({ tone: 'error', text: `撤销失败：${(error as Error).message}` });
    } finally {
      undoBusy.current = false;
    }
  }

  async function close() {
    if (closing) return;
    setClosing(true);
    await Promise.allSettled([...pending.current.values()]);
    props.onClose([...updated.current.values()]);
  }

  function stepImage(delta: number) {
    if (images.length < 2) return;
    setImageIndex((index) => (Math.min(index, images.length - 1) + delta + images.length) % images.length);
  }

  // 键盘处理器每次渲染更新，监听只注册一次，避免读到旧状态。
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (event) => {
    if (event.isComposing) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target && (target.isContentEditable || target.closest('input, textarea, select'))) return;
    const { key } = event;
    if (key === 'Escape') { event.preventDefault(); void close(); return; }
    if ((key === 'z' || key === 'Z') && !event.altKey && !event.shiftKey) { event.preventDefault(); void undo(); return; }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (key === 'Enter') { event.preventDefault(); if (!event.repeat) sendToPublish(); return; }
    if (/^[1-9]$/.test(key)) {
      event.preventDefault();
      const template = templates[Number(key) - 1];
      if (template && !event.repeat) decide(template.id);
      return;
    }
    if (key === 'ArrowLeft') { event.preventDefault(); stepImage(-1); return; }
    if (key === 'ArrowRight') { event.preventDefault(); stepImage(1); return; }
    if (key === 's' || key === 'S') { event.preventDefault(); dispatch({ type: 'skip' }); return; }
    if (key === 'x' || key === 'X') { event.preventDefault(); sendToRemove(); return; }
    if (key === 'd' || key === 'D') { event.preventDefault(); deleteImage(); return; }
    if (key === 'ArrowUp') { event.preventDefault(); dispatch({ type: 'move', delta: -1 }); return; }
    if (key === 'ArrowDown') { event.preventDefault(); dispatch({ type: 'move', delta: 1 }); }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const grouping = product ? groupingOf(product) : undefined;
  const sizes = product ? [...new Set(productSizeEntries(product.collected).map((entry) => entry.value))] : [];
  const colorCount = product
    ? new Set(product.collected.variants.flatMap((v) => Object.entries(v.options ?? {}).filter(([k]) => COLOR_KEY.test(k)).map(([, value]) => value))).size
    : 0;
  const currentTemplateId = decision && decision.status !== 'error' ? decision.templateId : product?.templateId;
  const currentIssues = item?.review.fits.find((fit) => fit.templateId === product?.templateId)?.issues ?? [];
  const currentKnown = Boolean(product?.templateId && nameOf(product.templateId));

  return (
    <div className="template-sorter" role="dialog" aria-modal="true" aria-label="分拣模板" ref={dialogRef} tabIndex={-1}>
      <div className="template-sorter-dialog">
        <header className="template-sorter-head">
          <div>
            <strong>分拣模板</strong>
            <span>
              {queue.length
                ? `${state.finished ? '已看完' : `第 ${state.index + 1} / ${queue.length} 件`} · 已处理 ${settledCount}${skippedCount ? ` · 跳过 ${skippedCount}` : ''}${errorCount ? ` · 保存失败 ${errorCount}` : ''}`
                : '没有待确认模板的商品'}
              {publishCount ? ` · 发布清单 ${publishCount}` : ''}
              {removeCount ? ` · 删除清单 ${removeCount}` : ''}
              {discardCount ? ` · 废弃 ${discardCount}` : ''}
            </span>
          </div>
          <button type="button" className="ghost" onClick={() => void close()} disabled={closing}>{closing ? '正在保存…' : '退出 Esc'}</button>
        </header>
        <div className="template-sorter-progress" aria-hidden="true"><i style={{ width: `${queue.length ? (settledCount / queue.length) * 100 : 100}%` }} /></div>
        {notice && <div className={`template-sorter-notice ${notice.tone}`} role="status">{notice.text}</div>}

        {!item || !product ? (
          <div className="template-sorter-done">
            <strong>{queue.length ? '这一轮分完了' : '没有需要分拣的商品'}</strong>
            {queue.length > 0 && (
              <p>
                确认 {confirmedCount} 件，换模板 {changedCount} 件
                {publishCount ? `，进发布清单 ${publishCount} 件` : ''}
                {removeCount ? `，进删除清单 ${removeCount} 件` : ''}
                {discardCount ? `，移入废弃箱 ${discardCount} 件` : ''}
                {skippedCount ? `，跳过 ${skippedCount} 件` : ''}
                {errorCount ? `，${errorCount} 件保存失败` : ''}。
              </p>
            )}
            <div>
              {skippedCount > 0 && <button type="button" className="ghost" onClick={() => dispatch({ type: 'reviewSkipped' })}>回头看跳过的 {skippedCount} 件</button>}
              <button type="button" onClick={() => void close()} disabled={closing}>完成</button>
            </div>
            {state.history.length > 0 && <small>按 Z 可以撤销上一件</small>}
          </div>
        ) : (
          <div className="template-sorter-body">
            <section className="template-sorter-media" aria-label="商品图片">
              <div className="template-sorter-main-image">
                {shownSrc
                  // 换商品时重建 img，避免短暂显示上一件的图；同一件切图时保留旧图，直到新图加载完。
                  ? <img
                      key={product.id}
                      src={shownSrc}
                      alt=""
                      decoding="async"
                      onLoad={() => setLoadedSrc(shownSrc)}
                      onError={(e) => { setLoadedSrc(shownSrc); fallbackToAllegroOriginal(e.currentTarget); }}
                    />
                  : <span className="muted">无图</span>}
                {shownSrc && loadedSrc !== shownSrc && <em className="template-sorter-loading">加载图片…</em>}
                {shownImage && (
                  <button
                    type="button"
                    className="template-sorter-image-delete"
                    onClick={() => { deleteImage(); dialogRef.current?.focus(); }}
                    title="删除这张图（只改草稿，采集原图保留）"
                  >
                    删除这张图 <kbd>D</kbd>
                  </button>
                )}
                {images.length > 1 && <em>{Math.min(imageIndex, images.length - 1) + 1} / {images.length} · ←/→ 切换</em>}
              </div>
              {images.length > 1 && (
                <div className="template-sorter-thumbs" role="group" aria-label="拖动可调整图片顺序" title="拖动可调整顺序，第一张为主图">
                  {images.map((src, index) => {
                    const classes = [
                      index === imageIndex ? 'on' : '',
                      dragIndex === index ? 'dragging' : '',
                      dropIndex === index && dragIndex !== null && dragIndex !== index ? 'drop' : '',
                    ].filter(Boolean).join(' ');
                    return (
                      <button
                        key={`${src}-${index}`}
                        type="button"
                        className={classes}
                        draggable
                        onClick={() => setImageIndex(index)}
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move';
                          // Firefox 要求写入数据才会开始拖动。
                          e.dataTransfer.setData('text/plain', String(index));
                          setDragIndex(index);
                        }}
                        onDragOver={(e) => {
                          if (dragIndex === null) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          if (dropIndex !== index) setDropIndex(index);
                        }}
                        onDrop={(e) => {
                          if (dragIndex === null) return;
                          e.preventDefault();
                          reorderImages(dragIndex, index);
                          setDragIndex(null);
                          setDropIndex(null);
                        }}
                        onDragEnd={() => { setDragIndex(null); setDropIndex(null); }}
                        aria-label={`第 ${index + 1} 张图${index === 0 ? '（主图）' : ''}`}
                      >
                        <img src={sizedImageSource(src, 'thumb')} alt="" loading="lazy" decoding="async" draggable={false} onError={(e) => fallbackToAllegroOriginal(e.currentTarget)} />
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="template-sorter-info">
              <div className="template-sorter-title">{product.collected.title}</div>
              {product.edited?.title && product.edited.title !== product.collected.title && (
                <div className="template-sorter-subtitle">改后标题：{product.edited.title}</div>
              )}
              <div className="template-sorter-meta">
                {grouping && <span>{groupLabel(grouping.groupId)} · {materialLabel(grouping.material)}</span>}
                {colorCount > 0 && <span>{colorCount} 个颜色</span>}
                <Link to={`/products/${product.id}`} target="_blank" rel="noopener noreferrer">编辑页</Link>
                <a href={product.collected.sourceUrl} target="_blank" rel="noopener noreferrer">原商品</a>
              </div>
              {sizes.length > 0 && (
                <div className="template-sorter-sizes" aria-label="采集到的尺码">
                  {sizes.slice(0, 14).map((size) => <span key={size}>{size}</span>)}
                  {sizes.length > 14 && <span>+{sizes.length - 14}</span>}
                </div>
              )}

              <div className={`template-sorter-current ${decision && decision.status !== 'error' ? 'decided' : currentIssues.length || !currentKnown ? 'warn' : 'ok'}`}>
                {decision && decision.status !== 'error' ? (
                  <p><b>已定为「{nameOf(currentTemplateId) ?? '未知模板'}」</b>{decision.status === 'saving' ? ' · 保存中…' : ''}。按其他数字可以改。</p>
                ) : (
                  <>
                    <p>当前模板：<b>{nameOf(product.templateId) ?? (product.templateId ? '已删除的模板' : '未指定')}</b></p>
                    {currentIssues.length > 0
                      ? <ul>{currentIssues.map((issue) => <li key={issue.message}>{issue.message}</li>)}</ul>
                      : currentKnown && <small>和商品没有发现矛盾</small>}
                    {decision?.status === 'error' && <small className="error">上次保存失败，请重新选择</small>}
                  </>
                )}
              </div>

              <div className={`template-sorter-suggestion ${suggestion ? suggestion.confidence : 'none'}`}>
                {suggestion ? (
                  <>
                    <p>
                      建议：<b>{nameOf(suggestion.templateId)}</b>
                      <span className="chip">{suggestion.confidence === 'high' ? '有把握' : '要看图确认'}</span>
                      <kbd>Enter</kbd>
                    </p>
                    {suggestion.reasons.length > 0 && <ul>{suggestion.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
                    {suggestion.note && <small>提示：{suggestion.note}</small>}
                  </>
                ) : (
                  <p>没有合适的模板，可能不是短袖或卫衣。按数字键选一个再按 Enter，或按 X 加入删除清单。</p>
                )}
              </div>

              <div className="template-sorter-matrix" role="group" aria-label="选择模板">
                {rows.map((row) => (
                  <div className="template-sorter-row" key={row.key}>
                    <span>{row.label}</span>
                    <div>
                      {row.items.map(({ template, number }) => {
                        const issues = item.review.fits.find((fit) => fit.templateId === template.id)?.issues ?? [];
                        const classes = [
                          'template-sorter-option',
                          suggestion?.templateId === template.id ? 'suggested' : '',
                          currentTemplateId === template.id ? 'current' : '',
                          issues.length ? 'conflict' : '',
                        ].filter(Boolean).join(' ');
                        return (
                          <button
                            key={template.id}
                            type="button"
                            className={classes}
                            onClick={() => {
                              decide(template.id, 'publish');
                              // 焦点留在按钮上时，空格会把同一模板误套到下一件。
                              dialogRef.current?.focus();
                            }}
                            title={issues.length ? `与商品不符：\n${issues.map((x) => x.message).join('\n')}` : `套用「${template.name}」并确认`}
                          >
                            <span className="num">{number <= 9 ? number : '·'}</span>
                            <b>{template.name}</b>
                            {suggestion?.templateId === template.id && <small className="tag suggested">建议</small>}
                            {currentTemplateId === template.id && <small className="tag current">{decision && decision.status !== 'error' ? '已定' : '当前'}</small>}
                            {issues.length > 0 && <small className="tag conflict">不符</small>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div className="template-sorter-actions">
                <button
                  type="button"
                  className="ghost danger"
                  onClick={() => { sendToRemove(); dialogRef.current?.focus(); }}
                  title="不需要的商品：加入删除清单，不改模板。之后可以在删除清单里统一处理。"
                >
                  加入删除清单 <kbd>X</kbd>
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => { discard(); dialogRef.current?.focus(); }}
                  title="移入本地废弃箱，可在废弃箱恢复，不影响 Joom 线上商品。不能用 Z 撤销。"
                >
                  移入废弃箱
                </button>
                <button
                  type="button"
                  onClick={() => { sendToPublish(); dialogRef.current?.focus(); }}
                  title="确认模板（按建议或已选的模板）并加入发布清单。"
                >
                  加入发布清单 <kbd>Enter</kbd>
                </button>
              </div>
            </section>
          </div>
        )}

        <footer className="template-sorter-foot">
          <span><kbd>Enter</kbd> 进发布清单</span>
          <span><kbd>1</kbd>–<kbd>9</kbd> 选模板</span>
          <span><kbd>←</kbd><kbd>→</kbd> 看图</span>
          <span><kbd>D</kbd> 删这张图</span>
          <span>拖动缩略图调整顺序</span>
          <span><kbd>S</kbd> 跳过</span>
          <span><kbd>X</kbd> 进删除清单</span>
          <span><kbd>↑</kbd><kbd>↓</kbd> 上一件/下一件</span>
          <span><kbd>Z</kbd> 撤销</span>
          <span><kbd>Esc</kbd> 退出</span>
          <small>换模板和快捷模板一样：标题、SKU、图片保持不变</small>
        </footer>
      </div>
    </div>
  );
}

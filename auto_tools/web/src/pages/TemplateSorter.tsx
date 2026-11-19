import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { GroupTemplateBinding, PresetTemplate, ProductRecord, TemplateDecisionResult } from '@shared/types';
import { groupLabel, materialLabel } from '@shared/product-grouping';
import type { ProductSortCandidate } from '@shared/product-catalog';
import { productSizeEntries, reviewTemplates, templateTraits, type TemplateTraits } from '@shared/template-fit';
import { api } from '../api';
import { fallbackToAllegroOriginal, sizedImageSource } from '../image-utils';
import { addProductsToActionList, readProductActionLists, removeProductsFromActionList, type ProductActionListKind } from '../product-action-lists';
import { groupingOf } from './ProductGroupingPanel';
import { readSorterProgress, saveSorterProgress, sorterSourceName, type SorterProgress } from '../sorter-progress';

const SORTABLE_STATUSES = new Set<ProductRecord['status']>(['collected', 'edited', 'failed']);

/** 需要分拣的商品：模板还没确认，并且现在可以修改（未发布、未废弃、不在发布队列里）。 */
export function needsTemplateDecision(p: Pick<ProductRecord, 'id' | 'status' | 'templateConfirmed'>, activeIds?: Set<string>): boolean {
  return !p.templateConfirmed && SORTABLE_STATUSES.has(p.status) && !activeIds?.has(p.id);
}

/** 同一建议的商品排在一起，有把握且建议就是当前模板的排最前，节奏最快。 */
function buildQueue(products: ProductSortCandidate[], templates: PresetTemplate[], activeIds: Set<string>): ProductSortCandidate[] {
  const order = new Map(templates.map((t, index) => [t.id, index]));
  const rank = (item: ProductSortCandidate) => {
    const suggestion = item.suggestion;
    if (!suggestion) return 3;
    if (suggestion.confidence !== 'high') return 2;
    return suggestion.templateId === item.templateId ? 0 : 1;
  };
  return products
    .filter((product) => !activeIds.has(product.id))
    .sort((a, b) => {
      const ta = a.suggestion ? order.get(a.suggestion.templateId) ?? 98 : 99;
      const tb = b.suggestion ? order.get(b.suggestion.templateId) ?? 98 : 99;
      return ta - tb || rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt);
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
  kind: 'decision' | 'park' | 'image' | 'skip';
}

interface SorterState {
  source: string;
  index: number;
  choices: Record<string, string>;
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
  | { type: 'selectSource'; source: string }
  | { type: 'pick'; id: string; templateId: string }
  | { type: 'decide'; id: string; templateId: string; key: number }
  | { type: 'saved'; record: ProductRecord; templateId: string; action: Decision['action'] }
  | { type: 'failed'; id: string; templateId: string; key: number }
  | { type: 'undone'; record: ProductRecord; entry: HistoryEntry }
  | { type: 'parked'; id: string; kind: Parked; key: number; record?: ProductRecord }
  | { type: 'unparked'; id: string; key: number }
  | { type: 'pushHistory'; entry: HistoryEntry }
  | { type: 'dropHistory'; key: number }
  | { type: 'latest'; record: ProductRecord }
  | { type: 'skip'; key: number }
  | { type: 'unskip'; entry: HistoryEntry }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'reviewSkipped' };

function makeReducer(queues: Map<string, ProductSortCandidate[]>) {
  const isOpen = (s: SorterState, id: string) => (!s.decisions[id] || s.decisions[id].status === 'error') && !s.skipped[id] && !s.parked[id];
  const advance = (s: SorterState): SorterState => {
    const queue = queues.get(s.source)!;
    for (let i = s.index + 1; i < queue.length; i++) if (isOpen(s, queue[i].id)) return { ...s, index: i, finished: false };
    for (let i = 0; i <= s.index && i < queue.length; i++) if (isOpen(s, queue[i].id)) return { ...s, index: i, finished: false };
    return { ...s, finished: true };
  };
  const focus = (s: SorterState, id: string): SorterState => {
    const index = queues.get(s.source)!.findIndex((item) => item.id === id);
    return index < 0 ? s : { ...s, index, finished: false };
  };
  return (s: SorterState, action: SorterAction): SorterState => {
    const queue = queues.get(s.source)!;
    const currentId = queue[s.index]?.id;
    switch (action.type) {
      case 'selectSource':
        return advance({ ...s, source: action.source, index: -1 });
      case 'pick':
        return { ...s, choices: { ...s.choices, [action.id]: action.templateId } };
      case 'decide': {
        const skipped = { ...s.skipped };
        delete skipped[action.id];
        return {
          ...s,
          skipped,
          decisions: { ...s.decisions, [action.id]: { status: 'saving', templateId: action.templateId } },
          history: [...s.history, { key: action.key, id: action.id, kind: 'decision' }],
        };
      }
      case 'saved': {
        const choices = { ...s.choices };
        delete choices[action.record.id];
        const next: SorterState = {
          ...s,
          choices,
          decisions: { ...s.decisions, [action.record.id]: { status: 'saved', templateId: action.templateId, action: action.action } },
          parked: { ...s.parked, [action.record.id]: 'publish' },
          latest: { ...s.latest, [action.record.id]: action.record },
        };
        return currentId === action.record.id ? advance(next) : next;
      }
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
        const parked = { ...s.parked };
        if (entry.kind === 'decision') {
          delete parked[record.id];
          // 同一件改过两次时，撤销后回到第一次的确认结果。
          if (record.templateConfirmed && record.templateId) decisions[record.id] = { status: 'saved', templateId: record.templateId, action: 'confirmed' };
          else delete decisions[record.id];
        }
        return focus({
          ...s,
          decisions,
          parked,
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
        return currentId === action.id ? advance(next) : next;
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
        if (s.finished || !currentId || s.parked[currentId] || s.decisions[currentId]?.status === 'saving') return s;
        if (s.skipped[currentId]) return advance(s);
        return advance({ ...s, skipped: { ...s.skipped, [currentId]: true },
          history: [...s.history, { key: action.key, id: currentId, kind: 'skip' }] });
      case 'unskip': {
        const skipped = { ...s.skipped };
        delete skipped[action.entry.id];
        return focus({ ...s, skipped, history: s.history.filter((entry) => entry.key !== action.entry.key) }, action.entry.id);
      }
      case 'move':
        return { ...s, index: Math.min(queue.length - 1, Math.max(0, s.index + action.delta)), finished: false };
      case 'reviewSkipped': {
        const first = queue.findIndex(({ id }) => s.skipped[id]);
        if (first < 0) return s;
        const skipped = { ...s.skipped };
        for (const { id } of queue) delete skipped[id];
        const history = s.history.filter((entry) => entry.kind !== 'skip' || !s.skipped[entry.id] || skipped[entry.id]);
        return { ...s, skipped, history, index: first, finished: false };
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
  products: ProductSortCandidate[];
  templates: PresetTemplate[];
  bindings: GroupTemplateBinding[];
  /** 不参与分拣的商品：发布中，或已在发布/删除清单里。 */
  activeIds: Set<string>;
  /** 清单按店铺分开保存，写入时用同一个范围。 */
  scope: string;
  batchId?: string;
  /** updated：本次分拣改动过的商品（服务端返回的最新记录），列表据此就地更新。 */
  onClose: (updated: ProductRecord[]) => void;
}) {
  const { templates, scope, batchId } = props;
  const [checkpoint] = useState(() => readSorterProgress(scope, batchId));
  const [queues] = useState(() => {
    const all = buildQueue(props.products, templates, props.activeIds);
    const groups = new Map([['all', all]]);
    for (const item of all) {
      const source = item.source;
      const group = groups.get(source);
      if (group) group.push(item);
      else groups.set(source, [item]);
    }
    if (checkpoint?.source && !groups.has(checkpoint.source)) groups.set(checkpoint.source, []);
    return groups;
  });
  const sources = useMemo(() => [...queues.keys()].filter((source) => source !== 'all').sort(), [queues]);
  const reducer = useMemo(() => makeReducer(queues), [queues]);
  const [state, dispatch] = useReducer(reducer, checkpoint, (saved): SorterState => {
    const all = queues.get('all')!;
    const ids = new Set(all.map((item) => item.id));
    const templateIds = new Set(templates.map((t) => t.id));
    const source = saved && queues.has(saved.source) ? saved.source : 'all';
    const queue = queues.get(source)!;
    const skipped = Object.fromEntries(Object.entries(saved?.skipped ?? {}).filter(([id]) => ids.has(id)));
    const choices = Object.fromEntries(Object.entries(saved?.choices ?? {}).filter(([id, choice]) => ids.has(id) && templateIds.has(choice)));
    let index = queue.findIndex((item) => item.id === saved?.currentId);
    if (index < 0) index = queue.findIndex((item) => !skipped[item.id]);
    return { source, index: Math.max(index, 0), choices, skipped, decisions: {}, history: [], parked: {}, latest: {}, finished: index < 0 };
  });
  const queue = queues.get(state.source)!;
  const visibleIds = useMemo(() => new Set(queue.map(({ id }) => id)), [queue]);
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
  const id = item?.id;
  const lastCheckpoint = useRef<SorterProgress | null>(checkpoint);
  const warnedStorage = useRef(false);
  const completed = state.finished && queues.get('all')!.every((item) => Boolean(state.parked[item.id]));
  useEffect(() => {
    const next = completed ? null : { source: state.source, currentId: id ?? null, choices: state.choices, skipped: state.skipped };
    const saved = saveSorterProgress(scope, batchId, next, lastCheckpoint.current);
    if (saved) lastCheckpoint.current = next;
    else if (!warnedStorage.current) {
      warnedStorage.current = true;
      setNotice({ tone: 'error', text: '浏览器无法保存分拣进度，关闭后可能需要重新选择来源。' });
    }
  }, [scope, batchId, id, state.source, state.skipped, state.choices, completed]);
  const latest = id ? state.latest[id] : undefined;
  const [detail, setDetail] = useState<{ id: string; record?: ProductRecord; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!id || latest) return;
    let cancelled = false;
    setDetail(undefined);
    api.getProduct(id).then(({ record }) => {
      if (!cancelled) setDetail({ id, record });
    }).catch((error: Error) => {
      if (!cancelled) setDetail({ id, error: error.message });
    });
    return () => { cancelled = true; };
  }, [id, latest, attempt]);
  const loaded = detail?.id === id ? detail : undefined;
  const product = latest ?? loaded?.record;
  const review = useMemo(() => product && reviewTemplates(product.collected, templates, {
    grouping: groupingOf(product), bindings: props.bindings, preferredId: product.templateId,
  }), [product, templates, props.bindings]);
  const decision = item ? state.decisions[item.id] : undefined;
  const choice = item ? state.choices[item.id] : undefined;
  const suggestion = review?.suggestion;
  const images = product ? imagesOf(product) : [];
  const shownImage = images[Math.min(imageIndex, Math.max(0, images.length - 1))];
  const shownSrc = shownImage ? sizedImageSource(shownImage, 'preview') : undefined;

  const decisionIds = Object.keys(state.decisions).filter((id) => visibleIds.has(id));
  const parkedIds = Object.keys(state.parked).filter((id) => visibleIds.has(id));
  const decisionList = decisionIds.map((id) => state.decisions[id]);
  const settledCount = new Set([
    ...parkedIds,
    ...decisionIds.filter((id) => state.decisions[id].status === 'saved'),
  ]).size;
  const confirmedCount = decisionList.filter((d) => d.status === 'saved' && d.action === 'confirmed').length;
  const changedCount = decisionList.filter((d) => d.status === 'saved' && d.action === 'changed').length;
  const errorCount = decisionList.filter((d) => d.status === 'error').length;
  const skippedCount = Object.keys(state.skipped).filter((id) => visibleIds.has(id)).length;
  const parkedList = parkedIds.map((id) => state.parked[id]);
  const lastAction = state.history.filter((entry) => visibleIds.has(entry.id)).at(-1);
  const publishCount = parkedList.filter((k) => k === 'publish').length;
  const removeCount = parkedList.filter((k) => k === 'remove').length;
  const discardCount = parkedList.filter((k) => k === 'discard').length;

  useEffect(() => {
    const previous = document.body.style.overflow;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previous;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => { setImageIndex(0); }, [item?.id]);

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
      const src = next.image;
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

  function pickTemplate(templateId: string) {
    if (!product || closing || state.parked[product.id] || pending.current.has(product.id)) return;
    dispatch({ type: 'pick', id: product.id, templateId });
  }

  /** 保存的是按下确认时的商品和模板，加入清单成功后再换到下一件。 */
  function confirmAndQueue(product: ProductRecord, templateId: string) {
    const id = product.id;
    const key = nextKey();
    dispatch({ type: 'decide', id, templateId, key });
    const task = api.decideTemplate(id, templateId)
      .then((res) => {
        updated.current.set(id, res.record);
        outcomes.current.set(key, 'saved');
        putInList('publish', id);
        dispatch({ type: 'saved', record: res.record, templateId, action: res.action });
        setNotice({ tone: 'info', text: `「${product.collected.title.slice(0, 24)}」已确认模板，加入发布清单` });
      })
      .catch((error: Error) => {
        outcomes.current.set(key, 'error');
        dispatch({ type: 'failed', id, templateId, key });
        setNotice({ tone: 'error', text: `「${product.collected.title.slice(0, 24)}」保存失败：${error.message}。这件还留在队列里。` });
      })
      .finally(() => pending.current.delete(id));
    pending.current.set(id, task);
  }

  /** Enter：按建议（或已选的模板）确认，并加入发布清单。 */
  function sendToPublish() {
    const s = stateRef.current;
    if (!product || closing) return;
    const id = product.id;
    const parked = s.parked[id];
    if (parked) {
      setNotice({ tone: 'info', text: `这件已在${PARKED_LABEL[parked]}，按 Z 可以撤销` });
      return;
    }
    const existing = s.decisions[id];
    if (pending.current.has(id) || existing?.status === 'saving') return;
    const target = s.choices[id] ?? existing?.templateId ?? suggestion?.templateId;
    if (existing?.status === 'saved' && existing.templateId === target) {
      // 已经在本轮确认过模板，直接加入发布清单。
      putInList('publish', id);
      dispatch({ type: 'parked', id, kind: 'publish', key: nextKey() });
      setNotice({ tone: 'info', text: `「${product.collected.title.slice(0, 24)}」已加入发布清单` });
      return;
    }
    if (!target) {
      setNotice({ tone: 'info', text: '这件没有合适的模板：按数字键选一个再按 Enter，或按 X 加入删除清单' });
      return;
    }
    confirmAndQueue(product, target);
  }

  /** X：加入删除清单。只改本地清单，不动模板，之后可在删除清单里统一处理。 */
  function sendToRemove() {
    const s = stateRef.current;
    if (!product || closing) return;
    const id = product.id;
    const parked = s.parked[id];
    if (parked) {
      setNotice({ tone: 'info', text: `这件已在${PARKED_LABEL[parked]}，按 Z 可以撤销` });
      return;
    }
    if (s.decisions[id]?.status === 'saving' || pending.current.has(id)) return;
    putInList('remove', id);
    dispatch({ type: 'parked', id, kind: 'remove', key: nextKey() });
    setNotice({ tone: 'info', text: `「${product.collected.title.slice(0, 24)}」已加入删除清单，按 Z 可以撤销` });
  }

  /** 移入废弃箱：只改本地状态，可在废弃箱恢复，不能用 Z 撤销。 */
  function discard() {
    const s = stateRef.current;
    if (!product || closing) return;
    const id = product.id;
    if (s.parked[id]) return;
    // 正在保存中（套模板或废弃）的商品先不动，等结果回来再说。
    if (pending.current.has(id)) return;
    const name = product.collected.title.slice(0, 24);
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
    if (!product || closing) return;
    const id = product.id;
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
        setNotice({ tone: 'info', text: `「${record.collected.title.slice(0, 24)}」已删图，还剩 ${imagesOf(record).length} 张` });
      })
      .catch((error: Error) => {
        outcomes.current.set(key, 'error');
        dispatch({ type: 'dropHistory', key });
        setNotice({ tone: 'error', text: `「${product.collected.title.slice(0, 24)}」删除图片失败：${error.message}` });
      })
      .finally(() => pending.current.delete(id));
    pending.current.set(id, task);
  }

  /** 拖动缩略图：把 from 位置的图移到 to 位置（只改可编辑草稿，第一张为主图）。已进清单或正在保存的商品先不动。 */
  function reorderImages(from: number, to: number) {
    const s = stateRef.current;
    if (!product || closing || from === to) return;
    const id = product.id;
    const parked = s.parked[id];
    if (parked) {
      setNotice({ tone: 'info', text: `这件已在${PARKED_LABEL[parked]}，不能再调整图片顺序` });
      return;
    }
    if (pending.current.has(id)) {
      setNotice({ tone: 'info', text: '这件正在保存，稍等一下再调整顺序' });
      return;
    }
    const list = imagesOf(s.latest[id] ?? product);
    if (from < 0 || to < 0 || from >= list.length || to >= list.length) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const task = api.reorderProductImages(id, next)
      .then((record) => {
        updated.current.set(id, record);
        dispatch({ type: 'latest', record });
        // 大图跟着被拖动的那张走；若期间已切到别的商品，就不动当前的大图位置。
        const view = stateRef.current;
        if (!view.finished && queues.get(view.source)![view.index]?.id === id) setImageIndex(to);
        setNotice({ tone: 'info', text: `「${record.collected.title.slice(0, 24)}」${to === 0 ? '已更新主图' : '已调整图片顺序'}` });
      })
      .catch((error: Error) => {
        setNotice({ tone: 'error', text: `「${product.collected.title.slice(0, 24)}」调整图片顺序失败：${error.message}` });
      })
      .finally(() => pending.current.delete(id));
    pending.current.set(id, task);
  }

  /** Z：撤销栈顶的一步。清单操作只改本地；套模板和删图要等保存完成，再由服务端按同样的顺序撤销。 */
  async function undo() {
    if (undoBusy.current || closing) return;
    const top = lastAction;
    if (!top) {
      setNotice({ tone: 'info', text: '没有可以撤销的操作' });
      return;
    }
    undoBusy.current = true;
    try {
      if (top.kind === 'skip') {
        dispatch({ type: 'unskip', entry: top });
        setNotice({ tone: 'info', text: '已回到刚才跳过的商品' });
        return;
      }
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
      if (top.kind === 'decision') takeOutOfList('publish', top.id);
      updated.current.set(top.id, res.record);
      outcomes.current.delete(top.key);
      dispatch({ type: 'undone', record: res.record, entry: top });
      setNotice({ tone: 'info', text: `「${res.record.collected.title.slice(0, 24)}」${top.kind === 'image' ? '已恢复图片' : '已撤销模板确认并移出发布清单'}` });
    } catch (error) {
      setNotice({ tone: 'error', text: `撤销失败：${(error as Error).message}` });
    } finally {
      undoBusy.current = false;
    }
  }

  async function close() {
    if (closing) return;
    if (undoBusy.current) {
      setNotice({ tone: 'info', text: '正在撤销，请稍候再退出' });
      return;
    }
    setClosing(true);
    await Promise.allSettled([...pending.current.values()]);
    props.onClose([...updated.current.values()]);
  }

  function stepImage(delta: number) {
    if (images.length < 2) return;
    setImageIndex((index) => (Math.min(index, images.length - 1) + delta + images.length) % images.length);
  }

  function skipCurrent() {
    if (!closing && id && !pending.current.has(id)) dispatch({ type: 'skip', key: nextKey() });
  }

  // 键盘处理器每次渲染更新，监听只注册一次，避免读到旧状态。
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (event) => {
    if (event.isComposing) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const dialog = dialogRef.current;
    if (event.key === 'Tab' && dialog) {
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:enabled, a[href], select:enabled'));
      const first = controls[0], last = controls.at(-1);
      if (first && last && (event.shiftKey ? target === first || target === dialog : target === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
      return;
    }
    if (target && (target.isContentEditable || target.closest('input, textarea, select'))) return;
    const { key } = event;
    if (key === 'Escape') { event.preventDefault(); void close(); return; }
    if ((key === 'z' || key === 'Z') && !event.altKey && !event.shiftKey) { event.preventDefault(); if (!event.repeat) void undo(); return; }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (key === 'Enter') {
      if (target?.closest('button, a[href], summary')) return;
      event.preventDefault();
      if (!event.repeat) sendToPublish();
      return;
    }
    if (/^[1-9]$/.test(key)) {
      event.preventDefault();
      const template = templates[Number(key) - 1];
      if (template && !event.repeat) pickTemplate(template.id);
      return;
    }
    if (key === 'ArrowLeft') { event.preventDefault(); stepImage(-1); return; }
    if (key === 'ArrowRight') { event.preventDefault(); stepImage(1); return; }
    if (key === 's' || key === 'S') { event.preventDefault(); if (!event.repeat) skipCurrent(); return; }
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
  const currentTemplateId = choice ?? decision?.templateId ?? product?.templateId;
  const currentIssues = review?.fits.find((fit) => fit.templateId === product?.templateId)?.issues ?? [];
  const currentKnown = Boolean(product?.templateId && nameOf(product.templateId));

  return (
    <div className="template-sorter" role="dialog" aria-modal="true" aria-label="分拣模板" ref={dialogRef} tabIndex={-1}>
      <div className="template-sorter-dialog">
        <header className="template-sorter-head">
          <div>
            <strong>{batchId ? '分拣这批采集商品' : '分拣模板'}</strong>
            <span>
              {queue.length
                ? `${state.finished ? '已看完' : `第 ${state.index + 1} / ${queue.length} 件`} · 已处理 ${settledCount}${skippedCount ? ` · 跳过 ${skippedCount}` : ''}${errorCount ? ` · 保存失败 ${errorCount}` : ''}`
                : '没有待确认模板的商品'}
              {publishCount ? ` · 发布清单 ${publishCount}` : ''}
              {removeCount ? ` · 删除清单 ${removeCount}` : ''}
              {discardCount ? ` · 废弃 ${discardCount}` : ''}
            </span>
          </div>
          <label className="template-sorter-source">
            来源平台
            <select className="sort-select" aria-label="来源平台" value={state.source} disabled={closing} onChange={(event) => {
              setNotice(null);
              dispatch({ type: 'selectSource', source: event.target.value });
              dialogRef.current?.focus();
            }}>
              <option value="all">全部来源（{queues.get('all')!.length}）</option>
              {sources.map((source) => (
                <option key={source} value={source}>{sorterSourceName(source)}（{queues.get(source)!.length}）</option>
              ))}
            </select>
          </label>
          <button type="button" className="ghost" onClick={() => void close()} disabled={closing}>{closing ? '正在保存…' : '退出 Esc'}</button>
        </header>
        <div className="template-sorter-progress" aria-hidden="true"><i style={{ width: `${queue.length ? (settledCount / queue.length) * 100 : 100}%` }} /></div>
        {notice && <div className={`template-sorter-notice ${notice.tone}`} role="status">{notice.text}</div>}

        {!item ? (
          <div className="template-sorter-done">
            <strong>{queue.length ? '这一轮分完了' : `${sorterSourceName(state.source)}暂无待分拣商品`}</strong>
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
              {state.source !== 'all' && queues.get('all')!.length > queue.length && (
                <button type="button" className="ghost" onClick={() => dispatch({ type: 'selectSource', source: 'all' })}>查看全部来源</button>
              )}
              {skippedCount > 0 && <button type="button" className="ghost" onClick={() => dispatch({ type: 'reviewSkipped' })}>回头看跳过的 {skippedCount} 件</button>}
              {lastAction && <button type="button" className="ghost" onClick={() => void undo()} disabled={closing}>撤销上一步</button>}
              <button type="button" onClick={() => void close()} disabled={closing}>完成</button>
            </div>
          </div>
        ) : !product || !review ? (
          <div className="template-sorter-done" role="status">
            {loaded?.error ? <>
              <p>商品详情读取失败：{loaded.error}</p>
              <div>
                <button type="button" onClick={() => setAttempt((value) => value + 1)}>重试</button>
                <button type="button" className="ghost" onClick={skipCurrent}>跳过这件</button>
              </div>
            </> : '正在读取商品详情…'}
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
                <span>来源：{sorterSourceName(product.collected.source)}</span>
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
                {choice || (decision && decision.status !== 'error') ? (
                  <p aria-live="polite"><b>{decision?.status === 'saving' ? '正在确认' : choice ? '已选' : '已确认'}「{nameOf(currentTemplateId)}」</b>{decision?.status === 'error' ? '保存失败，可按 Enter 重试' : choice && decision?.status !== 'saving' ? '按 Enter 确认并加入发布清单' : ''}</p>
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
                      {!choice && <kbd>Enter</kbd>}
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
                        const issues = review.fits.find((fit) => fit.templateId === template.id)?.issues ?? [];
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
                            aria-pressed={choice === template.id}
                            disabled={closing || decision?.status === 'saving' || Boolean(state.parked[product.id])}
                            onClick={() => {
                              pickTemplate(template.id);
                              dialogRef.current?.focus();
                            }}
                            title={issues.length ? `与商品不符：\n${issues.map((x) => x.message).join('\n')}` : `选择「${template.name}」`}
                          >
                            <span className="num">{number <= 9 ? number : '·'}</span>
                            <b>{template.name}</b>
                            {suggestion?.templateId === template.id && <small className="tag suggested">建议</small>}
                            {currentTemplateId === template.id && <small className="tag current">{choice ? '已选' : decision?.status === 'saved' ? '已定' : '当前'}</small>}
                            {issues.length > 0 && <small className="tag conflict">不符</small>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {product && (
          <div className="template-sorter-actions">
            <button type="button" className="ghost" disabled={closing || decision?.status === 'saving' || Boolean(state.parked[product.id])}
              onClick={() => { skipCurrent(); dialogRef.current?.focus(); }}>暂时跳过 <kbd>S</kbd></button>
            <button type="button" className="ghost sorter-undo" disabled={closing || !lastAction}
              onClick={() => { void undo(); dialogRef.current?.focus(); }}>撤销上一步 <kbd>Z</kbd></button>
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
              disabled={closing || decision?.status === 'saving' || Boolean(state.parked[product.id])}
              onClick={() => { sendToPublish(); dialogRef.current?.focus(); }}
              title="确认模板（按建议或已选的模板）并加入发布清单。"
            >
              {decision?.status === 'saving' ? '正在确认…' : '确认并加入发布清单'} <kbd>Enter</kbd>
            </button>
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

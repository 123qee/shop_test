import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type MouseEvent } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import type { AiTitleMaterial, BatchOperation, BatchOperationItem, BatchPublishItem, BatchRemoveRemoteItem, JoomIssueDetail, JoomRemoveReason, JoomShopStatusSummary, JoomShopSyncResult, JoomStatus, ProductQualityScore, ProductRecord, PublishJob } from '@shared/types';
import { classifyJoomListing, JOOM_BUCKET_META, PRIMARY_JOOM_BUCKETS, type JoomListingBucket } from '@shared/joom-listing';
import { QUALITY_GRADE_META } from '@shared/quality';
import { JOOM_REVIEW_REASON_META, summarizeJoomIssues, type JoomReviewReasonKey } from '@shared/joom-review';
import { api } from '../api';
import { fallbackToAllegroOriginal, imagePreviewSource } from '../image-utils';
import { lookupProductsByIds, parseProductIds, type IdLookupHit } from '../id-lookup';
import { compareProductQueue, isRecentlyEdited, isUnpublished, productSku, productTitle } from '../product-queue';
import { ConfirmPopover } from '../components/ConfirmPopover';
import { ErrorSummary } from '../components/ErrorSummary';
import { AiTitleDialog } from './AiTitleDialog';
import type { GroupTemplateBinding, PresetTemplate, ProductGroupId, ProductMaterial } from '@shared/types';
import { isProductGroup, isProductMaterial, PRODUCT_GROUPS } from '@shared/product-grouping';
import { groupingOf, matchesGroupFilters, ProductGroupingBadges, ProductGroupingPanel, type GroupFilters } from './ProductGroupingPanel';
import { needsTemplateDecision, TemplateSorter } from './TemplateSorter';
import { useNativePrompt } from '../components/NativePromptProvider';
import { showFeedback } from '../feedback';
import {
  PRODUCT_ACTION_LISTS_CHANGED,
  addProductsToActionList,
  pruneProductActionLists,
  readProductActionLists,
  removeProductsFromActionList,
  type ProductActionListKind,
  type ProductActionLists,
  type ProductActionListsChangedDetail,
} from '../product-action-lists';

const STATUS_LABEL: Record<string, string> = {
  collected: '已采集',
  edited: '已编辑',
  publishing: '发布中',
  published: '已发布',
  failed: '发布失败',
  discarded: '废弃箱',
};

type BatchResult =
  | { kind: 'publish'; items: BatchPublishItem[] }
  | { kind: 'operation'; items: BatchOperationItem[] }
  | { kind: 'ai-title'; items: BatchOperationItem[] }
  | { kind: 'remove-remote'; items: BatchRemoveRemoteItem[] };

type PublishFilter = 'all' | 'unpublished' | 'published' | 'discarded' | 'nonEnglish' | 'failed' | 'recent';
type ListingFilter = 'all' | JoomListingBucket | 'unsynced';

function hasActiveItems(job: PublishJob) {
  return job.items.some((item) => item.status === 'queued' || item.status === 'running');
}

function orderPublishJobs(jobs: PublishJob[]) {
  const unique = [...new Map(jobs.map((job) => [job.id, job])).values()];
  return unique.sort((a, b) => {
    const aActive = hasActiveItems(a);
    const bActive = hasActiveItems(b);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return aActive
      ? a.createdAt.localeCompare(b.createdAt)
      : b.createdAt.localeCompare(a.createdAt);
  });
}
type QualityFilter = 'all' | ProductQualityScore['grade'] | 'weak';
type ReviewReasonFilter = 'all' | JoomReviewReasonKey;
type ListView = 'grid' | 'table';

const VIEW_KEY = 'auto_tools.listView';
const QUALITY_GRADES: ProductQualityScore['grade'][] = ['excellent', 'good', 'attention', 'risk'];
const REVIEW_REASON_KEYS: JoomReviewReasonKey[] = [
  'categoryPermission',
  'category',
  'content',
  'image',
  'intellectualProperty',
  'restrictedProduct',
  'variant',
  'priceOrShipping',
  'compliance',
  'duplicate',
  'unknown',
];

function parseListingParam(value: string | null): ListingFilter {
  if (value === 'unsynced' || value === 'pending' || value === 'offline') return value;
  if (value && PRIMARY_JOOM_BUCKETS.includes(value as JoomListingBucket)) return value as JoomListingBucket;
  return 'all';
}

function shopListingBucket(listing: { state?: string; inventory?: number; hasActiveVersion?: boolean }): JoomListingBucket | undefined {
  return classifyJoomListing({
    joomState: listing.state,
    joomInventory: listing.inventory,
    joomHasActiveVersion: listing.hasActiveVersion,
  });
}

function productBucketForShop(product: ProductRecord, shopId?: string): JoomListingBucket | undefined {
  const listing = shopId ? product.joomListings?.find((entry) => entry.shopId === shopId) : undefined;
  if (listing) return shopListingBucket(listing);
  if (shopId && product.joomListings?.length) return undefined;
  return classifyJoomListing(product);
}

function productMatchesListingBucket(product: ProductRecord, bucket: JoomListingBucket): boolean {
  if (product.joomListings?.length) return product.joomListings.some((listing) => shopListingBucket(listing) === bucket);
  return classifyJoomListing(product) === bucket;
}

function parsePublishFilter(value: string | null): PublishFilter {
  if (value === 'unpublished' || value === 'published' || value === 'discarded' || value === 'nonEnglish' || value === 'failed' || value === 'recent') {
    return value;
  }
  return 'all';
}

function parseQualityFilter(value: string | null): QualityFilter {
  if (value === 'weak' || (value && QUALITY_GRADES.includes(value as ProductQualityScore['grade']))) {
    return value as QualityFilter;
  }
  return 'all';
}

function parseReviewReasonFilter(value: string | null): ReviewReasonFilter {
  if (value && REVIEW_REASON_KEYS.includes(value as JoomReviewReasonKey)) return value as JoomReviewReasonKey;
  return 'all';
}

function matchesQuality(p: ProductRecord, filter: QualityFilter) {
  if (filter === 'all') return true;
  const grade = p.qualityScore?.grade;
  if (filter === 'weak') return grade === 'attention' || grade === 'risk';
  return grade === filter;
}

function reviewGroupsFor(p: ProductRecord) {
  return summarizeJoomIssues(p.joomIssueDetails, p.joomIssues || undefined);
}

function matchesReviewReason(p: ProductRecord, filter: ReviewReasonFilter) {
  if (filter === 'all') return true;
  return reviewGroupsFor(p).some((group) => group.key === filter);
}

function matchesSearch(p: ProductRecord, q: string) {
  if (!q) return true;
  const hay = [productTitle(p), productSku(p), p.joomProductId ?? '', p.collected.sourceProductId, p.collected.store?.name ?? '']
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((token) => hay.includes(token));
}

/** 多个值、Joom 长 ID 或商品 SKU 自动进入精确 ID 查找；普通文字走模糊搜索。 */
function looksLikeIdLookup(raw: string, items: ProductRecord[]): boolean {
  const parsed = parseProductIds(raw);
  if (!parsed.ids.length) return false;
  const isIdToken = (rawToken: string) => {
    const token = rawToken.toLowerCase();
    return items.some((product) => product.joomProductId?.toLowerCase() === token || product.edited?.sku?.toLowerCase() === token)
      || /^[a-f\d]{20,}$/i.test(token)
      || /^\d{12,}$/.test(token);
  };
  return parsed.ids.every(isIdToken);
}

function deleteConfirmDescription(title: string) {
  const shortTitle = title.length > 34 ? `${title.slice(0, 34)}…` : title;
  return `「${shortTitle}」将从本地采集箱删除，不影响 Joom 线上商品。`;
}

function clickedSelectionControl(event: MouseEvent<HTMLElement>) {
  return event.target instanceof Element && Boolean(event.target.closest(
    'a, button, input, select, textarea, label, summary, details, [role="button"], [contenteditable="true"]',
  ));
}

function readStoredView(): ListView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'grid';
  } catch {
    return 'grid';
  }
}

function replaceListSearch(patch: {
  grouping?: GroupFilters;
  listing?: ListingFilter;
  joomIds?: string[] | null;
  q?: string | null;
  quality?: QualityFilter;
  reason?: ReviewReasonFilter;
  status?: PublishFilter;
}) {
  const params = new URLSearchParams(window.location.search);
  if (patch.grouping) {
    for (const [key, value] of Object.entries({ group: patch.grouping.group, material: patch.grouping.material, templateState: patch.grouping.template })) {
      if (value === 'all') params.delete(key);
      else params.set(key, value);
    }
  }
  if (patch.listing !== undefined) {
    if (patch.listing === 'all') params.delete('listing');
    else params.set('listing', patch.listing);
  }
  if (patch.joomIds !== undefined) {
    if (!patch.joomIds?.length) params.delete('joomIds');
    else params.set('joomIds', patch.joomIds.join(','));
  }
  if (patch.q !== undefined) {
    if (!patch.q?.trim()) params.delete('q');
    else params.set('q', patch.q.trim());
  }
  if (patch.quality !== undefined) {
    if (patch.quality === 'all') params.delete('quality');
    else params.set('quality', patch.quality);
  }
  if (patch.reason !== undefined) {
    if (patch.reason === 'all') params.delete('reason');
    else params.set('reason', patch.reason);
  }
  if (patch.status !== undefined) {
    if (patch.status === 'all') params.delete('status');
    else params.set('status', patch.status);
  }
  const search = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${search ? `?${search}` : ''}`);
}

export type ProductListMode = 'browse' | 'publish' | 'remove';

export function ProductList({ mode = 'browse' }: { mode?: ProductListMode }) {
  const nativePrompt = useNativePrompt();
  const { joom } = useOutletContext<{ joom: JoomStatus | null }>();
  const actionListScope = joom?.shopId ?? 'default';
  const actionListScopeRef = useRef(actionListScope);
  actionListScopeRef.current = actionListScope;
  const [items, setItems] = useState<ProductRecord[]>([]);
  const [groupFilters, setGroupFilters] = useState<GroupFilters>(() => {
    const params = new URLSearchParams(window.location.search);
    const group = params.get('group');
    const material = params.get('material');
    const template = params.get('templateState');
    return { group: isProductGroup(group) ? group : 'all', material: isProductMaterial(material) ? material : 'all', template: template === 'pending' || template === 'confirmed' ? template : 'all' };
  });
  const [groupBindings, setGroupBindings] = useState<GroupTemplateBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionLists, setActionLists] = useState<ProductActionLists>(readProductActionLists);
  const [actionListNotice, setActionListNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [deletingId, setDeletingId] = useState('');
  const [result, setResult] = useState<BatchResult | null>(null);
  const [publishJobs, setPublishJobs] = useState<PublishJob[]>([]);
  const [submittingId, setSubmittingId] = useState('');
  const [pausingJobId, setPausingJobId] = useState('');
  const [refreshingJobs, setRefreshingJobs] = useState(false);
  const [copiedId, setCopiedId] = useState('');
  const [publishFilter, setPublishFilter] = useState<PublishFilter>(() =>
    parsePublishFilter(new URLSearchParams(window.location.search).get('status')),
  );
  const [listingFilter, setListingFilter] = useState<ListingFilter>(() => parseListingParam(new URLSearchParams(window.location.search).get('listing')));
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>(() =>
    parseQualityFilter(new URLSearchParams(window.location.search).get('quality')),
  );
  const [reasonFilter, setReasonFilter] = useState<ReviewReasonFilter>(() =>
    parseReviewReasonFilter(new URLSearchParams(window.location.search).get('reason')),
  );
  const [searchInput, setSearchInput] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  const [searchQ, setSearchQ] = useState(() => (new URLSearchParams(window.location.search).get('q') ?? '').trim().toLowerCase());
  const [view, setView] = useState<ListView>(readStoredView);
  const [batchPanel, setBatchPanel] = useState<null | 'price' | 'inventory' | 'remove-remote'>(null);
  const [publishNotice, setPublishNotice] = useState<{ jobId: string; count: number } | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [dockHeight, setDockHeight] = useState(80);
  const [removeReason, setRemoveReason] = useState<JoomRemoveReason>('stopSelling');
  const [removeDeleteLocal, setRemoveDeleteLocal] = useState(false);
  const [removeIncludeMissed, setRemoveIncludeMissed] = useState(true);
  const [priceMode, setPriceMode] = useState<'set' | 'multiply'>('set');
  const [priceValue, setPriceValue] = useState('9.99');
  const [inventoryValue, setInventoryValue] = useState('999');
  const [syncRemoteOp, setSyncRemoteOp] = useState(false);
  const [appliedIds, setAppliedIds] = useState<string[] | null>(null);
  const [lookupTruncated, setLookupTruncated] = useState(false);
  const [idLookupHint, setIdLookupHint] = useState('');
  const [copiedMissed, setCopiedMissed] = useState(false);
  const [shopSync, setShopSync] = useState<JoomShopSyncResult | null>(null);
  const [joomStatusSummary, setJoomStatusSummary] = useState<JoomShopStatusSummary | null>(null);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [pageSize, setPageSize] = useState(20);
  const [operationBusy, setOperationBusy] = useState(false);
  const [templates, setTemplates] = useState<Array<{ id: string; name: string }>>([]);
  /** 完整预设（含默认值），分拣时据此核对和推荐。 */
  const [presetTemplates, setPresetTemplates] = useState<PresetTemplate[]>([]);
  const [sorterOpen, setSorterOpen] = useState(false);
  const [presetId, setPresetId] = useState('');
  const [defaultTemplateId, setDefaultTemplateId] = useState('');
  const [quickTemplateBusy, setQuickTemplateBusy] = useState(false);
  const [quickTemplateFeedback, setQuickTemplateFeedback] = useState('');
  const [quickTemplateDoneIds, setQuickTemplateDoneIds] = useState<Set<string>>(new Set());
  const [aiOpen, setAiOpen] = useState(false);
  const [aiMaterial, setAiMaterial] = useState<AiTitleMaterial>('polyester');
  const [aiPreview, setAiPreview] = useState(true);
  const [imagePreview, setImagePreview] = useState<{ src: string; x: number; y: number } | null>(null);
  const autoSyncTried = useRef(false);
  const pendingUrlSelect = useRef(false);
  const quickTemplateTimer = useRef<number | null>(null);
  const listRequest = useRef<Promise<ProductRecord[] | undefined> | null>(null);
  const jobsRefreshing = useRef(false);
  const jobItemVersions = useRef<Map<string, string> | null>(null);

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(() => setCopiedId(''), 1500);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  }

  function load(opts?: { silent?: boolean; preservePage?: boolean }) {
    if (listRequest.current) return listRequest.current;
    const request = loadList(opts);
    listRequest.current = request;
    void request.finally(() => { listRequest.current = null; });
    return request;
  }

  async function loadList(opts?: { silent?: boolean; preservePage?: boolean }) {
    if (!opts?.silent) setLoading(true);
    try {
      const list = await api.listProducts();
      setItems(list);
      const currentScope = actionListScopeRef.current;
      setActionLists(pruneProductActionLists(readProductActionLists(currentScope), list.map((p) => p.id), currentScope));
      // 清理已不存在的选中项
      const existingIds = new Set(list.map((p) => p.id));
      setSelected((prev) => new Set([...prev].filter((id) => existingIds.has(id))));
      // 刚编完切回列表时回到第 1 页，避免还停在旧页找不到
      if (opts?.silent && !opts.preservePage && list.some((p) => isRecentlyEdited(p))) setPage(1);
      setError('');
      return list;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshList() {
    const list = await load();
    if (list) showFeedback(`数据已刷新，共 ${list.length} 件商品`);
  }

  async function refreshPublishJobs(showBusy = false) {
    if (jobsRefreshing.current) return;
    jobsRefreshing.current = true;
    if (showBusy) setRefreshingJobs(true);
    try {
      // 等初次列表落地后再记录任务版本，避免加载期间完成的商品漏更新。
      if (listRequest.current) await listRequest.current;
      const jobs = await api.listPublishJobs();
      const previous = jobItemVersions.current;
      const versions = new Map<string, string>();
      const changedIds = new Set<string>();
      for (const job of jobs) {
        for (const item of job.items) {
          const key = `${job.id}:${item.productId}`;
          const version = JSON.stringify([item.status, item.joomProductId, item.error]);
          versions.set(key, version);
          // 首次进度由列表加载；后续只更新有变化的商品，避免不断下载全库。
          if (previous && (previous.has(key) ? previous.get(key) !== version : item.status !== 'queued')) changedIds.add(item.productId);
        }
      }
      const updates = new Map<string, ProductRecord>();
      // 顺序拉取，限制并发及详情数据的峰值内存。
      for (const id of changedIds) {
        const { record } = await api.getProduct(id);
        updates.set(id, record);
      }
      if (updates.size) setItems((current) => current.map((p) => updates.get(p.id) ?? p));
      jobItemVersions.current = versions;
      setPublishJobs(orderPublishJobs(jobs));
      if (showBusy) showFeedback('发布进度已刷新');
    } catch (error) {
      // 自动轮询失败时保留旧版本；手动刷新则明确告诉用户。
      if (showBusy) showFeedback((error as Error).message || '发布进度刷新失败', 'error');
    }
    finally {
      jobsRefreshing.current = false;
      if (showBusy) setRefreshingJobs(false);
    }
  }

  useEffect(() => {
    const parsed = parseProductIds(new URLSearchParams(window.location.search).get('joomIds') ?? '');
    if (parsed.ids.length) {
      setSearchInput(parsed.ids.join(', '));
      setAppliedIds(parsed.ids);
      setLookupTruncated(parsed.truncated);
      pendingUrlSelect.current = true;
      replaceListSearch({ joomIds: parsed.ids });
    }
    load();
    void refreshPublishJobs();
    api.joomShopStatusSummary().then(setJoomStatusSummary).catch(() => {});
    const onVisible = () => {
      if (document.visibilityState === 'visible') load({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    api
      .getSettings()
      .then((config) => {
        const nextTemplates = config.templates.map((t) => ({ id: t.id, name: t.name }));
        setTemplates(nextTemplates);
        setPresetTemplates(config.templates);
        setDefaultTemplateId(config.activeId);
        setPresetId((current) => current || config.activeId || nextTemplates[0]?.id || '');
      })
      .catch((e) => setError((e as Error).message));
    api
      .getAiConfig()
      .then((c) => {
        setAiMaterial(c.material);
        setAiPreview(c.preview);
      })
      .catch(() => {});
    api.getGroupTemplateBindings().then(setGroupBindings).catch((e) => setError((e as Error).message));
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (quickTemplateTimer.current) window.clearTimeout(quickTemplateTimer.current);
    };
  }, []);

  useEffect(() => {
    const onListsChanged = (event: Event) => {
      const detail = (event as CustomEvent<ProductActionListsChangedDetail>).detail;
      if (!detail || detail.scope === actionListScope) setActionLists(detail?.lists ?? readProductActionLists(actionListScope));
    };
    window.addEventListener(PRODUCT_ACTION_LISTS_CHANGED, onListsChanged);
    return () => window.removeEventListener(PRODUCT_ACTION_LISTS_CHANGED, onListsChanged);
  }, [actionListScope]);

  useEffect(() => {
    setActionLists(readProductActionLists(actionListScope));
  }, [actionListScope]);

  useEffect(() => {
    setSelected(new Set());
    setBatchPanel(null);
    setActionListNotice('');
    setPage(1);
  }, [mode]);

  const publishStatusById = useMemo(() => {
    const statuses = new Map<string, 'queued' | 'running'>();
    for (const job of publishJobs) {
      for (const item of job.items) {
        if (item.status === 'queued' || item.status === 'running') statuses.set(item.productId, item.status);
      }
    }
    return statuses;
  }, [publishJobs]);
  const activePublishIds = useMemo(() => new Set(publishStatusById.keys()), [publishStatusById]);
  const activePublishJobs = useMemo(() => publishJobs.filter(hasActiveItems), [publishJobs]);
  const activePublishItems = useMemo(() => activePublishJobs.flatMap((job) => job.items), [activePublishJobs]);
  const shownPublishJob = activePublishJobs[0] ?? publishJobs[0];
  const hasActivePublishJobs = activePublishJobs.length > 0;
  const displayedPublishItems = hasActivePublishJobs ? activePublishItems : (shownPublishJob?.items ?? []);
  const displayedPublishCompleted = displayedPublishItems.filter((item) => item.status === 'succeeded' || item.status === 'failed').length;
  const displayedPublishQueued = displayedPublishItems.filter((item) => item.status === 'queued').length;
  const displayedPublishSucceeded = displayedPublishItems.filter((item) => item.status === 'succeeded').length;
  const displayedPublishFailed = displayedPublishItems.filter((item) => item.status === 'failed').length;
  useEffect(() => {
    if (!hasActivePublishJobs) return;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      if (document.visibilityState === 'visible') await refreshPublishJobs();
      if (!stopped) timer = window.setTimeout(poll, 2500);
    };
    timer = window.setTimeout(poll, 2500);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [hasActivePublishJobs]);

  useEffect(() => {
    if (autoSyncTried.current || loading || !joomStatusSummary) return;
    const connectedShops = joom?.shops?.filter((shop) => shop.connected) ?? [];
    if (!connectedShops.length && !joom?.connected) return;
    const shopsToCheck = connectedShops.length ? connectedShops : [{ id: joom?.shopId ?? 'default', name: joom?.shopName ?? 'Joom', connected: true }];
    const stale = shopsToCheck.some((shop) => {
      const snapshot = joomStatusSummary.shops.find((entry) => entry.shopId === shop.id);
      return !snapshot?.lastSyncedAt || Date.now() - Date.parse(snapshot.lastSyncedAt) > 15 * 60 * 1000;
    });
    if (!stale) return;
    autoSyncTried.current = true;
    void syncShop();
  }, [joom?.connected, joom?.shops, joomStatusSummary, loading]);

  const titleOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of items) m.set(p.id, p.edited?.title ?? p.collected.title);
    return (id: string) => m.get(id) ?? id;
  }, [items]);

  const idLookupActive = Boolean(appliedIds?.length);
  const idLookup = useMemo(
    () => (appliedIds?.length ? lookupProductsByIds(items, appliedIds) : null),
    [items, appliedIds],
  );
  const lookupByProduct = useMemo(() => {
    const map = new Map<string, IdLookupHit>();
    if (!idLookup) return map;
    for (const hit of idLookup.matched) map.set(hit.product.id, hit);
    return map;
  }, [idLookup]);

  useEffect(() => {
    if (!pendingUrlSelect.current || !appliedIds?.length || loading) return;
    pendingUrlSelect.current = false;
    setSelected(new Set(lookupProductsByIds(items, appliedIds).matched.map((hit) => hit.product.id)));
  }, [appliedIds, items, loading]);

  /** ID 检索时按粘贴顺序展示；否则未发布优先，同组内刚编辑的排前面。 */
  const filteredItems = useMemo(() => {
    if (idLookup) return idLookup.matched.map((hit) => hit.product);
    const filtered = items.filter((p) => {
      if (publishFilter === 'published') return p.status === 'published';
      if (publishFilter === 'discarded') return p.status === 'discarded';
      if (publishFilter === 'unpublished') return isUnpublished(p.status);
      if (publishFilter === 'nonEnglish') return Boolean(p.languageRisk);
      if (publishFilter === 'failed') return p.status === 'failed';
      if (publishFilter === 'recent') return isRecentlyEdited(p);
      return true;
    }).filter((p) => {
      if (listingFilter === 'all') return true;
      if (listingFilter === 'unsynced') {
        return !p.joomListings?.length
          && Boolean(p.joomProductId || p.status === 'published');
      }
      return productMatchesListingBucket(p, listingFilter);
    }).filter((p) => matchesQuality(p, qualityFilter)).filter((p) => matchesReviewReason(p, reasonFilter)).filter((p) => matchesSearch(p, searchQ));
    return filtered.sort(compareProductQueue);
  }, [items, publishFilter, listingFilter, qualityFilter, reasonFilter, searchQ, idLookup]);

  const visibleItems = useMemo(() => {
    const grouped = idLookupActive ? filteredItems : filteredItems.filter((p) => matchesGroupFilters(p, groupFilters));
    if (mode === 'browse') {
      const assigned = new Set([...actionLists.publish, ...actionLists.remove]);
      return grouped.filter((p) => !assigned.has(p.id) && !activePublishIds.has(p.id) && p.status !== 'publishing');
    }
    const queued = new Set(mode === 'publish' ? actionLists.publish : actionLists.remove);
    return grouped.filter((p) => queued.has(p.id));
  }, [filteredItems, groupFilters, idLookupActive, mode, actionLists, activePublishIds]);

  function changeGroupFilters(filters: GroupFilters) {
    if (idLookupActive) return;
    setGroupFilters(filters);
    setSelected(new Set());
    setPage(1);
    replaceListSearch({ grouping: filters });
  }

  async function bindGroupTemplate(binding: Omit<GroupTemplateBinding, 'templateId'> & { templateId: string | null }) {
    setOperationBusy(true);
    try {
      setGroupBindings(await api.saveGroupTemplateBinding(binding));
      showQuickTemplateFeedback(binding.templateId ? '已保存此组常用预设，下次可直接套用' : '已取消此组常用预设', []);
      setError('');
    } catch (e) { setError((e as Error).message); }
    finally { setOperationBusy(false); }
  }

  const publishedCount = useMemo(() => items.filter((p) => p.status === 'published').length, [items]);
  const discardedCount = useMemo(() => items.filter((p) => p.status === 'discarded').length, [items]);
  const unpublishedCount = items.length - publishedCount - discardedCount;
  const nonEnglishCount = useMemo(() => items.filter((p) => p.languageRisk).length, [items]);
  const failedCount = useMemo(() => items.filter((p) => p.status === 'failed').length, [items]);
  const templateNameById = useMemo(() => new Map(templates.map((template) => [template.id, template.name])), [templates]);
  // 发布中、已在发布清单或删除清单里的商品，不再出现在分拣队列里。
  const sorterExcludedIds = useMemo(
    () => new Set([...activePublishIds, ...actionLists.publish, ...actionLists.remove]),
    [activePublishIds, actionLists],
  );
  const sortableCount = useMemo(() => items.filter((p) => needsTemplateDecision(p, sorterExcludedIds)).length, [items, sorterExcludedIds]);
  const selectedTemplate = templates.find((template) => template.id === presetId) ?? templates[0];
  const recentCount = useMemo(() => items.filter((p) => isRecentlyEdited(p)).length, [items]);
  const qualityCounts = useMemo(() => {
    const counts: Record<string, number> = { excellent: 0, good: 0, attention: 0, risk: 0, weak: 0 };
    for (const p of items) {
      const grade = p.qualityScore?.grade;
      if (grade) counts[grade] += 1;
      if (grade === 'attention' || grade === 'risk') counts.weak += 1;
    }
    return counts;
  }, [items]);
  const reviewReasonCounts = useMemo(() => {
    const counts: Partial<Record<JoomReviewReasonKey, number>> = {};
    for (const p of items) {
      for (const group of reviewGroupsFor(p)) counts[group.key] = (counts[group.key] ?? 0) + 1;
    }
    return counts;
  }, [items]);
  const listingCounts = useMemo(() => {
    const counts: Record<string, number> = {
      ...(joomStatusSummary?.byListing ?? { active: 0, oos: 0, error: 0, optimize: 0, pending: 0, offline: 0, unknown: 0 }),
      unsynced: 0,
    };
    counts.unsynced = items.filter((product) =>
      !product.joomListings?.length
      && Boolean(product.joomProductId || product.status === 'published'),
    ).length;
    return counts;
  }, [items, joomStatusSummary]);
  const lastSyncedAt = joomStatusSummary?.lastSyncedAt ?? '';
  const totalPages = Math.max(1, Math.ceil(visibleItems.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => visibleItems.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [visibleItems, currentPage, pageSize],
  );
  const selectedPages = useMemo(() => {
    const pages = new Set<number>();
    visibleItems.forEach((p, index) => { if (selected.has(p.id)) pages.add(Math.floor(index / pageSize)); });
    return pages.size;
  }, [visibleItems, selected, pageSize]);
  const noticeJob = publishJobs.find((job) => job.id === publishNotice?.jobId);
  const noticeCompleted = noticeJob?.items.filter((item) => item.status === 'succeeded' || item.status === 'failed').length ?? 0;
  const dockVisible = selected.size > 0 || batchPanel === 'remove-remote' || Boolean(publishNotice);
  useEffect(() => {
    if (!dockVisible || !dockRef.current) return;
    const dock = dockRef.current;
    const observer = new ResizeObserver(() => setDockHeight(Math.ceil(dock.getBoundingClientRect().height)));
    observer.observe(dock);
    setDockHeight(Math.ceil(dock.getBoundingClientRect().height));
    return () => observer.disconnect();
  }, [dockVisible]);

  function clearSelection() {
    setSelected(new Set());
    setBatchPanel(null);
  }

  function addSelectedToActionList(kind: ProductActionListKind) {
    const ids = [...selected];
    if (!ids.length) return;
    setActionLists(addProductsToActionList(actionLists, kind, ids, actionListScope));
    setSelected(new Set());
    setBatchPanel(null);
    const message = `已将 ${ids.length} 件商品加入${kind === 'publish' ? '发布清单' : '删除清单'}`;
    setActionListNotice(`${message}，并从当前浏览列表移除`);
    showFeedback(message);
  }

  function removeSelectedFromCurrentList() {
    if (mode === 'browse') return;
    const ids = [...selected];
    if (!ids.length) return;
    const kind: ProductActionListKind = mode === 'publish' ? 'publish' : 'remove';
    setActionLists(removeProductsFromActionList(actionLists, kind, ids, actionListScope));
    setSelected(new Set());
    setBatchPanel(null);
    const message = `已从${mode === 'publish' ? '发布清单' : '删除清单'}移出 ${ids.length} 件商品`;
    setActionListNotice(message);
    showFeedback(message);
  }

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
    setPageInput(String(currentPage));
  }, [page, currentPage]);

  async function remove(id: string) {
    setDeletingId(id);
    try {
      await api.deleteProduct(id);
      setActionLists(removeProductsFromActionList(readProductActionLists(actionListScope), 'remove', [id], actionListScope));
      setError('');
      await load({ silent: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeletingId('');
    }
  }

  async function restore(id: string) {
    if (!await nativePrompt.confirm('确定将这个商品从废弃箱恢复到未发布列表？')) return;
    try {
      await api.restoreProduct(id);
      setError('');
      await load({ silent: true });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const visibleIds = pageItems.map((p) => p.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const matchingIds = visibleItems.map((p) => p.id);
  const allMatchingSelected = matchingIds.length > 0 && matchingIds.every((id) => selected.has(id));
  const toggleAll = () => {
    showFeedback(allSelected ? `已取消选择本页 ${visibleIds.length} 件商品` : `已选择本页 ${visibleIds.length} 件商品`, 'info');
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const toggleAllMatching = () => {
    showFeedback(allMatchingSelected ? `已取消选择全部 ${matchingIds.length} 件商品` : `已选择全部 ${matchingIds.length} 件商品`, 'info');
    setSelected((prev) => {
      const next = new Set(prev);
      if (allMatchingSelected) matchingIds.forEach((id) => next.delete(id));
      else matchingIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const changeFilter = (value: PublishFilter) => {
    if (idLookupActive) return;
    setPublishFilter(value);
    setPage(1);
    setSelected(new Set());
    replaceListSearch({ status: value });
  };

  const changeQualityFilter = (value: QualityFilter) => {
    if (idLookupActive) return;
    setQualityFilter(value);
    setPage(1);
    setSelected(new Set());
    replaceListSearch({ quality: value });
  };

  const changeReasonFilter = (value: ReviewReasonFilter) => {
    if (idLookupActive) return;
    setReasonFilter(value);
    setPage(1);
    setSelected(new Set());
    // 选择审核原因时自动退出店铺状态筛选，避免两个筛选条件叠加后用户误以为没有数据。
    if (value !== 'all') {
      setListingFilter('all');
      setPublishFilter('all');
      replaceListSearch({ reason: value, listing: 'all', status: 'all' });
    } else {
      replaceListSearch({ reason: value });
    }
  };

  const applySearch = (raw: string) => {
    const next = raw.trim().toLowerCase();
    setAppliedIds(null);
    setLookupTruncated(false);
    setIdLookupHint('');
    setSearchQ(next);
    setPage(1);
    setSelected(new Set());
    replaceListSearch({ q: next || null, joomIds: null });
  };

  function applyUnifiedSearch(raw: string) {
    if (!raw.trim()) {
      clearUnifiedSearch();
      return;
    }
    if (mode === 'browse' && looksLikeIdLookup(raw, items)) {
      applyIdLookup(raw);
      return;
    }
    applySearch(raw);
  }

  function clearUnifiedSearch() {
    setSearchInput('');
    setSearchQ('');
    setAppliedIds(null);
    setLookupTruncated(false);
    setIdLookupHint('');
    setCopiedMissed(false);
    setSelected(new Set());
    setPage(1);
    replaceListSearch({ q: null, joomIds: null });
  }

  const clearFilters = () => {
    if (idLookupActive) return;
    setPublishFilter('all');
    setQualityFilter('all');
    setReasonFilter('all');
    setListingFilter('all');
    setSearchInput('');
    setSearchQ('');
    setSelected(new Set());
    setPage(1);
    replaceListSearch({ status: 'all', quality: 'all', reason: 'all', listing: 'all', q: null });
  };

  const changeView = (next: ListView) => {
    setImagePreview(null);
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* ignore */
    }
  };

  const changeListingFilter = (value: ListingFilter) => {
    if (idLookupActive) return;
    const next = listingFilter === value ? 'all' : value;
    setListingFilter(next);
    if (next !== 'all') {
      setPublishFilter('all');
      replaceListSearch({ listing: next, status: 'all' });
    } else {
      replaceListSearch({ listing: next });
    }
    setPage(1);
    setSelected(new Set());
  };

  function applyParsedIds(ids: string[], truncated: boolean) {
    setAppliedIds(ids);
    setLookupTruncated(truncated);
    setIdLookupHint('');
    setSearchQ('');
    setPage(1);
    setSelected(new Set(lookupProductsByIds(items, ids).matched.map((hit) => hit.product.id)));
    replaceListSearch({ joomIds: ids, q: null });
  }

  function applyIdLookup(raw: string) {
    const parsed = parseProductIds(raw);
    if (!parsed.ids.length) {
      setIdLookupHint('没有识别到有效 ID');
      return;
    }
    applyParsedIds(parsed.ids, parsed.truncated);
  }

  function clearIdLookup() {
    setAppliedIds(null);
    setLookupTruncated(false);
    setIdLookupHint('');
    setSearchInput('');
    setCopiedMissed(false);
    setSelected(new Set());
    setPage(1);
    replaceListSearch({ joomIds: null });
  }

  function dropLookupToken(token: string) {
    if (!appliedIds) return;
    const next = appliedIds.filter((id) => id.toLowerCase() !== token.toLowerCase());
    setSearchInput(next.join(', '));
    if (!next.length) {
      clearIdLookup();
      return;
    }
    applyParsedIds(next, false);
  }

  async function copyMissedIds(ids: string[]) {
    try {
      await navigator.clipboard.writeText(ids.join('\n'));
      setCopiedMissed(true);
      setTimeout(() => setCopiedMissed(false), 1500);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  }

  function onUnifiedSearchPaste(e: ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData('text');
    if (mode !== 'browse' || !pasted.trim() || !looksLikeIdLookup(pasted, items)) return;
    const el = e.currentTarget;
    const start = el.selectionStart ?? searchInput.length;
    const end = el.selectionEnd ?? searchInput.length;
    const next = `${searchInput.slice(0, start)}${pasted}${searchInput.slice(end)}`;
    if (!looksLikeIdLookup(next, items)) return;
    e.preventDefault();
    setSearchInput(next.replace(/[\r\n]+/g, ', '));
    const parsed = parseProductIds(next);
    if (parsed.ids.length) applyParsedIds(parsed.ids, parsed.truncated);
  }

  const changePageSize = (value: number) => {
    setPageSize(value);
    setPage(1);
    setPageInput('1');
    setSelected(new Set());
  };

  function jumpToPage(raw: string = pageInput) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      setPageInput(String(currentPage));
      return;
    }
    const target = Math.min(totalPages, Math.max(1, parsed));
    setPage(target);
    setPageInput(String(target));
  }

  async function batchDelete() {
    const ids = [...selected];
    if (!ids.length) return;
    if (!await nativePrompt.confirm(`从采集箱删除选中的 ${ids.length} 个商品?仅删除本地记录,不影响已发布到 Joom 的商品。`)) return;
    setBusy(`删除中…(0/${ids.length})`);
    setResult(null);
    let done = 0;
    try {
      for (const id of ids) {
        await api.deleteProduct(id);
        done++;
        setBusy(`删除中…(${done}/${ids.length})`);
      }
      setError('');
      setSelected(new Set());
      setActionLists(removeProductsFromActionList(readProductActionLists(actionListScope), 'remove', ids, actionListScope));
      await load({ silent: true });
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      showFeedback(message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function submitRemoveRemote() {
    const ids = [...selected];
    const extra = removeIncludeMissed && idLookupActive ? (idLookup?.missed ?? []) : [];
    if (!ids.length && !extra.length) return;
    if (!joom?.connected) {
      setError('请先在右上角连接 Joom，才能删除线上商品。');
      return;
    }
    const extraHint = extra.length ? `\n同时删除检索未命中的 ${extra.length} 个 Joom ID。` : '';
    const localHint = removeDeleteLocal ? '同时从采集箱删除本地记录' : '本地记录将移入废弃箱，可稍后恢复后重新发布';
    if (
      !await nativePrompt.confirm(
        `确定从 Joom 删除选中的线上商品？此操作不可恢复，会删除线上商品及全部变体。不要用于临时下架。${extraHint}\n${localHint}`,
      )
    ) {
      return;
    }
    setBusy(`正在从 Joom 删除…(${ids.length + extra.length} 个)`);
    setResult(null);
    try {
      const items = await api.batchRemoveRemote({
        ids,
        remoteIds: extra.length ? extra : undefined,
        reason: removeReason,
        deleteLocal: removeDeleteLocal,
      });
      setResult({ kind: 'remove-remote', items });
      const removedIds = items.filter((item) => item.ok).map((item) => item.id);
      if (removedIds.length) setActionLists(removeProductsFromActionList(readProductActionLists(actionListScope), 'remove', removedIds, actionListScope));
      setError('');
      setSelected(new Set());
      setBatchPanel(null);
      await load({ silent: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function batchPublish() {
    const ids = [...selected];
    if (!ids.length) return;
    if (!await nativePrompt.confirm(`确定发布选中的 ${ids.length} 个商品到 Joom?会创建真实商品(进审核)。`)) return;
    setBusy('提交发布任务…');
    setResult(null);
    try {
      const job = await api.enqueuePublish(ids);
      setPublishJobs((current) => orderPublishJobs([job, ...current]));
      setPublishNotice({ jobId: job.id, count: ids.length });
      setActionLists(removeProductsFromActionList(readProductActionLists(actionListScope), 'publish', ids, actionListScope));
      setBatchPanel(null);
      setSelected(new Set());
      setError('');
      showFeedback(job.aheadCount > 0
        ? `已追加到发布队列末尾，前面还有 ${job.aheadCount} 件，完成后会自动执行`
        : `已加入发布队列，${ids.length} 件商品将按顺序发布`);
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      showFeedback(message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function publishOne(id: string) {
    setSubmittingId(id);
    try {
      const job = await api.enqueuePublish([id]);
      setPublishJobs((current) => orderPublishJobs([job, ...current]));
      setActionLists(removeProductsFromActionList(readProductActionLists(actionListScope), 'publish', [id], actionListScope));
      setError('');
      showFeedback(job.aheadCount > 0
        ? `已追加到队列末尾，前面还有 ${job.aheadCount} 件`
        : '已加入后台发布队列');
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      showFeedback(message, 'error');
    } finally {
      setSubmittingId('');
    }
  }

  async function pausePublishJob(jobId: string) {
    setPausingJobId(jobId);
    try {
      const job = await api.pausePublishJob(jobId);
      setPublishJobs((current) => orderPublishJobs([job, ...current.filter((item) => item.id !== job.id)]));
      const pausedIds = job.items.filter((item) => item.status === 'paused').map((item) => item.productId);
      if (pausedIds.length) {
        setActionLists(addProductsToActionList(readProductActionLists(actionListScope), 'publish', pausedIds, actionListScope));
        setActionListNotice(`已暂停发布，${pausedIds.length} 件尚未开始的商品已放回发布清单`);
        showFeedback(`已暂停任务，${pausedIds.length} 件商品已放回发布清单`, 'info');
      }
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPausingJobId('');
    }
  }

  async function pauseAllPublishJobs() {
    if (!activePublishJobs.length) return;
    setPausingJobId('all');
    try {
      const pausedJobs: PublishJob[] = [];
      for (const job of activePublishJobs) pausedJobs.push(await api.pausePublishJob(job.id));
      const pausedIds = pausedJobs.flatMap((job) => job.items.filter((item) => item.status === 'paused').map((item) => item.productId));
      setPublishJobs((current) => orderPublishJobs([
        ...pausedJobs,
        ...current.filter((item) => !pausedJobs.some((paused) => paused.id === item.id)),
      ]));
      if (pausedIds.length) {
        setActionLists(addProductsToActionList(readProductActionLists(actionListScope), 'publish', pausedIds, actionListScope));
        setActionListNotice(`已暂停全部发布任务，${pausedIds.length} 件尚未开始的商品已放回发布清单`);
      }
      setError('');
      showFeedback(`已暂停全部任务，${pausedIds.length} 件商品已放回发布清单`, 'info');
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      showFeedback(message, 'error');
    } finally {
      setPausingJobId('');
    }
  }

  function returnPublishJobToList(job: PublishJob) {
    const ids = job.items
      .filter((item) => item.status === 'paused' || item.status === 'failed')
      .map((item) => item.productId);
    if (!ids.length) return;
    setActionLists(addProductsToActionList(readProductActionLists(actionListScope), 'publish', ids, actionListScope));
    setActionListNotice(`已将 ${ids.length} 件暂停或失败的商品放回发布清单`);
    showFeedback(`已放回发布清单：${ids.length} 件商品`);
  }

  async function batchSync() {
    const ids = [...selected];
    if (!ids.length) return;
    setBusy(`同步 Joom 状态中…`);
    try {
      await api.batchSync(ids);
      setSelected(new Set());
      setJoomStatusSummary(await api.joomShopStatusSummary());
      await load({ silent: true });
      setError('');
      showFeedback(`已同步 ${ids.length} 件商品的 Joom 状态`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function syncShop() {
    const hasConnectedShop = joom?.shops?.some((shop) => shop.connected) ?? joom?.connected ?? false;
    if (!hasConnectedShop) {
      setError('请先连接至少一个 Joom 店铺，才能同步店铺状态。');
      return;
    }
    setBusy('正在同步所有已连接的 Joom 店铺…这不会改本地草稿。');
    setShopSync(null);
    try {
      const summary = await api.syncShop();
      setShopSync(summary);
      setJoomStatusSummary(summary.overview);
      await load({ silent: true });
      setError('');
      showFeedback(`店铺状态同步完成：匹配 ${summary.ok} 个商品${summary.failed ? `，失败 ${summary.failed} 个` : ''}`, summary.failed ? 'info' : 'success');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function syncOne(id: string) {
    if (!joom?.connected) {
      setError('请先连接 Joom，才能获取审核原因。');
      return;
    }
    setBusy('正在获取商品审核原因…');
    try {
      await api.syncProduct(id);
      setJoomStatusSummary(await api.joomShopStatusSummary());
      await load({ silent: true });
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  function showQuickTemplateFeedback(message: string, ids: string[]) {
    setQuickTemplateFeedback(message);
    setQuickTemplateDoneIds(new Set(ids));
    if (quickTemplateTimer.current) window.clearTimeout(quickTemplateTimer.current);
    quickTemplateTimer.current = window.setTimeout(() => {
      setQuickTemplateFeedback('');
      setQuickTemplateDoneIds(new Set());
    }, 4000);
  }

  async function applyQuickTemplate(ids: string[], templateId: string) {
    const template = templates.find((item) => item.id === templateId);
    if (!ids.length || !template || quickTemplateBusy || operationBusy) return;
    setPresetId(templateId);
    setQuickTemplateBusy(true);
    setOperationBusy(true);
    setBusy('正在套用预设…');
    setResult(null);
    try {
      const results = await api.batchOperate(ids, { type: 'template', templateId }, false);
      const succeeded = results.filter((item) => item.ok).map((item) => item.id);
      const failed = results.filter((item) => !item.ok);
      if (succeeded.length) {
        showQuickTemplateFeedback(
          succeeded.length === 1
            ? `已套用「${template.name}」`
            : `已为 ${succeeded.length} 件商品套用「${template.name}」`,
          succeeded,
        );
      }
      if (failed.length) setError(failed.map((item) => item.error || `${item.id} 套用失败`).join('\n'));
      else setError('');
      setSelected((previous) => new Set([...previous].filter((id) => !succeeded.includes(id))));
      const list = await load({ silent: true });
      if (failed.length) setError(failed.map((item) => item.error || `${item.id} 套用失败`).join('\n'));
      // 待确认视图处理完整组后，直接进入下一组；部分失败留在当前组。
      if (list && !failed.length && groupFilters.template === 'pending' && groupFilters.group !== 'all') {
        const latest = new Map(list.map((p) => [p.id, p]));
        const remaining = filteredItems.map((p) => latest.get(p.id)).filter((p): p is ProductRecord => Boolean(p && !p.templateConfirmed && p.status !== 'discarded' && p.status !== 'publishing' && !activePublishIds.has(p.id)));
        if (!remaining.some((p) => matchesGroupFilters(p, groupFilters))) {
          if (remaining.some((p) => groupingOf(p).groupId === groupFilters.group)) {
            changeGroupFilters({ ...groupFilters, material: 'all' });
          } else {
            const next = PRODUCT_GROUPS.find((g) => remaining.some((p) => groupingOf(p).groupId === g.id));
            if (next) changeGroupFilters({ group: next.id, material: 'all', template: 'pending' });
          }
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setQuickTemplateBusy(false);
      setOperationBusy(false);
      setBusy('');
    }
  }

  function chooseQuickTemplate(templateId: string) {
    setPresetId(templateId);
    if (selected.size > 0) void applyQuickTemplate([...selected], templateId);
  }

  function persistAiPrefs(next: { material?: AiTitleMaterial; preview?: boolean }) {
    const material = next.material ?? aiMaterial;
    const preview = next.preview ?? aiPreview;
    setAiMaterial(material);
    setAiPreview(preview);
    api.saveAiConfig({ material, preview }).catch(() => {});
  }

  async function startAiTitles() {
    const ids = [...selected];
    if (!ids.length || operationBusy) return;
    persistAiPrefs({});
    if (aiPreview) {
      setAiOpen(true);
      return;
    }
    const name = aiMaterial === 'cotton' ? '棉' : '聚酯纤维';
    if (!await nativePrompt.confirm(`将用「${name}」提示词直接改写 ${ids.length} 个标题，不再逐条预览。继续？`)) return;
    setOperationBusy(true);
    setBusy(`AI 改标题中…(0/${ids.length})`);
    setResult(null);
    try {
      const generated = await api.batchAiTitles({ ids, material: aiMaterial, includeTags: true });
      const ok = generated.filter((item) => item.ok && item.title?.trim());
      if (!ok.length) {
        setResult({
          kind: 'ai-title',
          items: generated.map((item) => ({ id: item.id, ok: item.ok, error: item.error || '未生成标题' })),
        });
        setError('这次没有生成成功的标题，请检查 DeepSeek 配置或换几个商品再试。');
        return;
      }
      const syncRemote = await nativePrompt.confirm(`已生成 ${ok.length}/${ids.length} 条。是否同时把已发布商品提交到 Joom？未发布商品只保存本地草稿。`);
      const results = await api.batchOperate(
        ok.map((item) => item.id),
        {
          type: 'title',
          items: ok.map((item) => ({ id: item.id, title: item.title!.trim(), tags: item.tags?.length ? item.tags : undefined })),
        },
        syncRemote,
      );
      const failedGen = generated.filter((item) => !item.ok).map((item) => ({ id: item.id, ok: false, error: item.error }));
      setResult({ kind: 'ai-title', items: [...results, ...failedGen] });
      setSelected(new Set());
      await load({ silent: true });
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOperationBusy(false);
      setBusy('');
    }
  }

  async function applyAiTitles(items: Array<{ id: string; title: string; tags?: string[] }>, syncRemote: boolean) {
    const ids = items.map((item) => item.id);
    if (!ids.length || operationBusy) return;
    setOperationBusy(true);
    setBusy(`写入 AI 标题中…(${ids.length} 个)`);
    setResult(null);
    try {
      const results = await api.batchOperate(ids, { type: 'title', items }, syncRemote);
      setResult({ kind: 'ai-title', items: results });
      setSelected(new Set());
      setAiOpen(false);
      await load({ silent: true });
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOperationBusy(false);
      setBusy('');
    }
  }

  async function batchNormalizeColors() {
    const ids = [...selected];
    if (!ids.length || operationBusy) return;
    if (!await nativePrompt.confirm(`将选中的 ${ids.length} 个商品的变体颜色映射为 Joom 英文色名（如 черный → Black）。不会改变体 SKU。`)) return;
    const syncRemote = await nativePrompt.confirm('是否同时把已发布商品的修改提交到 Joom？未发布商品只保存本地草稿。');
    setOperationBusy(true);
    setBusy(`规范化颜色中…(${ids.length} 个)`);
    setResult(null);
    try {
      const items = await api.batchOperate(ids, { type: 'normalizeColors' }, syncRemote);
      setResult({ kind: 'operation', items });
      setSelected(new Set());
      await load({ silent: true });
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOperationBusy(false);
      setBusy('');
    }
  }

  async function batchDiscard() {
    const ids = [...selected];
    if (!ids.length) return;
    if (!await nativePrompt.confirm(`将选中的 ${ids.length} 个商品移入废弃箱？只改本地列表，不影响已发布到 Joom 的商品，之后可恢复。`)) return;
    setBusy(`移入废弃箱…(0/${ids.length})`);
    setResult(null);
    let done = 0;
    try {
      for (const id of ids) {
        await api.discardProduct(id);
        done++;
        setBusy(`移入废弃箱…(${done}/${ids.length})`);
      }
      setError('');
      setSelected(new Set());
      await load({ silent: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function runBatchOperation(operation: BatchOperation, syncRemote: boolean) {
    const ids = [...selected];
    if (!ids.length || operationBusy) return;
    setOperationBusy(true);
    setBusy('批量更新本地草稿…');
    setResult(null);
    try {
      const items = await api.batchOperate(ids, operation, syncRemote);
      setResult({ kind: 'operation', items });
      setSelected(new Set());
      setBatchPanel(null);
      await load({ silent: true });
      setError('');
      const succeeded = items.filter((item) => item.ok).length;
      showFeedback(`批量操作完成：成功 ${succeeded}/${items.length}`, succeeded === items.length ? 'success' : 'info');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOperationBusy(false);
      setBusy('');
    }
  }

  async function submitPrice() {
    const value = Number(priceValue);
    if (!Number.isFinite(value) || value <= 0) {
      setError('请输入大于 0 的价格或倍率');
      return;
    }
    await runBatchOperation({ type: 'price', mode: priceMode, value }, syncRemoteOp);
  }

  async function submitInventory() {
    const value = Number(inventoryValue);
    if (!Number.isInteger(value) || value < 0) {
      setError('库存须为大于等于 0 的整数');
      return;
    }
    await runBatchOperation({ type: 'inventory', value }, syncRemoteOp);
  }

  const okCount = result ? result.items.filter((i) => i.ok).length : 0;
  const matchedCount = idLookup?.matched.length ?? 0;
  const missedIds = idLookup?.missed ?? [];

  return (
    <>
      {mode !== 'browse' && (
        <section className={`action-list-intro ${mode === 'remove' ? 'remove' : 'publish'}`}>
          <div className="action-list-intro-icon">{mode === 'publish' ? '发' : '删'}</div>
          <div>
            <strong>{mode === 'publish' ? '发布前检查区' : '删除前复核区'}</strong>
            <span>
              {mode === 'publish'
                ? `清单中有 ${actionLists.publish.length} 件商品，确认内容后再提交发布。`
                : `清单中有 ${actionLists.remove.length} 件商品，加入清单不会立即删除。`}
            </span>
          </div>
          <Link className="ghost action-list-browse-link" to="/joom">继续浏览商品</Link>
        </section>
      )}
      {actionListNotice && <div className="action-list-notice" role="status">{actionListNotice}</div>}
      {mode === 'browse' && sortableCount > 0 && presetTemplates.length > 0 && (
        <section className="template-sort-entry" aria-label="分拣模板">
          <div>
            <strong>{sortableCount} 件商品还没确认模板</strong>
            <span>一次一件看大图：Enter 确认模板并进发布清单，X 进删除清单，1–9 换模板，Z 撤销</span>
          </div>
          <button type="button" onClick={() => setSorterOpen(true)} disabled={loading || operationBusy}>开始分拣</button>
        </section>
      )}
      <details className="workspace-disclosure product-control-disclosure">
        <summary>
          <span>
            <strong>{mode === 'browse' ? '商品筛选与工具' : '清单筛选与工具'}</strong>
            <small>
              {mode === 'browse'
                ? `${visibleItems.length} 个待处理商品 · 点击展开筛选与操作`
                : `清单中 ${mode === 'publish' ? actionLists.publish.length : actionLists.remove.length} 个商品 · 点击展开筛选与操作`}
            </small>
          </span>
          {visibleItems.length > 0 && (
            <div className="disclosure-selection-actions" role="group" aria-label="快速选择商品">
              <button
                type="button"
                className={allSelected ? 'on' : ''}
                aria-pressed={allSelected}
                disabled={!!busy}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleAll();
                }}
              >
                <span className="disclosure-selection-check" aria-hidden="true" />
                选择本页
              </button>
              <button
                type="button"
                className={allMatchingSelected ? 'on' : ''}
                aria-pressed={allMatchingSelected}
                disabled={!!busy}
                title="选择当前筛选下的全部商品"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleAllMatching();
                }}
              >
                {allMatchingSelected ? '取消全选' : `选择全部 ${visibleItems.length}`}
              </button>
            </div>
          )}
          <b>展开</b>
        </summary>
        <section className="product-control-panel" aria-label="商品筛选与工具">
          <div className="product-filter-row">
            <div className="product-count">
              <strong>{mode === 'publish' ? actionLists.publish.length : mode === 'remove' ? actionLists.remove.length : visibleItems.length}</strong>
              <span>{mode === 'browse' ? '待处理' : '清单商品'}</span>
            </div>
            <select
              className="status-filter"
              value={publishFilter}
              onChange={(e) => changeFilter(e.target.value as PublishFilter)}
              disabled={idLookupActive}
              title={idLookupActive ? '请先退出 ID 检索' : '商品状态'}
              aria-label="商品状态"
            >
              <option value="all">全部状态（{items.length}）</option>
              <option value="unpublished">未发布（{unpublishedCount}）</option>
              <option value="recent">刚编辑（{recentCount}）</option>
              <option value="failed">发布失败（{failedCount}）</option>
              <option value="published">已发布（{publishedCount}）</option>
              <option value="discarded">废弃箱（{discardedCount}）</option>
              <option value="nonEnglish">含非英文（{nonEnglishCount}）</option>
            </select>
            <select
              className="status-filter"
              value={qualityFilter}
              onChange={(e) => changeQualityFilter(e.target.value as QualityFilter)}
              disabled={idLookupActive}
              title={idLookupActive ? '请先退出 ID 检索' : '按发布准备度筛选'}
              aria-label="质量筛选"
            >
              <option value="all">全部质量</option>
              <option value="weak">待完善（{qualityCounts.weak}）</option>
              {QUALITY_GRADES.map((grade) => (
                <option key={grade} value={grade}>{QUALITY_GRADE_META[grade].label}（{qualityCounts[grade] ?? 0}）</option>
              ))}
            </select>
            <select
              className={`status-filter review-filter-select ${reasonFilter !== 'all' ? 'filter-active' : ''}`}
              value={reasonFilter}
              onChange={(e) => changeReasonFilter(e.target.value as ReviewReasonFilter)}
              disabled={idLookupActive}
              title={idLookupActive ? '请先退出 ID 检索' : '按 Joom 审核失败原因筛选'}
              aria-label="审核原因"
            >
              <option value="all">全部审核原因</option>
              {REVIEW_REASON_KEYS.map((key) => (
                <option key={key} value={key} disabled={!reviewReasonCounts[key]}>
                  {JOOM_REVIEW_REASON_META[key].label}（{reviewReasonCounts[key] ?? 0}）
                </option>
              ))}
            </select>
            {(publishFilter !== 'all' || qualityFilter !== 'all' || reasonFilter !== 'all' || listingFilter !== 'all') && (
              <button type="button" className="clear-filter-button" onClick={clearFilters} disabled={idLookupActive}>清除筛选</button>
            )}
            <div className="product-filter-spacer" />
            {visibleItems.length > 0 && (
              <div className="view-seg" role="group" aria-label="列表视图">
                <button type="button" className={view === 'grid' ? 'on' : ''} onClick={() => changeView('grid')}>卡片</button>
                <button type="button" className={view === 'table' ? 'on' : ''} onClick={() => changeView('table')}>列表</button>
              </div>
            )}
          </div>
  
          <div className="product-utility-row product-search-row">
            <form
              className={`unified-product-search ${idLookupActive ? 'id-mode' : ''}`}
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                applyUnifiedSearch(searchInput);
              }}
            >
              <input
                value={searchInput}
                placeholder={mode === 'browse' ? '搜索标题、SKU、来源店，或粘贴 Joom 商品 ID' : '搜索标题、SKU 或来源店'}
                aria-label="搜索商品，或按 Joom 商品 ID 查找"
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  if (idLookupHint) setIdLookupHint('');
                  if (!e.target.value.trim() && (searchQ || idLookupActive)) clearUnifiedSearch();
                }}
                onPaste={onUnifiedSearchPaste}
              />
              {(idLookupActive || searchQ || searchInput) && <button type="button" className="unified-search-clear" onClick={clearUnifiedSearch} disabled={!!busy}>清除</button>}
              <button type="submit" className="unified-search-submit" disabled={!!busy}>搜索</button>
            </form>
            <div className="product-utility-actions">
              <button className="ghost" onClick={() => void refreshList()} disabled={!!busy || loading}>{loading ? '刷新中…' : '刷新数据'}</button>
              {mode === 'browse' && <button className="ghost" onClick={syncShop} disabled={!!busy || !(joom?.shops?.some((shop) => shop.connected) ?? joom?.connected)}>{busy.startsWith('正在同步所有') ? '同步中…' : '同步所有店铺状态'}</button>}
            </div>
          </div>
        </section>
      </details>

      {mode === 'browse' && <details className="workspace-disclosure">
        <summary><span><strong>分组与快捷模板</strong><small>需要批量套用模板时再展开</small></span><b>展开</b></summary>
        <ProductGroupingPanel
          key={`${groupFilters.group}:${groupFilters.material}`}
          items={filteredItems} visible={visibleItems} filters={groupFilters} onChange={changeGroupFilters}
          templates={templates} bindings={groupBindings} onBind={bindGroupTemplate}
          onApply={(ids, templateId) => void applyQuickTemplate(ids, templateId)}
          onSelect={(ids) => setSelected(new Set(ids))}
          onCorrect={(groupId: ProductGroupId, material?: ProductMaterial) => void runBatchOperation({ type: 'grouping', groupId, material }, false)}
          selectedCount={selected.size} activeIds={activePublishIds}
          disabled={loading || !!busy || quickTemplateBusy || operationBusy} locked={idLookupActive}
        />

        {templates.length > 0 && (
          <section className="quick-template-dock" aria-label="快捷模板">
          <div className="quick-template-head">
            <div>
              <strong>快捷模板</strong>
              <span>
                {selected.size > 0
                  ? `已选 ${selected.size} 件，点击模板立即批量套用`
                  : `已选「${selectedTemplate?.name ?? '默认模板'}」，点击商品的模板标签即可连续套用`}
              </span>
            </div>
            <small>更新价格、库存、尺码等预设字段；标题、SKU、图片保持不变</small>
          </div>
          <div className="quick-template-strip" role="group" aria-label="选择快捷模板">
            {templates.map((template, index) => (
              <button
                key={template.id}
                type="button"
                className={presetId === template.id ? 'on' : ''}
                aria-pressed={presetId === template.id}
                disabled={quickTemplateBusy || operationBusy}
                onClick={() => chooseQuickTemplate(template.id)}
              >
                <span>{index + 1}</span>
                <b>{template.name}</b>
                {template.id === defaultTemplateId && <small>默认</small>}
              </button>
            ))}
          </div>
          {quickTemplateFeedback && <div className="quick-template-feedback" role="status">✓ {quickTemplateFeedback}</div>}
          </section>
        )}
      </details>}

      {mode === 'browse' && <details className="workspace-disclosure store-status-disclosure">
        <summary><span><strong>Joom 店铺状态</strong><small>{lastSyncedAt ? `上次同步 ${formatSyncTime(lastSyncedAt)}` : '尚未同步'}</small></span><b>展开</b></summary>
      <section className={`listing-overview ${idLookupActive ? 'locked' : ''}`} aria-label="Joom 店铺状态">
        <div className="listing-overview-grid">
          <div className="listing-overview-main">
            <div>
              <strong>Joom 店铺状态</strong>
              <span>
                {joomStatusSummary?.total ?? 0} 个店铺刊登
                {lastSyncedAt ? ` · 上次同步 ${formatSyncTime(lastSyncedAt)}` : ' · 尚未同步'}
                {listingCounts.unsynced > 0 ? ` · ${listingCounts.unsynced} 个未同步` : ''}
              </span>
            </div>
            <button onClick={syncShop} disabled={!!busy || !(joom?.shops?.some((shop) => shop.connected) ?? joom?.connected)} title="同步所有已连接店铺，只更新状态快照">
              {busy.startsWith('正在同步所有') ? '同步中…' : '同步状态'}
            </button>
          </div>
          {PRIMARY_JOOM_BUCKETS.map((bucket) => (
            <button
              key={bucket}
              type="button"
              className={`listing-overview-stat ${bucket} ${!idLookupActive && listingFilter === bucket ? 'on' : ''}`}
              onClick={() => changeListingFilter(bucket)}
              title={idLookupActive ? '请先退出 ID 检索' : JOOM_BUCKET_META[bucket].hint}
            >
              <span>{JOOM_BUCKET_META[bucket].label}</span>
              <b>{listingCounts[bucket] ?? 0}</b>
            </button>
          ))}
        </div>
        {joomStatusSummary?.shops.length ? <div className="listing-overview-shops">
          {joomStatusSummary.shops.map((shop) => (
            <span key={shop.shopId} title={shop.lastError || `${shop.shopName}：${shop.total} 个刊登`}>
              {shop.shopName}: {shop.total}
              {shop.lastError ? ' · 同步失败' : !shop.connected ? ' · 未连接' : shop.lastSyncedAt ? ` · ${formatSyncTime(shop.lastSyncedAt)}` : ' · 尚未同步'}
            </span>
          ))}
        </div> : null}
        {(listingCounts.pending > 0 || listingCounts.offline > 0 || listingCounts.unknown > 0 || listingCounts.unsynced > 0 || listingFilter !== 'all' || (joomStatusSummary?.unmatchedRemote ?? 0) > 0) && (
          <div className="listing-overview-extra">
            <span>其他状态</span>
            {listingCounts.pending > 0 && <button type="button" className={listingFilter === 'pending' ? 'on' : ''} onClick={() => changeListingFilter('pending')}>审核中 {listingCounts.pending}</button>}
            {listingCounts.offline > 0 && <button type="button" className={listingFilter === 'offline' ? 'on' : ''} onClick={() => changeListingFilter('offline')}>已下架 {listingCounts.offline}</button>}
            {listingCounts.unknown > 0 && <span>未知 {listingCounts.unknown}</span>}
            {listingCounts.unsynced > 0 && <button type="button" className={listingFilter === 'unsynced' ? 'on' : ''} onClick={() => changeListingFilter('unsynced')}>未同步 {listingCounts.unsynced}</button>}
            {(joomStatusSummary?.unmatchedRemote ?? 0) > 0 && <span>另有 {joomStatusSummary!.unmatchedRemote} 个平台商品未关联本地记录</span>}
            {listingFilter !== 'all' && <button type="button" className="clear-listing-filter" onClick={() => changeListingFilter('all')}>清除状态筛选</button>}
          </div>
        )}
      </section>
      </details>}

      {idLookupHint && <div className="notice">{idLookupHint}</div>}
      {!loading && idLookupActive && idLookup && (
        <div className="id-lookup-status">
          <span>
            按 <strong>{appliedIds?.length}</strong> 个 ID 查找 · 命中 <strong>{matchedCount}</strong>
            {missedIds.length ? ` · 未找到 ${missedIds.length}` : ''}
            {lookupTruncated ? ' · 最多一次 100 个，已忽略其余' : ''}
            {matchedCount > 0 ? ' · 已勾选，可直接批量操作' : ''}
          </span>
          <button type="button" className="ghost" onClick={clearIdLookup}>
            退出 ID 检索
          </button>
        </div>
      )}
      {!loading && idLookupActive && missedIds.length > 0 && (
        <div className="id-missed">
          <div className="id-missed-head">
            <strong>未命中 {missedIds.length} 个</strong>
            <span className="muted">采集箱中没有这些 ID。可能未采集、已删除，或非本工具发布。</span>
            <button type="button" className="copy-btn" onClick={() => copyMissedIds(missedIds)}>
              {copiedMissed ? '已复制' : '复制未命中'}
            </button>
            <button
              type="button"
              className="ghost danger"
              disabled={!!busy || !joom?.connected}
              title={joom?.connected ? '调用 Joom POST /products/remove，不可恢复' : '请先连接 Joom'}
              onClick={() => {
                setRemoveIncludeMissed(true);
                setBatchPanel('remove-remote');
              }}
            >
              从 Joom 删除未命中
            </button>
          </div>
          <div className="id-missed-list">
            {missedIds.map((id) => (
              <span className="id-missed-chip" key={id}>
                <code>{id}</code>
                <button type="button" onClick={() => dropLookupToken(id)} aria-label={`从检索中移除 ${id}`}>
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 批量操作条:选中时出现 */}
      {mode === 'publish' && shownPublishJob && (
        <div className="publish-job" role="status" aria-live="polite">
          <div className="publish-job-head">
            <strong>{hasActivePublishJobs ? `后台发布队列${activePublishJobs.length > 1 ? `（${activePublishJobs.length} 个任务）` : ''}` : shownPublishJob.items.some((item) => item.status === 'paused') ? '发布已暂停' : '最近一次发布已完成'}</strong>
            <span>
              完成 {displayedPublishCompleted}/{displayedPublishItems.length}
              {displayedPublishQueued > 0 && ` · 排队 ${displayedPublishQueued}`}
              {shownPublishJob.items.some((item) => item.status === 'paused') && ` · 暂停 ${shownPublishJob.items.filter((item) => item.status === 'paused').length}`}
              {' · '}成功 {displayedPublishSucceeded}
              {' · '}失败 {displayedPublishFailed}
            </span>
            {hasActivePublishJobs && displayedPublishQueued > 0 && (
              <button type="button" className="ghost danger" disabled={pausingJobId === 'all'} onClick={() => void pauseAllPublishJobs()}>
                {pausingJobId === 'all' ? '暂停中…' : '暂停全部'}
              </button>
            )}
            {shownPublishJob.items.some((item) => item.status === 'paused') && !shownPublishJob.items.some((item) => item.status === 'queued' || item.status === 'running') && (
              <button type="button" className="ghost" onClick={() => returnPublishJobToList(shownPublishJob)}>
                放回发布清单（{shownPublishJob.items.filter((item) => item.status === 'paused' || item.status === 'failed').length}）
              </button>
            )}
            <button type="button" className="ghost" disabled={refreshingJobs} onClick={() => void refreshPublishJobs(true)}>{refreshingJobs ? '刷新中…' : '刷新进度'}</button>
          </div>
          {activePublishJobs.length > 1 && (
            <div className="publish-job-queue">
              {activePublishJobs.map((job, index) => {
                const completed = job.items.filter((item) => item.status === 'succeeded' || item.status === 'failed').length;
                const running = job.items.some((item) => item.status === 'running');
                return (
                  <div key={job.id} className={running ? 'running' : ''}>
                    <b>{running ? '正在执行' : `等待任务 ${index + 1}`}</b>
                    <span>{completed}/{job.items.length}</span>
                    {!running && job.aheadCount > 0 && <small>前面还有 {job.aheadCount} 件</small>}
                  </div>
                );
              })}
              <p>新提交的商品会追加到队尾，前面的任务完成后自动继续。</p>
            </div>
          )}
          {displayedPublishItems.some((item) => item.status === 'failed') && (
            <ul className="publish-job-failures">
              {displayedPublishItems.filter((item) => item.status === 'failed').slice(0, 8).map((item) => (
                <li key={item.productId}>
                  <Link to={`/products/${item.productId}`} target="_blank">{titleOf(item.productId)}</Link>
                  <ErrorSummary message={item.error || '发布失败'} />
                  <button type="button" className="ghost" disabled={!!submittingId || activePublishIds.has(item.productId)} onClick={() => void publishOne(item.productId)}>重试</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {dockVisible && <div className="batch-dock" ref={dockRef}>
      {selected.size > 0 && (
        <div className="batchbar" role="region" aria-label="已选商品批量操作">
          <div className="batchbar-main">
            <div className="batchbar-summary">
              <div className="batchbar-selection">
                <span>已选 <strong>{selected.size}</strong> 件{selectedPages > 1 && <small> · 跨 {selectedPages} 页</small>}</span>
                <small className="batchbar-shop">{joom?.connected ? `发布到：${joom.shopName || '当前 Joom 店铺'}` : '请先连接 Joom 店铺'}</small>
              </div>
              <button type="button" className="ghost" onClick={clearSelection} disabled={!!busy}>清空选择</button>
            </div>
            <div className="batchbar-actions">
              {mode === 'browse' ? (
                <>
                  <button type="button" className="batch-publish-button" onClick={() => addSelectedToActionList('publish')} disabled={!!busy}>加入发布清单（{selected.size}）</button>
                  <button type="button" className="batch-list-remove-button" onClick={() => addSelectedToActionList('remove')} disabled={!!busy}>加入删除清单</button>
                </>
              ) : mode === 'publish' ? (
                <>
                  <button type="button" className="batch-publish-button" onClick={() => void batchPublish()} disabled={!!busy || !joom?.connected || [...selected].some((id) => activePublishIds.has(id))} title={!joom?.connected ? '请先连接 Joom' : undefined}>{busy === '提交发布任务…' ? '提交中…' : `发布到 Joom（${selected.size}）`}</button>
                  <button type="button" className="ghost" onClick={removeSelectedFromCurrentList} disabled={!!busy}>移出清单</button>
                </>
              ) : (
                <>
                  <button type="button" className="batch-delete-button" onClick={() => void batchDelete()} disabled={!!busy}>{busy.startsWith('删除中') ? busy : `确认删除（${selected.size}）`}</button>
                  <button type="button" className="ghost" onClick={removeSelectedFromCurrentList} disabled={!!busy}>移出清单</button>
                </>
              )}
            </div>
          </div>
          {mode !== 'remove' && <div className="batchbar-tools" role="group" aria-label="批量处理工具">
            <div className="batchbar-tool-group">
              <button type="button" className="ghost" onClick={() => void batchSync()} disabled={!!busy}>同步 Joom</button>
              <button type="button" className={`ghost${batchPanel === 'price' ? ' is-active' : ''}`} aria-pressed={batchPanel === 'price'} onClick={() => setBatchPanel((current) => current === 'price' ? null : 'price')} disabled={!!busy}>改价</button>
              <button type="button" className={`ghost${batchPanel === 'inventory' ? ' is-active' : ''}`} aria-pressed={batchPanel === 'inventory'} onClick={() => setBatchPanel((current) => current === 'inventory' ? null : 'inventory')} disabled={!!busy}>库存</button>
              <button type="button" className="ghost" onClick={() => void batchNormalizeColors()} disabled={!!busy}>规范颜色</button>
            </div>
            <div className="batchbar-ai">
              <div className="ai-seg" role="group" aria-label="AI 标题面料">
                <button type="button" className={aiMaterial === 'cotton' ? 'on' : ''} disabled={!!busy} onClick={() => persistAiPrefs({ material: 'cotton' })}>棉</button>
                <button type="button" className={aiMaterial === 'polyester' ? 'on' : ''} disabled={!!busy} onClick={() => persistAiPrefs({ material: 'polyester' })}>聚酯</button>
              </div>
              <label className="ai-toggle">
                <input type="checkbox" checked={aiPreview} disabled={!!busy} onChange={(e) => persistAiPrefs({ preview: e.target.checked })} />
                预览
              </label>
              <button type="button" className="ghost preset-action" onClick={() => void startAiTitles()} disabled={!!busy}>AI 改标题</button>
            </div>
          </div>}
          {mode === 'remove' && <div className="batchbar-tools batchbar-remove-tools" role="group" aria-label="删除清单工具">
            <span>需要同时删除线上商品？</span>
            <button type="button" className={`ghost danger${batchPanel === 'remove-remote' ? ' is-active' : ''}`} aria-pressed={batchPanel === 'remove-remote'} onClick={() => setBatchPanel((current) => current === 'remove-remote' ? null : 'remove-remote')} disabled={!!busy || !joom?.connected} title={joom?.connected ? '删除线上商品及全部变体，不可恢复' : '请先连接 Joom'}>从 Joom 删除</button>
          </div>}
          {busy && <div className="batchbar-progress" role="status">{busy}</div>}
        </div>
      )}

      {selected.size > 0 && batchPanel === 'price' && (
        <div className="batch-panel">
          <strong>批量改价</strong>
          <select value={priceMode} onChange={(e) => setPriceMode(e.target.value as 'set' | 'multiply')} aria-label="改价方式">
            <option value="set">统一设为</option>
            <option value="multiply">乘以倍率</option>
          </select>
          <input
            type="number"
            min="0"
            step="0.01"
            value={priceValue}
            onChange={(e) => setPriceValue(e.target.value)}
            placeholder={priceMode === 'set' ? '例如 9.99' : '例如 1.1'}
          />
          <label className="ck">
            <input type="checkbox" checked={syncRemoteOp} onChange={(e) => setSyncRemoteOp(e.target.checked)} />
            已发布同时提交 Joom
          </label>
          <button onClick={() => void submitPrice()} disabled={!!busy}>执行</button>
          <button className="ghost" onClick={() => setBatchPanel(null)} disabled={!!busy}>取消</button>
        </div>
      )}
      {selected.size > 0 && batchPanel === 'inventory' && (
        <div className="batch-panel">
          <strong>批量库存</strong>
          <input
            type="number"
            min="0"
            step="1"
            value={inventoryValue}
            onChange={(e) => setInventoryValue(e.target.value)}
            placeholder="例如 999"
          />
          <label className="ck">
            <input type="checkbox" checked={syncRemoteOp} onChange={(e) => setSyncRemoteOp(e.target.checked)} />
            已发布同时提交 Joom
          </label>
          <button onClick={() => void submitInventory()} disabled={!!busy}>执行</button>
          <button className="ghost" onClick={() => setBatchPanel(null)} disabled={!!busy}>取消</button>
        </div>
      )}
      {batchPanel === 'remove-remote' && (
        <div className="batch-panel remove-remote">
          <strong>从 Joom 删除</strong>
          <span className="muted">不可恢复，会删除线上商品及全部变体。不要用于临时下架。</span>
          <select
            value={removeReason}
            onChange={(e) => setRemoveReason(e.target.value as JoomRemoveReason)}
            aria-label="删除原因"
            disabled={!!busy}
          >
            <option value="stopSelling">停止销售</option>
            <option value="legalRequirement">法规要求</option>
          </select>
          <label className="ck">
            <input
              type="checkbox"
              checked={removeDeleteLocal}
              disabled={!!busy}
              onChange={(e) => setRemoveDeleteLocal(e.target.checked)}
            />
            同时删除本地采集箱记录
          </label>
          {idLookupActive && missedIds.length > 0 && (
            <label className="ck">
              <input
                type="checkbox"
                checked={removeIncludeMissed}
                disabled={!!busy}
                onChange={(e) => setRemoveIncludeMissed(e.target.checked)}
              />
              同时删除未命中的 {missedIds.length} 个 Joom ID
            </label>
          )}
          <button className="ghost danger" onClick={() => void submitRemoveRemote()} disabled={!!busy}>
            确认删除
          </button>
          <button className="ghost" onClick={() => setBatchPanel(null)} disabled={!!busy}>
            取消
          </button>
        </div>
      )}
      {!selected.size && publishNotice && <div className="batch-publish-notice" role="status">
        <div>
          <strong>{noticeCompleted === publishNotice.count ? '本次发布已完成' : noticeJob?.items.some((item) => item.status === 'paused') ? '本次发布已暂停' : noticeJob?.aheadCount ? '已追加到发布队列末尾' : '已加入后台发布队列'}</strong>
          <span>{publishNotice.count} 件商品 · 完成 {noticeCompleted}/{publishNotice.count}{noticeJob && ` · 失败 ${noticeJob.items.filter((item) => item.status === 'failed').length}`}{noticeJob?.items.some((item) => item.status === 'paused') && ` · 暂停 ${noticeJob.items.filter((item) => item.status === 'paused').length}`}{noticeJob?.aheadCount ? ` · 前面还有 ${noticeJob.aheadCount} 件` : ''} · 可以继续选品</span>
        </div>
        {noticeJob?.items.some((item) => item.status === 'queued') && (
          <button type="button" className="ghost danger" disabled={pausingJobId === noticeJob.id} onClick={() => void pausePublishJob(noticeJob.id)}>
            {pausingJobId === noticeJob.id ? '暂停中…' : '暂停发布'}
          </button>
        )}
        <button type="button" className="ghost" onClick={() => setPublishNotice(null)}>收起</button>
      </div>}
      </div>}

      {aiOpen && (
        <AiTitleDialog
          ids={[...selected]}
          material={aiMaterial}
          busy={operationBusy}
          onClose={() => setAiOpen(false)}
          onApply={applyAiTitles}
        />
      )}

      {busy && <div className="ok">{busy}</div>}
      {error && <div className="error"><ErrorSummary message={error} /></div>}
      {shopSync && (
        <div className="notice">
          已同步 {shopSync.ok} 个店铺刊登
          {shopSync.unmatchedRemote ? ` · ${shopSync.unmatchedRemote} 个平台商品未关联本地记录` : ''}
          {shopSync.failed ? ` · ${shopSync.failed} 个店铺同步失败` : ''}
          {shopSync.usedFallback ? ' · 本次走逐条同步' : ''}
        </div>
      )}

      {/* 批量结果 */}
      {result && (
        <div className="issues">
          <strong>
            {result.kind === 'publish'
                ? '批量发布结果'
                : result.kind === 'ai-title'
                  ? '批量 AI 改标题结果'
                  : result.kind === 'remove-remote'
                    ? '从 Joom 删除结果'
                    : '批量操作结果'}{' '}
            · 成功 {okCount}/{result.items.length}
          </strong>
          <ul>
            {result.items.map((it) => (
              <li key={it.id} className={it.ok ? ('unresolved' in it && it.unresolved?.length ? 'iss-warning' : 'iss-ok') : 'iss-error'}>
                <span className="tag">{it.ok ? ('unresolved' in it && it.unresolved?.length ? '部分' : 'OK') : '失败'}</span>
                {result.kind === 'remove-remote' && 'deletedLocal' in it && it.deletedLocal ? (
                  <span>{titleOf(it.id)}</span>
                ) : result.kind === 'remove-remote' && !items.some((p) => p.id === it.id) ? (
                  <code>{it.id}</code>
                ) : (
                  <Link to={`/products/${it.id}`} target="_blank" rel="noopener noreferrer">{titleOf(it.id)}</Link>
                )}
                {result.kind === 'publish' && it.ok && 'joomProductId' in it && (
                  <code>{(it as BatchPublishItem).joomProductId}</code>
                )}
                {result.kind === 'remove-remote' && it.ok && (
                  <span className="reason" style={{ color: '#166534' }}>
                    {'alreadyGone' in it && it.alreadyGone ? '线上已不存在' : '已删除'}
                    {'deletedLocal' in it && it.deletedLocal ? ' · 已删本地' : 'discarded' in it && it.discarded ? ' · 已入废弃箱' : ''}
                  </span>
                )}
                {!it.ok && renderReason(it)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading ? (
        <p className="muted">加载中…</p>
      ) : visibleItems.length === 0 ? (
        <div className="empty-state">
          {items.length === 0
            ? '还没有采集的商品。用浏览器插件在 AliExpress / Allegro / ASOS / Joom 等来源页点采集，商品会出现在这里。'
            : mode === 'publish' && actionLists.publish.length === 0
              ? '发布清单还是空的。请到“商品浏览”选择商品并加入发布清单。'
            : mode === 'remove' && actionLists.remove.length === 0
              ? '删除清单还是空的。请到“商品浏览”选择不再需要的商品。'
            : idLookupActive
              ? '采集箱中没有这些 ID。可能未采集、已删除，或非本工具发布。'
              : reasonFilter !== 'all'
                ? `没有匹配「${JOOM_REVIEW_REASON_META[reasonFilter].label}」的商品。`
              : searchQ
                ? `没有匹配「${searchInput.trim()}」的商品。`
                : '当前筛选条件下没有商品。'}
        </div>
      ) : view === 'table' ? (
        <div className="table-wrap plist-wrap">
          <table className="plist">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="全选当前页" />
                </th>
                <th style={{ width: 56 }}>图</th>
                <th>标题</th>
                <th style={{ width: 110 }}>价格</th>
                <th style={{ width: 88 }}>状态</th>
                <th style={{ width: 72 }}>店铺</th>
                <th style={{ width: 190 }}>当前模板</th>
                <th style={{ width: 64 }}>质量</th>
                <th style={{ width: 205 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((p) => {
                const snap = productSnap(p);
                const isSel = selected.has(p.id);
                return (
                  <tr
                    key={p.id}
                    className={isSel ? 'sel' : undefined}
                    onClick={(event) => { if (!clickedSelectionControl(event)) toggle(p.id); }}
                  >
                    <td>
                      <input type="checkbox" checked={isSel} onChange={() => toggle(p.id)} aria-label={`选择商品：${snap.title}`} />
                    </td>
                    <td className="plist-image-cell">
                      {snap.images[0] ? (
                        <img
                          className="plist-thumb"
                          src={snap.images[0]}
                          alt=""
                          loading="lazy"
                          onError={(e) => fallbackToAllegroOriginal(e.currentTarget)}
                          onMouseEnter={(e) => setImagePreview({ src: imagePreviewSource(snap.images[0]), x: e.clientX, y: e.clientY })}
                          onMouseMove={(e) => setImagePreview({ src: imagePreviewSource(snap.images[0]), x: e.clientX, y: e.clientY })}
                          onMouseLeave={() => setImagePreview(null)}
                        />
                      ) : <span className="muted">无图</span>}
                    </td>
                    <td>
                      <div className="plist-title">{snap.title}</div>
                      <ProductGroupingBadges product={p} />
                      {(productBucketForShop(p, joom?.shopId) === 'error' || productBucketForShop(p, joom?.shopId) === 'optimize' || p.joomIssues) && (
                        <div className="plist-issue" title={p.joomIssues || undefined}>
                          审核：{summarizeJoomIssues(p.joomIssueDetails, p.joomIssues)[0]?.meta.label ?? 'Joom 审核异常'}
                        </div>
                      )}
                      {(p.status === 'failed' || p.status === 'discarded') && p.lastError && !p.joomIssues && <ErrorSummary message={p.lastError} />}
                      <div className="plist-meta">
                        {isRecentlyEdited(p) && <span className="badge just-edited">刚编辑</span>}
                        {p.languageRisk && <span className="badge non-en">含非英文</span>}
                        {p.joomProductId && <code title={p.joomProductId}>{p.joomProductId}</code>}
                      </div>
                    </td>
                    <td className="price">{snap.price} {snap.currency}</td>
                    <td><span className={`badge ${publishStatusById.has(p.id) ? 'publishing' : p.status}`}>{publishStatusById.get(p.id) === 'queued' ? '排队中' : publishStatusById.get(p.id) === 'running' ? '发布中' : STATUS_LABEL[p.status] ?? p.status}</span></td>
                    <td><ListingBadge p={p} shopId={joom?.shopId} /></td>
                    <td className="quick-template-cell">
                      <button
                        type="button"
                        className={`quick-template-apply ${quickTemplateDoneIds.has(p.id) ? 'done' : ''}`}
                        disabled={!selectedTemplate || quickTemplateBusy || operationBusy || p.status === 'discarded' || activePublishIds.has(p.id)}
                        onClick={() => selectedTemplate && void applyQuickTemplate([p.id], selectedTemplate.id)}
                        title={`当前模板：${templateNameById.get(p.templateId ?? defaultTemplateId) ?? '未指定'}；${p.status === 'discarded' ? '废弃箱商品不能套用模板' : `点击套用「${selectedTemplate?.name ?? '上方已选模板'}」`}`}
                      >
                        <b>{templateNameById.get(p.templateId ?? defaultTemplateId) ?? '未指定'}</b>
                        <small>
                          {quickTemplateDoneIds.has(p.id)
                            ? '已更换成功'
                            : quickTemplateBusy
                              ? '应用中…'
                              : (p.templateId ?? defaultTemplateId) === selectedTemplate?.id
                                ? '点击重新套用'
                                : `套用 → ${selectedTemplate?.name ?? '选择模板'}`}
                        </small>
                      </button>
                    </td>
                    <td>{p.qualityScore ? <b className={`score-${p.qualityScore.grade}`}>{p.qualityScore.score}</b> : '—'}</td>
                    <td className="plist-actions">
                      {p.status === 'discarded' ? (
                        <button onClick={() => restore(p.id)}>恢复</button>
                      ) : (
                        <>
                          <Link to={`/products/${p.id}`} target="_blank" rel="noopener noreferrer"><button className="ghost">编辑</button></Link>
                          {mode === 'publish' && <button type="button" disabled={!joom?.connected || !!submittingId || activePublishIds.has(p.id)} onClick={() => void publishOne(p.id)}>
                            {activePublishIds.has(p.id) ? '发布中' : submittingId === p.id ? '提交中' : p.joomProductId ? '更新' : '发布'}
                          </button>}
                        </>
                      )}
                      {mode === 'remove' && <ConfirmPopover
                        title="删除这个商品？"
                        description={deleteConfirmDescription(snap.title)}
                        disabled={deletingId === p.id || activePublishIds.has(p.id)}
                        onConfirm={() => remove(p.id)}
                      >
                          <button className="ghost" type="button" disabled={deletingId === p.id || activePublishIds.has(p.id)}>
                          {deletingId === p.id ? '删除中…' : '删除'}
                        </button>
                      </ConfirmPopover>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid">
          {pageItems.map((p) => {
            const snap = productSnap(p);
            const isSel = selected.has(p.id);
            return (
              <div
                className={`card ${isSel ? 'sel' : ''}`}
                key={p.id}
                onClick={(event) => { if (!clickedSelectionControl(event)) toggle(p.id); }}
              >
                <label className="cardsel">
                  <input type="checkbox" checked={isSel} onChange={() => toggle(p.id)} aria-label={`选择商品：${snap.title}`} />
                </label>
                {snap.images[0] ? (
                  <img
                    src={snap.images[0]}
                    alt=""
                    loading="lazy"
                    onError={(e) => fallbackToAllegroOriginal(e.currentTarget)}
                  />
                ) : <div className="card-image-placeholder">无图</div>}
                <div className="body">
                  <span className={`badge ${publishStatusById.has(p.id) ? 'publishing' : p.status}`}>{publishStatusById.get(p.id) === 'queued' ? '排队中' : publishStatusById.get(p.id) === 'running' ? '发布中' : STATUS_LABEL[p.status] ?? p.status}</span>
                  {isRecentlyEdited(p) && <span className="badge just-edited">刚编辑</span>}
                  {p.languageRisk && <span className="badge non-en">含非英文</span>}
                  <ListingBadge p={p} shopId={joom?.shopId} />
                  {(() => {
                    const hit = lookupByProduct.get(p.id);
                    if (!hit) return null;
                    if (hit.via === 'sku') {
                      return <span className="badge listing-unsynced">{hit.collision ? 'SKU 重复' : 'SKU 命中'}</span>;
                    }
                    return null;
                  })()}
                  {((productBucketForShop(p, joom?.shopId) === 'error' || productBucketForShop(p, joom?.shopId) === 'optimize') || p.joomIssues) && (
                    <div className={`joom-diagnostic ${productBucketForShop(p, joom?.shopId) === 'error' ? 'is-error' : 'is-warning'}`}>
                      <div className="joom-diagnostic-head">
                        <strong>{productBucketForShop(p, joom?.shopId) === 'error' ? (p.joomHasActiveVersion ? '当前版本未通过 · 旧版本仍在售' : '审核未通过') : '店铺提示'}</strong>
                        {p.lastSyncedAt && <span>同步于 {formatSyncTime(p.lastSyncedAt)}</span>}
                      </div>
                      <JoomReviewSummary details={p.joomIssueDetails} fallback={p.joomIssues || undefined} />
                      {!p.joomIssueDetails?.length && (productBucketForShop(p, joom?.shopId) === 'error' || productBucketForShop(p, joom?.shopId) === 'optimize') && (
                        <button className="diagnostic-sync" onClick={() => syncOne(p.id)} disabled={!!busy}>刷新原因</button>
                      )}
                    </div>
                  )}
                  <div className="title">{snap.title}</div>
                  <ProductGroupingBadges product={p} />
                  <div className="price">
                    {snap.price} {snap.currency}
                  </div>
                  <button
                    type="button"
                    className={`quick-template-card ${quickTemplateDoneIds.has(p.id) ? 'done' : ''}`}
                    disabled={!selectedTemplate || quickTemplateBusy || operationBusy || p.status === 'discarded' || activePublishIds.has(p.id)}
                    onClick={() => selectedTemplate && void applyQuickTemplate([p.id], selectedTemplate.id)}
                    title={`当前模板：${templateNameById.get(p.templateId ?? defaultTemplateId) ?? '未指定'}；${p.status === 'discarded' ? '废弃箱商品不能套用模板' : `点击套用「${selectedTemplate?.name ?? '上方已选模板'}」`}`}
                  >
                    <span>当前模板</span>
                    <b>{templateNameById.get(p.templateId ?? defaultTemplateId) ?? '未指定'}</b>
                    <small>
                      {quickTemplateDoneIds.has(p.id)
                        ? '已更换'
                        : (p.templateId ?? defaultTemplateId) === selectedTemplate?.id
                          ? '重新套用此模板'
                          : `切换为：${selectedTemplate?.name ?? '选择模板'}`}
                    </small>
                  </button>
                  {p.qualityScore && <div className="quality-line"><span>质量分</span><b className={`score-${p.qualityScore.grade}`}>{p.qualityScore.score}</b></div>}
                  {p.joomProductId && (
                    <div className="joomid" title={`Joom 商品 id: ${p.joomProductId}`}>
                      <span className="muted">Joom id</span>
                      <code>{p.joomProductId}</code>
                      <button className="copy-btn" onClick={() => copyId(p.joomProductId!)}>
                        {copiedId === p.joomProductId ? '已复制' : '复制'}
                      </button>
                    </div>
                  )}
                  {lookupByProduct.get(p.id)?.via === 'sku' && p.edited?.sku && (
                    <div className="joomid" title={`SKU: ${p.edited.sku}`}>
                      <span className="muted">SKU</span>
                      <code>{p.edited.sku}</code>
                    </div>
                  )}
                  {typeof p.joomInventory === 'number' && (p.joomProductId || p.lastSyncedAt) && (
                    <div className="muted">店铺库存 {p.joomInventory}</div>
                  )}
                  {(p.status === 'failed' || p.status === 'discarded') && p.lastError && !p.joomIssues && (
                    <ErrorSummary message={p.lastError} />
                  )}
                </div>
                <div className="actions">
                  {p.status === 'discarded' ? (
                    <button onClick={() => restore(p.id)}>恢复商品</button>
                  ) : (
                    <>
                      <Link to={`/products/${p.id}`} target="_blank" rel="noopener noreferrer" className="card-edit"><button className="ghost">编辑</button></Link>
                      {mode === 'publish' && <button type="button" disabled={!joom?.connected || !!submittingId || activePublishIds.has(p.id)} title={!joom?.connected ? '请先连接 Joom' : undefined} onClick={() => void publishOne(p.id)}>
                        {activePublishIds.has(p.id) ? '发布中' : submittingId === p.id ? '提交中' : p.joomProductId ? '更新 Joom' : '直接发布'}
                      </button>}
                    </>
                  )}
                  {mode === 'remove' && <ConfirmPopover
                    title="删除这个商品？"
                    description={deleteConfirmDescription(snap.title)}
                    disabled={deletingId === p.id || activePublishIds.has(p.id)}
                    onConfirm={() => remove(p.id)}
                  >
                    <button className="ghost" type="button" disabled={deletingId === p.id || activePublishIds.has(p.id)}>
                      {deletingId === p.id ? '删除中…' : '删除'}
                    </button>
                  </ConfirmPopover>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {visibleItems.length > 0 && (
        <div className="pagination">
          <span className="muted">
            共 {visibleItems.length} 条 · 第 {currentPage}/{totalPages} 页
          </span>
          <label className="page-size">
            每页
            <select aria-label="每页商品数量" value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))}>
              {[10, 20, 50, 100, 150, 200].map((n) => (
                <option key={n} value={n}>
                  {n} 条
                </option>
              ))}
            </select>
          </label>
          <label className="page-jump">
            跳到
            <input
              type="number"
              min={1}
              max={totalPages}
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onBlur={() => jumpToPage()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  jumpToPage();
                }
              }}
              aria-label="跳转到页码"
            />
            / {totalPages} 页
            <button className="ghost" type="button" onClick={() => jumpToPage()}>
              跳转
            </button>
          </label>
          <button className="ghost" onClick={() => setPage(1)} disabled={currentPage === 1}>
            首页
          </button>
          <button className="ghost" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}>
            上一页
          </button>
          <span className="page-number">{currentPage}</span>
          <button className="ghost" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>
            下一页
          </button>
          <button className="ghost" onClick={() => setPage(totalPages)} disabled={currentPage === totalPages}>
            末页
          </button>
        </div>
      )}

      {view === 'table' && imagePreview && (
        <div
          className="hover-preview"
          style={{
            left: Math.min(imagePreview.x + 24, Math.max(12, window.innerWidth - 340)),
            top: Math.min(imagePreview.y + 16, Math.max(12, window.innerHeight - 340)),
          }}
        >
          <img src={imagePreview.src} alt="商品大图预览" />
        </div>
      )}
      {dockVisible && <div className="batch-dock-spacer" style={{ height: dockHeight + 32 }} aria-hidden="true" />}
      {sorterOpen && (
        <TemplateSorter
          products={items}
          templates={presetTemplates}
          bindings={groupBindings}
          activeIds={sorterExcludedIds}
          scope={actionListScope}
          onClose={(updated) => {
            setSorterOpen(false);
            if (!updated.length) return;
            // 只替换分拣改过的商品，避免重新下载全库。
            const latest = new Map(updated.map((record) => [record.id, record]));
            setItems((current) => current.map((p) => latest.get(p.id) ?? p));
            showFeedback(`分拣已保存，更新了 ${updated.length} 件商品`);
          }}
        />
      )}
    </>
  );
}

/** 失败原因:校验问题清单或错误信息 */
function renderReason(it: BatchPublishItem | BatchOperationItem | BatchRemoveRemoteItem) {
  if ('unresolved' in it && it.unresolved?.length) {
    const mapped = 'mappedCount' in it && it.mappedCount ? `已映射 ${it.mappedCount} 个；` : '';
    const defaulted = 'defaultedCount' in it && it.defaultedCount ? `自动补齐 ${it.defaultedCount} 个；` : '';
    return <span className="reason">{mapped}{defaulted}未识别：{it.unresolved.join('、')}</span>;
  }
  if ('defaultedCount' in it && it.ok && it.defaultedCount) {
    const mapped = 'mappedCount' in it && it.mappedCount ? `，映射 ${it.mappedCount} 个` : '';
    return <span className="reason" style={{ color: '#166534' }}>自动补齐 {it.defaultedCount} 个颜色{mapped}</span>;
  }
  if ('mappedCount' in it && it.ok && it.mappedCount) {
    return <span className="reason" style={{ color: '#166534' }}>映射 {it.mappedCount} 个颜色</span>;
  }
  if ('issues' in it && it.issues && it.issues.length) {
    return <ErrorSummary message={it.issues.map((i) => `${i.field ? `${i.field}: ` : ''}${i.message}`).join('；')} />;
  }
  if ('error' in it && it.error) return <ErrorSummary message={it.error} />;
  return null;
}

function JoomReviewSummary({ details, fallback }: { details?: JoomIssueDetail[]; fallback?: string }) {
  const groups = summarizeJoomIssues(details, fallback || 'Joom 已返回审核异常，但没有返回可识别的原因');
  const total = groups.reduce((count, group) => count + group.items.length, 0);
  const primary = groups[0];
  if (!primary) return null;
  return (
    <div className="review-summary">
      <div className="review-reason-row">
        <strong>{primary.meta.label}</strong>
        {groups.slice(1, 3).map((group) => <span className="review-reason-chip" key={group.key}>{group.meta.label}</span>)}
        {groups.length > 3 && <span className="review-reason-more">另有 {groups.length - 3} 类问题</span>}
      </div>
      <p>{primary.meta.advice}</p>
      <details className="joom-issue-details">
        <summary>查看具体问题（{total}）</summary>
        <ul>
          {groups.map((group) => (
            <li className="review-detail-group" key={group.key}>
              <strong>{group.meta.label}</strong>
              <ul>
                {group.items.map((detail, index) => (
                  <li key={`${detail.code ?? 'issue'}-${index}`}>
                    <span className="joom-issue-message">{detail.message}</span>
                    {(detail.field || detail.variantSku || detail.code) && (
                      <span className="joom-issue-meta">
                        {[detail.field && `字段：${detail.field}`, detail.variantSku && `变体 SKU：${detail.variantSku}`, detail.code && `平台代码：${detail.code}`].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function formatSyncTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(iso).toLocaleString();
}

function productSnap(p: ProductRecord) {
  return p.edited
    ? {
        title: p.edited.title,
        images: p.edited.images,
        price: p.edited.variants[0]?.price ?? 0,
        currency: p.edited.currency,
      }
    : {
        title: p.collected.title,
        images: p.collected.images,
        price: p.collected.price?.value ?? 0,
        currency: p.collected.price?.currency ?? '',
      };
}

function ListingBadge({ p, shopId }: { p: ProductRecord; shopId?: string }) {
  const bucket = productBucketForShop(p, shopId);
  if (bucket) return <span className={`badge listing-${bucket}`}>{JOOM_BUCKET_META[bucket].label}</span>;
  if (p.joomProductId || p.status === 'published') return <span className="badge listing-unsynced">未同步</span>;
  return null;
}

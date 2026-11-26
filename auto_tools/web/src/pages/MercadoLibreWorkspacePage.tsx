import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { MercadoLibreConfigPublic, MercadoLibreListingIndexItem, ProductRecord } from '@shared/types';
import type { ProductIndexItem } from '@shared/product-catalog';
import { api } from '../api';
import { useProductCards } from '../product-cards';
import { useNativePrompt } from '../components/NativePromptProvider';
import { productSearchText, remainingSelectedProducts, runListingBatch, selectedListingTargets, WORKSPACE_PAGE_SIZE, type BulkAction, type ListingBatchResult } from './mercadolibre-workspace';

const sites = ['MLC', 'MLM', 'MCO'] as const;
const statusOrder: MercadoLibreListingIndexItem['status'][] = ['draft', 'validating', 'publishing', 'published', 'paused', 'failed'];
type StatusFilter = 'all' | MercadoLibreListingIndexItem['status'];
type SortMode = 'updated_desc' | 'title_asc' | 'status_first';

export function MercadoLibreWorkspacePage() {
  const nativePrompt = useNativePrompt();
  const [config, setConfig] = useState<MercadoLibreConfigPublic | null>(null);
  const [products, setProducts] = useState<ProductIndexItem[]>([]);
  const [listings, setListings] = useState<MercadoLibreListingIndexItem[]>([]);
  const [page, setPage] = useState(1);
  const [siteFilter, setSiteFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('updated_desc');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<ProductRecord | null>(null);
  const [selectingProductId, setSelectingProductId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [productQuery, setProductQuery] = useState('');
  const [accountId, setAccountId] = useState('');
  const [siteIds, setSiteIds] = useState<string[]>(['MLC']);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [batchProgress, setBatchProgress] = useState({ completed: 0, total: 0 });
  const [batchResult, setBatchResult] = useState<{ action: BulkAction; results: ListingBatchResult[] } | null>(null);
  const [failurePage, setFailurePage] = useState(1);
  const [refreshing, setRefreshing] = useState(true);
  const [params, setParams] = useSearchParams();
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const sourceRequest = useRef(0);
  const batchRunning = useRef(false);
  const batchController = useRef<AbortController | null>(null);

  async function load(options?: { silent?: boolean }) {
    const request = ++loadRequest.current;
    if (!options?.silent) setRefreshing(true);
    try {
      const [nextConfig, sourceProducts, nextListings] = await Promise.all([
        api.mercadoLibreConfig(), api.productIndex(), api.mercadoLibreListingIndex(),
      ]);
      if (!mounted.current || request !== loadRequest.current) return;
      setConfig(nextConfig);
      setProducts(sourceProducts);
      setListings(nextListings);
      setAccountId((current) => current || nextConfig.connectedAccounts[0]?.id || '');
      const existing = new Set(nextListings.map((listing) => listing.productId));
      setSelectedIds((current) => new Set([...current].filter((id) => existing.has(id))));
      setError('');
    } catch (e) { if (mounted.current && request === loadRequest.current) setError((e as Error).message); }
    finally { if (mounted.current && request === loadRequest.current) setRefreshing(false); }
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; loadRequest.current++; sourceRequest.current++; batchController.current?.abort(); };
  }, []);
  useEffect(() => {
    if (params.get('mercadolibre') === 'connected') { setParams({}, { replace: true }); void load(); }
  }, [params, setParams]);
  const sourceProductId = params.get('productId');
  useEffect(() => {
    if (!sourceProductId) return;
    setCreateOpen(true);
    void selectSourceProduct(sourceProductId);
  }, [sourceProductId]);
  useEffect(() => { setPage(1); }, [query, siteFilter, statusFilter, sortMode]);

  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const listingProductCount = useMemo(() => new Set(listings.map((listing) => listing.productId)).size, [listings]);
  const sourceSearchById = useMemo(() => new Map(products.map((product) => [product.id, productSearchText(product)])), [products]);
  const siteVisible = useMemo(() => listings.filter((item) => siteFilter === 'all' || item.siteId === siteFilter), [listings, siteFilter]);
  const allProductGroups = useMemo(() => groupListings(siteVisible), [siteVisible]);
  const visibleListings = useMemo(() => siteVisible.filter((item) => statusFilter === 'all' || item.status === statusFilter), [siteVisible, statusFilter]);
  const productGroups = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const groups = groupListings(visibleListings).filter((group) => {
      if (!keyword) return true;
      const text = [sourceSearchById.get(group.productId), ...group.listings.map((item) => `${item.siteId} ${item.title} ${item.categoryId || ''} ${item.skuSearchText || ''}`)].join(' ').toLowerCase();
      return text.includes(keyword);
    });
    return groups.sort((a, b) => {
      const aProduct = productById.get(a.productId);
      const bProduct = productById.get(b.productId);
      if (sortMode === 'title_asc') return (aProduct?.collected.title || a.listings[0]?.title || '').localeCompare(bProduct?.collected.title || b.listings[0]?.title || '');
      if (sortMode === 'status_first') return statusRank(a.listings) - statusRank(b.listings);
      return latestTimestamp(b.listings) - latestTimestamp(a.listings);
    });
  }, [visibleListings, productById, sourceSearchById, query, sortMode]);
  const statusCounts = useMemo(() => statusOrder.reduce((result, status) => {
    result[status] = allProductGroups.filter((group) => group.listings.some((item) => item.status === status)).length;
    return result;
  }, {} as Record<MercadoLibreListingIndexItem['status'], number>), [allProductGroups]);
  const totalPages = Math.max(1, Math.ceil(productGroups.length / WORKSPACE_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageGroups = useMemo(() => productGroups.slice((currentPage - 1) * WORKSPACE_PAGE_SIZE, currentPage * WORKSPACE_PAGE_SIZE), [productGroups, currentPage]);
  const pageIds = pageGroups.map((group) => group.productId);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const selectedTargets = useMemo(() => selectedListingTargets(listings, selectedIds), [listings, selectedIds]);
  const connected = (config?.connectedAccounts?.length ?? 0) > 0;
  const selectableProducts = useMemo(() => {
    const keyword = productQuery.trim().toLowerCase();
    return products.filter((product) => {
      if (product.status === 'discarded') return false;
      if (!keyword) return true;
      return sourceSearchById.get(product.id)?.includes(keyword);
    }).slice(0, 12);
  }, [products, sourceSearchById, productQuery]);
  const cardRows = useMemo(() => {
    const ids = new Set(pageGroups.map((group) => group.productId));
    if (createOpen && !selected) selectableProducts.forEach((product) => ids.add(product.id));
    return [...ids].flatMap((id) => { const product = productById.get(id); return product ? [product] : []; });
  }, [pageGroups, productById, createOpen, selected, selectableProducts]);
  const cardPage = useProductCards(cardRows);
  const cardById = useMemo(() => new Map(cardPage.cards.map((card) => [card.id, card])), [cardPage.cards]);
  const failures = useMemo(() => batchResult?.results.filter((result) => !result.ok) ?? [], [batchResult]);
  const failurePages = Math.max(1, Math.ceil(failures.length / 10));
  const currentFailurePage = Math.min(failurePage, failurePages);
  const retryTargets = useMemo(() => {
    const failedIds = new Set(batchResult?.results.filter((result) => !result.ok).map((result) => result.listing.id));
    return listings.filter((listing) => failedIds.has(listing.id));
  }, [batchResult, listings]);
  const setupSteps = [
    { label: '应用配置', done: Boolean(config?.configured), detail: config?.configured ? 'App 信息已保存' : '填写 App ID 与回调地址', to: '/mercadolibre/settings' },
    { label: '连接卖家', done: connected, detail: connected ? `${config?.connectedAccounts.length} 个账号可用` : '完成 OAuth 授权', to: '/mercadolibre/settings' },
    { label: '创建刊登', done: listings.length > 0, detail: listings.length ? `${listingProductCount} 个商品在管理` : '从采集母库选择商品', action: true },
  ];

  function openCreateModal() {
    sourceRequest.current++;
    setSelected(null);
    setSelectingProductId('');
    setProductQuery('');
    setCreateOpen(true);
    setNotice('');
  }

  function closeCreateModal() {
    if (busy) return;
    sourceRequest.current++;
    setSelectingProductId('');
    setCreateOpen(false);
    setSelected(null);
    setParams({}, { replace: true });
  }

  async function selectSourceProduct(id: string) {
    const request = ++sourceRequest.current;
    setSelectingProductId(id);
    setError('');
    try {
      const { record } = await api.getProduct(id);
      if (mounted.current && request === sourceRequest.current) setSelected(record);
    } catch (error) {
      if (mounted.current && request === sourceRequest.current) setError((error as Error).message);
    } finally {
      if (mounted.current && request === sourceRequest.current) setSelectingProductId('');
    }
  }

  function toggleSite(site: string) {
    setSiteIds((current) => current.includes(site) ? current.filter((item) => item !== site) : [...current, site]);
  }

  function toggleSelected(productId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(productId)) next.delete(productId); else next.add(productId);
      return next;
    });
  }

  function togglePage() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  }

  async function createDrafts() {
    if (!selected || !accountId || !siteIds.length) return;
    setBusy(true); setError('');
    try {
      await api.createMercadoLibreListings(selected.id, accountId, siteIds);
      setSelected(null);
      setCreateOpen(false);
      setParams({}, { replace: true });
      setNotice(`已为“${selected.collected.title}”创建 ${siteIds.length} 个站点草稿`);
      await load({ silent: true });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function runBulkAction(action: BulkAction, targets = selectedTargets) {
    if (!targets.length || batchRunning.current) return;
    batchRunning.current = true;
    const controller = new AbortController();
    batchController.current = controller;
    setBusyAction(action); setError(''); setNotice(''); setBatchResult(null);
    setBatchProgress({ completed: 0, total: targets.length });
    try {
      const results = await runListingBatch(action, targets, api, (completed, total) => {
        if (mounted.current) setBatchProgress({ completed, total });
      }, controller.signal);
      if (!mounted.current) return;
      setBatchResult({ action, results });
      setFailurePage(1);
      setSelectedIds((current) => remainingSelectedProducts(current, results));
      const success = results.filter((result) => result.ok).length;
      setNotice(`${action === 'validate' ? '校验' : '发布/更新'}完成：${success}/${targets.length} 个站点${action === 'validate' ? '通过' : '成功'}${success < targets.length ? `，${targets.length - success} 个需处理` : ''}`);
      await load({ silent: true });
    } finally {
      batchRunning.current = false;
      if (batchController.current === controller) batchController.current = null;
      if (mounted.current) setBusyAction('');
    }
  }

  async function retryFailed() {
    if (!batchResult || !retryTargets.length || batchRunning.current) return;
    if (batchResult.action === 'publish' && !await nativePrompt.confirm('上次发布失败的站点可能已经在平台创建成功。请先核对线上结果，确认后再重试这些站点。继续重试？')) return;
    await runBulkAction(batchResult.action, retryTargets);
  }

  if (!config) return <div className="empty-state">{refreshing ? <p role="status">正在加载美客多工作区…</p> : <><p className="error">{error || '工作区加载失败'}</p><button className="button secondary" onClick={() => void load()}>重新加载</button></>}</div>;

  return <div className="ml-workspace">
    <div className="workspace-heading">
      <div><div className="eyebrow">MERCADO LIBRE</div><h2>美客多刊登中心</h2><p>从母库选品、完善站点信息，并统一发布到智利、墨西哥和哥伦比亚</p></div>
      <div className="workspace-heading-actions"><span className={`connection-pill ${connected ? 'connected' : ''}`}><i />{connected ? `${config?.connectedAccounts.length} 个卖家已连接` : '尚未连接卖家'}</span><Link className="button secondary" to="/mercadolibre/settings">平台设置</Link><button className="button primary" onClick={() => openCreateModal()} disabled={!products.length || !connected}>＋ 创建刊登</button></div>
    </div>

    {notice && <div className="ok ml-alert">{notice}</div>}{error && <div className="error ml-alert">{error}</div>}

    {(!config?.configured || !connected || !listings.length) && <div className="ml-setup-guide"><div className="setup-guide-copy"><span className="eyebrow">快速开始</span><strong>完成 3 步即可发布商品</strong></div><div className="setup-steps">{setupSteps.map((step, index) => step.action ? <button type="button" className={`setup-step ${step.done ? 'done' : ''}`} key={step.label} onClick={() => openCreateModal()} disabled={!connected || !products.length}><i>{step.done ? '✓' : index + 1}</i><span><b>{step.label}</b><small>{step.detail}</small></span></button> : <Link className={`setup-step ${step.done ? 'done' : ''}`} key={step.label} to={step.to!}><i>{step.done ? '✓' : index + 1}</i><span><b>{step.label}</b><small>{step.detail}</small></span></Link>)}</div></div>}

    <div className="ml-stat-grid"><button className={`ml-stat ${statusFilter === 'all' ? 'on' : ''}`} onClick={() => setStatusFilter('all')}><strong>{allProductGroups.length}</strong><span>全部商品</span></button><button className={`ml-stat ${statusFilter === 'draft' ? 'on' : ''}`} onClick={() => setStatusFilter('draft')}><strong>{statusCounts.draft}</strong><span>有草稿商品</span></button><button className={`ml-stat ${statusFilter === 'published' ? 'on' : ''}`} onClick={() => setStatusFilter('published')}><strong>{statusCounts.published}</strong><span>已发布商品</span></button><button className={`ml-stat warning ${statusFilter === 'failed' ? 'on' : ''}`} onClick={() => setStatusFilter('failed')}><strong>{statusCounts.failed}</strong><span>发布失败商品</span></button></div>

    <div className="ml-toolbar ml-management-toolbar"><div className="search-control"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索商品名称、SKU、来源 ID 或站点" />{query && <button type="button" onClick={() => setQuery('')}>×</button>}</div><div className="filter-group"><span className="filter-label">站点</span>{['all', ...sites].map((site) => <button key={site} className={siteFilter === site ? 'filter-pill on' : 'filter-pill'} onClick={() => setSiteFilter(site)}>{site === 'all' ? '全部' : site}</button>)}</div><select className="sort-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}><option value="all">全部状态</option><option value="draft">草稿</option><option value="validating">待校验</option><option value="publishing">发布中</option><option value="published">已发布</option><option value="paused">已暂停</option><option value="failed">发布失败</option></select><select className="sort-select" value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)}><option value="updated_desc">最近更新</option><option value="title_asc">商品名称</option><option value="status_first">优先处理</option></select><span className="toolbar-count">共 {productGroups.length} 个商品</span><button className="button secondary small" onClick={() => void load()} disabled={refreshing}>{refreshing ? '刷新中…' : '刷新'}</button></div>

    {selectedIds.size > 0 && <div className="bulk-actionbar">
      <strong>已选择 {selectedIds.size} 个商品 · {selectedTargets.length} 个站点</strong>
      <span>跨页保留选择，将处理所选商品的全部站点（含筛选外站点）</span>
      <div className="toolbar-spacer" />
      <button className="button secondary small" onClick={() => void runBulkAction('validate')} disabled={Boolean(busyAction) || !selectedTargets.length}>{busyAction === 'validate' ? '校验中…' : '批量校验'}</button>
      <button className="button primary small" onClick={() => void runBulkAction('publish')} disabled={Boolean(busyAction) || !selectedTargets.length}>{busyAction === 'publish' ? '发布中…' : '批量发布/更新'}</button>
      <button className="text-button" disabled={Boolean(busyAction)} onClick={() => setSelectedIds(new Set())}>清除选择</button>
    </div>}
    {busyAction && <div className="ml-alert" role="status">{busyAction === 'validate' ? '正在校验' : '正在发布/更新'}：{batchProgress.completed} / {batchProgress.total} 个站点，请保持本页打开。</div>}
    {failures.length > 0 && <section className="section" aria-label="批量处理失败结果">
      <div className="section-head">
        <strong>{failures.length} 个站点需要处理</strong>
        <button className="button secondary small" disabled={Boolean(busyAction) || !retryTargets.length} onClick={() => void retryFailed()}>{batchResult?.action === 'validate' ? '重新校验未通过站点' : '核对后重试失败站点'}</button>
      </div>
      {batchResult?.action === 'publish' && <p className="hint">发布请求失败不代表平台未收到，请先核对线上结果。重试只处理下列失败站点。</p>}
      <ul>{failures.slice((currentFailurePage - 1) * 10, currentFailurePage * 10).map(({ listing, error }) => <li key={listing.id}>
        <Link to={`/mercadolibre/products/${listing.productId}?listingId=${listing.id}`}>{listing.title} · {listing.siteId}</Link>：{error}
      </li>)}</ul>
      {failurePages > 1 && <div className="pagination"><span>第 {currentFailurePage} / {failurePages} 页</span><button className="ghost" disabled={currentFailurePage <= 1} onClick={() => setFailurePage(currentFailurePage - 1)}>上一页</button><button className="ghost" disabled={currentFailurePage >= failurePages} onClick={() => setFailurePage(currentFailurePage + 1)}>下一页</button></div>}
    </section>}
    {cardPage.error && <div className="error ml-alert">商品缩略信息加载失败：{cardPage.error} <button className="ghost" onClick={cardPage.retry}>重试</button></div>}

    {!connected && <div className="ml-empty-panel"><div className="empty-icon">ML</div><div><strong>先连接一个美客多卖家</strong><p>完成应用配置和账号授权后，即可创建各站点刊登。</p></div><Link className="button secondary" to="/mercadolibre/settings">去连接卖家</Link></div>}
    {connected && !productGroups.length && <div className="ml-empty-panel"><div className="empty-icon">＋</div><div><strong>{listings.length ? '没有符合筛选条件的商品' : '还没有美客多刊登'}</strong><p>{listings.length ? '换一个站点、状态或搜索词试试。' : '从采集母库选择商品，再创建智利、墨西哥或哥伦比亚刊登。'}</p></div>{listings.length ? <button className="button secondary" onClick={() => { setQuery(''); setSiteFilter('all'); setStatusFilter('all'); }}>清除筛选</button> : <button className="button primary" onClick={() => openCreateModal()} disabled={!products.length}>创建刊登</button>}</div>}

    {productGroups.length > 0 && <div className="ml-table-card"><div className="table-wrap"><table className="ml-table ml-management-table"><thead><tr><th className="select-col"><input type="checkbox" checked={allPageSelected} disabled={Boolean(busyAction)} onChange={togglePage} aria-label="选择本页全部商品" /></th><th className="product-col">商品</th><th>已创建站点</th><th>发布状态</th><th>类目</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{pageGroups.map((group) => {
      const product = productById.get(group.productId);
      const card = cardById.get(group.productId);
      const first = group.listings[0];
      const latest = group.listings.reduce((value, item) => item.updatedAt > value.updatedAt ? item : value, first);
      const categories = [...new Set(group.listings.map((item) => item.categoryId).filter(Boolean))];
      const needsAttention = group.listings.some((item) => item.status === 'failed' || !item.categoryId);
      return <tr key={group.productId} className={selectedIds.has(group.productId) ? 'selected-row' : ''}>
        <td className="select-col"><input type="checkbox" checked={selectedIds.has(group.productId)} disabled={Boolean(busyAction)} onChange={() => toggleSelected(group.productId)} aria-label={`选择${product?.collected.title || first.title}`} /></td>
        <td className="product-cell"><div className="product-cell-inner">
          {card?.sourceImage ? <img src={card.sourceImage} alt="" loading="lazy" /> : <div className="product-placeholder">{cardPage.loading ? '…' : 'ML'}</div>}
          <div><Link className="product-title" to={`/mercadolibre/products/${group.productId}?listingId=${first.id}`}>{product?.collected.title || first.title}</Link>
            <small>{group.listings.length} 个站点 · {card?.variantCount ?? '—'} 个变体 · 来源 ID {product?.collected.sourceProductId ?? '—'}</small>
            {group.listings.find((item) => item.lastError)?.lastError && <span className="row-error">{group.listings.find((item) => item.lastError)?.lastError}</span>}
          </div>
        </div></td>
        <td><div className="site-tags">{group.listings.map((item) => <span className="site-tag" key={item.id}>{item.siteId}<small>{siteName(item.siteId)}</small></span>)}</div></td>
        <td><div className="status-stack">{group.listings.map((item) => <span className={`ml-status ${statusClass(item.status)}`} key={item.id}><i />{item.siteId} {statusLabel(item.status)}</span>)}</div></td>
        <td><span className={categories.length ? 'category-value' : 'category-empty'}>{categories.length ? categories.join('、') : '待选择类目'}</span></td>
        <td className="time-cell">{formatDate(latest.updatedAt)}</td>
        <td className="action-cell"><div className="row-actions"><Link className={`table-action ${needsAttention ? 'attention-action' : ''}`} to={`/mercadolibre/products/${group.productId}?listingId=${first.id}`}>{needsAttention ? '继续完善' : '管理'}</Link>{card?.sourceUrl && <a className="table-action muted-action" href={card.sourceUrl} target="_blank" rel="noreferrer">来源</a>}</div></td>
      </tr>;
    })}</tbody></table></div></div>}
    {totalPages > 1 && <div className="pagination">
      <span>第 {currentPage} / {totalPages} 页 · 每页 {WORKSPACE_PAGE_SIZE} 件 · 共 {productGroups.length} 件</span>
      <button className="ghost" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
      <button className="ghost" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>下一页</button>
    </div>}

    {createOpen && <div className="modal-backdrop" onClick={closeCreateModal}>
      <div className="modal ml-create-modal" role="dialog" aria-modal="true" aria-labelledby="create-listing-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><div><span className="eyebrow">CREATE LISTING</span><h2 id="create-listing-title">创建美客多刊登</h2><p>先选母商品，再选择卖家和目标站点。</p></div><button type="button" className="modal-close" aria-label="关闭" onClick={closeCreateModal} disabled={busy}>×</button></div>
        <div className="modal-body">
          {error && <div className="error">{error}</div>}
          {selected ? <>
            <div className="selected-source">
              <div className="selected-source-thumb">{selected.collected.images[0] ? <img src={selected.collected.images[0]} alt="" /> : 'ML'}</div>
              <div><span>已选母商品</span><strong>{selected.collected.title}</strong><small>{selected.collected.images.length} 张图片 · {selected.collected.variants.length} 个变体 · {selected.collected.sourceProductId}</small></div>
              <button type="button" className="text-button source-change" disabled={busy} onClick={() => setSelected(null)}>更换</button>
            </div>
            <div className="field"><label>卖家账号</label><select value={accountId} disabled={busy} onChange={(e) => setAccountId(e.target.value)}>{config?.connectedAccounts.map((account) => <option value={account.id} key={account.id}>{account.nickname || account.userId} · {sellerModelLabel(account.model)}</option>)}</select></div>
            <div className="field"><label>目标站点 <span>可同时创建多个站点</span></label><div className="site-select-grid">{sites.map((site) => <button type="button" key={site} disabled={busy} className={siteIds.includes(site) ? 'site-select on' : 'site-select'} onClick={() => toggleSite(site)}><strong>{site}</strong><small>{siteName(site)}</small><i>{siteIds.includes(site) ? '✓' : ''}</i></button>)}</div></div>
          </> : <>
            <div className="source-picker-search"><span>⌕</span><input autoFocus value={productQuery} onChange={(e) => setProductQuery(e.target.value)} placeholder="搜索商品名称、SKU 或来源 ID" /></div>
            {selectingProductId && <p role="status">正在读取所选商品…</p>}
            {cardPage.error && <div className="error">缩略图加载失败 <button className="ghost" onClick={cardPage.retry}>重试</button></div>}
            <div className="source-picker-list">{selectableProducts.length ? selectableProducts.map((product) => {
              const card = cardById.get(product.id);
              return <button type="button" className="source-picker-item" key={product.id} onClick={() => void selectSourceProduct(product.id)} disabled={selectingProductId === product.id}>
                <span className="source-picker-thumb">{card?.sourceImage ? <img src={card.sourceImage} alt="" loading="lazy" /> : '—'}</span>
                <span><strong>{product.collected.title}</strong><small>{card?.variantCount ?? '—'} 个变体 · {product.collected.sourceProductId}</small></span><b>{selectingProductId === product.id ? '读取中…' : '选择'}</b>
              </button>;
            }) : <div className="source-picker-empty">{products.length ? '没有匹配的母商品，请换个关键词。' : '母库还没有商品，请先使用采集插件添加商品。'}</div>}</div>
          </>}
        </div>
        <div className="modal-foot">
          <span className="hint">{selected ? `将创建 ${siteIds.length} 个站点刊登` : `母库共 ${products.filter((item) => item.status !== 'discarded').length} 个可用商品`}</span>
          <div className="modal-actions"><button type="button" className="button secondary" onClick={closeCreateModal} disabled={busy}>取消</button>{selected && <button type="button" className="button primary" onClick={() => void createDrafts()} disabled={busy || !accountId || !siteIds.length}>{busy ? '创建中…' : `创建 ${siteIds.length} 个站点刊登`}</button>}</div>
        </div>
      </div>
    </div>}
  </div>;
}

function statusLabel(status: MercadoLibreListingIndexItem['status']) {
  return ({ draft: '草稿', validating: '待校验', publishing: '发布中', published: '已发布', paused: '已暂停', failed: '失败' } as Record<typeof status, string>)[status];
}

function statusClass(status: MercadoLibreListingIndexItem['status']) {
  return status === 'published' ? 'success' : status === 'failed' ? 'danger' : status === 'paused' ? 'paused' : 'pending';
}

function siteName(site: string) {
  return site === 'MLC' ? '智利' : site === 'MLM' ? '墨西哥' : site === 'MCO' ? '哥伦比亚' : site;
}

function sellerModelLabel(model: MercadoLibreConfigPublic['connectedAccounts'][number]['model']) {
  return ({ user_products: 'User Products', global_items: 'Global Items', fully_managed: '全托管', unknown: '模式待识别' } as const)[model];
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function latestTimestamp(listings: MercadoLibreListingIndexItem[]) {
  return Math.max(...listings.map((item) => Date.parse(item.updatedAt) || 0));
}

function statusRank(listings: MercadoLibreListingIndexItem[]) {
  const rank: Record<MercadoLibreListingIndexItem['status'], number> = { failed: 0, draft: 1, validating: 2, publishing: 3, paused: 4, published: 5 };
  return Math.min(...listings.map((item) => rank[item.status]));
}

interface ProductGroup { productId: string; listings: MercadoLibreListingIndexItem[]; }

function groupListings(items: MercadoLibreListingIndexItem[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();
  for (const item of items) {
    const group = groups.get(item.productId) || { productId: item.productId, listings: [] };
    group.listings.push(item);
    groups.set(item.productId, group);
  }
  return [...groups.values()];
}

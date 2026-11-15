import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { MercadoLibreConfigPublic, MercadoLibreListingDraft, ProductRecord } from '@shared/types';
import { api } from '../api';

const sites = ['MLC', 'MLM', 'MCO'] as const;
const statusOrder: MercadoLibreListingDraft['status'][] = ['draft', 'validating', 'publishing', 'published', 'paused', 'failed'];
type StatusFilter = 'all' | MercadoLibreListingDraft['status'];
type SortMode = 'updated_desc' | 'title_asc' | 'status_first';

export function MercadoLibreWorkspacePage() {
  const [config, setConfig] = useState<MercadoLibreConfigPublic | null>(null);
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [listings, setListings] = useState<MercadoLibreListingDraft[]>([]);
  const [siteFilter, setSiteFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('updated_desc');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<ProductRecord | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [productQuery, setProductQuery] = useState('');
  const [accountId, setAccountId] = useState('');
  const [siteIds, setSiteIds] = useState<string[]>(['MLC']);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [params, setParams] = useSearchParams();

  async function load(options?: { silent?: boolean }) {
    if (!options?.silent) setRefreshing(true);
    try {
      const [nextConfig, sourceProducts, nextListings] = await Promise.all([
        api.mercadoLibreConfig(), api.listProducts(), api.mercadoLibreListings(),
      ]);
      setConfig(nextConfig);
      setProducts(sourceProducts);
      setListings(nextListings);
      if (!accountId && nextConfig.connectedAccounts[0]) setAccountId(nextConfig.connectedAccounts[0].id);
      const sourceProductId = params.get('productId');
      if (sourceProductId) {
        setSelected(sourceProducts.find((product) => product.id === sourceProductId) ?? null);
        setCreateOpen(true);
      }
      setError('');
    } catch (e) { setError((e as Error).message); }
    finally { setRefreshing(false); }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (params.get('mercadolibre') === 'connected') { setParams({}, { replace: true }); void load(); }
  }, [params, setParams]);

  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const siteVisible = useMemo(() => listings.filter((item) => siteFilter === 'all' || item.siteId === siteFilter), [listings, siteFilter]);
  const allProductGroups = useMemo(() => groupListings(siteVisible), [siteVisible]);
  const visibleListings = useMemo(() => siteVisible.filter((item) => statusFilter === 'all' || item.status === statusFilter), [siteVisible, statusFilter]);
  const productGroups = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const groups = groupListings(visibleListings).filter((group) => {
      if (!keyword) return true;
      const product = productById.get(group.productId);
      const text = [product?.collected.title, product?.collected.sourceProductId, product?.collected.store?.name, ...(product?.collected.variants || []).map((item) => item.sourceSkuId || ''), ...group.listings.map((item) => `${item.siteId} ${item.title} ${item.categoryId || ''}`)].join(' ').toLowerCase();
      return text.includes(keyword);
    });
    return groups.sort((a, b) => {
      const aProduct = productById.get(a.productId);
      const bProduct = productById.get(b.productId);
      if (sortMode === 'title_asc') return (aProduct?.collected.title || a.listings[0]?.title || '').localeCompare(bProduct?.collected.title || b.listings[0]?.title || '');
      if (sortMode === 'status_first') return statusRank(a.listings) - statusRank(b.listings);
      return latestTimestamp(b.listings) - latestTimestamp(a.listings);
    });
  }, [visibleListings, productById, query, sortMode]);
  const statusCounts = useMemo(() => statusOrder.reduce((result, status) => {
    result[status] = allProductGroups.filter((group) => group.listings.some((item) => item.status === status)).length;
    return result;
  }, {} as Record<MercadoLibreListingDraft['status'], number>), [allProductGroups]);
  const visibleIds = productGroups.map((group) => group.productId);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const connected = (config?.connectedAccounts?.length ?? 0) > 0;
  const selectableProducts = useMemo(() => {
    const keyword = productQuery.trim().toLowerCase();
    return products.filter((product) => {
      if (product.status === 'discarded') return false;
      if (!keyword) return true;
      const text = [
        product.collected.title,
        product.collected.sourceProductId,
        product.collected.store?.name,
        ...product.collected.variants.map((variant) => variant.sourceSkuId || ''),
      ].join(' ').toLowerCase();
      return text.includes(keyword);
    }).slice(0, 12);
  }, [products, productQuery]);
  const setupSteps = [
    { label: '应用配置', done: Boolean(config?.configured), detail: config?.configured ? 'App 信息已保存' : '填写 App ID 与回调地址', to: '/mercadolibre/settings' },
    { label: '连接卖家', done: connected, detail: connected ? `${config?.connectedAccounts.length} 个账号可用` : '完成 OAuth 授权', to: '/mercadolibre/settings' },
    { label: '创建刊登', done: listings.length > 0, detail: listings.length ? `${groupListings(listings).length} 个商品在管理` : '从采集母库选择商品', action: true },
  ];

  function openCreateModal(product?: ProductRecord) {
    setSelected(product ?? null);
    setProductQuery('');
    setCreateOpen(true);
    setNotice('');
  }

  function closeCreateModal() {
    if (busy) return;
    setCreateOpen(false);
    setSelected(null);
    setParams({}, { replace: true });
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

  function toggleAllVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
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

  async function runBulkAction(action: 'validate' | 'publish') {
    const targets = productGroups.filter((group) => selectedIds.has(group.productId)).flatMap((group) => group.listings);
    if (!targets.length) return;
    setBusyAction(action); setError(''); setNotice('');
    const results = await Promise.allSettled(targets.map((item) => action === 'validate'
      ? api.validateMercadoLibreListing(item.id)
      : api.publishMercadoLibreListing(item.id)));
    const success = results.filter((result) => result.status === 'fulfilled').length;
    setSelectedIds(new Set());
    setBusyAction('');
    setNotice(`${action === 'validate' ? '校验' : '发布/更新'}完成：${success}/${targets.length} 个站点成功`);
    await load({ silent: true });
  }

  return <div className="ml-workspace">
    <div className="workspace-heading">
      <div><div className="eyebrow">MERCADO LIBRE</div><h2>美客多刊登中心</h2><p>从母库选品、完善站点信息，并统一发布到智利、墨西哥和哥伦比亚</p></div>
      <div className="workspace-heading-actions"><span className={`connection-pill ${connected ? 'connected' : ''}`}><i />{connected ? `${config?.connectedAccounts.length} 个卖家已连接` : '尚未连接卖家'}</span><Link className="button secondary" to="/mercadolibre/settings">平台设置</Link><button className="button primary" onClick={() => openCreateModal()} disabled={!products.length || !connected}>＋ 创建刊登</button></div>
    </div>

    {notice && <div className="ok ml-alert">{notice}</div>}{error && <div className="error ml-alert">{error}</div>}

    {(!config?.configured || !connected || !listings.length) && <div className="ml-setup-guide"><div className="setup-guide-copy"><span className="eyebrow">快速开始</span><strong>完成 3 步即可发布商品</strong></div><div className="setup-steps">{setupSteps.map((step, index) => step.action ? <button type="button" className={`setup-step ${step.done ? 'done' : ''}`} key={step.label} onClick={() => openCreateModal()} disabled={!connected || !products.length}><i>{step.done ? '✓' : index + 1}</i><span><b>{step.label}</b><small>{step.detail}</small></span></button> : <Link className={`setup-step ${step.done ? 'done' : ''}`} key={step.label} to={step.to!}><i>{step.done ? '✓' : index + 1}</i><span><b>{step.label}</b><small>{step.detail}</small></span></Link>)}</div></div>}

    <div className="ml-stat-grid"><button className={`ml-stat ${statusFilter === 'all' ? 'on' : ''}`} onClick={() => setStatusFilter('all')}><strong>{allProductGroups.length}</strong><span>全部商品</span></button><button className={`ml-stat ${statusFilter === 'draft' ? 'on' : ''}`} onClick={() => setStatusFilter('draft')}><strong>{statusCounts.draft}</strong><span>有草稿商品</span></button><button className={`ml-stat ${statusFilter === 'published' ? 'on' : ''}`} onClick={() => setStatusFilter('published')}><strong>{statusCounts.published}</strong><span>已发布商品</span></button><button className={`ml-stat warning ${statusFilter === 'failed' ? 'on' : ''}`} onClick={() => setStatusFilter('failed')}><strong>{statusCounts.failed}</strong><span>发布失败商品</span></button></div>

    <div className="ml-toolbar ml-management-toolbar"><div className="search-control"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索商品名称、SKU、来源 ID 或站点" />{query && <button type="button" onClick={() => setQuery('')}>×</button>}</div><div className="filter-group"><span className="filter-label">站点</span>{['all', ...sites].map((site) => <button key={site} className={siteFilter === site ? 'filter-pill on' : 'filter-pill'} onClick={() => setSiteFilter(site)}>{site === 'all' ? '全部' : site}</button>)}</div><select className="sort-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}><option value="all">全部状态</option><option value="draft">草稿</option><option value="validating">待校验</option><option value="publishing">发布中</option><option value="published">已发布</option><option value="paused">已暂停</option><option value="failed">发布失败</option></select><select className="sort-select" value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)}><option value="updated_desc">最近更新</option><option value="title_asc">商品名称</option><option value="status_first">优先处理</option></select><span className="toolbar-count">共 {productGroups.length} 个商品</span><button className="button secondary small" onClick={() => void load()} disabled={refreshing}>{refreshing ? '刷新中…' : '刷新'}</button></div>

    {selectedIds.size > 0 && <div className="bulk-actionbar"><strong>已选择 {selectedIds.size} 个商品</strong><span>将对所选商品的全部站点执行操作</span><div className="toolbar-spacer" /><button className="button secondary small" onClick={() => void runBulkAction('validate')} disabled={Boolean(busyAction)}>{busyAction === 'validate' ? '校验中…' : '批量校验'}</button><button className="button primary small" onClick={() => void runBulkAction('publish')} disabled={Boolean(busyAction)}>{busyAction === 'publish' ? '发布中…' : '批量发布/更新'}</button><button className="text-button" onClick={() => setSelectedIds(new Set())}>清除选择</button></div>}

    {!connected && <div className="ml-empty-panel"><div className="empty-icon">ML</div><div><strong>先连接一个美客多卖家</strong><p>完成应用配置和账号授权后，即可创建各站点刊登。</p></div><Link className="button secondary" to="/mercadolibre/settings">去连接卖家</Link></div>}
    {connected && !productGroups.length && <div className="ml-empty-panel"><div className="empty-icon">＋</div><div><strong>{listings.length ? '没有符合筛选条件的商品' : '还没有美客多刊登'}</strong><p>{listings.length ? '换一个站点、状态或搜索词试试。' : '从采集母库选择商品，再创建智利、墨西哥或哥伦比亚刊登。'}</p></div>{listings.length ? <button className="button secondary" onClick={() => { setQuery(''); setSiteFilter('all'); setStatusFilter('all'); }}>清除筛选</button> : <button className="button primary" onClick={() => openCreateModal()} disabled={!products.length}>创建刊登</button>}</div>}

    {productGroups.length > 0 && <div className="ml-table-card"><div className="table-wrap"><table className="ml-table ml-management-table"><thead><tr><th className="select-col"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="选择全部可见商品" /></th><th className="product-col">商品</th><th>已创建站点</th><th>发布状态</th><th>类目</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{productGroups.map((group) => {
      const product = productById.get(group.productId);
      const first = group.listings[0];
      const latest = group.listings.reduce((value, item) => item.updatedAt > value.updatedAt ? item : value, first);
      const categories = [...new Set(group.listings.map((item) => item.categoryId).filter(Boolean))];
      const needsAttention = group.listings.some((item) => item.status === 'failed' || !item.categoryId);
      return <tr key={group.productId} className={selectedIds.has(group.productId) ? 'selected-row' : ''}><td className="select-col"><input type="checkbox" checked={selectedIds.has(group.productId)} onChange={() => toggleSelected(group.productId)} aria-label={`选择${product?.collected.title || first.title}`} /></td><td className="product-cell"><div className="product-cell-inner">{product?.collected.images[0] ? <img src={product.collected.images[0]} alt="" /> : <div className="product-placeholder">ML</div>}<div><Link className="product-title" to={`/mercadolibre/products/${group.productId}?listingId=${first.id}`}>{product?.collected.title || first.title}</Link><small>{group.listings.length} 个站点 · {product?.collected.variants.length ?? 0} 个变体 · 来源 ID {product?.collected.sourceProductId}</small>{group.listings.find((item) => item.lastError)?.lastError && <span className="row-error">{group.listings.find((item) => item.lastError)?.lastError}</span>}</div></div></td><td><div className="site-tags">{group.listings.map((item) => <span className="site-tag" key={item.id}>{item.siteId}<small>{siteName(item.siteId)}</small></span>)}</div></td><td><div className="status-stack">{group.listings.map((item) => <span className={`ml-status ${statusClass(item.status)}`} key={item.id}><i />{item.siteId} {statusLabel(item.status)}</span>)}</div></td><td><span className={categories.length ? 'category-value' : 'category-empty'}>{categories.length ? categories.join('、') : '待选择类目'}</span></td><td className="time-cell">{formatDate(latest.updatedAt)}</td><td className="action-cell"><div className="row-actions"><Link className={`table-action ${needsAttention ? 'attention-action' : ''}`} to={`/mercadolibre/products/${group.productId}?listingId=${first.id}`}>{needsAttention ? '继续完善' : '管理'}</Link>{product?.collected.sourceUrl && <a className="table-action muted-action" href={product.collected.sourceUrl} target="_blank" rel="noreferrer">来源</a>}</div></td></tr>;
    })}</tbody></table></div></div>}

    {createOpen && <div className="modal-backdrop" onClick={closeCreateModal}><div className="modal ml-create-modal" role="dialog" aria-modal="true" aria-labelledby="create-listing-title" onClick={(e) => e.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">CREATE LISTING</span><h2 id="create-listing-title">创建美客多刊登</h2><p>先选母商品，再选择卖家和目标站点。</p></div><button type="button" className="modal-close" aria-label="关闭" onClick={closeCreateModal}>×</button></div><div className="modal-body">{selected ? <><div className="selected-source"><div className="selected-source-thumb">{selected.collected.images[0] ? <img src={selected.collected.images[0]} alt="" /> : 'ML'}</div><div><span>已选母商品</span><strong>{selected.collected.title}</strong><small>{selected.collected.images.length} 张图片 · {selected.collected.variants.length} 个变体 · {selected.collected.sourceProductId}</small></div><button type="button" className="text-button source-change" onClick={() => setSelected(null)}>更换</button></div><div className="field"><label>卖家账号</label><select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{config?.connectedAccounts.map((account) => <option value={account.id} key={account.id}>{account.nickname || account.userId} · {sellerModelLabel(account.model)}</option>)}</select></div><div className="field"><label>目标站点 <span>可同时创建多个站点</span></label><div className="site-select-grid">{sites.map((site) => <button type="button" key={site} className={siteIds.includes(site) ? 'site-select on' : 'site-select'} onClick={() => toggleSite(site)}><strong>{site}</strong><small>{siteName(site)}</small><i>{siteIds.includes(site) ? '✓' : ''}</i></button>)}</div></div></> : <><div className="source-picker-search"><span>⌕</span><input autoFocus value={productQuery} onChange={(e) => setProductQuery(e.target.value)} placeholder="搜索商品名称、SKU 或来源 ID" /></div><div className="source-picker-list">{selectableProducts.length ? selectableProducts.map((product) => <button type="button" className="source-picker-item" key={product.id} onClick={() => setSelected(product)}><span className="source-picker-thumb">{product.collected.images[0] ? <img src={product.collected.images[0]} alt="" /> : '—'}</span><span><strong>{product.collected.title}</strong><small>{product.collected.variants.length} 个变体 · {product.collected.sourceProductId}</small></span><b>选择</b></button>) : <div className="source-picker-empty">{products.length ? '没有匹配的母商品，请换个关键词。' : '母库还没有商品，请先使用采集插件添加商品。'}</div>}</div></>}</div><div className="modal-foot"><span className="hint">{selected ? `将创建 ${siteIds.length} 个站点刊登` : `母库共 ${products.filter((item) => item.status !== 'discarded').length} 个可用商品`}</span><div className="modal-actions"><button type="button" className="button secondary" onClick={closeCreateModal}>取消</button>{selected && <button type="button" className="button primary" onClick={() => void createDrafts()} disabled={busy || !accountId || !siteIds.length}>{busy ? '创建中…' : `创建 ${siteIds.length} 个站点刊登`}</button>}</div></div></div></div>}
  </div>;
}

function statusLabel(status: MercadoLibreListingDraft['status']) {
  return ({ draft: '草稿', validating: '待校验', publishing: '发布中', published: '已发布', paused: '已暂停', failed: '失败' } as Record<typeof status, string>)[status];
}

function statusClass(status: MercadoLibreListingDraft['status']) {
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

function latestTimestamp(listings: MercadoLibreListingDraft[]) {
  return Math.max(...listings.map((item) => Date.parse(item.updatedAt) || 0));
}

function statusRank(listings: MercadoLibreListingDraft[]) {
  const rank: Record<MercadoLibreListingDraft['status'], number> = { failed: 0, draft: 1, validating: 2, publishing: 3, paused: 4, published: 5 };
  return Math.min(...listings.map((item) => rank[item.status]));
}

interface ProductGroup { productId: string; listings: MercadoLibreListingDraft[]; }

function groupListings(items: MercadoLibreListingDraft[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();
  for (const item of items) {
    const group = groups.get(item.productId) || { productId: item.productId, listings: [] };
    group.listings.push(item);
    groups.set(item.productId, group);
  }
  return [...groups.values()];
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  compareOrderLines,
  formatChinaDateTime,
  ORDER_RANGE_PRESETS,
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  POLYESTER_TYPE_LABELS,
  rangeForPreset,
  type OrderExportProfile,
  type OrderExportRecord,
  type OrderPreview,
  type OrderPreviewLine,
  type OrderQueryInput,
  type OrderRangePreset,
  type OrderSourceShopInfo,
  type OrderSourcesResponse,
  type OrderStatus,
  type OrderSyncJob,
  type OrderSortOrder,
  type PolyesterType,
} from '@shared/orders';
import type { ProductMaterial } from '@shared/types';
import { OrderItems } from './OrderItems';
import { retryOrderExportFile, startOrderExport } from './export-task';
import { materialLabel } from '@shared/product-grouping';
import { api } from '../../api';
import { showFeedback } from '../../feedback';
import {
  describeProfile,
  errorMessage,
  fileSize,
  parseShopKey,
  PROFILE_STORAGE_KEY,
  readStored,
  relativeTime,
  shopRefKey,
  writeStored,
} from './order-ui';

const REMEMBER_KEY = 'auto_tools.orders.rememberMaterial';
const POLL_MS = 800;

interface Props {
  profiles: OrderExportProfile[];
  active: boolean;
  exporting: boolean;
  exportedId?: string;
  onManageProfiles: () => void;
}

export function OrderExportTab({ profiles, active, exporting, exportedId, onManageProfiles }: Props) {
  const [sources, setSources] = useState<OrderSourcesResponse | null>(null);
  const [sourcesError, setSourcesError] = useState('');
  const [profileId, setProfileId] = useState(() => readStored(PROFILE_STORAGE_KEY));
  const profile = profiles.find((item) => item.id === profileId) ?? profiles[0];
  const [shopKeys, setShopKeys] = useState<Set<string>>(new Set());
  const [rangePreset, setRangePreset] = useState<OrderRangePreset>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [statuses, setStatuses] = useState<Set<OrderStatus>>(new Set(['to_ship']));
  const [onlyNew, setOnlyNew] = useState(true);
  const [overrides, setOverrides] = useState<Record<string, ProductMaterial>>({});
  const [polyesterTypes, setPolyesterTypes] = useState<Record<string, PolyesterType | null>>({});
  const [selectedImages, setSelectedImages] = useState<Record<string, string[]>>({});
  const [excludedLineUids, setExcludedLineUids] = useState<Set<string>>(new Set());
  const [sortOrder, setSortOrder] = useState<OrderSortOrder>('oldest');
  const [savingMaterial, setSavingMaterial] = useState(false);
  const [previewQueryKey, setPreviewQueryKey] = useState('');
  const [remember, setRemember] = useState(() => readStored(REMEMBER_KEY) !== '0');
  const [syncJob, setSyncJob] = useState<OrderSyncJob | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const mounted = useRef(true);
  const previewSeq = useRef(0);
  const appliedProfile = useRef<OrderExportProfile>();
  const hasPreview = useRef(false);

  // 挂载时也要置 true：开发模式的 StrictMode 会先模拟一次卸载再挂载
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadSources = useCallback(async () => {
    try {
      const data = await api.orderSources();
      if (!mounted.current) return;
      setSources(data);
      setSourcesError('');
    } catch (error) {
      if (mounted.current) setSourcesError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    if (active) void loadSources();
  }, [active, exportedId, loadSources]);

  useEffect(() => {
    if (!active) return;
    const stored = readStored(PROFILE_STORAGE_KEY);
    if (stored && profiles.some((item) => item.id === stored)) setProfileId(stored);
  }, [active, profiles]);

  const allShops = useMemo(() => sources?.platforms.flatMap((platform) => platform.shops) ?? [], [sources]);

  // 切换方案时套用该方案记住的店铺和条件；没记住店铺时默认勾选全部已授权店铺
  useEffect(() => {
    if (!profile || !sources) return;
    const previous = appliedProfile.current;
    appliedProfile.current = profile;
    const sameProfile = previous?.id === profile.id;
    if (sameProfile && JSON.stringify(previous.defaults) === JSON.stringify(profile.defaults)) return;
    const connected = allShops.filter((shop) => shop.connected).map(shopRefKey);
    const remembered = profile.defaults.shops.map(shopRefKey).filter((key) => connected.includes(key));
    setShopKeys(new Set(remembered.length ? remembered : connected));
    setStatuses(new Set(profile.defaults.statuses));
    setOnlyNew(profile.defaults.onlyNew);
    if (sameProfile) return;
    setOverrides({});
    setPolyesterTypes({});
    setSelectedImages({});
    setExcludedLineUids(new Set());
    previewSeq.current++;
    hasPreview.current = false;
    setPreview(null);
    setPreviewing(false);
    setPreviewError('');
    setSyncJob(null);
  }, [profile, sources, allShops]);

  const range = useMemo(
    () => (rangePreset === 'custom' ? { from: customFrom || undefined, to: customTo || undefined } : rangeForPreset(rangePreset)),
    [rangePreset, customFrom, customTo],
  );

  const query = useMemo<OrderQueryInput | null>(() => {
    if (!profile) return null;
    return {
      profileId: profile.id,
      shops: [...shopKeys].map(parseShopKey),
      statuses: ORDER_STATUSES.filter((status) => statuses.has(status)),
      ...(range.from ? { from: range.from } : {}),
      ...(range.to ? { to: range.to } : {}),
      onlyNew,
      overrides,
      polyesterTypes,
      selectedImages,
      excludedLineUids: [...excludedLineUids],
      sortOrder,
    };
  }, [profile, shopKeys, statuses, range, onlyNew, overrides, polyesterTypes, selectedImages, excludedLineUids, sortOrder]);
  const queryKey = JSON.stringify([query, profile?.updatedAt, exportedId]);

  const invalidReason = !query
    ? '请先在「高级设置」里创建导出方案'
    : !query.shops.length
      ? '请至少选择一家店铺'
      : !query.statuses.length
        ? '请至少选择一个订单状态'
        : range.from && range.to && range.from > range.to
          ? '开始日期不能晚于结束日期'
          : '';

  const runPreview = useCallback(async (input: OrderQueryInput) => {
    const seq = ++previewSeq.current;
    setPreviewing(true);
    setPreviewError('');
    try {
      const data = await api.previewOrders(input);
      if (seq === previewSeq.current && mounted.current) {
        setPreview(data);
        setPreviewQueryKey(JSON.stringify([input, profile?.updatedAt, exportedId]));
      }
    } catch (error) {
      if (seq === previewSeq.current && mounted.current) setPreviewError(errorMessage(error));
    } finally {
      if (seq === previewSeq.current && mounted.current) setPreviewing(false);
    }
  }, [profile?.updatedAt, exportedId]);

  useEffect(() => {
    hasPreview.current = Boolean(preview);
  }, [preview]);

  // 已经预览过时，条件一改就用本地数据自动刷新预览（不重新同步）
  useEffect(() => {
    if (!active || !hasPreview.current || !query || invalidReason) return;
    setPreviewing(true);
    const timer = window.setTimeout(() => void runPreview(query), 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, queryKey]);

  async function syncAndPreview() {
    if (!query || invalidReason) {
      showFeedback(invalidReason, 'error');
      return;
    }
    setSyncing(true);
    try {
      let job = await api.syncOrders(query.shops, query.from);
      setSyncJob(job);
      while ((job.status === 'queued' || job.status === 'running') && mounted.current) {
        await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
        job = await api.orderSyncJob(job.id);
        if (mounted.current) setSyncJob(job);
      }
      if (!mounted.current) return;
      if (job.status === 'failed') showFeedback('同步失败，下面列出了各店铺的原因；预览用的是之前同步的数据', 'error');
      else if (job.status === 'partial') showFeedback('部分店铺同步失败，其余店铺已更新', 'info');
      void loadSources();
      await runPreview(query);
    } catch (error) {
      showFeedback(errorMessage(error), 'error');
    } finally {
      if (mounted.current) setSyncing(false);
    }
  }

  async function previewLocal() {
    if (!query || invalidReason) {
      showFeedback(invalidReason, 'error');
      return;
    }
    await runPreview(query);
  }

  async function changeMaterial(lines: OrderPreviewLine[], material: ProductMaterial) {
    const line = lines[0];
    setOverrides((current) => ({ ...current, ...Object.fromEntries(lines.map((item) => [item.uid, material])) }));
    setPolyesterTypes((current) => ({ ...current, ...Object.fromEntries(lines.map((item) => [item.uid, null])) }));
    if (!remember || material === 'unknown' || !(line.productId || line.productSku)) return;
    setSavingMaterial(true);
    try {
      await api.saveOrderMaterialRule({
        platform: line.platform, productId: line.productId, productSku: line.productSku, title: line.title, material, polyesterType: null,
      });
      showFeedback(`已记住：这个商品以后按「${materialLabel(material)}」导出`);
    } catch (error) {
      showFeedback(errorMessage(error), 'error');
    } finally { if (mounted.current) setSavingMaterial(false); }
  }

  async function changePolyesterType(lines: OrderPreviewLine[], polyesterType: PolyesterType | null) {
    setPolyesterTypes((current) => ({ ...current, ...Object.fromEntries(lines.map((line) => [line.uid, polyesterType])) }));
    const line = lines[0];
    if (!remember || !(line.productId || line.productSku)) return;
    setSavingMaterial(true);
    try {
      await api.saveOrderMaterialRule({
        platform: line.platform, productId: line.productId, productSku: line.productSku, title: line.title,
        material: 'polyester', polyesterType,
      });
      if (polyesterType) showFeedback(`已记住：这个商品以后按「聚酯纤维 · ${POLYESTER_TYPE_LABELS[polyesterType]}」导出`);
    } catch (error) {
      showFeedback(errorMessage(error), 'error');
    } finally { if (mounted.current) setSavingMaterial(false); }
  }

  function changeImages(lines: OrderPreviewLine[], images: string[]) {
    setSelectedImages((current) => ({ ...current, ...Object.fromEntries(lines.map((line) => [line.uid, images])) }));
  }

  function changeExport(lines: OrderPreviewLine[], checked: boolean) {
    setExcludedLineUids((current) => {
      const next = new Set(current);
      for (const line of lines) {
        if (checked) next.delete(line.uid);
        else next.add(line.uid);
      }
      return next;
    });
  }

  function toggleShop(key: string, on: boolean) {
    setShopKeys((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function toggleStatus(status: OrderStatus) {
    setStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  const busy = syncing || exporting;

  return (
    <div className="orders-export" hidden={!active}>
      <section className="orders-card">
        <div className="orders-preview-head"><div><h3>1. 选择店铺，同步订单</h3><span className="orders-hint">默认查看待发货、未导出订单。美客多订单从妙手读取；自用 Excel 按平台生成，供应商 Excel 跨平台合并为成人棉、童装棉两份，只保留拿货尺码。</span></div></div>
        <div className="orders-row">
          <span className="orders-label">店铺</span>
          <div className="orders-control orders-shop-groups">
            {sourcesError && <span className="orders-error-text">{sourcesError}</span>}
            {!sources && !sourcesError && <span className="orders-hint">正在读取店铺…</span>}
            {sources?.platforms.map((platform) => (
              <div key={platform.platform} className="orders-shop-group">
                <span className="orders-platform">{platform.label}</span>
                {platform.error && <span className="orders-error-text">读取店铺失败：{platform.error}</span>}
                {platform.shops.length === 0 && <span className="orders-hint">还没有店铺</span>}
                {platform.platform === 'mercadolibre' && <Link className="orders-shop-link" to="/miaoshou/settings">妙手连接设置</Link>}
                {platform.shops.map((shop) => (
                  <ShopOption
                    key={shopRefKey(shop)}
                    shop={shop}
                    checked={shopKeys.has(shopRefKey(shop))}
                    disabled={busy}
                    onToggle={(on) => toggleShop(shopRefKey(shop), on)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        <details className="orders-advanced">
          <summary>更多选项 · 日期、订单状态、导出格式</summary>
        <div className="orders-row">
          <span className="orders-label">导出方案</span>
          <div className="orders-control">
            <select
              className="orders-select"
              value={profile?.id ?? ''}
              onChange={(event) => {
                setProfileId(event.target.value);
                writeStored(PROFILE_STORAGE_KEY, event.target.value);
              }}
            >
              {profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <button type="button" className="ghost orders-small" onClick={onManageProfiles}>管理方案</button>
            {profile && <span className="orders-hint">{describeProfile(profile)}</span>}
          </div>
        </div>

        <div className="orders-row">
          <span className="orders-label">下单时间</span>
          <div className="orders-control">
            <div className="orders-segmented" role="group" aria-label="下单时间">
              {ORDER_RANGE_PRESETS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={rangePreset === item.id}
                  className={rangePreset === item.id ? 'on' : ''}
                  onClick={() => setRangePreset(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {rangePreset === 'custom' && (
              <span className="orders-dates">
                <input type="date" value={customFrom} max={customTo || undefined} onChange={(event) => setCustomFrom(event.target.value)} aria-label="开始日期" />
                <span>至</span>
                <input type="date" value={customTo} min={customFrom || undefined} onChange={(event) => setCustomTo(event.target.value)} aria-label="结束日期" />
              </span>
            )}
            {rangePreset !== 'custom' && range.from && (
              <span className="orders-hint">{range.from === range.to ? range.from : `${range.from} 至 ${range.to}`}（北京时间）</span>
            )}
          </div>
        </div>

        <div className="orders-row">
          <span className="orders-label">订单状态</span>
          <div className="orders-control">
            <div className="orders-chips">
              {ORDER_STATUSES.map((status) => (
                <button
                  key={status}
                  type="button"
                  aria-pressed={statuses.has(status)}
                  className={`orders-chip${statuses.has(status) ? ' on' : ''}`}
                  onClick={() => toggleStatus(status)}
                >
                  {ORDER_STATUS_LABELS[status]}
                </button>
              ))}
            </div>
            <label className="orders-check">
              <input type="checkbox" checked={onlyNew} onChange={(event) => setOnlyNew(event.target.checked)} />
              只导出这个方案没导过的订单
            </label>
          </div>
        </div>

        </details>

        <div className="orders-actions">
          <span className={invalidReason ? 'orders-error-text' : 'orders-hint'}>
            {invalidReason || `首次同步回溯 ${sources?.lookbackDays ?? 30} 天，选更早的日期会自动补拉。`}
          </span>
          <button type="button" className="ghost" disabled={busy || previewing || Boolean(invalidReason)} onClick={() => void previewLocal()}>
            查看已同步订单
          </button>
          <button type="button" disabled={busy || Boolean(invalidReason)} onClick={() => void syncAndPreview()}>
            {syncing ? '正在同步…' : '同步订单'}
          </button>
        </div>

        {syncJob && <SyncProgress job={syncJob} />}
      </section>

      {previewError && <div className="error">{previewError}</div>}

      {preview && (
        <PreviewPanel
          preview={preview}
          active={active}
          refreshing={previewing || previewQueryKey !== queryKey || savingMaterial}
          blockedReason={invalidReason || previewError}
          exporting={exporting}
          remember={remember}
          onlyNew={onlyNew}
          selectedImages={selectedImages}
          excludedLineUids={excludedLineUids}
          sortOrder={sortOrder}
          onSortChange={setSortOrder}
          onChangeExport={changeExport}
          onRememberChange={(value) => {
            setRemember(value);
            writeStored(REMEMBER_KEY, value ? '1' : '0');
          }}
          onChangeMaterial={(lines, material) => void changeMaterial(lines, material)}
          onChangePolyesterType={(lines, type) => void changePolyesterType(lines, type)}
          onChangeImages={changeImages}
          disabled={busy || savingMaterial}
          onExport={() => { if (query && !invalidReason) void startOrderExport(query); }}
        />
      )}

    </div>
  );
}

function ShopOption({ shop, checked, disabled, onToggle }: {
  shop: OrderSourceShopInfo;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}) {
  const status = !shop.connected
    ? shop.configured ? '未授权' : '缺凭证'
    : shop.lastError
      ? '上次同步失败'
      : shop.lastSyncedAt
        ? `${relativeTime(shop.lastSyncedAt)}同步 · ${shop.orderCount} 单`
        : '还没同步过';
  return (
    <label
      className={`orders-shop${checked ? ' on' : ''}${shop.connected ? '' : ' off'}${shop.lastError ? ' warn' : ''}`}
      title={shop.lastError ? `上次同步失败：${shop.lastError}` : undefined}
    >
      <input type="checkbox" checked={checked} disabled={disabled || !shop.connected} onChange={(event) => onToggle(event.target.checked)} />
      <span className="orders-shop-name">{shop.shopName}</span>
      <small>{status}</small>
      {!shop.connected && <Link className="orders-shop-link" to={shop.platform === 'mercadolibre' ? '/miaoshou/settings' : '/settings'}>去授权</Link>}
    </label>
  );
}

function SyncProgress({ job }: { job: OrderSyncJob }) {
  const text = (shop: OrderSyncJob['shops'][number]) => {
    switch (shop.status) {
      case 'pending': return '等待中';
      case 'running': return `正在拉取… 已获取 ${shop.fetched} 单`;
      case 'succeeded': return shop.fetched ? `完成，更新了 ${shop.fetched} 单` : '完成，没有新变化';
      default: return `失败：${shop.error ?? '未知原因'}`;
    }
  };
  return (
    <div className="orders-sync" aria-live="polite">
      {job.shops.map((shop) => (
        <div key={`${shop.platform}::${shop.shopId}`} className={`orders-sync-row ${shop.status}`}>
          <span className="orders-sync-dot" />
          <span className="orders-sync-shop">{shop.shopName}</span>
          <span>{text(shop)}</span>
        </div>
      ))}
    </div>
  );
}

function PreviewPanel({ preview, active, refreshing, blockedReason, exporting, remember, onlyNew, selectedImages,
  excludedLineUids, sortOrder, onSortChange, onChangeExport,
  onRememberChange, onChangeMaterial, onChangePolyesterType, onChangeImages, onExport, disabled,
}: {
  preview: OrderPreview;
  active: boolean;
  refreshing: boolean;
  blockedReason: string;
  exporting: boolean;
  remember: boolean;
  onlyNew: boolean;
  selectedImages: Record<string, string[]>;
  excludedLineUids: Set<string>;
  sortOrder: OrderSortOrder;
  onSortChange: (value: OrderSortOrder) => void;
  onChangeExport: (lines: OrderPreviewLine[], checked: boolean) => void;
  onRememberChange: (value: boolean) => void;
  onChangeMaterial: (lines: OrderPreviewLine[], material: ProductMaterial) => void;
  onChangePolyesterType: (lines: OrderPreviewLine[], type: PolyesterType | null) => void;
  onChangeImages: (lines: OrderPreviewLine[], images: string[]) => void;
  onExport: () => void;
  disabled: boolean;
}) {
  const [view, setView] = useState<'list' | 'cards'>('list');
  const [materialFilter, setMaterialFilter] = useState('all');
  useEffect(() => { if (active) setView('list'); }, [active]);
  const items = useMemo(() => preview.buckets.flatMap((bucket) => bucket.lines.map((line) => ({ line, bucket })))
    .sort((a, b) => compareOrderLines(a.line, b.line, sortOrder)), [preview, sortOrder]);
  const filtered = items.filter(({ bucket }) => materialFilter === 'all' || bucket.key === materialFilter);
  const eligible = filtered.filter(({ bucket }) => !bucket.excluded).map(({ line }) => line);
  const ready = items.filter(({ bucket }) => !bucket.excluded);
  const pending = items.length - ready.length;
  const selected = ready.filter(({ line }) => !excludedLineUids.has(line.uid));
  const missingTypes = selected.filter(({ line }) => line.material === 'polyester' && !line.polyesterType).length;
  const quantity = selected.reduce((sum, { line }) => sum + line.quantity, 0);
  const orders = new Set(selected.map(({ line }) => JSON.stringify([line.platform, line.shopId, line.orderId]))).size;
  const skipped = ready.length - selected.length;
  return (
    <section className="orders-card orders-preview">
      <div className="orders-preview-head">
        <div>
          <h3>2. 勾选要导出的商品</h3>
          <span className="orders-hint" role="status">已选 {orders} 单 · {selected.length} 行 · {quantity} 件{skipped ? ` · 本次跳过 ${skipped} 行` : ''} · 待确认 {pending} 行{refreshing ? ' · 正在更新…' : ''}</span>
        </div>
        <label className="orders-check">
          <input type="checkbox" checked={remember} disabled={disabled} onChange={(event) => onRememberChange(event.target.checked)} />记住商品材质
        </label>
      </div>
      <p className="orders-hint">取消商品勾选可跳过本次导出，以后仍可导出。聚酯纤维需选择平板或针眼，拿货尺码保留原值；其他童装拿货尺码增大一码，160 不变；成人棉质尺码按原规则换算。默认只导出订单图；点「选图片」或切换卡片可多选，点图放大。</p>
      {preview.warnings.length > 0 && <ul className="orders-warnings">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      <div className="orders-item-toolbar">
        <div className="orders-chips" role="group" aria-label="筛选商品材质">
          <button type="button" className={`orders-chip${materialFilter === 'all' ? ' on' : ''}`} aria-pressed={materialFilter === 'all'} onClick={() => setMaterialFilter('all')}>全部 {items.length}</button>
          {preview.buckets.filter((bucket) => bucket.lines.length).map((bucket) => <button type="button" key={bucket.key} className={`orders-chip${materialFilter === bucket.key ? ' on' : ''}`} aria-pressed={materialFilter === bucket.key} onClick={() => setMaterialFilter(bucket.key)}>{bucket.label} {bucket.lines.length}</button>)}
        </div>
        <div className="orders-item-toolbar-controls">
          <select className="orders-select" aria-label="订单时间排序" value={sortOrder} disabled={disabled} onChange={(event) => onSortChange(event.target.value as OrderSortOrder)}>
            <option value="oldest">最早下单在前</option><option value="newest">最新下单在前</option>
          </select>
          <div className="orders-segmented" role="group" aria-label="订单视图">
            <button type="button" className={view === 'list' ? 'on' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')}>列表</button>
            <button type="button" className={view === 'cards' ? 'on' : ''} aria-pressed={view === 'cards'} onClick={() => setView('cards')}>卡片</button>
          </div>
        </div>
      </div>
      {eligible.length > 0 && <div className="orders-selection-tools">
        <button type="button" className="ghost orders-small" disabled={disabled} onClick={() => onChangeExport(eligible, true)}>全选当前筛选</button>
        <button type="button" className="ghost orders-small" disabled={disabled} onClick={() => onChangeExport(eligible, false)}>取消当前筛选</button>
        <span className="orders-hint">当前筛选 {filtered.length} 行，其中 {eligible.length} 行可勾选；导出包含所有材质中已勾选的商品。</span>
      </div>}
      {filtered.length > 0 && <OrderItems key={`${materialFilter}:${view}`} items={filtered} view={view} excludedLineUids={excludedLineUids} selectedImages={selectedImages} onChangeExport={onChangeExport} onChangeMaterial={onChangeMaterial} onChangePolyesterType={onChangePolyesterType} onChangeImages={onChangeImages} disabled={disabled} />}
      {items.length > 0 && filtered.length === 0 && <div className="orders-empty">当前筛选下没有商品，可以切换到「全部」。</div>}
      {preview.totals.lines === 0 && <div className="orders-empty">没有符合条件的订单{onlyNew ? '。已导出的订单自动隐藏，可以在更多选项里取消「只导出这个方案没导过的订单」。' : '。'}</div>}
      <div className="orders-export-bar">
        <div className="orders-export-files"><strong>本次导出 {orders} 单 · {quantity} 件</strong><br />{preview.files.length && selected.length ? <>将生成：{preview.files.map((file) => file.name).join('、')}{pending > 0 ? `；${pending} 行待确认，本次不导出` : ''}</> : ready.length ? '请勾选需要导出的商品' : '没有可导出的订单，请先确认材质'}</div>
        <button type="button" disabled={disabled || exporting || refreshing || Boolean(blockedReason) || Boolean(missingTypes) || !selected.length || !preview.files.length} onClick={onExport}>{exporting ? '正在下载图片并导出…' : missingTypes ? `请先选择 ${missingTypes} 行聚酯类型` : `3. 导出已选商品（${quantity} 件）`}</button>
      </div>
    </section>
  );
}

export function ExportResult({ record, downloading, downloadFailedIds }: { record: OrderExportRecord; downloading: boolean; downloadFailedIds: string[] }) {
  return (
    <section className="orders-card orders-result">
      <div className="orders-result-head">
        <span className="orders-result-icon" aria-hidden="true">✓</span>
        <div>
          <h3 role="status">{`已生成 ${record.files.length} 个 Excel 文件`}{downloading ? ' · 正在下载' : downloadFailedIds.length ? ` · ${downloadFailedIds.length} 个下载失败` : ' · 已开始下载'}</h3>
          <span className="orders-hint">
            {formatChinaDateTime(record.createdAt)} · 方案「{record.profileName}」 · 这些订单已标记为导出过
          </span>
        </div>

      </div>
      {record.files.some((file) => file.lowResolutionImages) && <p className="orders-hint">部分所选源图不足 240 像素，已保留现有清晰度。可重新同步获取高清图，或另选更清晰的图片后再次导出。</p>}
      <ul className="orders-files">
        {record.files.map((file) => (
          <li key={file.id}>
            <span className="orders-file-name">{file.name}</span>
            <span className="orders-hint">{file.orderCount} 单 · {file.quantity} 件 · {fileSize(file.size)}{file.lowResolutionImages ? ` · ${file.lowResolutionImages} 张源图偏小` : ''}</span>
            {downloadFailedIds.includes(file.id)
              ? <button type="button" className="ghost orders-small" disabled={downloading} onClick={() => void retryOrderExportFile(file)}>重试下载</button>
              : <a className="orders-link-button ghost" href={api.orderExportFileUrl(record.id, file.id)} download={file.name}>下载文件</a>}
          </li>
        ))}
      </ul>
    </section>
  );
}

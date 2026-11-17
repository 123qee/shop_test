import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  formatChinaDateTime,
  ORDER_RANGE_PRESETS,
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
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
} from '@shared/orders';
import type { ProductMaterial } from '@shared/types';
import { GarmentCards } from './GarmentCards';
import { downloadFiles } from './download-files';
import { materialLabel } from '@shared/product-grouping';
import { api } from '../../api';
import { showFeedback } from '../../feedback';
import { PlannerIcon } from '../planner/PlannerIcon';
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
  onExported: (record: OrderExportRecord) => void;
  onManageProfiles: () => void;
}

export function OrderExportTab({ profiles, onExported, onManageProfiles }: Props) {
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
  const [selectedImages, setSelectedImages] = useState<Record<string, string[]>>({});
  const [savingMaterial, setSavingMaterial] = useState(false);
  const [previewQueryKey, setPreviewQueryKey] = useState('');
  const [remember, setRemember] = useState(() => readStored(REMEMBER_KEY) !== '0');
  const [syncJob, setSyncJob] = useState<OrderSyncJob | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<OrderExportRecord | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailedIds, setDownloadFailedIds] = useState<string[]>([]);
  const mounted = useRef(true);
  const previewSeq = useRef(0);
  const appliedProfile = useRef('');
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
    void loadSources();
  }, [loadSources]);

  const allShops = useMemo(() => sources?.platforms.flatMap((platform) => platform.shops) ?? [], [sources]);

  // 切换方案时套用该方案记住的店铺和条件；没记住店铺时默认勾选全部已授权店铺
  useEffect(() => {
    if (!profile || !sources || appliedProfile.current === profile.id) return;
    appliedProfile.current = profile.id;
    const connected = allShops.filter((shop) => shop.connected).map(shopRefKey);
    const remembered = profile.defaults.shops.map(shopRefKey).filter((key) => connected.includes(key));
    setShopKeys(new Set(remembered.length ? remembered : connected));
    setStatuses(new Set(profile.defaults.statuses));
    setOnlyNew(profile.defaults.onlyNew);
    setOverrides({});
    setSelectedImages({});
    setPreview(null);
    setResult(null);
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
      selectedImages,
    };
  }, [profile, shopKeys, statuses, range, onlyNew, overrides, selectedImages]);
  const queryKey = JSON.stringify(query);

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
        setPreviewQueryKey(JSON.stringify(input));
      }
    } catch (error) {
      if (seq === previewSeq.current && mounted.current) setPreviewError(errorMessage(error));
    } finally {
      if (seq === previewSeq.current && mounted.current) setPreviewing(false);
    }
  }, []);

  useEffect(() => {
    hasPreview.current = Boolean(preview);
  }, [preview]);

  // 已经预览过时，条件一改就用本地数据自动刷新预览（不重新同步）
  useEffect(() => {
    if (!hasPreview.current || !query || invalidReason) return;
    const timer = window.setTimeout(() => void runPreview(query), 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  async function syncAndPreview() {
    if (!query || invalidReason) {
      showFeedback(invalidReason, 'error');
      return;
    }
    setSyncing(true);
    setResult(null);
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
    setResult(null);
    await runPreview(query);
  }

  async function changeMaterial(lines: OrderPreviewLine[], material: ProductMaterial) {
    const line = lines[0];
    setOverrides((current) => ({ ...current, ...Object.fromEntries(lines.map((item) => [item.uid, material])) }));
    if (!remember || material === 'unknown' || !(line.productId || line.productSku)) return;
    setSavingMaterial(true);
    try {
      await api.saveOrderMaterialRule({
        platform: line.platform, productId: line.productId, productSku: line.productSku, title: line.title, material,
      });
      showFeedback(`已记住：这个商品以后按「${materialLabel(material)}」导出`);
    } catch (error) {
      showFeedback(errorMessage(error), 'error');
    } finally { if (mounted.current) setSavingMaterial(false); }
  }

  function changeImages(lines: OrderPreviewLine[], images: string[]) {
    setSelectedImages((current) => ({ ...current, ...Object.fromEntries(lines.map((line) => [line.uid, images])) }));
  }

  async function runExport() {
    if (!query || invalidReason) return;
    setExporting(true);
    try {
      const record = await api.exportOrders(query);
      if (!mounted.current) return;
      setResult(record);
      setDownloading(true);
      setDownloadFailedIds([]);
      onExported(record);
      void loadSources();
      const failed = await downloadFiles(record.files.map((file) => ({ id: file.id, name: file.name, url: api.orderExportFileUrl(record.id, file.id) })));
      if (!mounted.current) return;
      setDownloadFailedIds(failed);
      setDownloading(false);
      showFeedback(failed.length ? `已导出，${failed.length} 个文件下载失败，请在结果中重试下载` : `已自动开始下载 ${record.files.length} 个 Excel 文件`, failed.length ? 'error' : 'success');
      await runPreview(query);
    } catch (error) {
      showFeedback(errorMessage(error), 'error');
    } finally {
      if (mounted.current) { setExporting(false); setDownloading(false); }
    }
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
    <div className="orders-export">
      <section className="orders-card">
        <div className="orders-preview-head"><div><h3>1. 选择店铺，同步订单</h3><span className="orders-hint">默认导出待发货、未导出订单。看图选择需要的图片，未确定材质的衣服会自动跳过。</span></div></div>
        <div className="orders-row">
          <span className="orders-label">店铺</span>
          <div className="orders-control orders-shop-groups">
            {sourcesError && <span className="orders-error-text">{sourcesError}</span>}
            {!sources && !sourcesError && <span className="orders-hint">正在读取店铺…</span>}
            {sources?.platforms.map((platform) => (
              <div key={platform.platform} className="orders-shop-group">
                <span className="orders-platform">{platform.label}</span>
                {platform.shops.length === 0 && <span className="orders-hint">还没有店铺</span>}
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
          refreshing={previewing || previewQueryKey !== queryKey || savingMaterial}
          blockedReason={invalidReason || previewError}
          exporting={exporting}
          remember={remember}
          onlyNew={onlyNew}
          selectedImages={selectedImages}
          onRememberChange={(value) => {
            setRemember(value);
            writeStored(REMEMBER_KEY, value ? '1' : '0');
          }}
          onChangeMaterial={(lines, material) => void changeMaterial(lines, material)}
          onChangeImages={changeImages}
          disabled={busy || savingMaterial}
          onExport={() => void runExport()}
        />
      )}

      {result && <ExportResult record={result} downloading={downloading} downloadFailedIds={downloadFailedIds} />}
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
      {!shop.connected && <Link className="orders-shop-link" to="/settings">去授权</Link>}
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

function PreviewPanel({ preview, refreshing, blockedReason, exporting, remember, onlyNew, selectedImages,
  onRememberChange, onChangeMaterial, onChangeImages, onExport, disabled,
}: {
  preview: OrderPreview;
  refreshing: boolean;
  blockedReason: string;
  exporting: boolean;
  remember: boolean;
  onlyNew: boolean;
  selectedImages: Record<string, string[]>;
  onRememberChange: (value: boolean) => void;
  onChangeMaterial: (lines: OrderPreviewLine[], material: ProductMaterial) => void;
  onChangeImages: (lines: OrderPreviewLine[], images: string[]) => void;
  onExport: () => void;
  disabled: boolean;
}) {
  const [pendingOnly, setPendingOnly] = useState(false);
  const pending = preview.buckets.filter((bucket) => bucket.excluded).reduce((sum, bucket) => sum + bucket.lines.length, 0);
  const ready = preview.buckets.filter((bucket) => !bucket.excluded).reduce((sum, bucket) => sum + bucket.lines.length, 0);
  return (
    <section className="orders-card orders-preview">
      <div className="orders-preview-head">
        <div>
          <h3>2. 看衣服，选图片</h3>
          <span className="orders-hint">可导出 {ready} 行 · 待确认 {pending} 行{refreshing ? ' · 正在更新…' : ''}</span>
        </div>
        <label className="orders-check">
          <input type="checkbox" checked={remember} disabled={disabled} onChange={(event) => onRememberChange(event.target.checked)} />记住商品材质
        </label>
      </div>
      <p className="orders-hint">默认只选订单图；正反面、细节图按需多选，点图片可放大。所选图片直接嵌入 Excel，件数不重复。</p>
      {preview.warnings.length > 0 && <ul className="orders-warnings">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      {pending > 0 && <label className="orders-check"><input type="checkbox" checked={pendingOnly} onChange={(event) => setPendingOnly(event.target.checked)} />只看待确认</label>}
      {(pendingOnly && pending ? preview.buckets.filter((bucket) => bucket.excluded) : preview.buckets)
        .filter((bucket) => bucket.lines.length).map((bucket) => (
          <div key={bucket.key} className="orders-garment-section">
            <h4>{bucket.label} · {bucket.quantity} 件{bucket.excluded ? ' · 确认材质后才能导出' : ''}</h4>
            <GarmentCards bucket={bucket} selectedImages={selectedImages} onChangeMaterial={onChangeMaterial} onChangeImages={onChangeImages} disabled={disabled} />
          </div>
        ))}
      {preview.totals.lines === 0 && <div className="orders-empty">没有符合条件的订单{onlyNew ? '。已导出的订单自动隐藏，可以在更多选项里取消「只导出这个方案没导过的订单」。' : '。'}</div>}
      <div className="orders-export-bar">
        <div className="orders-export-files">{preview.files.length ? <>将生成：{preview.files.map((file) => file.name).join('、')}{pending > 0 ? `；${pending} 行待确认，本次不导出` : ''}</> : '没有可导出的订单，请先确认材质'}</div>
        <button type="button" disabled={disabled || exporting || refreshing || Boolean(blockedReason) || !preview.files.length} onClick={onExport}>{exporting ? '正在下载图片并导出…' : `3. 导出 ${preview.files.length} 个文件`}</button>
      </div>
    </section>
  );
}

function ExportResult({ record, downloading, downloadFailedIds }: { record: OrderExportRecord; downloading: boolean; downloadFailedIds: string[] }) {
  return (
    <section className="orders-card orders-result">
      <div className="orders-result-head">
        <span className="orders-result-icon" aria-hidden="true">✓</span>
        <div>
          <h3>{downloadFailedIds.length ? `${downloadFailedIds.length} 个文件下载失败` : `${downloading ? '正在自动下载' : '已开始自动下载'} ${record.files.length} 个文件`}</h3>
          <span className="orders-hint">
            {formatChinaDateTime(record.createdAt)} · 方案「{record.profileName}」 · 这些订单已标记为导出过
          </span>
        </div>

      </div>
      <ul className="orders-files">
        {record.files.map((file) => (
          <li key={file.id}>
            <span className="orders-file-name">{file.name}</span>
            <span className="orders-hint">{file.orderCount} 单 · {file.quantity} 件 · {fileSize(file.size)}</span>
            {downloadFailedIds.includes(file.id)
              ? <a className="orders-link-button ghost" href={api.orderExportFileUrl(record.id, file.id)} download>重试下载</a>
              : <span className="orders-hint">{downloading ? '自动下载中…' : '已开始下载'}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

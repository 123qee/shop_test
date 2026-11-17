import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  formatChinaDateTime,
  ORDER_RANGE_PRESETS,
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  rangeForPreset,
  type ExportMaterial,
  type OrderExportProfile,
  type OrderExportRecord,
  type OrderPreview,
  type OrderPreviewBucket,
  type OrderPreviewLine,
  type OrderQueryInput,
  type OrderRangePreset,
  type OrderSourceShopInfo,
  type OrderSourcesResponse,
  type OrderStatus,
  type OrderSyncJob,
} from '@shared/orders';
import { materialLabel } from '@shared/product-grouping';
import { api } from '../../api';
import { showFeedback } from '../../feedback';
import { PlannerIcon } from '../planner/PlannerIcon';
import {
  describeProfile,
  errorMessage,
  fileSize,
  MATERIAL_OPTIONS,
  parseShopKey,
  PROFILE_STORAGE_KEY,
  readStored,
  relativeTime,
  shopRefKey,
  writeStored,
} from './order-ui';

const REMEMBER_KEY = 'auto_tools.orders.rememberMaterial';
const ROW_LIMIT = 100;
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
  const [overrides, setOverrides] = useState<Record<string, ExportMaterial>>({});
  const [remember, setRemember] = useState(() => readStored(REMEMBER_KEY) !== '0');
  const [syncJob, setSyncJob] = useState<OrderSyncJob | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<OrderExportRecord | null>(null);
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
    };
  }, [profile, shopKeys, statuses, range, onlyNew, overrides]);
  const queryKey = JSON.stringify(query);

  const invalidReason = !query
    ? '请先在「方案与材质」里创建导出方案'
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
      if (seq === previewSeq.current && mounted.current) setPreview(data);
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

  async function changeMaterial(line: OrderPreviewLine, material: ExportMaterial) {
    const canRemember = remember && Boolean(line.productId || line.productSku);
    if (!canRemember) {
      setOverrides((current) => ({ ...current, [line.uid]: material }));
      return;
    }
    try {
      await api.saveOrderMaterialRule({
        platform: line.platform,
        productId: line.productId,
        productSku: line.productSku,
        title: line.title,
        material,
      });
      showFeedback(`已记住：这个商品以后按「${materialLabel(material)}」导出`);
      const nextOverrides = { ...overrides };
      delete nextOverrides[line.uid];
      setOverrides(nextOverrides);
      if (query) await runPreview({ ...query, overrides: nextOverrides });
    } catch (error) {
      showFeedback(errorMessage(error), 'error');
    }
  }

  async function runExport() {
    if (!query || invalidReason) return;
    setExporting(true);
    try {
      const record = await api.exportOrders(query);
      if (!mounted.current) return;
      setResult(record);
      setOverrides({});
      showFeedback(`已导出 ${record.files.length} 个文件`);
      onExported(record);
      void loadSources();
      await runPreview({ ...query, overrides: {} });
    } catch (error) {
      showFeedback(errorMessage(error), 'error');
    } finally {
      if (mounted.current) setExporting(false);
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

        <div className="orders-actions">
          <span className={invalidReason ? 'orders-error-text' : 'orders-hint'}>
            {invalidReason || `先从平台拉取所选店铺的最新订单，再按方案拆分预览。首次同步回溯 ${sources?.lookbackDays ?? 30} 天，选更早的日期会自动补拉。`}
          </span>
          <button type="button" className="ghost" disabled={busy || previewing || Boolean(invalidReason)} onClick={() => void previewLocal()}>
            仅预览本地数据
          </button>
          <button type="button" disabled={busy || Boolean(invalidReason)} onClick={() => void syncAndPreview()}>
            {syncing ? '正在同步…' : '同步并预览'}
          </button>
        </div>

        {syncJob && <SyncProgress job={syncJob} />}
      </section>

      {previewError && <div className="error">{previewError}</div>}

      {preview && (
        <PreviewPanel
          preview={preview}
          refreshing={previewing}
          blockedReason={invalidReason}
          exporting={exporting}
          remember={remember}
          onlyNew={onlyNew}
          overrides={overrides}
          onRememberChange={(value) => {
            setRemember(value);
            writeStored(REMEMBER_KEY, value ? '1' : '0');
          }}
          onChangeMaterial={(line, material) => void changeMaterial(line, material)}
          onExport={() => void runExport()}
        />
      )}

      {result && <ExportResult record={result} />}
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

function PreviewPanel({
  preview,
  refreshing,
  blockedReason,
  exporting,
  remember,
  onlyNew,
  overrides,
  onRememberChange,
  onChangeMaterial,
  onExport,
}: {
  preview: OrderPreview;
  refreshing: boolean;
  blockedReason: string;
  exporting: boolean;
  remember: boolean;
  onlyNew: boolean;
  overrides: Record<string, ExportMaterial>;
  onRememberChange: (value: boolean) => void;
  onChangeMaterial: (line: OrderPreviewLine, material: ExportMaterial) => void;
  onExport: () => void;
}) {
  const fileOf = (bucket: OrderPreviewBucket) => preview.files.find((file) => file.sheets.includes(bucket.label));
  const overrideCount = Object.keys(overrides).length;
  return (
    <section className={`orders-card orders-preview${refreshing ? ' refreshing' : ''}`}>
      <div className="orders-preview-head">
        <div>
          <h3>预览</h3>
          <span className="orders-hint">
            共 {preview.totals.orders} 单 · {preview.totals.quantity} 件
            {refreshing ? ' · 正在刷新…' : ''}
            {overrideCount ? ` · 本次临时改了 ${overrideCount} 行材质` : ''}
          </span>
        </div>
        <label className="orders-check" title="勾选后，在下面改材质会记住这个商品，以后自动归类；不勾选只对本次导出生效">
          <input type="checkbox" checked={remember} onChange={(event) => onRememberChange(event.target.checked)} />
          改材质时记住这个商品
        </label>
      </div>

      {preview.warnings.length > 0 && (
        <ul className="orders-warnings">
          {preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}

      <div className="orders-buckets">
        {preview.buckets.map((bucket) => {
          const file = fileOf(bucket);
          return (
            <div key={bucket.key} className={`orders-bucket ${bucket.kind === 'unknown' ? 'unknown' : bucket.key}${bucket.lines.length ? '' : ' empty'}`}>
              <span className="orders-bucket-label">{bucket.label}</span>
              <span className="orders-bucket-count"><strong>{bucket.orderCount}</strong> 单 · {bucket.quantity} 件</span>
              <span className="orders-bucket-file" title={file?.name}>
                {bucket.excluded
                  ? '本次不导出'
                  : file
                    ? file.sheets.length > 1 ? `${file.name} · 工作表「${bucket.label}」` : file.name
                    : '没有订单，不生成文件'}
              </span>
            </div>
          );
        })}
      </div>

      {preview.buckets.filter((bucket) => bucket.lines.length).map((bucket) => (
        <BucketLines
          key={bucket.key}
          bucket={bucket}
          overrides={overrides}
          onChangeMaterial={onChangeMaterial}
        />
      ))}

      {preview.totals.lines === 0 && (
        <div className="orders-empty">
          没有符合条件的订单{onlyNew ? '。导出过的订单不会再出现，需要重新导出可以取消「只导出这个方案没导过的订单」。' : '。'}
        </div>
      )}

      <div className="orders-export-bar">
        <div className="orders-export-files">
          {preview.files.length
            ? <>将生成 {preview.files.length} 个文件：{preview.files.map((file) => file.name).join('、')}</>
            : '没有可以导出的文件'}
        </div>
        <button type="button" disabled={exporting || refreshing || Boolean(blockedReason) || !preview.files.length} onClick={onExport}>
          {exporting ? '正在导出…' : `导出 ${preview.files.length} 个文件`}
        </button>
      </div>
    </section>
  );
}

function BucketLines({ bucket, overrides, onChangeMaterial }: {
  bucket: OrderPreviewBucket;
  overrides: Record<string, ExportMaterial>;
  onChangeMaterial: (line: OrderPreviewLine, material: ExportMaterial) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? bucket.lines : bucket.lines.slice(0, ROW_LIMIT);
  return (
    <details className={`orders-lines${bucket.kind === 'unknown' ? ' unknown' : ''}`} open={bucket.kind === 'unknown'}>
      <summary>
        <b>{bucket.label}</b>
        <span>{bucket.orderCount} 单 · {bucket.quantity} 件</span>
        {bucket.kind === 'unknown' && <span className="orders-hint">{bucket.excluded ? '本次不导出，确认材质后下次可以导出' : '请确认这些订单的材质'}</span>}
      </summary>
      <div className="orders-table-wrap">
        <table className="orders-table">
          <thead>
            <tr>
              <th>商品</th>
              <th>颜色 / 尺码</th>
              <th className="num">数量</th>
              <th>店铺 / 订单号</th>
              <th>下单时间</th>
              <th>材质</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((line) => {
              const known = MATERIAL_OPTIONS.some((option) => option.id === line.material);
              return (
                <tr key={line.uid} className={overrides[line.uid] ? 'overridden' : undefined}>
                  <td>
                    <div className="orders-product">
                      {line.imageUrl
                        ? <img src={line.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        : <span className="orders-noimg"><PlannerIcon name="package" size={16} /></span>}
                      <div>
                        <div className="orders-title" title={line.title}>
                          {line.title || '（没有商品名称）'}
                          {line.isGift && <span className="orders-tag">赠品</span>}
                        </div>
                        <div className="orders-sub mono">{line.variantSku || line.productSku || line.productId || '—'}</div>
                      </div>
                    </div>
                  </td>
                  <td>{[line.color, line.size].filter(Boolean).join(' / ') || '—'}</td>
                  <td className="num">{line.quantity}</td>
                  <td>
                    <div>{line.shopName}</div>
                    <div className="orders-sub mono">{line.orderId}</div>
                  </td>
                  <td>
                    <div>{formatChinaDateTime(line.orderedAt)}</div>
                    {line.exportedAt && <div className="orders-sub">已于 {formatChinaDateTime(line.exportedAt)} 导出</div>}
                  </td>
                  <td>
                    <select
                      className="orders-select small"
                      value={known ? line.material : ''}
                      onChange={(event) => onChangeMaterial(line, event.target.value as ExportMaterial)}
                      aria-label={`订单 ${line.orderId} 的材质`}
                    >
                      {!known && <option value="" disabled>{materialLabel(line.material)}，请选择</option>}
                      {MATERIAL_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                    </select>
                    <div className="orders-sub orders-evidence" title={line.materialEvidence}>{line.materialEvidence}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {bucket.lines.length > ROW_LIMIT && !showAll && (
        <button type="button" className="ghost orders-small orders-more" onClick={() => setShowAll(true)}>
          显示全部 {bucket.lines.length} 行
        </button>
      )}
    </details>
  );
}

function ExportResult({ record }: { record: OrderExportRecord }) {
  return (
    <section className="orders-card orders-result">
      <div className="orders-result-head">
        <span className="orders-result-icon" aria-hidden="true">✓</span>
        <div>
          <h3>已导出 {record.files.length} 个文件</h3>
          <span className="orders-hint">
            {formatChinaDateTime(record.createdAt)} · 方案「{record.profileName}」 · 这些订单已标记为导出过
          </span>
        </div>
        {record.files.length > 1 && (
          <a className="orders-link-button" href={api.orderExportZipUrl(record.id)} download>
            <PlannerIcon name="download" size={15} /> 打包下载
          </a>
        )}
      </div>
      <ul className="orders-files">
        {record.files.map((file) => (
          <li key={file.id}>
            <span className="orders-file-name">{file.name}</span>
            <span className="orders-hint">{file.orderCount} 单 · {file.quantity} 件 · {fileSize(file.size)}</span>
            <a className="orders-link-button ghost" href={api.orderExportFileUrl(record.id, file.id)} download>下载</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

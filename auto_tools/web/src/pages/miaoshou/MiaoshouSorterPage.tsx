import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ProductIndexItem } from '@shared/product-catalog';
import type { MiaoshouDraft } from '@shared/miaoshou';
import { MIAOSHOU_SITE_NAMES } from '@shared/miaoshou';
import { PRODUCT_GROUPS, PRODUCT_MATERIALS } from '@shared/product-grouping';
import { api } from '../../api';
import { miaoshouApi } from './api';
import { useMiaoshouWorkspace } from './use-workspace';
import { useProductCards } from '../../product-cards';
import { sizedImageSource, fallbackToSourceImage } from '../../image-utils';
import { SorterImage } from '../../components/SorterImage';
import { useSorterImages } from '../../use-sorter-images';
import './miaoshou.css';

export function MiaoshouSorterPage() {
  const { workspace, refresh, error, setError, loading } = useMiaoshouWorkspace();
  const [products, setProducts] = useState<ProductIndexItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [loadedDraft, setDraft] = useState<MiaoshouDraft | null>(null);
  const [choice, setChoice] = useState('');
  const [image, setImage] = useState(0);
  const [readyImage, setReadyImage] = useState('');
  const [revisited, setRevisited] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [params, setParams] = useSearchParams();
  const requestId = useRef(0);
  const openedProduct = useRef<{ id: string; updatedAt: string; version: number }>();
  const source = params.get('source') || '', group = params.get('group') || '', material = params.get('material') || '', scope = params.get('scope') || '';
  const [catalogRetry, setCatalogRetry] = useState(0);
  useEffect(() => { let cancelled = false; setCatalogLoading(true); api.productIndex().then(data => { if (!cancelled) setProducts(data); }).catch(e => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setCatalogLoading(false); }); return () => { cancelled = true; }; }, [catalogRetry, setError]);
  const byProduct = useMemo(() => new Map(workspace?.drafts.map(d => [d.productId, d])), [workspace]);
  const candidates = useMemo(() => products.filter(p => {
    const existing = byProduct.get(p.id);
    return p.status !== 'discarded' && (!source || p.collected.source === source) && (!group || p.grouping.groupId === group) && (!material || p.grouping.material === material)
      && (scope === 'skipped' ? existing?.status === 'skipped' && !revisited.has(p.id) : !existing || existing.status === 'pending');
  }), [products, byProduct, source, group, material, scope, revisited]);
  useEffect(() => { setRevisited(new Set()); }, [scope, source, group, material]);
  const current = candidates[0];
  const draft = loadedDraft?.productId === current?.id ? loadedDraft : null;
  const templates = workspace?.templates ?? [];
  const templateIds = templates.map(template => template.id).join(',');
  const recommendation = templates.find(t => t.groupId && t.groupId === current?.grouping.groupId && (!t.material || t.material === current?.grouping.material));
  const currentSummary = current ? byProduct.get(current.id) : undefined;
  const { cards } = useProductCards(candidates.slice(0, 3));
  const previewSource = draft?.images[image] ?? currentSummary?.image ?? cards.find(card => card.id === current?.id)?.sourceImage;
  useSorterImages(Boolean(previewSource && readyImage === previewSource), [
    draft?.images[image + 1],
    ...candidates.slice(1, 3).map(product => byProduct.get(product.id)?.image ?? cards.find(card => card.id === product.id)?.sourceImage),
    draft?.images[image + 2],
  ]);
  useEffect(() => {
    // 新建的草稿随后进入轮询摘要时，无需重置刚选好的模板或图片。
    if (current && openedProduct.current?.id === current.id && openedProduct.current.updatedAt === current.updatedAt
      && loadedDraft?.productId === current.id && loadedDraft.version === currentSummary?.version) return;
    const request = ++requestId.current;
    openedProduct.current = undefined;
    setDraft(null); setChoice(''); setImage(0); setReadyImage('');
    if (!current || !workspace) return;
    const opened = currentSummary ? miaoshouApi.get(currentSummary.id) : miaoshouApi.open(current.id);
    opened.then(d => { if (request === requestId.current) { openedProduct.current = { id: current.id, updatedAt: current.updatedAt, version: d.version }; setDraft(d); setChoice(templates.some(t => t.id === d.templateId) ? d.templateId : recommendation?.id ?? ''); } }).catch(e => { if (request === requestId.current) setError(e.message); });
    return () => { requestId.current++; };
  // 后台轮询会返回新 templates 数组，内容没变时不能清空并重新加载当前商品。
  }, [current?.id, current?.updatedAt, currentSummary?.version, Boolean(workspace), catalogRetry, setError]);
  useEffect(() => { setChoice(value => value && !templates.some(template => template.id === value) ? '' : value); }, [templateIds]);
  function filter(key: string, value: string) { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); setParams(next, { replace: true }); }
  async function decide(action: 'ready' | 'skipped') {
    if (!draft || busy) return;
    setBusy(true); setNotice('');
    try { await miaoshouApi.decide(draft, action, action === 'ready' ? choice || undefined : undefined); if (scope === 'skipped' && action === 'skipped') setRevisited(ids => new Set([...ids, draft.productId])); await refresh(); setNotice(action === 'ready' ? '已加入妙手提交清单，缺少的信息可以稍后补齐。' : '已暂时跳过，可在跳过项中继续分拣。'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function undo() {
    if (!workspace?.undoId || busy) return; setBusy(true);
    try { await miaoshouApi.undo(workspace.undoId); setRevisited(new Set()); await refresh(); setNotice('已撤销上一步分拣。'); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (busy || e.repeat || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true],[role=dialog]')) return;
      if (/^[1-9]$/.test(e.key) && templates[Number(e.key) - 1]) { setChoice(templates[Number(e.key) - 1].id); e.preventDefault(); }
      if (e.key === 'Enter' && !(e.target as HTMLElement).closest('button,a')) { e.preventDefault(); void decide('ready'); }
      if (e.key.toLowerCase() === 's') { e.preventDefault(); void decide('skipped'); }
      if (e.key.toLowerCase() === 'z') { e.preventDefault(); void undo(); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  });
  const selected = templates.find(t => t.id === choice);
  const queueCount = workspace?.drafts.filter(d => ['ready', 'failed'].includes(d.status)).length ?? 0;
  return <div className="ms-page">
    <div className="ms-top"><div><strong>传统店铺 · 美客多分拣</strong><p>采集母库 → 分拣 → 妙手采集箱 → 在妙手完成刊登</p></div><Link className="ghost" to="/miaoshou/queue">妙手提交清单 · {queueCount}</Link></div>
    {error && <div className="error" role="alert">{error} <button className="ghost" onClick={() => { setCatalogRetry(n => n + 1); void refresh().catch(() => {}); }}>重试</button></div>}
    <div className="ms-toolbar">
      <select aria-label="采集来源" value={source} onChange={e => filter('source', e.target.value)} disabled={busy}><option value="">全部来源</option>{[...new Set(products.map(p => p.collected.source))].sort().map(s => <option key={s}>{s}</option>)}</select>
      <select aria-label="商品分组" value={group} onChange={e => filter('group', e.target.value)} disabled={busy}><option value="">全部分组</option>{PRODUCT_GROUPS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select>
      <select aria-label="材质" value={material} onChange={e => filter('material', e.target.value)} disabled={busy}><option value="">全部材质</option>{PRODUCT_MATERIALS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
      <button className="ghost" disabled={busy} onClick={() => filter('scope', scope === 'skipped' ? '' : 'skipped')}>{scope === 'skipped' ? '返回待分拣' : `回看跳过项（${workspace?.drafts.filter(d => d.status === 'skipped').length ?? 0}）`}</button><span className="ms-muted">当前筛选 {candidates.length} 件</span>
    </div>
    {(loading || catalogLoading || current && !draft) && <div className="empty-state"><strong>正在加载分拣商品…</strong></div>}
    {current && !draft && previewSource && <div className="ms-sort-grid"><div className="ms-hero"><SorterImage key={current.id} source={previewSource} alt={current.collected.title} onReady={() => setReadyImage(previewSource)} /></div></div>}
    {!loading && !catalogLoading && !current && <div className="empty-state"><strong>当前筛选没有待分拣商品</strong><p>调整来源、分组或材质，或查看暂时跳过的商品。</p><Link to="/miaoshou/queue">打开妙手提交清单</Link></div>}
    {draft && current && <div className="ms-sort-grid">
      <div><div className="ms-hero">{draft.images[image] ? <SorterImage key={`${draft.id}:${draft.images[image]}`} source={draft.images[image]} alt={draft.title} onReady={() => setReadyImage(draft.images[image])} /> : <span>暂无图片</span>}</div><div className="ms-thumbnails">{draft.images.map((img, i) => <button key={`${img}-${i}`} aria-label={`查看第 ${i + 1} 张图片`} aria-pressed={image === i} onClick={() => setImage(i)}><img src={sizedImageSource(img, 'thumb')} alt="" loading="lazy" decoding="async" fetchPriority="low" onError={event => fallbackToSourceImage(event.currentTarget, img)} /></button>)}</div><h2 className="ms-product-title">{draft.title}</h2><p className="ms-muted">{draft.source} · {draft.sourceProductId} · {draft.variants.length} 个原始 SKU</p><a href={draft.sourceUrl} target="_blank" rel="noreferrer">查看来源商品 ↗</a></div>
      <div className="ms-sort-options"><div className="ms-section-head"><h3>选择独立商品模板</h3><Link to="/miaoshou/settings">管理模板</Link></div>
        {!templates.length && <p className="ms-note">模板可以稍后创建。先加入提交清单，再完善净收益、类目和尺码等信息。</p>}
        <div className="ms-template-list"><button className={`ms-template${!choice ? ' selected' : ''}`} aria-pressed={!choice} disabled={busy} onClick={() => setChoice('')}><strong>暂不套用模板</strong><small>保留采集内容，稍后填写</small></button>{templates.map((t, i) => <button key={t.id} className={`ms-template${choice === t.id ? ' selected' : ''}`} aria-pressed={choice === t.id} disabled={busy} onClick={() => setChoice(t.id)}><strong>{i < 9 && <kbd>{i + 1}</kbd>} {t.name}{recommendation?.id === t.id && <span className="ms-good"> · 推荐</span>}</strong><small>净收益 {t.netProceeds == null ? '待填写' : `${t.netProceeds} USD`} · {t.sites.map(s => MIAOSHOU_SITE_NAMES[s]).join(' / ')}</small></button>)}</div>
        <div className="ms-preview"><h3>套用后预览</h3><dl><div><dt>定价模式</dt><dd>净收益（USD）</dd></div><div><dt>净收益</dt><dd>{selected?.netProceeds ?? draft.netProceeds ?? '待填写'}</dd></div><div><dt>站点</dt><dd>{(selected?.sites ?? draft.sites).map(s => MIAOSHOU_SITE_NAMES[s]).join('、') || '待选择'}</dd></div><div><dt>类目与尺码</dt><dd>可在提交清单中完善</dd></div></dl></div>
        <Link className="ghost" to={`/miaoshou/drafts/${draft.id}`}>编辑这份美客多草稿</Link>
      </div>
    </div>}
    <div className="ms-actions"><button className="ghost" onClick={() => void undo()} disabled={busy || !workspace?.undoId}>撤销上一步 <kbd>Z</kbd></button><button className="ghost" onClick={() => void decide('skipped')} disabled={busy || !draft}>暂时跳过 <kbd>S</kbd></button><button onClick={() => void decide('ready')} disabled={busy || !draft}>{busy ? '正在保存…' : '确认并加入妙手提交清单'} <kbd>Enter</kbd></button></div>
    <div className="ms-notice" role="status" aria-live="polite">{notice}</div>
  </div>;
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ProductIndexItem } from '@shared/product-catalog';
import type { MiaoshouDraft } from '@shared/miaoshou';
import { MIAOSHOU_SITE_NAMES } from '@shared/miaoshou';
import { PRODUCT_GROUPS, PRODUCT_MATERIALS } from '@shared/product-grouping';
import { api } from '../../api';
import { miaoshouApi } from './api';
import { useMiaoshouWorkspace } from './use-workspace';
import './miaoshou.css';

export function MiaoshouSorterPage() {
  const { workspace, refresh, error, setError, loading } = useMiaoshouWorkspace();
  const [products, setProducts] = useState<ProductIndexItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [draft, setDraft] = useState<MiaoshouDraft | null>(null);
  const [choice, setChoice] = useState('');
  const [image, setImage] = useState(0);
  const [failedImage, setFailedImage] = useState('');
  const [revisited, setRevisited] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [params, setParams] = useSearchParams();
  const requestId = useRef(0);
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
  const templates = workspace?.templates ?? [];
  const recommendation = templates.find(t => t.groupId && t.groupId === current?.grouping.groupId && (!t.material || t.material === current?.grouping.material));
  useEffect(() => {
    const request = ++requestId.current;
    setDraft(null); setChoice(''); setImage(0); setFailedImage('');
    if (!current || !workspace) return;
    miaoshouApi.open(current.id).then(d => { if (request === requestId.current) { setDraft(d); setChoice(templates.some(t => t.id === d.templateId) ? d.templateId : recommendation?.id ?? ''); } }).catch(e => { if (request === requestId.current) setError(e.message); });
    return () => { requestId.current++; };
  }, [current?.id, current?.updatedAt, recommendation?.id, templates, Boolean(workspace), setError]);
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
    {!loading && !catalogLoading && !current && <div className="empty-state"><strong>当前筛选没有待分拣商品</strong><p>调整来源、分组或材质，或查看暂时跳过的商品。</p><Link to="/miaoshou/queue">打开妙手提交清单</Link></div>}
    {draft && current && <div className="ms-sort-grid">
      <div><div className="ms-hero">{draft.images[image] && failedImage !== draft.images[image] ? <img key={draft.images[image]} src={draft.images[image]} alt={draft.title} onError={() => setFailedImage(draft.images[image])} /> : <span>{draft.images[image] ? '图片加载失败，可切换图片或查看来源' : '暂无图片'}</span>}</div><div className="ms-thumbnails">{draft.images.map((img, i) => <button key={`${img}-${i}`} aria-label={`查看第 ${i + 1} 张图片`} aria-pressed={image === i} onClick={() => setImage(i)}><img src={img} alt="" loading="lazy" /></button>)}</div><h2 className="ms-product-title">{draft.title}</h2><p className="ms-muted">{draft.source} · {draft.sourceProductId} · {draft.variants.length} 个原始 SKU</p><a href={draft.sourceUrl} target="_blank" rel="noreferrer">查看来源商品 ↗</a></div>
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

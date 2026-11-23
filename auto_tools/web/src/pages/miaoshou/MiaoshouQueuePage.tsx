import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MIAOSHOU_STATUS_NAMES, type MiaoshouStatus, type MiaoshouSummary } from '@shared/miaoshou';
import { miaoshouApi } from './api';
import { useMiaoshouWorkspace } from './use-workspace';
import { useNativePrompt } from '../../components/NativePromptProvider';
import { MiaoshouReviewActions } from './MiaoshouReviewActions';
import './miaoshou.css';

export function MiaoshouQueuePage() {
  const { workspace, refresh, error, setError, loading } = useMiaoshouWorkspace();
  const [tab, setTab] = useState<'queue' | 'history' | 'review'>('queue');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const prompt = useNativePrompt();
  const statuses: Record<typeof tab, MiaoshouStatus[]> = { queue: ['ready', 'failed', 'queued', 'submitting'], history: ['submitted'], review: ['needs_review'] };
  const rows = useMemo(() => (workspace?.drafts ?? []).filter(d => statuses[tab].includes(d.status) && (!query.trim() || `${d.title} ${d.source} ${d.remoteId ?? ''}`.toLowerCase().includes(query.toLowerCase()))), [workspace, tab, query]);
  const canSubmit = (d: MiaoshouSummary) => ['ready', 'failed'].includes(d.status) && !d.issues.length;
  const selectable = rows.filter(canSubmit);
  const checked = selectable.filter(d => selected.has(d.id));
  async function action(run: () => Promise<unknown>, message: string) { if (busy) return; setBusy(true); setNotice(''); try { await run(); await refresh(); setNotice(message); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function submit() {
    if (!checked.length) return;
    if (!await prompt.confirm(`将选中的 ${checked.length} 件商品加入妙手采集箱提交队列。请确认各商品的目标店铺、站点和净收益已经核对。`)) return;
    await action(async () => { await miaoshouApi.submit(checked.map(d => ({ id: d.id, version: d.version }))); setSelected(new Set()); }, '已加入提交队列，页面将自动更新进度。');
  }
  return <div className="ms-page">
    <div className="ms-top"><div><strong>妙手提交清单</strong><p>先完善信息，再将商品写入传统店铺的美客多采集箱。</p></div><div className="ms-inline"><a className="ghost" href="https://erp.91miaoshou.com/mercadolibre/collect_box/items" target="_blank" rel="noreferrer">打开妙手采集箱 ↗</a><Link className="ghost" to="/miaoshou/sort">继续分拣</Link></div></div>
    {error && <div className="error" role="alert">{error}</div>}
    <div className="ms-tabs">{(['queue', 'review', 'history'] as const).map(t => <button key={t} className={tab === t ? 'on' : 'ghost'} aria-pressed={tab === t} onClick={() => setTab(t)}>{({ queue: '待提交与处理中', review: '结果待核对', history: '已入箱记录' })[t]}（{workspace?.drafts.filter(d => statuses[t].includes(d.status)).length ?? 0}）</button>)}</div>
    <div className="ms-toolbar"><input aria-label="搜索提交清单" placeholder="搜索标题、来源或妙手采集箱 ID" value={query} onChange={e => setQuery(e.target.value)} /><button className="ghost" disabled={busy} onClick={() => void action(refresh, '已刷新。')}>刷新</button><span className="ms-muted">{rows.length} 件商品</span>{tab === 'queue' && <><button className="ghost" disabled={busy || !selectable.length} onClick={() => setSelected(s => checked.length === selectable.length ? new Set([...s].filter(id => !selectable.some(d => d.id === id))) : new Set([...s, ...selectable.map(d => d.id)]))}>{checked.length === selectable.length && selectable.length ? '取消全选' : '全选可提交商品'}</button><button disabled={busy || !checked.length} onClick={() => void submit()}>提交到妙手采集箱（{checked.length}）</button></>}</div>
    {loading && <div className="empty-state">正在加载提交清单…</div>}
    {!loading && !rows.length && <div className="empty-state"><strong>当前没有商品</strong><p>从独立分拣工作台选择商品，确认后会进入提交清单。</p></div>}
    {rows.length > 0 && <div className="ms-table-wrap"><table className="ms-table"><thead><tr>{tab === 'queue' && <th>选择</th>}<th>商品与模板</th><th>店铺 / 站点</th><th>净收益 USD</th><th>提交状态</th><th>操作</th></tr></thead><tbody>{rows.map(d => <tr key={d.id}>
      {tab === 'queue' && <td><input type="checkbox" aria-label={`选择 ${d.title}`} disabled={busy || !canSubmit(d)} checked={selected.has(d.id)} onChange={e => { const next = new Set(selected); if (e.target.checked) next.add(d.id); else next.delete(d.id); setSelected(next); }} /></td>}
      <td><div className="ms-row-product">{d.image && <img src={d.image} alt="" loading="lazy" />}<div><Link to={`/miaoshou/drafts/${d.id}`}>{d.title}</Link><small>{d.source} · {workspace?.templates.find(t => t.id === d.templateId)?.name ?? '未套用模板'}</small></div></div></td>
      <td>{d.shopId || '待选店铺'}<small>{d.sites.join(' / ') || '待选站点'}</small></td><td>{d.netProceeds ?? '待填写'}</td>
      <td><span className={`ms-status ms-${d.status}`}>{MIAOSHOU_STATUS_NAMES[d.status]}</span>{d.remoteId && <small>采集箱 ID：{d.remoteId}</small>}{d.lastError && <small className="ms-error-text">{d.lastError}</small>}{d.issues.length > 0 && !['submitted', 'submitting', 'queued'].includes(d.status) && <details><summary>待补 {d.issues.length} 项</summary><ul>{d.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></details>}</td>
      <td><div className="ms-row-actions"><Link to={`/miaoshou/drafts/${d.id}`}>{['submitted', 'needs_review', 'queued', 'submitting'].includes(d.status) ? '查看草稿' : '编辑补齐'}</Link>{['ready', 'failed'].includes(d.status) && <button className="ghost" disabled={busy} onClick={() => void action(() => miaoshouApi.decide(d, 'pending'), '已移回分拣。')}>移回分拣</button>}{d.status === 'needs_review' && <MiaoshouReviewActions draft={d} busy={busy} run={action} />}</div></td>
    </tr>)}</tbody></table></div>}
    <p className="ms-notice" role="status" aria-live="polite">{notice}</p>
  </div>;
}

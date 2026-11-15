import { useEffect, useState } from 'react';
import type { DashboardStats, JoomStatus } from '@shared/types';
import { Link, useOutletContext } from 'react-router-dom';
import { api } from '../api';
import { PlannerIcon } from './planner/PlannerIcon';
import { JOOM_BUCKET_META, PRIMARY_JOOM_BUCKETS } from '@shared/joom-listing';
import {
  PRODUCT_ACTION_LISTS_CHANGED,
  readProductActionLists,
  type ProductActionLists,
  type ProductActionListsChangedDetail,
} from '../product-action-lists';

export function DashboardPage() {
  const { joom } = useOutletContext<{ joom: JoomStatus | null }>();
  const actionListScope = joom?.shopId ?? 'default';
  const [data, setData] = useState<DashboardStats | null>(null);
  const [actionLists, setActionLists] = useState<ProductActionLists>(readProductActionLists);
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    return api.dashboard().then(setData).catch((e) => setError((e as Error).message));
  };
  useEffect(() => {
    load();
    const onListsChanged = (event: Event) => {
      const detail = (event as CustomEvent<ProductActionListsChangedDetail>).detail;
      if (!detail || detail.scope === actionListScope) setActionLists(detail?.lists ?? readProductActionLists(actionListScope));
    };
    window.addEventListener(PRODUCT_ACTION_LISTS_CHANGED, onListsChanged);
    return () => window.removeEventListener(PRODUCT_ACTION_LISTS_CHANGED, onListsChanged);
  }, [actionListScope]);
  useEffect(() => { setActionLists(readProductActionLists(actionListScope)); }, [actionListScope]);
  if (error) return <div className="error">{error}</div>;
  if (!data) return <p className="muted">加载看板…</p>;
  const unpublished = data.total - (data.byStatus.published ?? 0) - (data.byStatus.discarded ?? 0);
  return <>
    <div className="dashboard-toolbar"><span>数据概览</span><button className="ghost" onClick={load}>刷新数据</button></div>
    <div className="metric-grid dashboard-metrics">
      <Metric label="商品总数" value={data.total} tone="blue" to="/joom" />
      <Metric label="待发布商品" value={unpublished} tone="orange" to="/joom?status=unpublished" />
      <Metric label="店铺活性" value={data.byListing?.active ?? 0} tone="green" to="/joom?listing=active" />
      <Metric label="需要处理" value={data.byListing?.error ?? 0} tone="red" to="/joom?listing=error" />
    </div>

    <div className="dashboard-section-head"><div><h2>待处理</h2><p>先整理清单，再执行发布或删除</p></div><Link to="/joom">浏览商品 →</Link></div>
    <div className="dashboard-action-lists">
      <Link className="dashboard-action-card publish" to="/joom/publish-list">
        <span className="dashboard-action-icon"><PlannerIcon name="upload" size={20}/></span>
        <span><strong>发布清单</strong><small>发布前集中检查商品内容</small></span>
        <b>{actionLists.publish.length}</b>
        <em>查看清单 →</em>
      </Link>
      <Link className="dashboard-action-card remove" to="/joom/delete-list">
        <span className="dashboard-action-icon"><PlannerIcon name="trash" size={20}/></span>
        <span><strong>删除清单</strong><small>集中复核，避免误删商品</small></span>
        <b>{actionLists.remove.length}</b>
        <em>查看清单 →</em>
      </Link>
    </div>

    <div className="dashboard-home-grid">
      <section className="section dashboard-compact-section">
        <div className="section-head"><h3>Joom 店铺状态</h3><Link to="/joom">查看商品 →</Link></div>
        <div className="dashboard-status-list">
          {PRIMARY_JOOM_BUCKETS.map((bucket) => (
            <Link key={bucket} to={`/joom?listing=${bucket}`} title={JOOM_BUCKET_META[bucket].hint}>
              <span className={`dashboard-status-dot ${bucket}`} />
              <span>{JOOM_BUCKET_META[bucket].label}</span>
              <strong>{data.byListing?.[bucket] ?? 0}</strong>
            </Link>
          ))}
        </div>
        <p className="dashboard-sync-note">
          {data.joomStatus.lastSyncedAt
            ? `按 ${data.joomStatus.shops.filter((shop) => shop.lastSyncedAt).length} 个已同步店铺的刊登统计 · 共 ${data.joomStatus.total} 条${data.joomStatus.unmatchedRemote ? ` · ${data.joomStatus.unmatchedRemote} 条未关联本地记录` : ''}`
            : '尚无店铺状态快照，请先同步各店铺'}
        </p>
        {data.unsyncedPublished > 0 && <Link className="dashboard-sync-note" to="/joom?listing=unsynced">还有 {data.unsyncedPublished} 个商品未同步店铺状态 →</Link>}
      </section>
      <section className="section dashboard-compact-section">
        <div className="section-head"><h3>最近任务</h3><Link to="/joom">进入商品浏览 →</Link></div>
        {data.recentActivity.length ? <div className="activity-list dashboard-activity-list">{data.recentActivity.slice(0, 5).map((a) => <div className="activity-item" key={a.id}><span className="activity-icon">{a.action.includes('sync') ? '↻' : a.action.includes('publish') ? '↑' : '✦'}</span><span><strong>{a.summary}</strong><small>{new Date(a.createdAt).toLocaleString()}</small></span></div>)}</div> : <div className="empty-state">还没有操作记录。</div>}
      </section>
    </div>
  </>;
}

function Metric({ label, value, suffix, tone, to }: { label: string; value: number; suffix?: string; tone: string; to?: string }) {
  const body = <><span>{label}</span><strong>{value}<small>{suffix}</small></strong></>;
  if (to) return <Link className={`metric-card ${tone}`} to={to}>{body}</Link>;
  return <div className={`metric-card ${tone}`}>{body}</div>;
}

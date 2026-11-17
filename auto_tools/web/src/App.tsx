import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import type { JoomStatus } from '@shared/types';
import { api } from './api';
import {
  PRODUCT_ACTION_LISTS_CHANGED,
  readProductActionLists,
  type ProductActionLists,
  type ProductActionListsChangedDetail,
} from './product-action-lists';
import { APP_FEEDBACK_EVENT, type FeedbackDetail } from './feedback';
import { PlannerIcon } from './pages/planner/PlannerIcon';

const SIDEBAR_COLLAPSED_KEY = 'auto_tools.sidebarCollapsed';

function readSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function pageMeta(pathname: string) {
  if (pathname.startsWith('/projects')) return ['项目', '为工作与生活，留出各自的空间'];
  if (pathname === '/tasks') return ['任务', '把想法变成行动，按自己的节奏推进'];
  if (pathname === '/' || pathname === '/dashboard') return ['工作台', '查看店铺状态和今天需要处理的任务'];
  if (pathname === '/sources') return ['采集母库', '统一管理从各平台采集的原始商品'];
  if (pathname === '/joom') return ['商品浏览', '筛选商品并加入发布清单或删除清单'];
  if (pathname === '/joom/publish-list') return ['发布清单', '发布前集中检查，确认后提交到 Joom'];
  if (pathname === '/joom/delete-list') return ['删除清单', '集中复核待删除商品，避免误操作'];
  if (pathname.startsWith('/products/')) return ['编辑商品', '完善商品信息并检查发布准备度'];
  if (pathname === '/settings') return ['Joom 设置', '店铺、模板和发布配置'];
  if (pathname.startsWith('/orders')) return ['订单导出', '多店铺订单按材质拆分，导出 Excel'];
  if (pathname === '/mercadolibre/settings') return ['美客多设置', '应用、卖家账号与刊登模板'];
  if (pathname === '/aliexpress/auto-fill') return ['速卖通自动填充', '查看并维护扩展自动填写的字段和值'];
  if (pathname.startsWith('/mercadolibre/products/')) return ['编辑美客多商品', '完善站点刊登内容'];
  if (pathname.startsWith('/mercadolibre')) return ['美客多刊登中心', '管理各站点商品草稿和发布状态'];
  return ['商品运营', '跨境商品工作台'];
}

export function App() {
  const [joom, setJoom] = useState<JoomStatus | null>(null);
  const [actionLists, setActionLists] = useState<ProductActionLists>(readProductActionLists);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const location = useLocation();
  const inMercadoLibre = location.pathname.startsWith('/mercadolibre');
  // 订单导出按页面里勾选的店铺工作，与「当前店铺」无关，不显示店铺切换器以免误会
  const inOrders = location.pathname.startsWith('/orders');
  const inPersonal = location.pathname.startsWith('/projects') || location.pathname === '/tasks';
  const inTasks = location.pathname === '/tasks';
  const inProjects = location.pathname === '/projects';
  const compactPersonal = inTasks || inProjects;
  const [title, subtitle] = pageMeta(location.pathname);
  const actionListScope = joom?.shopId ?? 'default';

  async function refresh() {
    try {
      setJoom(await api.joomStatus());
    } catch {
      setJoom(null);
    }
  }

  useEffect(() => {
    refresh();
    // OAuth 回调跳回时带 ?joom=connected
    if (new URLSearchParams(location.search).get('joom') === 'connected') {
      history.replaceState({}, '', '/');
      refresh();
    }
    const onRefresh = () => {
      void refresh();
    };
    window.addEventListener('joom-refresh', onRefresh);
    return () => window.removeEventListener('joom-refresh', onRefresh);
  }, []);

  useEffect(() => {
    const onListsChanged = (event: Event) => {
      const detail = (event as CustomEvent<ProductActionListsChangedDetail>).detail;
      if (!detail || detail.scope === actionListScope) setActionLists(detail?.lists ?? readProductActionLists(actionListScope));
    };
    const onStorage = () => setActionLists(readProductActionLists(actionListScope));
    window.addEventListener(PRODUCT_ACTION_LISTS_CHANGED, onListsChanged);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(PRODUCT_ACTION_LISTS_CHANGED, onListsChanged);
      window.removeEventListener('storage', onStorage);
    };
  }, [actionListScope]);

  useEffect(() => {
    setActionLists(readProductActionLists(actionListScope));
  }, [actionListScope]);

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* 本地存储不可用时仅保留本次页面状态 */
      }
      return next;
    });
  }

  return (
    <div className={`app-shell${inPersonal ? ' personal-space' : ''}${inTasks ? ' task-space' : inProjects ? ' project-space' : ''}`}>
      <FeedbackToast />
      <aside className={`app-sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
        <button
          type="button"
          className="sidebar-collapse-button"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? '展开菜单栏' : '收起菜单栏'}
          title={sidebarCollapsed ? '展开菜单栏' : '收起菜单栏'}
          aria-expanded={!sidebarCollapsed}
        >
          {sidebarCollapsed ? '›' : '‹'}
        </button>
        <Link className="sidebar-brand" to="/">
          <span className="sidebar-brand-mark"><PlannerIcon name="grid" size={20}/></span>
          <span className="sidebar-brand-copy"><strong>我的工作台</strong><small>工作与生活</small></span>
        </Link>
        <nav className="sidebar-nav" aria-label="主导航">
          <span className="sidebar-group-label">概览</span>
          <NavLink to="/" end title="工作台" className={({ isActive }) => `sidebar-link${isActive ? ' on' : ''}`}>
            <span className="sidebar-link-icon"><PlannerIcon name="grid" size={17}/></span><span className="sidebar-link-label">工作台</span>
          </NavLink>
          <span className="sidebar-group-label">个人管理</span>
          <NavLink to="/tasks" title="任务" className={({ isActive }) => `sidebar-link sidebar-personal${isActive ? ' on' : ''}`}>
            <span className="sidebar-link-icon"><PlannerIcon name="tasks" size={17}/></span><span className="sidebar-link-label">任务</span>
          </NavLink>
          <NavLink to="/projects" title="项目" className={({ isActive }) => `sidebar-link sidebar-personal${isActive ? ' on' : ''}`}>
            <span className="sidebar-link-icon"><PlannerIcon name="folder" size={17}/></span><span className="sidebar-link-label">项目</span>
          </NavLink>
          <span className="sidebar-group-label">商品</span>
          <NavLink to="/sources" title="采集母库" className={({ isActive }) => `sidebar-link${isActive ? ' on' : ''}`}>
            <span className="sidebar-link-icon"><PlannerIcon name="collection" size={17}/></span><span className="sidebar-link-label">采集母库</span>
          </NavLink>
          <NavLink to="/joom" end title="商品浏览" className={({ isActive }) => `sidebar-link${isActive ? ' on' : ''}`}>
            <span className="sidebar-link-icon"><PlannerIcon name="package" size={17}/></span><span className="sidebar-link-label">商品浏览</span>
          </NavLink>
          <span className="sidebar-group-label">Joom 发布</span>
          <NavLink to="/joom/publish-list" title="发布清单" className={({ isActive }) => `sidebar-link${isActive ? ' on' : ''}`}>
            <span className="sidebar-link-icon"><PlannerIcon name="upload" size={17}/></span><span className="sidebar-link-label">发布清单</span>
            {actionLists.publish.length > 0 && <b className="sidebar-count">{actionLists.publish.length}</b>}
          </NavLink>
          <NavLink to="/joom/delete-list" title="删除清单" className={({ isActive }) => `sidebar-link sidebar-link-danger${isActive ? ' on' : ''}`}>
            <span className="sidebar-link-icon"><PlannerIcon name="trash" size={17}/></span><span className="sidebar-link-label">删除清单</span>
            {actionLists.remove.length > 0 && <b className="sidebar-count">{actionLists.remove.length}</b>}
          </NavLink>
          <NavLink to="/settings" title="店铺与模板" className={({ isActive }) => `sidebar-link${isActive ? ' on' : ''}`}>
            <span className="sidebar-link-icon"><PlannerIcon name="settings" size={17}/></span><span className="sidebar-link-label">店铺与模板</span>
          </NavLink>
          <span className="sidebar-group-label">订单</span>
          <NavLink to="/orders" title="订单导出" className={({ isActive }) => `sidebar-link${isActive ? ' on' : ''}`}>
            <span className="sidebar-link-icon"><PlannerIcon name="download" size={17}/></span><span className="sidebar-link-label">订单导出</span>
          </NavLink>
          <span className="sidebar-group-label">速卖通工具</span>
          <NavLink to="/aliexpress/auto-fill" title="自动填充字段" className={({ isActive }) => `sidebar-link${isActive ? ' on' : ''}`}>
            <span className="sidebar-link-icon"><PlannerIcon name="settings" size={17}/></span><span className="sidebar-link-label">自动填充字段</span>
          </NavLink>
          <span className="sidebar-group-label">其他平台</span>
          <NavLink to="/mercadolibre" end title="美客多刊登" className={({ isActive }) => `sidebar-link${isActive ? ' on' : ''}`}>
            <span className="sidebar-link-icon"><PlannerIcon name="globe" size={17}/></span><span className="sidebar-link-label">美客多刊登</span>
          </NavLink>
          <NavLink to="/mercadolibre/settings" title="美客多设置" className={({ isActive }) => `sidebar-link${isActive ? ' on' : ''}`}>
            <span className="sidebar-link-icon"><PlannerIcon name="settings" size={17}/></span><span className="sidebar-link-label">美客多设置</span>
          </NavLink>
        </nav>
        <div className="sidebar-foot">
          <span className={`sidebar-status-dot ${joom?.connected ? 'on' : ''}`} />
          <span>{joom?.connected ? `${joom.shopName || 'Joom'} 已连接` : 'Joom 未连接'}</span>
        </div>
      </aside>

      <div className="app-workspace">
        <header className="app-header">
          <div className="app-header-copy">
            <h1>{compactPersonal && <PlannerIcon name={inTasks ? "tasks" : "folder"} size={17}/>} {title}</h1>
            {!compactPersonal && <p>{subtitle}</p>}
          </div>
          <div className="app-header-actions">
            {!compactPersonal && (inPersonal
              ? <span className="pl-header-note">个人空间</span>
              : inOrders
                ? <span className="orders-header-note">订单数据只保存在本机</span>
                : !inMercadoLibre && <JoomChip status={joom} onChange={refresh} />)}
          </div>
        </header>
        <main className="container">
          <Outlet context={{ joom, refreshJoom: refresh }} />
        </main>
      </div>
    </div>
  );
}

function FeedbackToast() {
  const [feedback, setFeedback] = useState<FeedbackDetail | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    const onFeedback = (event: Event) => {
      const detail = (event as CustomEvent<FeedbackDetail>).detail;
      if (!detail?.message) return;
      setFeedback(detail);
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => setFeedback(null), detail.tone === 'error' ? 5000 : 3200);
    };
    window.addEventListener(APP_FEEDBACK_EVENT, onFeedback);
    return () => {
      window.removeEventListener(APP_FEEDBACK_EVENT, onFeedback);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  if (!feedback) return null;
  return (
    <div className={`app-feedback ${feedback.tone}`} role={feedback.tone === 'error' ? 'alert' : 'status'} aria-live="polite">
      <span className="app-feedback-icon" aria-hidden="true">{feedback.tone === 'success' ? '✓' : feedback.tone === 'error' ? '!' : 'i'}</span>
      <span>{feedback.message}</span>
      <button type="button" aria-label="关闭提示" onClick={() => setFeedback(null)}>×</button>
    </div>
  );
}

function JoomChip({ status, onChange }: { status: JoomStatus | null; onChange: () => void }) {
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState('');
  const shops = status?.shops ?? [];

  async function switchShop(id: string) {
    if (!id || id === status?.shopId) return;
    setSwitching(true);
    setSwitchError('');
    try {
      await api.setActiveShop(id);
      onChange();
    } catch (error) {
      setSwitchError((error as Error).message);
    } finally {
      setSwitching(false);
    }
  }

  if (!status) return <span className="muted">后端未连接</span>;

  const shopSelect =
    shops.length > 0 ? (
      <>
        <select
          className="shop-switch"
          value={status.shopId ?? ''}
          disabled={switching}
          onChange={(e) => void switchShop(e.target.value)}
          title="切换当前店铺：发布、同步、授权都走这家"
        >
          {shops.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.connected ? ' · 已授权' : s.configured ? ' · 未授权' : ' · 缺凭证'}
            </option>
          ))}
        </select>
        {switchError && <span className="shop-switch-error" role="alert">{switchError}</span>}
      </>
    ) : null;

  if (!status.configured) {
    return (
      <div className="joom-chip">
        {shopSelect}
        <span className="muted">
          未配置凭证，<Link to="/settings">去设置填写</Link>
        </span>
      </div>
    );
  }
  if (status.connected) {
    return (
      <div className="joom-chip">
        {shopSelect}
        <span className="dot on" />
        已连接{status.shopName ? ` ${status.shopName}` : ' Joom'}（{status.env}）
        <button
          className="ghost"
          onClick={async () => {
            await api.joomDisconnect();
            onChange();
          }}
        >
          断开
        </button>
      </div>
    );
  }
  return (
    <div className="joom-chip">
      {shopSelect}
      <span className="dot off" />
      未连接{status.shopName ? ` ${status.shopName}` : ' Joom'}（{status.env}）
      <button onClick={() => (location.href = '/api/joom/auth')}>连接 Joom</button>
    </div>
  );
}

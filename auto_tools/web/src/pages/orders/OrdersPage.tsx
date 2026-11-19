import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { OrderExportProfile } from '@shared/orders';
import { api } from '../../api';
import { ExportResult, OrderExportTab } from './OrderExportTab';
import { startOrderExport, useOrderExportTask } from './export-task';
import { OrderHistoryTab } from './OrderHistoryTab';
import { OrderProfilesTab } from './OrderProfilesTab';
import { errorMessage } from './order-ui';
import './orders.css';

const TABS = [
  { id: 'export', label: '导出' },
  { id: 'history', label: '导出记录' },
  { id: 'settings', label: '高级设置' },
] as const;
type TabId = typeof TABS[number]['id'];

export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: TabId = TABS.some((item) => item.id === requested) ? (requested as TabId) : 'export';
  const [profiles, setProfiles] = useState<OrderExportProfile[] | null>(null);
  const [error, setError] = useState('');
  const task = useOrderExportTask();
  const record = 'record' in task ? task.record : undefined;
  const exporting = task.phase === 'generating' || task.phase === 'downloading';

  const loadProfiles = useCallback(async () => {
    try {
      setProfiles(await api.orderProfiles());
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles, record?.id]);

  function openTab(next: TabId) {
    setParams(next === 'export' ? {} : { tab: next });
  }

  return (
    <div className="orders-page">
      <div className="orders-tabs" role="tablist" aria-label="订单导出">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`orders-tab${tab === item.id ? ' on' : ''}`}
            onClick={() => openTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {task.phase === 'generating' && <div className="orders-card" role="status">正在生成 Excel 文件…</div>}
      {task.phase === 'error' && (
        <div className="error" role="alert">
          导出失败：{task.message}{' '}
          <button type="button" className="ghost orders-small" onClick={() => void startOrderExport(task.query)}>重试本次导出</button>
        </div>
      )}
      {'record' in task && <ExportResult record={task.record} downloading={task.phase === 'downloading'} downloadFailedIds={task.failedIds} />}

      {error && (
        <div className="error">
          {error}
          {' '}
          <button type="button" className="ghost orders-small" onClick={() => void loadProfiles()}>重试</button>
        </div>
      )}
      {!profiles && !error && <div className="orders-loading">正在加载…</div>}

      {profiles && (
        <OrderExportTab
          profiles={profiles}
          active={tab === 'export'}
          exporting={exporting}
          exportedId={record?.id}
          onManageProfiles={() => openTab('settings')}
        />
      )}
      {tab === 'history' && <OrderHistoryTab version={record?.id} />}
      {profiles && tab === 'settings' && <OrderProfilesTab profiles={profiles} onChange={setProfiles} />}
    </div>
  );
}

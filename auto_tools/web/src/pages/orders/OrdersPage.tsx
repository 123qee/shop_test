import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { OrderExportProfile } from '@shared/orders';
import { api } from '../../api';
import { OrderExportTab } from './OrderExportTab';
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
  const [historyVersion, setHistoryVersion] = useState(0);

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
  }, [loadProfiles]);

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

      {error && (
        <div className="error">
          {error}
          {' '}
          <button type="button" className="ghost orders-small" onClick={() => void loadProfiles()}>重试</button>
        </div>
      )}
      {!profiles && !error && <div className="orders-loading">正在加载…</div>}

      {profiles && tab === 'export' && (
        <OrderExportTab
          profiles={profiles}
          onExported={() => {
            setHistoryVersion((value) => value + 1);
            void loadProfiles();
          }}
          onManageProfiles={() => openTab('settings')}
        />
      )}
      {tab === 'history' && <OrderHistoryTab version={historyVersion} />}
      {profiles && tab === 'settings' && <OrderProfilesTab profiles={profiles} onChange={setProfiles} />}
    </div>
  );
}

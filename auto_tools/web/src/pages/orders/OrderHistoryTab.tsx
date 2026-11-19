import { useEffect, useState } from 'react';
import { formatChinaDateTime, type OrderExportRecord } from '@shared/orders';
import { api } from '../../api';
import { errorMessage, fileSize, rangeText, statusText } from './order-ui';

export function OrderHistoryTab({ version }: { version?: string }) {
  const [records, setRecords] = useState<OrderExportRecord[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.orderExports()
      .then((data) => {
        if (alive) {
          setRecords(data);
          setError('');
        }
      })
      .catch((err) => {
        if (alive) setError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [version]);

  if (error) return <div className="error">{error}</div>;
  if (!records) return <div className="orders-loading">正在加载…</div>;
  if (!records.length) return <section className="orders-card orders-empty">还没有导出过订单。</section>;

  return (
    <section className="orders-card">
      <p className="orders-hint orders-history-note">导出文件保留 30 天，过期后自动删除，记录保留。</p>
      <div className="orders-table-wrap">
        <table className="orders-table orders-history">
          <thead>
            <tr>
              <th>导出时间</th>
              <th>方案</th>
              <th>店铺与条件</th>
              <th>各材质</th>
              <th>文件</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id}>
                <td className="nowrap">{formatChinaDateTime(record.createdAt)}</td>
                <td>{record.profileName}</td>
                <td>
                  <div>{record.query.shops.map((shop) => shop.shopName).join('、')}</div>
                  <div className="orders-sub">
                    {statusText(record.query.statuses)} · {rangeText(record.query.from, record.query.to)}
                    {record.query.onlyNew ? ' · 只导新订单' : ' · 含导出过的'}
                  </div>
                </td>
                <td>
                  <div className="orders-summary-chips">
                    {record.summary.map((item) => (
                      <span key={item.key} className={`orders-summary-chip${item.exported ? '' : ' skipped'}`} title={item.exported ? undefined : '本次没有导出'}>
                        {item.label} {item.orderCount} 单
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  {record.filesExpired ? (
                    <span className="orders-hint">已超过保留期，文件已清理</span>
                  ) : (
                    <div className="orders-history-files">
                      {record.files.map((file) => (
                        <a key={file.id} href={api.orderExportFileUrl(record.id, file.id)} download title={`${file.orderCount} 单 · ${file.quantity} 件 · ${fileSize(file.size)}`}>
                          {file.name}
                        </a>
                      ))}

                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

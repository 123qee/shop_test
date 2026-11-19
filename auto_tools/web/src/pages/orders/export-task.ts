import { useSyncExternalStore } from 'react';
import type { OrderExportFileInfo, OrderExportRecord, OrderQueryInput } from '@shared/orders';
import { api } from '../../api';
import { showFeedback } from '../../feedback';
import { downloadFiles } from './download-files';
import { errorMessage } from './order-ui';

type ExportTask =
  | { phase: 'idle' | 'generating' }
  | { phase: 'error'; message: string; query: OrderQueryInput }
  | { phase: 'downloading' | 'ready'; record: OrderExportRecord; failedIds: string[] };

// 任务由当前浏览器窗口持有，切换标签或离开订单页面时仍能完成下载。
let task: ExportTask = { phase: 'idle' };
const listeners = new Set<() => void>();

function update(next: ExportTask) {
  task = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useOrderExportTask() {
  return useSyncExternalStore(subscribe, () => task);
}

async function download(record: OrderExportRecord, files: OrderExportFileInfo[], previousFailures: string[]) {
  update({ phase: 'downloading', record, failedIds: previousFailures });
  const failed = await downloadFiles(files.map((file) => ({
    id: file.id, name: file.name, url: api.orderExportFileUrl(record.id, file.id),
  })));
  const attempted = new Set(files.map((file) => file.id));
  const failedIds = [...previousFailures.filter((id) => !attempted.has(id)), ...failed];
  update({ phase: 'ready', record, failedIds });
  showFeedback(failedIds.length
    ? `已生成文件，${failedIds.length} 个下载失败，可在导出结果中重试`
    : `已开始下载 ${files.length} 个 Excel 文件`, failedIds.length ? 'error' : 'success');
}

export async function startOrderExport(query: OrderQueryInput) {
  if (task.phase === 'generating' || task.phase === 'downloading') return;
  update({ phase: 'generating' });
  let record: OrderExportRecord;
  try {
    record = await api.exportOrders(query);
  } catch (error) {
    const message = errorMessage(error);
    update({ phase: 'error', message, query });
    showFeedback(message, 'error');
    return;
  }
  await download(record, record.files, []);
}

export async function retryOrderExportFile(file: OrderExportFileInfo) {
  if (task.phase === 'ready' && task.failedIds.includes(file.id)) {
    await download(task.record, [file], task.failedIds);
  }
}

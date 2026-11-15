export const ERP_BATCH_STORAGE = 'erpFillBatch';

export interface ErpRowRef {
  key: string;
  index: number;
  title: string;
  shop: string;
}

export interface ErpRunReport {
  productId: string;
  title: string;
  skuCount: number;
  complete: boolean;
  issues: string[];
  log: string[];
}

export interface ErpBatchItem extends ErpRowRef {
  state: 'pending' | 'opening' | 'running' | 'saving' | 'saved' | 'failed';
  tabId?: number;
  url?: string;
  report?: ErpRunReport;
  error?: string;
  attempt: number;
}

export interface ErpBatchState {
  id: string;
  state: 'running' | 'pausing' | 'paused' | 'completed';
  sourceTabId: number;
  items: ErpBatchItem[];
  createdAt: number;
  updatedAt: number;
}

export type ErpBatchMessage =
  | { type: 'ERP_BATCH_START'; rows: ErpRowRef[] }
  | { type: 'ERP_BATCH_PAUSE' }
  | { type: 'ERP_BATCH_FOCUS'; tabId: number }
  | { type: 'ERP_DETAIL_CANCEL' }
  | { type: 'ERP_BATCH_RESUME'; retryFailed?: boolean }
  | { type: 'ERP_BATCH_OPEN_ROW'; row: ErpRowRef }
  | { type: 'ERP_DETAIL_READY' }
  | { type: 'ERP_DETAIL_PREPARE'; productId: string; expectedTitle: string }
  | { type: 'ERP_DETAIL_RUN'; token: string; productId: string; expectedTitle: string }
  | { type: 'ERP_DETAIL_SAVE'; productId: string; expectedTitle: string };

export function isErpEditorUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://erp2.cnfth.com' && /^#\/product\/aliexpress\/add\?/.test(url.hash) && /^\d+$/.test(new URLSearchParams(url.hash.split('?')[1]).get('id') || '');
  } catch { return false; }
}

export function isErpListUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://erp2.cnfth.com' && url.hash.split('?')[0] === '#/product/aliexpress/acquisition/box';
  } catch { return false; }
}

export function isErpJobActive(job: ErpBatchState | null): boolean {
  return !!job && (job.state === 'running' || job.state === 'pausing');
}

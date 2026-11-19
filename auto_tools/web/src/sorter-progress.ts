/** One cursor per shop and collection batch. The general queue has no batch ID. */
export interface SorterProgress {
  source: string;
  currentId: string | null;
  skipped: Record<string, true>;
  choices: Record<string, string>;
}

const sourceNames: Record<string, string> = {
  all: '全部来源', aliexpress: 'AliExpress', allegro: 'Allegro', amazon: 'Amazon.de', asos: 'ASOS',
  george: 'George (ASDA)', joom: 'Joom', mercadolibre: 'Mercado Libre', ozon: 'Ozon', wildberries: 'Wildberries',
};
export const sorterSourceName = (source: string) => sourceNames[source] ?? source;

function progressKey(shopId: string, batchId?: string) {
  return 'auto_tools.sorter.progress.' + JSON.stringify([shopId, batchId ?? null]);
}

function lastBatchKey(shopId: string) {
  return 'auto_tools.sorter.lastBatch.' + shopId;
}

export function lastSorterBatch(shopId: string): string | undefined {
  try { return localStorage.getItem(lastBatchKey(shopId)) || undefined; }
  catch { return undefined; }
}

export function leaveSorterBatch(shopId: string, batchId?: string) {
  try {
    if (lastSorterBatch(shopId) === batchId) localStorage.removeItem(lastBatchKey(shopId));
  } catch { /* Storage may be disabled. */ }
}

export function readSorterProgress(shopId: string, batchId?: string): SorterProgress | null {
  try {
    const raw = JSON.parse(localStorage.getItem(progressKey(shopId, batchId)) || 'null');
    if (!raw || typeof raw.source !== 'string') return null;
    return {
      source: raw.source, currentId: typeof raw.currentId === 'string' ? raw.currentId : null,
      choices: Object.fromEntries(Object.entries(raw.choices ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      skipped: Object.fromEntries(Object.entries(raw.skipped ?? {}).filter((entry): entry is [string, true] => entry[1] === true)),
    };
  } catch { return null; }
}

// Two tabs can work on different items in the same queue. Only apply changes made in this tab.
function mergeChanges<T>(stored: Record<string, T>, previous: Record<string, T>, next: Record<string, T>) {
  const merged = { ...stored };
  for (const id of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (previous[id] === next[id]) continue;
    if (Object.hasOwn(next, id)) merged[id] = next[id];
    else delete merged[id];
  }
  return merged;
}

export function saveSorterProgress(shopId: string, batchId: string | undefined, next: SorterProgress | null, previous?: SorterProgress | null) {
  try {
    const key = progressKey(shopId, batchId);
    if (!next) {
      localStorage.removeItem(key);
      leaveSorterBatch(shopId, batchId);
      return true;
    }
    const stored = previous && readSorterProgress(shopId, batchId);
    const value = previous && stored ? {
      ...next,
      choices: mergeChanges(stored.choices, previous.choices, next.choices),
      skipped: mergeChanges(stored.skipped, previous.skipped, next.skipped),
    } : next;
    localStorage.setItem(key, JSON.stringify(value));
    if (batchId) localStorage.setItem(lastBatchKey(shopId), batchId);
    else localStorage.removeItem(lastBatchKey(shopId));
    return true;
  } catch { return false; }
}

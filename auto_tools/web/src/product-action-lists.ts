export type ProductActionListKind = 'publish' | 'remove';

export type ProductActionLists = {
  publish: string[];
  remove: string[];
};

export type ProductActionListsChangedDetail = {
  scope: string;
  lists: ProductActionLists;
};

export const PRODUCT_ACTION_LISTS_CHANGED = 'auto-tools:product-action-lists-changed';

const STORAGE_KEY = 'auto_tools.productActionLists';
const EMPTY_LISTS: ProductActionLists = { publish: [], remove: [] };

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item)))];
}

function scopedStorageKey(scope: string) {
  return scope === 'default' ? STORAGE_KEY : `${STORAGE_KEY}.${scope}`;
}

export function readProductActionLists(scope = 'default'): ProductActionLists {
  try {
    const parsed = JSON.parse(localStorage.getItem(scopedStorageKey(scope)) || '{}') as Partial<ProductActionLists>;
    return {
      publish: uniqueStrings(parsed.publish),
      remove: uniqueStrings(parsed.remove),
    };
  } catch {
    return { ...EMPTY_LISTS };
  }
}

export function writeProductActionLists(next: ProductActionLists, scope = 'default'): ProductActionLists {
  const normalized = {
    publish: uniqueStrings(next.publish),
    remove: uniqueStrings(next.remove),
  };
  try {
    localStorage.setItem(scopedStorageKey(scope), JSON.stringify(normalized));
  } catch {
    // Storage can be unavailable in private or hardened browser contexts.
  }
  window.dispatchEvent(new CustomEvent<ProductActionListsChangedDetail>(PRODUCT_ACTION_LISTS_CHANGED, {
    detail: { scope, lists: normalized },
  }));
  return normalized;
}

export function addProductsToActionList(
  current: ProductActionLists,
  kind: ProductActionListKind,
  ids: string[],
  scope = 'default',
): ProductActionLists {
  const additions = new Set(ids);
  const other: ProductActionListKind = kind === 'publish' ? 'remove' : 'publish';
  return writeProductActionLists({
    ...current,
    [kind]: [...new Set([...current[kind], ...ids])],
    [other]: current[other].filter((id) => !additions.has(id)),
  }, scope);
}

export function removeProductsFromActionList(
  current: ProductActionLists,
  kind: ProductActionListKind,
  ids: string[],
  scope = 'default',
): ProductActionLists {
  const removals = new Set(ids);
  return writeProductActionLists({
    ...current,
    [kind]: current[kind].filter((id) => !removals.has(id)),
  }, scope);
}

export function pruneProductActionLists(current: ProductActionLists, existingIds: Iterable<string>, scope = 'default'): ProductActionLists {
  const existing = new Set(existingIds);
  const next = {
    publish: current.publish.filter((id) => existing.has(id)),
    remove: current.remove.filter((id) => existing.has(id)),
  };
  if (next.publish.length === current.publish.length && next.remove.length === current.remove.length) return current;
  return writeProductActionLists(next, scope);
}

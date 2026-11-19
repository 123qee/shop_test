import { useEffect, useRef, useState } from 'react';
import type { ProductIndexItem, ProductListCard } from '@shared/product-catalog';
import { api } from './api';

/** Only the currently requested page is displayed, even when an earlier request finishes last. */
export function useProductCards(page: ProductIndexItem[]) {
  // Polling jobs or re-reading local selection can recreate a page with the same index entries.
  const stablePage = useRef(page);
  if (page.length !== stablePage.current.length || page.some((item, index) => item !== stablePage.current[index])) {
    stablePage.current = page;
  }
  const rows = stablePage.current;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ rows: ProductIndexItem[]; cards: ProductListCard[]; error?: string }>();
  useEffect(() => {
    if (!rows.length) return;
    let cancelled = false;
    api.productCards(rows.map((item) => item.id)).then((cards) => {
      if (!cancelled) setResult({ rows, cards });
    }).catch((err) => {
      if (!cancelled) setResult({ rows, cards: [], error: (err as Error).message });
    });
    return () => { cancelled = true; };
  }, [rows, attempt]);
  const current = result?.rows === rows ? result : undefined;
  return {
    cards: current?.cards ?? [],
    loading: rows.length > 0 && !current,
    error: current?.error,
    retry: () => { setResult(undefined); setAttempt((value) => value + 1); },
  };
}

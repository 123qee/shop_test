import { useCallback, useEffect, useState } from 'react';
import type { MiaoshouWorkspace } from '@shared/miaoshou';
import { miaoshouApi } from './api';

export function useMiaoshouWorkspace() {
  const [workspace, setWorkspace] = useState<MiaoshouWorkspace | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { const data = await miaoshouApi.workspace(); setWorkspace(data); setError(''); return data; }
    catch (e) { setError((e as Error).message); throw e; }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh().catch(() => {}); }, [refresh]);
  const active = workspace?.drafts.some(d => ['queued', 'submitting'].includes(d.status));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { void refresh().catch(() => {}); }, 2500);
    return () => window.clearInterval(timer);
  }, [active, refresh]);
  return { workspace, refresh, error, setError, loading };
}

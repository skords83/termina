import { useCallback, useEffect, useRef, useState } from 'react';
import { useRefreshBus } from '../store/refreshBus';
interface SyncStatus { running: boolean; finished_at: string | null; last_success_at: string | null; error: string | null; }
export function useSyncStatus() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState('');
  const lastFinished = useRef<string | null>(null);
  const mounted = useRef(true);
  const read = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/sync/status', { credentials: 'include', signal });
    if (!response.ok) throw new Error('Sync-Status nicht erreichbar.');
    const data: SyncStatus = await response.json();
    if (!mounted.current || signal?.aborted) return;
    if (data.finished_at && data.finished_at !== lastFinished.current) useRefreshBus.getState().bump();
    lastFinished.current = data.finished_at;
    setStatus(data); setError('');
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const poll = () => read(controller.signal).catch(() => { if (!controller.signal.aborted) setError('Sync-Status nicht erreichbar.'); });
    void poll(); const timer = setInterval(poll, 5000);
    return () => { mounted.current = false; controller.abort(); clearInterval(timer); };
  }, [read]);
  async function sync() {
    if (requesting || status?.running) return;
    setRequesting(true); setError('');
    try {
      const response = await fetch('/api/sync', { method: 'POST', credentials: 'include' });
      if (!response.ok) throw new Error();
      await read();
    } catch { if (mounted.current) setError('Synchronisation konnte nicht gestartet werden.'); }
    finally { if (mounted.current) setRequesting(false); }
  }
  return { syncing: requesting || !!status?.running, sync, status, error };
}

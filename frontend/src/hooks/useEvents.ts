import { useState, useEffect } from 'react';
import { CalendarEvent } from '../types';
import { apiFetch, ApiError } from './api';

interface Result {
  events: CalendarEvent[];
  loading: boolean;
  error: string | null;
}

export function useEvents(
  enabled: boolean,
  from: string,
  to: string,
  nonce: number = 0
): Result {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setEvents([]);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    apiFetch<CalendarEvent[]>('/api/events', { from, to }, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setEvents(data); })
      .catch((err: ApiError) => {
        if (!controller.signal.aborted) {
          setEvents([]);
          setError(err.message);
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled, from, to, nonce]);

  return { events, loading, error };
}

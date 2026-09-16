import { useState, useEffect } from 'react';
import { Calendar } from '../types';
import { apiFetch, ApiError } from './api';

interface Result {
  calendars: Calendar[];
  loading: boolean;
  error: string | null;
}

export function useCalendars(enabled: boolean): Result {
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setCalendars([]);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    apiFetch<Calendar[]>('/api/calendars', undefined, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setCalendars(data); })
      .catch((err: ApiError) => {
        if (!controller.signal.aborted) {
          setCalendars([]);
          setError(err.message);
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled]);

  return { calendars, loading, error };
}

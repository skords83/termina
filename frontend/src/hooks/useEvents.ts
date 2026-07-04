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
    if (!enabled) return;
    setLoading(true);
    setError(null);

    apiFetch<CalendarEvent[]>('/api/events', { from, to })
      .then(setEvents)
      .catch((err: ApiError) => setError(err.message))
      .finally(() => setLoading(false));
  }, [enabled, from, to, nonce]);

  return { events, loading, error };
}

import { useState, useEffect } from 'react';
import { CalendarEvent } from '../types';
import { apiFetch, ApiError } from './api';

interface Result {
  events: CalendarEvent[];
  loading: boolean;
  error: string | null;
}

export function useEvents(
  token: string | null,
  from: string,
  to: string
): Result {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError(null);

    apiFetch<CalendarEvent[]>('/api/events', token, { from, to })
      .then(setEvents)
      .catch((err: ApiError) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token, from, to]);

  return { events, loading, error };
}

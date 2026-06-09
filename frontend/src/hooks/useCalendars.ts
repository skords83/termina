import { useState, useEffect } from 'react';
import { Calendar } from '../types';
import { apiFetch, ApiError } from './api';

interface Result {
  calendars: Calendar[];
  loading: boolean;
  error: string | null;
}

export function useCalendars(token: string | null): Result {
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError(null);

    apiFetch<Calendar[]>('/api/calendars', token)
      .then(setCalendars)
      .catch((err: ApiError) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  return { calendars, loading, error };
}

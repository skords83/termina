import { useState, FormEvent } from 'react';
import { apiFetch, ApiError } from '../hooks/api';
import { Calendar } from '../types';

interface Props {
  onSuccess: (token: string) => void;
}

export function LoginForm({ onSuccess }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;

    setLoading(true);
    setError(null);

    try {
      await apiFetch<Calendar[]>('/api/calendars', token);
      onSuccess(token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Token ungültig.');
      } else {
        setError('Verbindung fehlgeschlagen.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-logo">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="var(--accent)" />
            <path
              d="M8 16C8 11.582 11.582 8 16 8V8C20.418 8 24 11.582 24 16V22H8V16Z"
              fill="white"
              fillOpacity="0.9"
            />
            <rect x="11" y="14" width="2" height="5" rx="1" fill="var(--accent)" />
            <rect x="15" y="12" width="2" height="7" rx="1" fill="var(--accent)" />
            <rect x="19" y="15" width="2" height="4" rx="1" fill="var(--accent)" />
          </svg>
          <span>Termina</span>
        </div>
        <p className="login-sub">API-Token eingeben</p>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            className="login-input"
            placeholder="Bearer-Token"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            spellCheck={false}
          />
          {error && <p className="login-error">{error}</p>}
          <button className="login-btn" type="submit" disabled={loading}>
            {loading ? 'Prüfe…' : 'Anmelden'}
          </button>
        </form>
      </div>
    </div>
  );
}

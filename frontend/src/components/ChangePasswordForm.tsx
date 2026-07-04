import { useState, FormEvent } from 'react';
import { AuthUser } from '../store';

interface Props {
  user: AuthUser;
  onSuccess: (user: AuthUser) => void;
  onLogout: () => void;
}

export function ChangePasswordForm({ user, onSuccess, onLogout }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!newPassword) return;
    if (newPassword !== confirmPassword) {
      setError('Passwörter stimmen nicht überein.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_password: user.must_change_password ? undefined : currentPassword,
          new_password: newPassword,
        }),
      });

      if (!res.ok) {
        if (res.status === 401) {
          setError('Aktuelles Passwort falsch.');
        } else {
          setError('Verbindung fehlgeschlagen.');
        }
        return;
      }

      const updated: AuthUser = await res.json();
      onSuccess(updated);
    } catch {
      setError('Verbindung fehlgeschlagen.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-logo">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect x="4" y="6" width="24" height="22" rx="4" stroke="var(--accent)" strokeWidth="2" />
            <line x1="4" y1="12" x2="28" y2="12" stroke="var(--accent)" strokeWidth="2" />
            <rect x="9" y="3" width="2" height="5" rx="1" fill="var(--accent)" />
            <rect x="19" y="15" width="2" height="4" rx="1" fill="var(--accent)" />
            <rect x="21" y="3" width="2" height="5" rx="1" fill="var(--accent)" />
          </svg>
          <span>Termina</span>
        </div>
        <p className="login-sub">
          {user.must_change_password
            ? 'Bitte lege ein neues Passwort fest.'
            : 'Passwort ändern'}
        </p>
        <form onSubmit={handleSubmit}>
          {!user.must_change_password && (
            <input
              type="password"
              className="login-input"
              placeholder="Aktuelles Passwort"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoFocus
              spellCheck={false}
            />
          )}
          <input
            type="password"
            className="login-input"
            placeholder="Neues Passwort"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoFocus={user.must_change_password}
            spellCheck={false}
          />
          <input
            type="password"
            className="login-input"
            placeholder="Neues Passwort bestätigen"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            spellCheck={false}
          />
          {error && <p className="login-error">{error}</p>}
          <button className="login-btn" type="submit" disabled={loading}>
            {loading ? 'Speichere…' : 'Passwort ändern'}
          </button>
          <button className="login-cancel-btn" type="button" onClick={onLogout}>
            Abmelden
          </button>
        </form>
      </div>
    </div>
  );
}

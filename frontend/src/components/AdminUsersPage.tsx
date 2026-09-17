import { useEffect, useState, FormEvent } from 'react';
import { Calendar } from '../types';

interface AdminUser {
  id: number;
  email: string;
  display_name: string;
  role: string;
  must_change_password: boolean;
  last_login_at: string | null;
  calendar_ids: string[];
  writable_calendar_ids: string[];
}

interface Props {
  calendars: Calendar[];
  onClose: () => void;
}

const ROLES = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Mitglied' },
  { value: 'child', label: 'Kind' },
];

export default function AdminUsersPage({ calendars, onClose }: Props) {
  const [accessBusy, setAccessBusy] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const [newEmail, setNewEmail] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState('member');
  const [newCalendarIds, setNewCalendarIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  async function loadUsers() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/users', { credentials: 'include' });
      if (!res.ok) throw new Error();
      setUsers(await res.json());
    } catch {
      setError('Nutzer konnten nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  function toggleNewCalendar(id: string) {
    setNewCalendarIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!newEmail.trim() || !newDisplayName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newEmail.trim(),
          display_name: newDisplayName.trim(),
          role: newRole,
          calendar_ids: Array.from(newCalendarIds),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.detail ?? 'Nutzer konnte nicht angelegt werden.');
        return;
      }
      const body = await res.json();
      setTempPassword(body.temp_password);
      setNewEmail('');
      setNewDisplayName('');
      setNewRole('member');
      setNewCalendarIds(new Set());
      await loadUsers();
    } finally {
      setCreating(false);
    }
  }

  async function handleResetPassword(id: number) {
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${id}/reset-password`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error();
      const body = await res.json();
      setTempPassword(body.temp_password);
    } catch {
      setError('Passwort konnte nicht zurückgesetzt werden.');
    }
  }

  async function handleToggleCalendar(u: AdminUser, calendarId: string, access: string) {
    if (accessBusy) return;
    setAccessBusy(true);
    const nextIds = u.calendar_ids.filter(id => id !== calendarId);
    if (access !== "none") nextIds.push(calendarId);
    const writable = u.writable_calendar_ids.filter(id => id !== calendarId);
    if (access === "write") writable.push(calendarId);

    try {
      const res = await fetch(`/api/admin/users/${u.id}/calendar-access`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendar_ids: nextIds, writable_calendar_ids: writable }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      setUsers((prev) => prev.map((x) => (x.id === u.id ? updated : x)));
    } catch {
      setError('Kalender-Zuordnung konnte nicht gespeichert werden.');
    } finally { setAccessBusy(false); }
  }

  return (
    <div className="admin-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-header">
          <h2>Nutzerverwaltung</h2>
          <button className="admin-close-btn" onClick={onClose} title="Schließen">✕</button>
        </div>

        {error && <p className="login-error admin-error">{error}</p>}

        {tempPassword && (
          <div className="admin-temp-password">
            <p>Temporäres Passwort (nur jetzt sichtbar):</p>
            <code>{tempPassword}</code>
            <button className="login-cancel-btn" onClick={() => setTempPassword(null)}>
              Schließen
            </button>
          </div>
        )}

        <form className="admin-create-form" onSubmit={handleCreate}>
          <h3>Neuen Nutzer anlegen</h3>
          <div className="admin-form-row">
            <input
              type="email"
              className="login-input"
              placeholder="E-Mail"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
            <input
              type="text"
              className="login-input"
              placeholder="Anzeigename"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
            />
            <select
              className="login-input"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          <p>Neue Kalenderfreigaben erlauben zunächst nur Lesen. Bearbeitungsrechte kannst du anschließend unten vergeben.</p>
          <div className="admin-calendar-checks">
            {calendars.map((c) => (
              <label key={c.id} className="admin-calendar-check">
                <input
                  type="checkbox"
                  checked={newCalendarIds.has(c.id)}
                  onChange={() => toggleNewCalendar(c.id)}
                />
                {c.name}
              </label>
            ))}
          </div>
          <button className="login-btn admin-submit-btn" type="submit" disabled={creating}>
            {creating ? 'Lege an…' : 'Anlegen'}
          </button>
        </form>

        <div className="admin-user-list">
          {loading && <p>Lade…</p>}
          {!loading && users.map((u) => (
            <div key={u.id} className="admin-user-row">
              <div className="admin-user-info">
                <strong>{u.display_name}</strong>
                <span className="admin-user-email">{u.email}</span>
                <span className="admin-user-role">{ROLES.find((r) => r.value === u.role)?.label ?? u.role}</span>
                {u.must_change_password && (
                  <span className="admin-user-flag">Passwortänderung ausstehend</span>
                )}
              </div>
              {u.role !== 'admin' && (
                <div className="admin-calendar-checks">
                  {calendars.map((c) => (
                    <label key={c.id} className="admin-calendar-check">
                      <select aria-label={`Zugriff auf ${c.name} für ${u.display_name}`} disabled={accessBusy} value={!u.calendar_ids.includes(c.id) ? "none" : !c.read_only && u.writable_calendar_ids.includes(c.id) ? "write" : "read"} onChange={e => handleToggleCalendar(u, c.id, e.target.value)}>
                        <option value="none">Kein Zugriff</option><option value="read">Nur lesen</option>{!c.read_only && <option value="write">Bearbeiten</option>}
                      </select>
                      {c.name}
                    </label>
                  ))}
                </div>
              )}
              <button className="admin-reset-btn" onClick={() => handleResetPassword(u.id)}>
                Passwort zurücksetzen
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

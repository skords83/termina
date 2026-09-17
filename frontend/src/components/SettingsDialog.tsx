import { useEffect, useRef, useState } from 'react';
import { AuthUser, useStore } from '../store';
import { Calendar } from '../types';
import './settings.css';
import { ChangePasswordForm } from './ChangePasswordForm';

export function SettingsDialog({ user, calendars, onClose, onSaved }: {
  user: AuthUser; calendars: Calendar[]; onClose: () => void;
  onSaved: (view: 'month' | 'week' | 'day' | 'agenda') => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [calendar, setCalendar] = useState(calendars.find(c => c.id === user.default_calendar_id && c.can_write !== false)?.id ?? '');
  const [duration, setDuration] = useState(user.default_duration_minutes ?? 60);
  const [view, setView] = useState(user.default_view ?? 'month');
  const [reminder, setReminder] = useState(user.default_reminder_minutes == null ? '' : String(user.default_reminder_minutes));
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="settings-dialog" onCancel={onClose} aria-labelledby="settings-title">
    {password ? <><h2 id="settings-title">Passwort ändern</h2><ChangePasswordForm embedded user={user} onLogout={() => setPassword(false)} onSuccess={updated => { useStore.getState().setUser(updated); onClose(); }} /></> : <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try {
        const response = await fetch('/api/preferences', { method: 'PUT', credentials: 'include', headers: {'Content-Type':'application/json'}, body: JSON.stringify({default_calendar_id: calendar || null, default_duration_minutes: duration, default_view: view, default_reminder_minutes: reminder === '' ? null : Number(reminder)}) });
        if (!response.ok) throw new Error('Einstellungen konnten nicht gespeichert werden. Bitte Kalenderberechtigung prüfen und erneut versuchen.');
        const prefs = await response.json();
        useStore.getState().setUser({...user, ...prefs}); onSaved(view); onClose();
      } catch (err) { setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.'); }
      finally { setBusy(false); }
    }}>
      <h2 id="settings-title">Meine Einstellungen</h2>
      <label>Standardkalender<select value={calendar} onChange={e => setCalendar(e.target.value)}><option value="">Erster beschreibbarer Kalender</option>{calendars.filter(c => c.can_write !== false).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Termindauer in Minuten<input type="number" min={5} max={1440} required value={duration} onChange={e => setDuration(e.target.valueAsNumber)} /></label>
      <label>Startansicht<select value={view} onChange={e => setView(e.target.value as typeof view)}><option value="month">Monat</option><option value="week">Woche</option><option value="day">Tag</option><option value="agenda">Agenda</option></select></label>
      <label>Standarderinnerung<select value={reminder} onChange={e => setReminder(e.target.value)}><option value="">Keine</option>{[...new Set([0,5,15,30,60,1440,...(reminder === '' ? [] : [Number(reminder)])])].sort((a,b)=>a-b).map(n => <option key={n} value={n}>{n === 0 ? 'Zum Beginn' : `${n} Minuten vorher`}</option>)}</select></label>
      <p>Erinnerungen werden über deine verbundene Kalender-App ausgelöst.</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={() => setPassword(true)}>Passwort ändern</button>
      <footer><button type="button" onClick={onClose}>Abbrechen</button><button type="submit" disabled={busy}>{busy ? 'Speichern …' : 'Speichern'}</button></footer>
    </form>}
  </dialog>;
}

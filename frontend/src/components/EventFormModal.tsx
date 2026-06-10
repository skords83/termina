// frontend/src/components/EventFormModal.tsx
//
// Modal für Erstellen und Bearbeiten von Terminen.
//
// Props:
//   mode="create"  → Leeres Formular, `defaultDate` als Startwert
//   mode="edit"    → Formular mit `event` vorgefüllt, sendet PUT + ETag
//
// Verwendung (Erstellen):
//   <EventFormModal
//     mode="create"
//     calendars={calendars}
//     defaultDate="2026-06-15"
//     defaultCalendarId={...}
//     onClose={() => setCreateModal(null)}
//     onSaved={(uid) => { /* optimistic oder refresh */ }}
//   />
//
// Verwendung (Bearbeiten):
//   <EventFormModal
//     mode="edit"
//     calendars={calendars}
//     event={event}
//     onClose={() => setEditModal(null)}
//     onSaved={(uid) => { /* optimistic update */ }}
//   />

import { useCallback, useEffect, useRef, useState } from 'react';
import { createEvent, updateEvent } from '../api/write';
import { useToast } from './Toast';
import type { CalendarEvent, CreateEventPayload, WriteError } from '../types';

interface Calendar {
  id: string;
  name: string;
  color: string;
}

interface BaseProps {
  calendars: Calendar[];
  onClose: () => void;
  onSaved: (uid: string, event: CalendarEvent) => void;
}

interface CreateProps extends BaseProps {
  mode: 'create';
  defaultDate?: string;       // "YYYY-MM-DD"
  defaultCalendarId?: string;
  event?: never;
}

interface EditProps extends BaseProps {
  mode: 'edit';
  event: CalendarEvent;
  defaultDate?: never;
  defaultCalendarId?: never;
}

type Props = CreateProps | EditProps;

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function toLocalDatetimeValue(isoStr: string): string {
  // "2026-06-15T10:00:00Z" → "2026-06-15T12:00" (MESZ)
  // Naive strings (ohne Z) direkt nehmen
  if (!isoStr.endsWith('Z') && !isoStr.includes('+')) {
    return isoStr.slice(0, 16);
  }
  const d = new Date(isoStr);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function toLocalDateValue(isoStr: string): string {
  // All-day: "2026-06-15" oder "2026-06-15T..." → nur Datum
  return isoStr.slice(0, 10);
}

function localDatetimeToISO(localStr: string): string {
  // "2026-06-15T10:00" → "2026-06-15T10:00:00" (naive, kein Z)
  // Backend erwartet naive strings für lokale Zeiten oder UTC mit Z
  // Wir senden als lokale Zeit ohne Z – Backend speichert as-is
  return `${localStr}:00`;
}

function makeDefaultStart(defaultDate?: string): string {
  if (defaultDate) return `${defaultDate}T09:00`;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours() + 1)}:00`
  );
}

function addHour(localDatetime: string): string {
  const [date, time] = localDatetime.split('T');
  const [h, m] = time.split(':').map(Number);
  const next = h + 1;
  if (next > 23) return `${date}T23:${String(m).padStart(2, '0')}`;
  return `${date}T${String(next).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function describeWriteError(err: WriteError): string {
  switch (err.type) {
    case 'conflict':
      return 'Der Termin wurde zwischenzeitlich extern geändert. Bitte Seite neu laden.';
    case 'not_found':
      return 'Termin oder Kalender nicht gefunden (404).';
    case 'nextcloud_down':
      return 'Nextcloud ist gerade nicht erreichbar. Bitte später erneut versuchen.';
    case 'auth':
      return 'Authentifizierung fehlgeschlagen. Bitte neu einloggen.';
    default:
      return `Unbekannter Fehler (${(err as { type: string; status?: number }).status ?? '?'}).`;
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    backdropFilter: 'blur(2px)',
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modal: {
    background: '#1e1e1e',
    border: '1px solid #2e2e2e',
    borderRadius: '0.75rem',
    width: '100%',
    maxWidth: '28rem',
    padding: '1.5rem',
    boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
    fontFamily: 'DM Sans, sans-serif',
    color: '#e8e6e3',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '1rem',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: '1rem',
    fontWeight: 600,
    letterSpacing: '-0.01em',
    color: '#f0eeeb',
    margin: 0,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#666',
    fontSize: '1.25rem',
    cursor: 'pointer',
    lineHeight: 1,
    padding: '0.125rem 0.25rem',
    borderRadius: '0.25rem',
  },
  field: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.375rem',
  },
  label: {
    fontSize: '0.75rem',
    fontWeight: 500,
    color: '#888',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  input: {
    background: '#151515',
    border: '1px solid #2e2e2e',
    borderRadius: '0.375rem',
    color: '#e8e6e3',
    padding: '0.5rem 0.625rem',
    fontSize: '0.875rem',
    fontFamily: 'DM Sans, sans-serif',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  textarea: {
    background: '#151515',
    border: '1px solid #2e2e2e',
    borderRadius: '0.375rem',
    color: '#e8e6e3',
    padding: '0.5rem 0.625rem',
    fontSize: '0.875rem',
    fontFamily: 'DM Sans, sans-serif',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
    resize: 'vertical' as const,
    minHeight: '4rem',
  },
  select: {
    background: '#151515',
    border: '1px solid #2e2e2e',
    borderRadius: '0.375rem',
    color: '#e8e6e3',
    padding: '0.5rem 0.625rem',
    fontSize: '0.875rem',
    fontFamily: 'DM Sans, sans-serif',
    outline: 'none',
    width: '100%',
    cursor: 'pointer',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '0.75rem',
  },
  toggle: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    cursor: 'pointer',
    userSelect: 'none' as const,
  },
  toggleCheckbox: {
    width: '1rem',
    height: '1rem',
    cursor: 'pointer',
    accentColor: '#5b8ef7',
  },
  toggleLabel: {
    fontSize: '0.875rem',
    color: '#aaa',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.5rem',
    paddingTop: '0.25rem',
  },
  btnCancel: {
    background: 'none',
    border: '1px solid #2e2e2e',
    borderRadius: '0.375rem',
    color: '#888',
    padding: '0.5rem 1rem',
    fontSize: '0.875rem',
    fontFamily: 'DM Sans, sans-serif',
    cursor: 'pointer',
  },
  btnSave: {
    background: '#5b8ef7',
    border: 'none',
    borderRadius: '0.375rem',
    color: '#fff',
    padding: '0.5rem 1.25rem',
    fontSize: '0.875rem',
    fontFamily: 'DM Sans, sans-serif',
    fontWeight: 500,
    cursor: 'pointer',
  },
  btnSaveDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  calendarDot: (color: string) => ({
    display: 'inline-block',
    width: '0.5rem',
    height: '0.5rem',
    borderRadius: '50%',
    background: color,
    marginRight: '0.4rem',
    flexShrink: 0,
  }),
};

// ── Komponente ────────────────────────────────────────────────────────────────

export function EventFormModal({ calendars, onClose, onSaved, ...props }: Props) {
  const { showToast } = useToast();

  const isEdit = props.mode === 'edit';
  const existingEvent = isEdit ? props.event : undefined;

  const defaultStartStr = isEdit
    ? existingEvent!.all_day
      ? toLocalDateValue(existingEvent!.start)
      : toLocalDatetimeValue(existingEvent!.start)
    : makeDefaultStart(props.mode === 'create' ? props.defaultDate : undefined);

  const defaultEndStr = isEdit
    ? existingEvent!.all_day
      ? toLocalDateValue(existingEvent!.end)
      : toLocalDatetimeValue(existingEvent!.end)
    : addHour(defaultStartStr);

  const defaultCalId =
    isEdit
      ? existingEvent!.calendar_id
      : props.mode === 'create' && props.defaultCalendarId
      ? props.defaultCalendarId
      : calendars[0]?.id ?? '';

  const [summary, setSummary] = useState(existingEvent?.summary ?? '');
  const [calendarId, setCalendarId] = useState(defaultCalId);
  const [allDay, setAllDay] = useState(existingEvent?.all_day ?? false);
  const [startStr, setStartStr] = useState(defaultStartStr);
  const [endStr, setEndStr] = useState(defaultEndStr);
  const [location, setLocation] = useState(existingEvent?.location ?? '');
  const [description, setDescription] = useState(existingEvent?.description ?? '');
  const [saving, setSaving] = useState(false);

  const summaryRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    summaryRef.current?.focus();
  }, []);

  // Esc schließt
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleAllDayToggle = () => {
    if (!allDay) {
      // Wechsel zu All-day: Datum extrahieren
      setStartStr(startStr.slice(0, 10));
      setEndStr(endStr.slice(0, 10));
    } else {
      // Wechsel zu timed: Uhrzeit anhängen
      setStartStr(`${startStr}T09:00`);
      setEndStr(`${startStr}T10:00`);
    }
    setAllDay((v) => !v);
  };

  const handleStartChange = (val: string) => {
    setStartStr(val);
    // End immer >= Start halten
    if (!allDay && val > endStr) {
      setEndStr(addHour(val));
    }
    if (allDay && val > endStr) {
      setEndStr(val);
    }
  };

  const buildPayload = (): CreateEventPayload => ({
    calendar_id: calendarId,
    summary: summary.trim(),
    start: allDay ? startStr : localDatetimeToISO(startStr),
    end: allDay ? endStr : localDatetimeToISO(endStr),
    all_day: allDay,
    location: location.trim() || null,
    description: description.trim() || null,
  });

  const handleSubmit = useCallback(async () => {
    if (!summary.trim() || !calendarId) return;
    setSaving(true);
    try {
      const payload = buildPayload();

      let uid: string;
      let savedEvent: CalendarEvent;

      if (isEdit) {
        const result = await updateEvent(existingEvent!.uid, {
          ...payload,
          etag: existingEvent!.etag!,
        });
        uid = result.uid;
        savedEvent = {
          ...existingEvent!,
          ...payload,
          uid,
          all_day: payload.all_day ?? false,
          location: payload.location ?? undefined,
        };
      } else {
        const result = await createEvent(payload);
        uid = result.uid;
        savedEvent = {
          uid,
          calendar_id: payload.calendar_id,
          summary: payload.summary,
          start: payload.start,
          end: payload.end,
          all_day: payload.all_day ?? false,
          location: payload.location ?? undefined,
          description: payload.description,
          etag: null,
        };
      }

      showToast(
        isEdit ? 'Termin gespeichert' : 'Termin erstellt',
        'success'
      );
      onSaved(uid, savedEvent);
      onClose();
    } catch (err) {
      const writeErr = err as WriteError;
      showToast(describeWriteError(writeErr), 'error');
      if (writeErr.type === 'conflict') {
        onClose(); // EventPopup schließen; User muss neu laden
      }
    } finally {
      setSaving(false);
    }
  }, [summary, calendarId, allDay, startStr, endStr, location, description, isEdit, existingEvent, showToast, onSaved, onClose]);

  const canSave = summary.trim().length > 0 && calendarId;

  return (
    <div style={S.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={S.modal}>
        {/* Header */}
        <div style={S.header}>
          <h2 style={S.title}>
            {isEdit ? 'Termin bearbeiten' : 'Neuer Termin'}
          </h2>
          <button style={S.closeBtn} onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>

        {/* Titel */}
        <div style={S.field}>
          <label style={S.label}>Titel *</label>
          <input
            ref={summaryRef}
            style={S.input}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && canSave && !saving && handleSubmit()}
            placeholder="Terminbezeichnung"
          />
        </div>

        {/* Kalender */}
        <div style={S.field}>
          <label style={S.label}>Kalender</label>
          <select
            style={S.select}
            value={calendarId}
            onChange={(e) => setCalendarId(e.target.value)}
          >
            {calendars.map((cal) => (
              <option key={cal.id} value={cal.id}>
                {cal.name}
              </option>
            ))}
          </select>
        </div>

        {/* Ganztag-Toggle */}
        <label style={S.toggle}>
          <input
            type="checkbox"
            style={S.toggleCheckbox}
            checked={allDay}
            onChange={handleAllDayToggle}
          />
          <span style={S.toggleLabel}>Ganztägig</span>
        </label>

        {/* Start / Ende */}
        <div style={S.row}>
          <div style={S.field}>
            <label style={S.label}>Von</label>
            {allDay ? (
              <input
                type="date"
                style={S.input}
                value={startStr}
                onChange={(e) => handleStartChange(e.target.value)}
              />
            ) : (
              <input
                type="datetime-local"
                style={S.input}
                value={startStr}
                onChange={(e) => handleStartChange(e.target.value)}
              />
            )}
          </div>
          <div style={S.field}>
            <label style={S.label}>Bis</label>
            {allDay ? (
              <input
                type="date"
                style={S.input}
                value={endStr}
                min={startStr}
                onChange={(e) => setEndStr(e.target.value)}
              />
            ) : (
              <input
                type="datetime-local"
                style={S.input}
                value={endStr}
                min={startStr}
                onChange={(e) => setEndStr(e.target.value)}
              />
            )}
          </div>
        </div>

        {/* Ort (optional) */}
        <div style={S.field}>
          <label style={S.label}>Ort</label>
          <input
            style={S.input}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Optional"
          />
        </div>

        {/* Beschreibung (optional) */}
        <div style={S.field}>
          <label style={S.label}>Beschreibung</label>
          <textarea
            style={S.textarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </div>

        {/* Footer */}
        <div style={S.footer}>
          <button style={S.btnCancel} onClick={onClose}>
            Abbrechen
          </button>
          <button
            style={{
              ...S.btnSave,
              ...((!canSave || saving) ? S.btnSaveDisabled : {}),
            }}
            onClick={handleSubmit}
            disabled={!canSave || saving}
          >
            {saving ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
      </div>
    </div>
  );
}
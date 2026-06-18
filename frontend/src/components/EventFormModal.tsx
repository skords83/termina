// frontend/src/components/EventFormModal.tsx
//
// Modal für Erstellen und Bearbeiten von Terminen.
// Unterstützt jetzt auch Serientermine (RRULE).
//
// Props:
//   mode="create"  → Leeres Formular, `defaultDate` als Startwert
//   mode="edit"    → Formular mit `event` vorgefüllt, sendet PUT + ETag
//
// Bei Serien-Edit (event.is_recurring === true) erscheint zuerst
// ein Auswahl-Dialog: "Nur diese Instanz" oder "Alle zukünftigen" oder "Alle".

import { useCallback, useEffect, useRef, useState } from "react";
import { createEvent, updateEvent } from "../api/write";
import { useToast } from "./Toast";
import type { CalendarEvent, CreateEventPayload, WriteError } from "../types";

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
  mode: "create";
  defaultDate?: string; // "YYYY-MM-DD"
  defaultCalendarId?: string;
  event?: never;
}

interface EditProps extends BaseProps {
  mode: "edit";
  event: CalendarEvent;
  defaultDate?: never;
  defaultCalendarId?: never;
}

type Props = CreateProps | EditProps;

// ── RRULE-Helpers ─────────────────────────────────────────────────────────────

type RecurFreq = "none" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

const FREQ_LABELS: Record<RecurFreq, string> = {
  none: "Nicht wiederholen",
  DAILY: "Täglich",
  WEEKLY: "Wöchentlich",
  MONTHLY: "Monatlich",
  YEARLY: "Jährlich",
};

/** Extrahiert FREQ und UNTIL aus einem RRULE-String. */
function parseRrule(rrule: string | null | undefined): {
  freq: RecurFreq;
  until: string;
} {
  if (!rrule) return { freq: "none", until: "" };
  const freqMatch = rrule.match(/FREQ=([A-Z]+)/);
  const untilMatch = rrule.match(/UNTIL=(\d{8}(?:T\d{6}Z?)?)/);
  const freq = (freqMatch?.[1] ?? "none") as RecurFreq;
  let until = "";
  if (untilMatch) {
    // "20261231" → "2026-12-31"
    const raw = untilMatch[1].slice(0, 8);
    until = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return { freq, until };
}

/** Baut einen RRULE-String aus freq + optionalem Enddatum. */
function buildRrule(freq: RecurFreq, until: string): string | null {
  if (freq === "none") return null;
  let s = `FREQ=${freq}`;
  if (until) {
    const compact = until.replace(/-/g, "");
    s += `;UNTIL=${compact}T235959Z`;
  }
  return s;
}

// ── Datum/Zeit-Helpers ────────────────────────────────────────────────────────

function toLocalDatetimeValue(isoStr: string): string {
  if (!isoStr.endsWith("Z") && !isoStr.includes("+")) {
    return isoStr.slice(0, 16);
  }
  const d = new Date(isoStr);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function toLocalDateValue(isoStr: string, exclusiveEnd = false): string {
  if (exclusiveEnd) {
    const [y, m, d] = isoStr.slice(0, 10).split("-").map(Number);
    const dt = new Date(y, m - 1, d - 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }
  return isoStr.slice(0, 10);
}

function localDatetimeToISO(localStr: string): string {
  return `${localStr}:00`;
}

function makeDefaultStart(defaultDate?: string): string {
  if (defaultDate) return `${defaultDate}T09:00`;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours() + 1)}:00`
  );
}

function addHour(localDatetime: string): string {
  const [date, time] = localDatetime.split("T");
  const [h, m] = time.split(":").map(Number);
  const next = h + 1;
  if (next > 23) return `${date}T23:${String(m).padStart(2, "0")}`;
  return `${date}T${String(next).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function describeWriteError(err: WriteError): string {
  switch (err.type) {
    case "conflict":
      return "Der Termin wurde zwischenzeitlich extern geändert. Bitte Seite neu laden.";
    case "not_found":
      return "Termin oder Kalender nicht gefunden (404).";
    case "nextcloud_down":
      return "Nextcloud ist gerade nicht erreichbar. Bitte später erneut versuchen.";
    case "auth":
      return "Authentifizierung fehlgeschlagen. Bitte neu einloggen.";
    default:
      return `Unbekannter Fehler (${(err as { type: string; status?: number }).status ?? "?"}).`;
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  overlay: {
    position: "fixed" as const,
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    backdropFilter: "blur(2px)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  modal: {
    background: "#1e1e1e",
    border: "1px solid #2e2e2e",
    borderRadius: "0.75rem",
    width: "100%",
    maxWidth: "28rem",
    padding: "1.5rem",
    boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
    fontFamily: "DM Sans, sans-serif",
    color: "#e8e6e3",
    display: "flex",
    flexDirection: "column" as const,
    gap: "1rem",
    maxHeight: "90vh",
    overflowY: "auto" as const,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: {
    fontSize: "1rem",
    fontWeight: 600,
    letterSpacing: "-0.01em",
    color: "#f0eeeb",
    margin: 0,
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#666",
    fontSize: "1.25rem",
    cursor: "pointer",
    lineHeight: 1,
    padding: "0.125rem 0.25rem",
    borderRadius: "0.25rem",
  },
  field: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.375rem",
  },
  label: {
    fontSize: "0.75rem",
    fontWeight: 500,
    color: "#888",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
  },
  input: {
    background: "#151515",
    border: "1px solid #2e2e2e",
    borderRadius: "0.375rem",
    color: "#e8e6e3",
    padding: "0.5rem 0.625rem",
    fontSize: "0.875rem",
    fontFamily: "DM Sans, sans-serif",
    outline: "none",
    width: "100%",
    boxSizing: "border-box" as const,
  },
  textarea: {
    background: "#151515",
    border: "1px solid #2e2e2e",
    borderRadius: "0.375rem",
    color: "#e8e6e3",
    padding: "0.5rem 0.625rem",
    fontSize: "0.875rem",
    fontFamily: "DM Sans, sans-serif",
    outline: "none",
    width: "100%",
    boxSizing: "border-box" as const,
    resize: "vertical" as const,
    minHeight: "4rem",
  },
  select: {
    background: "#151515",
    border: "1px solid #2e2e2e",
    borderRadius: "0.375rem",
    color: "#e8e6e3",
    padding: "0.5rem 0.625rem",
    fontSize: "0.875rem",
    fontFamily: "DM Sans, sans-serif",
    outline: "none",
    width: "100%",
    cursor: "pointer",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "0.75rem",
  },
  toggle: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    cursor: "pointer",
    userSelect: "none" as const,
  },
  toggleCheckbox: {
    width: "1rem",
    height: "1rem",
    cursor: "pointer",
    accentColor: "#5b8ef7",
  },
  toggleLabel: {
    fontSize: "0.875rem",
    color: "#aaa",
  },
  divider: {
    borderTop: "1px solid #2a2a2a",
    margin: "0.25rem 0",
  },
  recurBox: {
    background: "#181818",
    border: "1px solid #2a2a2a",
    borderRadius: "0.5rem",
    padding: "0.75rem",
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.625rem",
  },
  recurRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "0.75rem",
    alignItems: "end",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.5rem",
    paddingTop: "0.25rem",
  },
  btnCancel: {
    background: "none",
    border: "1px solid #2e2e2e",
    borderRadius: "0.375rem",
    color: "#888",
    padding: "0.5rem 1rem",
    fontSize: "0.875rem",
    fontFamily: "DM Sans, sans-serif",
    cursor: "pointer",
  },
  btnSave: {
    background: "#5b8ef7",
    border: "none",
    borderRadius: "0.375rem",
    color: "#fff",
    padding: "0.5rem 1.25rem",
    fontSize: "0.875rem",
    fontFamily: "DM Sans, sans-serif",
    fontWeight: 500,
    cursor: "pointer",
  },
  btnSaveDisabled: {
    opacity: 0.5,
    cursor: "not-allowed",
  },
  // Scope-Dialog (Nur diese / Alle)
  scopeOverlay: {
    position: "fixed" as const,
    inset: 0,
    background: "rgba(0,0,0,0.65)",
    backdropFilter: "blur(2px)",
    zIndex: 1100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  scopeBox: {
    background: "#1e1e1e",
    border: "1px solid #2e2e2e",
    borderRadius: "0.75rem",
    padding: "1.5rem",
    width: "100%",
    maxWidth: "22rem",
    boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
    fontFamily: "DM Sans, sans-serif",
    color: "#e8e6e3",
    display: "flex",
    flexDirection: "column" as const,
    gap: "1rem",
  },
  scopeTitle: {
    fontSize: "0.9375rem",
    fontWeight: 600,
    color: "#f0eeeb",
    margin: 0,
  },
  scopeSubtitle: {
    fontSize: "0.8125rem",
    color: "#777",
    margin: "-0.5rem 0 0",
  },
  scopeOptions: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.375rem",
  },
  scopeOption: (active: boolean) => ({
    background: active ? "rgba(91,142,247,0.12)" : "#151515",
    border: `1px solid ${active ? "#5b8ef7" : "#2e2e2e"}`,
    borderRadius: "0.375rem",
    color: active ? "#a8c4fb" : "#ccc",
    padding: "0.625rem 0.875rem",
    fontSize: "0.875rem",
    fontFamily: "DM Sans, sans-serif",
    cursor: "pointer",
    textAlign: "left" as const,
    transition: "all 0.1s",
  }),
  scopeFooter: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.5rem",
    borderTop: "1px solid #2a2a2a",
    paddingTop: "0.75rem",
  },
};

// ── Scope-Dialog (bei Serien-Edit) ────────────────────────────────────────────

type EditScope = "single" | "all";

interface ScopeDialogProps {
  onSelect: (scope: EditScope) => void;
  onCancel: () => void;
}

function ScopeDialog({ onSelect, onCancel }: ScopeDialogProps) {
  const [selected, setSelected] = useState<EditScope>("single");

  return (
    <div style={S.scopeOverlay}>
      <div style={S.scopeBox}>
        <div>
          <h2 style={S.scopeTitle}>Serientermin bearbeiten</h2>
          <p style={S.scopeSubtitle}>Welche Termine sollen geändert werden?</p>
        </div>
        <div style={S.scopeOptions}>
          <button
            style={S.scopeOption(selected === "single")}
            onClick={() => setSelected("single")}
          >
            Nur dieser Termin
          </button>
          <button
            style={S.scopeOption(selected === "all")}
            onClick={() => setSelected("all")}
          >
            Alle Termine der Serie
          </button>
        </div>
        <div style={S.scopeFooter}>
          <button style={S.btnCancel} onClick={onCancel}>
            Abbrechen
          </button>
          <button style={S.btnSave} onClick={() => onSelect(selected)}>
            Weiter
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Hauptkomponente ───────────────────────────────────────────────────────────

export function EventFormModal({
  calendars,
  onClose,
  onSaved,
  ...props
}: Props) {
  const { showToast } = useToast();

  const isEdit = props.mode === "edit";
  const existingEvent = isEdit ? props.event : undefined;

  // Bei Serientermin-Edit zuerst Scope-Dialog zeigen
  // null = noch nicht entschieden, 'single' oder 'all' = entschieden
  const [editScope, setEditScope] = useState<EditScope | null>(
    isEdit && existingEvent?.is_recurring ? null : "all",
  );

  const defaultStartStr = isEdit
    ? existingEvent!.all_day
      ? toLocalDateValue(existingEvent!.start)
      : toLocalDatetimeValue(existingEvent!.start)
    : makeDefaultStart(props.mode === "create" ? props.defaultDate : undefined);

  const defaultEndStr = isEdit
    ? existingEvent!.all_day
      ? toLocalDateValue(existingEvent!.end, true)
      : toLocalDatetimeValue(existingEvent!.end)
    : addHour(defaultStartStr);

  const defaultCalId = isEdit
    ? existingEvent!.calendar_id
    : props.mode === "create" && props.defaultCalendarId
      ? props.defaultCalendarId
      : (calendars[0]?.id ?? "");

  const [summary, setSummary] = useState(existingEvent?.summary ?? "");
  const [calendarId, setCalendarId] = useState(defaultCalId);
  const [allDay, setAllDay] = useState(existingEvent?.all_day ?? false);
  const [startStr, setStartStr] = useState(defaultStartStr);
  const [endStr, setEndStr] = useState(defaultEndStr);
  const [location, setLocation] = useState(existingEvent?.location ?? "");
  const [description, setDescription] = useState(
    existingEvent?.description ?? "",
  );
  const [saving, setSaving] = useState(false);

  // RRULE-State
  const initialRrule = parseRrule(existingEvent?.rrule);
  const [recurFreq, setRecurFreq] = useState<RecurFreq>(initialRrule.freq);
  const [recurUntil, setRecurUntil] = useState(initialRrule.until);

  const summaryRef = useRef<HTMLInputElement>(null);

  // Focus erst setzen wenn Scope-Dialog weg ist
  useEffect(() => {
    if (editScope !== null) {
      summaryRef.current?.focus();
    }
  }, [editScope]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleAllDayToggle = () => {
    if (!allDay) {
      setStartStr(startStr.slice(0, 10));
      setEndStr(endStr.slice(0, 10));
    } else {
      setStartStr(`${startStr}T09:00`);
      setEndStr(`${startStr}T10:00`);
    }
    setAllDay((v) => !v);
  };

  const handleStartChange = (val: string) => {
    setStartStr(val);
    if (!allDay && val > endStr) setEndStr(addHour(val));
    if (allDay && val > endStr) setEndStr(val);
  };

  const buildPayload = (): CreateEventPayload => ({
    calendar_id: calendarId,
    summary: summary.trim(),
    start: allDay ? startStr : localDatetimeToISO(startStr),
    end: allDay
      ? (() => {
          const [y, m, d] = endStr.split("-").map(Number);
          const dt = new Date(y, m - 1, d + 1);
          const pad = (n: number) => String(n).padStart(2, "0");
          return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
        })()
      : localDatetimeToISO(endStr),
    all_day: allDay,
    location: location.trim() || null,
    description: description.trim() || null,
    rrule: buildRrule(recurFreq, recurUntil),
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
          // Bei single-scope: recurrence_id mitschicken damit Backend nur diese Instanz ändert
          ...(editScope === "single" && existingEvent!.recurrence_id
            ? { recurrence_id: existingEvent!.recurrence_id }
            : {}),
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
          is_recurring: !!payload.rrule,
        };
      }

      showToast(isEdit ? "Termin gespeichert" : "Termin erstellt", "success");
      onSaved(uid, savedEvent);
      onClose();
    } catch (err) {
      const writeErr = err as WriteError;
      showToast(describeWriteError(writeErr), "error");
      if (writeErr.type === "conflict") {
        onClose();
      }
    } finally {
      setSaving(false);
    }
  }, [
    summary,
    calendarId,
    allDay,
    startStr,
    endStr,
    location,
    description,
    recurFreq,
    recurUntil,
    isEdit,
    existingEvent,
    editScope,
    showToast,
    onSaved,
    onClose,
  ]);

  const canSave = summary.trim().length > 0 && calendarId;

  // Scope-Dialog noch offen
  if (editScope === null) {
    return (
      <ScopeDialog
        onSelect={(scope) => setEditScope(scope)}
        onCancel={onClose}
      />
    );
  }

  return (
    <div
      style={S.overlay}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={S.modal}>
        {/* Header */}
        <div style={S.header}>
          <h2 style={S.title}>
            {isEdit ? "Termin bearbeiten" : "Neuer Termin"}
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
            onKeyDown={(e) =>
              e.key === "Enter" && canSave && !saving && handleSubmit()
            }
            placeholder="Terminbezeichnung"
          />
        </div>

        {/* Kalender (nur bei create; beim Edit nicht wechselbar) */}
        {!isEdit && (
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
        )}

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

        {/* ── Wiederholung ─────────────────────────────────────────────────── */}
        <div style={S.divider} />
        <div style={S.field}>
          <label style={S.label}>Wiederholung</label>
          <div style={S.recurBox}>
            <div style={S.recurRow}>
              <div style={S.field}>
                <label
                  style={{
                    ...S.label,
                    textTransform: "none",
                    letterSpacing: 0,
                    fontSize: "0.75rem",
                  }}
                >
                  Häufigkeit
                </label>
                <select
                  style={S.select}
                  value={recurFreq}
                  onChange={(e) => {
                    setRecurFreq(e.target.value as RecurFreq);
                    if (e.target.value === "none") setRecurUntil("");
                  }}
                  // Bei single-scope Edit: RRULE-Änderung ist nicht sinnvoll (nur diese Instanz)
                  disabled={editScope === "single"}
                >
                  {(Object.keys(FREQ_LABELS) as RecurFreq[]).map((f) => (
                    <option key={f} value={f}>
                      {FREQ_LABELS[f]}
                    </option>
                  ))}
                </select>
              </div>

              {recurFreq !== "none" && (
                <div style={S.field}>
                  <label
                    style={{
                      ...S.label,
                      textTransform: "none",
                      letterSpacing: 0,
                      fontSize: "0.75rem",
                    }}
                  >
                    Endet am (optional)
                  </label>
                  <input
                    type="date"
                    style={{
                      ...S.input,
                      opacity: editScope === "single" ? 0.4 : 1,
                    }}
                    value={recurUntil}
                    onChange={(e) => setRecurUntil(e.target.value)}
                    disabled={editScope === "single"}
                  />
                </div>
              )}
            </div>

            {editScope === "single" && (
              <p style={{ margin: 0, fontSize: "0.75rem", color: "#666" }}>
                Wiederholungseinstellungen gelten für alle Termine der Serie —
                hier nicht änderbar.
              </p>
            )}
          </div>
        </div>
        <div style={S.divider} />

        {/* Ort */}
        <div style={S.field}>
          <label style={S.label}>Ort</label>
          <input
            style={S.input}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Optional"
          />
        </div>

        {/* Beschreibung */}
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
              ...(!canSave || saving ? S.btnSaveDisabled : {}),
            }}
            onClick={handleSubmit}
            disabled={!canSave || saving}
          >
            {saving ? "Speichern…" : "Speichern"}
          </button>
        </div>
      </div>
    </div>
  );
}

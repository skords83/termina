// frontend/src/components/EventFormModal.tsx
//
// Modal für Erstellen und Bearbeiten von Terminen.
// Unterstützt Serientermine (RRULE).
// Verwendet custom DatePicker statt nativem <input type="date">.

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
  defaultDate?: string;
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

function parseRrule(rrule: string | null | undefined): {
  freq: RecurFreq;
  until: string;
  extraParts: string;
} {
  if (!rrule) return { freq: "none", until: "", extraParts: "" };
  const freqMatch = rrule.match(/FREQ=([A-Z]+)/);
  const untilMatch = rrule.match(/UNTIL=(\d{8}(?:T\d{6}Z?)?)/);
  const freq = (freqMatch?.[1] ?? "none") as RecurFreq;
  const rawUntil = untilMatch?.[1] ?? "";
  const until = rawUntil
    ? `${rawUntil.slice(0, 4)}-${rawUntil.slice(4, 6)}-${rawUntil.slice(6, 8)}`
    : "";
  const extraParts = rrule
    .split(";")
    .filter((p) => !p.startsWith("FREQ=") && !p.startsWith("UNTIL="))
    .join(";");
  return { freq, until, extraParts };
}

function buildRrule(freq: RecurFreq, until: string, extraParts: string): string | null {
  if (freq === "none") return null;
  let s = `FREQ=${freq}`;
  if (extraParts) s += `;${extraParts}`;
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
  const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${inOneHour.getFullYear()}-${pad(inOneHour.getMonth() + 1)}-${pad(inOneHour.getDate())}` +
    `T${pad(inOneHour.getHours())}:00`
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
    case "caldav_down":
      return "CalDAV-Server ist gerade nicht erreichbar. Bitte später erneut versuchen.";
    case "auth":
      return "Authentifizierung fehlgeschlagen. Bitte neu einloggen.";
    default:
      return `Unbekannter Fehler (${(err as { type: string; status?: number }).status ?? "?"}).`;
  }
}

// ── Custom DatePicker ─────────────────────────────────────────────────────────

const DE_MONTHS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];
const DE_DAYS_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

interface DatePickerProps {
  value: string; // "YYYY-MM-DD"
  min?: string; // "YYYY-MM-DD"
  onChange: (val: string) => void;
  disabled?: boolean;
}

function DatePicker({ value, min, onChange, disabled }: DatePickerProps) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const [y, m, d] = value
    ? value.split("-").map(Number)
    : [
        new Date().getFullYear(),
        new Date().getMonth() + 1,
        new Date().getDate(),
      ];

  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(y || new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(
    (m || new Date().getMonth() + 1) - 1,
  ); // 0-based
  const containerRef = useRef<HTMLDivElement>(null);

  // Schließen bei Klick außerhalb
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Sync view wenn value extern geändert wird
  useEffect(() => {
    if (value) {
      const [vy, vm] = value.split("-").map(Number);
      setViewYear(vy);
      setViewMonth(vm - 1);
    }
  }, [value]);

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  // Erster Tag des Monats (0=So,1=Mo,...), wir wollen Mo=0
  const firstDay = new Date(viewYear, viewMonth, 1);
  const firstDow = (firstDay.getDay() + 6) % 7; // Mo-basiert
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  // Vormonatstage zum Auffüllen
  const daysInPrev = new Date(viewYear, viewMonth, 0).getDate();
  const cells: { dateStr: string; inMonth: boolean }[] = [];
  for (let i = firstDow - 1; i >= 0; i--) {
    const prevD = daysInPrev - i;
    const pm = viewMonth === 0 ? 12 : viewMonth;
    const py = viewMonth === 0 ? viewYear - 1 : viewYear;
    cells.push({ dateStr: `${py}-${pad(pm)}-${pad(prevD)}`, inMonth: false });
  }
  for (let i = 1; i <= daysInMonth; i++) {
    cells.push({
      dateStr: `${viewYear}-${pad(viewMonth + 1)}-${pad(i)}`,
      inMonth: true,
    });
  }
  // Nachmonatstage
  const remaining = 42 - cells.length;
  for (let i = 1; i <= remaining; i++) {
    const nm = viewMonth === 11 ? 1 : viewMonth + 2;
    const ny = viewMonth === 11 ? viewYear + 1 : viewYear;
    cells.push({ dateStr: `${ny}-${pad(nm)}-${pad(i)}`, inMonth: false });
  }

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((v) => v - 1);
    } else setViewMonth((v) => v - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((v) => v + 1);
    } else setViewMonth((v) => v + 1);
  };

  const displayValue = value ? `${pad(d)}.${pad(m)}.${y}` : "–";

  return (
    <div ref={containerRef} className="date-picker">
      {/* Trigger */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className={`date-picker-trigger${open ? " date-picker-trigger--open" : ""}`}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          className="date-picker-trigger-icon"
        >
          <rect
            x="1"
            y="2"
            width="14"
            height="13"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M5 1v2M11 1v2M1 6h14"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <span style={{ flex: 1 }}>{displayValue}</span>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="date-picker-panel">
          {/* Header */}
          <div className="date-picker-header">
            <button
              type="button"
              className="date-picker-nav"
              onClick={prevMonth}
              aria-label="Vorheriger Monat"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M8 2L4 6l4 4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <span className="date-picker-month">
              {DE_MONTHS[viewMonth]} {viewYear}
            </span>
            <button
              type="button"
              className="date-picker-nav"
              onClick={nextMonth}
              aria-label="Nächster Monat"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M4 2l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>

          {/* Wochentag-Header */}
          <div className="date-picker-weekrow">
            {DE_DAYS_SHORT.map((dn) => (
              <div key={dn} className="date-picker-weekday">
                {dn}
              </div>
            ))}
          </div>

          {/* Tage */}
          <div className="date-picker-grid">
            {cells.map(({ dateStr, inMonth }) => {
              const isSelected = dateStr === value;
              const isToday = dateStr === todayStr;
              const isDisabled = !!min && dateStr < min;
              const classes = [
                "date-picker-day",
                isSelected && "date-picker-day--selected",
                !isSelected && isToday && "date-picker-day--today",
                !inMonth && "date-picker-day--muted",
                isDisabled && "date-picker-day--disabled",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={dateStr}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => {
                    if (!isDisabled) {
                      onChange(dateStr);
                      setOpen(false);
                    }
                  }}
                  className={classes}
                  aria-current={isToday ? "date" : undefined}
                  aria-label={dateStr}
                >
                  {parseInt(dateStr.split("-")[2], 10)}
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <div className="date-picker-footer">
            <button
              type="button"
              className="date-picker-footer-btn"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              Löschen
            </button>
            <button
              type="button"
              className="date-picker-footer-btn date-picker-footer-btn--accent"
              onClick={() => {
                onChange(todayStr);
                setOpen(false);
              }}
            >
              Heute
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Scope-Dialog ──────────────────────────────────────────────────────────────

type EditScope = "single" | "all";

interface ScopeDialogProps {
  onSelect: (scope: EditScope) => void;
  onCancel: () => void;
}

function ScopeDialog({ onSelect, onCancel }: ScopeDialogProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="rec-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="rec-dialog-header">
          <h3 className="rec-dialog-title">Serientermin bearbeiten</h3>
          <p className="rec-dialog-sub">
            Welche Termine sollen geändert werden?
          </p>
        </div>
        <div className="rec-dialog-options">
          <button className="rec-option" onClick={() => onSelect("single")}>
            <div className="rec-option-title">Nur dieser Termin</div>
            <div className="rec-option-desc">
              Nur diese eine Instanz wird geändert. Die Serie bleibt bestehen.
            </div>
          </button>
          <button className="rec-option" onClick={() => onSelect("all")}>
            <div className="rec-option-title">Alle Termine der Serie</div>
            <div className="rec-option-desc">
              Änderungen gelten für alle Termine der Serie.
            </div>
          </button>
        </div>
        <div className="rec-dialog-footer">
          <button className="rec-cancel" onClick={onCancel}>
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
}

// ── DateTimeField: DatePicker + optional Zeitfeld ─────────────────────────────

interface DateTimeFieldProps {
  value: string; // allDay: "YYYY-MM-DD", sonst "YYYY-MM-DDTHH:MM"
  allDay: boolean;
  min?: string; // "YYYY-MM-DD" oder "YYYY-MM-DDTHH:MM"
  onChange: (val: string) => void;
  disabled?: boolean;
}

function DateTimeField({
  value,
  allDay,
  min,
  onChange,
  disabled,
}: DateTimeFieldProps) {
  const datePart = value?.slice(0, 10) ?? "";
  const timePart = value?.slice(11, 16) ?? "09:00";
  const minDate = min?.slice(0, 10);

  const handleDateChange = (newDate: string) => {
    if (allDay) {
      onChange(newDate);
    } else {
      onChange(newDate ? `${newDate}T${timePart}` : "");
    }
  };

  const handleTimeChange = (newTime: string) => {
    onChange(`${datePart}T${newTime}`);
  };

  if (allDay) {
    return (
      <DatePicker
        value={datePart}
        min={minDate}
        onChange={handleDateChange}
        disabled={disabled}
      />
    );
  }

  return (
    <div style={{ display: "flex", gap: "6px" }}>
      <div style={{ flex: 1 }}>
        <DatePicker
          value={datePart}
          min={minDate}
          onChange={handleDateChange}
          disabled={disabled}
        />
      </div>
      <input
        type="time"
        value={timePart}
        disabled={disabled}
        onChange={(e) => handleTimeChange(e.target.value)}
        className="form-input form-time-input"
      />
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

  const initialRrule = parseRrule(existingEvent?.rrule);
  const [recurFreq, setRecurFreq] = useState<RecurFreq>(initialRrule.freq);
  const [recurUntil, setRecurUntil] = useState(initialRrule.until);
  const [recurExtraParts, setRecurExtraParts] = useState(initialRrule.extraParts);

  const summaryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editScope !== null) summaryRef.current?.focus();
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
    rrule: buildRrule(recurFreq, recurUntil, recurExtraParts),
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
      if (writeErr.type === "conflict") onClose();
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
      className="modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="form-modal">
        {/* Header */}
        <div className="form-modal-header">
          <h2 className="form-modal-title">
            {isEdit ? "Termin bearbeiten" : "Neuer Termin"}
          </h2>
          <button
            className="form-modal-close"
            onClick={onClose}
            aria-label="Schließen"
          >
            ×
          </button>
        </div>

        {/* Titel */}
        <div className="form-field">
          <label className="form-label" htmlFor="event-summary">
            Titel *
          </label>
          <input
            id="event-summary"
            ref={summaryRef}
            className="form-input"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && canSave && !saving && handleSubmit()
            }
            placeholder="Terminbezeichnung"
          />
        </div>

        {/* Kalender */}
        {!isEdit && (
          <div className="form-field">
            <label className="form-label" htmlFor="event-calendar">
              Kalender
            </label>
            <select
              id="event-calendar"
              className="form-select"
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

        {/* Datum/Zeit-Sektion */}
        <div className="form-section">
          <div className="form-section-head">
            <span className="form-label">Datum &amp; Zeit</span>
            <label className="form-toggle">
              <input
                type="checkbox"
                className="form-toggle-checkbox"
                checked={allDay}
                onChange={handleAllDayToggle}
              />
              <span className="form-toggle-label">Ganztägig</span>
            </label>
          </div>
          <div className="form-date-row">
            <span className="form-date-row-label">Von</span>
            <div style={{ flex: 1 }}>
              <DateTimeField
                value={startStr}
                allDay={allDay}
                onChange={handleStartChange}
              />
            </div>
          </div>
          <div className="form-date-row">
            <span className="form-date-row-label">Bis</span>
            <div style={{ flex: 1 }}>
              <DateTimeField
                value={endStr}
                allDay={allDay}
                min={startStr.slice(0, 10)}
                onChange={setEndStr}
              />
            </div>
          </div>
        </div>

        {/* Wiederholung */}
        <div className="form-section">
          <label className="form-label">Wiederholung</label>
          <div className="form-field">
            <label className="form-sublabel" htmlFor="event-recur-freq">
              Häufigkeit
            </label>
            <select
              id="event-recur-freq"
              className="form-select"
              value={recurFreq}
              onChange={(e) => {
                setRecurFreq(e.target.value as RecurFreq);
                if (e.target.value === "none") setRecurUntil("");
                setRecurExtraParts("");
              }}
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
            <div className="form-field">
              <label className="form-sublabel">Endet am (optional)</label>
              <DatePicker
                value={recurUntil}
                min={startStr.slice(0, 10)}
                onChange={setRecurUntil}
                disabled={editScope === "single"}
              />
            </div>
          )}

          {editScope === "single" && (
            <p className="form-recur-note">
              Wiederholungseinstellungen gelten für alle Termine der Serie —
              hier nicht änderbar.
            </p>
          )}
        </div>

        {/* Ort */}
        <div className="form-field">
          <label className="form-label" htmlFor="event-location">
            Ort
          </label>
          <input
            id="event-location"
            className="form-input"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Optional"
          />
        </div>

        {/* Beschreibung */}
        <div className="form-field">
          <label className="form-label" htmlFor="event-description">
            Beschreibung
          </label>
          <textarea
            id="event-description"
            className="form-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </div>

        {/* Footer */}
        <div className="form-modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn-primary"
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

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
    <div ref={containerRef} style={{ position: "relative" }}>
      {/* Trigger */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        style={{
          ...dpS.trigger,
          ...(disabled ? { opacity: 0.4, cursor: "default" } : {}),
          ...(open ? { borderColor: "#5b8ef7" } : {}),
        }}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          style={{ flexShrink: 0, color: "#666" }}
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
        <div style={dpS.panel}>
          {/* Header */}
          <div style={dpS.header}>
            <button type="button" style={dpS.navBtn} onClick={prevMonth}>
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
            <span style={dpS.monthLabel}>
              {DE_MONTHS[viewMonth]} {viewYear}
            </span>
            <button type="button" style={dpS.navBtn} onClick={nextMonth}>
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
          <div style={dpS.weekRow}>
            {DE_DAYS_SHORT.map((dn) => (
              <div key={dn} style={dpS.weekLabel}>
                {dn}
              </div>
            ))}
          </div>

          {/* Tage */}
          <div style={dpS.grid}>
            {cells.map(({ dateStr, inMonth }) => {
              const isSelected = dateStr === value;
              const isToday = dateStr === todayStr;
              const isDisabled = !!min && dateStr < min;
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
                  style={{
                    ...dpS.day,
                    ...(isSelected ? dpS.daySelected : {}),
                    ...(!isSelected && isToday ? dpS.dayToday : {}),
                    ...(!inMonth ? dpS.dayMuted : {}),
                    ...(isDisabled ? dpS.dayDisabled : {}),
                  }}
                >
                  {parseInt(dateStr.split("-")[2], 10)}
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <div style={dpS.footer}>
            <button
              type="button"
              style={dpS.footerBtn}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              Löschen
            </button>
            <button
              type="button"
              style={{ ...dpS.footerBtn, color: "#5b8ef7" }}
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

const dpS = {
  trigger: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    background: "#151515",
    border: "1px solid #2e2e2e",
    borderRadius: "0.375rem",
    color: "#e8e6e3",
    padding: "0.5rem 0.625rem",
    fontSize: "0.875rem",
    fontFamily: "DM Sans, sans-serif",
    cursor: "pointer",
    textAlign: "left" as const,
    transition: "border-color 0.12s",
    boxSizing: "border-box" as const,
  },
  panel: {
    position: "absolute" as const,
    top: "calc(100% + 4px)",
    left: 0,
    zIndex: 2000,
    background: "#1a1a1a",
    border: "1px solid #2e2e2e",
    borderRadius: "0.625rem",
    boxShadow: "0 12px 40px rgba(0,0,0,0.7)",
    width: "240px",
    overflow: "hidden",
    animation: "dp-in 0.1s ease",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 12px 8px",
    borderBottom: "1px solid #242424",
  },
  monthLabel: {
    fontSize: "0.8125rem",
    fontWeight: 600,
    color: "#e0dedd",
    letterSpacing: "-0.01em",
  },
  navBtn: {
    background: "none",
    border: "none",
    color: "#888",
    cursor: "pointer",
    padding: "4px 6px",
    borderRadius: "4px",
    display: "flex",
    alignItems: "center",
    transition: "color 0.1s",
  },
  weekRow: {
    display: "grid",
    gridTemplateColumns: "repeat(7, 1fr)",
    padding: "6px 8px 2px",
  },
  weekLabel: {
    fontSize: "0.6875rem",
    color: "#555",
    textAlign: "center" as const,
    fontWeight: 500,
    letterSpacing: "0.03em",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(7, 1fr)",
    padding: "2px 8px 8px",
    gap: "1px",
  },
  day: {
    background: "none",
    border: "none",
    borderRadius: "4px",
    color: "#ccc",
    fontSize: "0.8125rem",
    padding: "5px 0",
    cursor: "pointer",
    textAlign: "center" as const,
    fontFamily: "DM Sans, sans-serif",
    transition: "background 0.08s, color 0.08s",
    lineHeight: 1.2,
  },
  daySelected: {
    background: "#5b8ef7",
    color: "#fff",
    fontWeight: 600,
  },
  dayToday: {
    color: "#5b8ef7",
    fontWeight: 600,
  },
  dayMuted: {
    color: "#444",
  },
  dayDisabled: {
    color: "#333",
    cursor: "default",
  },
  footer: {
    display: "flex",
    justifyContent: "space-between",
    padding: "8px 12px",
    borderTop: "1px solid #242424",
  },
  footerBtn: {
    background: "none",
    border: "none",
    color: "#666",
    fontSize: "0.8125rem",
    cursor: "pointer",
    fontFamily: "DM Sans, sans-serif",
    padding: "2px 4px",
  },
};

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
    maxWidth: "24rem",
    padding: "1.25rem 1.25rem 1rem",
    boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
    fontFamily: "DM Sans, sans-serif",
    color: "#e8e6e3",
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.875rem",
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
  sublabel: {
    fontSize: "0.75rem",
    fontWeight: 500,
    color: "#777",
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
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.625rem",
  },
  dateSection: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.5rem",
    background: "#181818",
    border: "1px solid #2a2a2a",
    borderRadius: "0.5rem",
    padding: "0.625rem 0.75rem",
  },
  dateRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
  },
  dateLabel: {
    fontSize: "0.75rem",
    fontWeight: 500,
    color: "#888",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    width: "1.75rem",
    flexShrink: 0,
  },
  toggle: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    cursor: "pointer",
    userSelect: "none" as const,
  },
  toggleInline: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    cursor: "pointer",
    userSelect: "none" as const,
  },
  toggleCheckbox: {
    width: "0.875rem",
    height: "0.875rem",
    cursor: "pointer",
    accentColor: "#5b8ef7",
  },
  toggleLabel: {
    fontSize: "0.875rem",
    color: "#aaa",
  },
  toggleLabelSmall: {
    fontSize: "0.75rem",
    color: "#888",
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
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.625rem",
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

// ── Scope-Dialog ──────────────────────────────────────────────────────────────

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
        style={{
          ...S.input,
          width: "92px",
          flexShrink: 0,
          padding: "0.5rem 0.5rem",
          colorScheme: "dark",
        }}
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
    <>
      {/* Keyframe-Animation für DatePicker-Panel */}
      <style>{`
        @keyframes dp-in {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .dp-day-btn:hover:not(:disabled) {
          background: rgba(255,255,255,0.07) !important;
        }
        input[type="time"]::-webkit-calendar-picker-indicator {
          filter: invert(0.4);
          cursor: pointer;
        }
      `}</style>

      <div
        style={S.overlay}
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div style={S.modal}>
          {/* Accent bar */}
          <div
            style={{
              height: "2px",
              background: "linear-gradient(90deg, #5b8ef7, #7c5bf7)",
              borderRadius: "2px",
              margin: "-0.25rem 0 0",
            }}
          />
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

          {/* Kalender */}
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

          {/* Datum/Zeit-Sektion */}
          <div style={S.dateSection}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "0.125rem",
              }}
            >
              <span style={{ ...S.label, margin: 0 }}>Datum & Zeit</span>
              <label style={S.toggleInline}>
                <input
                  type="checkbox"
                  style={S.toggleCheckbox}
                  checked={allDay}
                  onChange={handleAllDayToggle}
                />
                <span style={S.toggleLabelSmall}>Ganztägig</span>
              </label>
            </div>
            <div style={S.dateRow}>
              <span style={S.dateLabel}>Von</span>
              <div style={{ flex: 1 }}>
                <DateTimeField
                  value={startStr}
                  allDay={allDay}
                  onChange={handleStartChange}
                />
              </div>
            </div>
            <div style={S.dateRow}>
              <span style={S.dateLabel}>Bis</span>
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
          <div style={S.field}>
            <label style={S.label}>Wiederholung</label>
            <div style={S.recurBox}>
              <div style={S.recurRow}>
                <div style={S.field}>
                  <label style={S.sublabel}>Häufigkeit</label>
                  <select
                    style={S.select}
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
                  <div style={S.field}>
                    <label style={S.sublabel}>Endet am (optional)</label>
                    <DatePicker
                      value={recurUntil}
                      min={startStr.slice(0, 10)}
                      onChange={setRecurUntil}
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
    </>
  );
}

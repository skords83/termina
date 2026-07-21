// frontend/src/components/EventPopup.tsx
//
// Popover-Karte direkt am Event.
// Neu in Phase 5: "Bearbeiten" und "Löschen" Buttons.
//
// Props:
//   event           – CalendarEvent (inkl. etag aus Phase 5)
//   calendarColor   – Hex-Farbe des Kalenders
//   calendarName    – Name des Kalenders
//   anchorRect      – DOMRect des geklickten EventItem (für Positionierung)
//   onClose         – Popup schließen
//   onEdit          – Bearbeiten-Modal öffnen
//   onDeleted       – Event wurde gelöscht → aus lokalem State entfernen
//   calendars       – für den Kalender-Namen (optional, alternativ calendarName)

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { deleteEvent } from "../api/write";
import { downloadIcsEventExport } from "../api/ics";
import { useToast } from "./Toast";
import type { CalendarEvent, WriteError } from "../types";

interface Props {
  event: CalendarEvent;
  calendarColor: string;
  calendarName: string;
  anchorPos: { x: number; y: number };
  onClose: () => void;
  onEdit: (event: CalendarEvent) => void;
  onDuplicate: (event: CalendarEvent) => void;
  onCopy: (event: CalendarEvent) => void;
  onDeleted: (uid: string, recurrenceId?: string | null, mode?: "single" | "future" | "all") => void;
}

// ── Formatierung ──────────────────────────────────────────────────────────────

function formatDateTime(start: string, end: string, allDay: boolean): string {
  if (allDay) {
    const s = start.slice(0, 10);
    // iCal DTEND ist exklusiv → -1 Tag für Anzeige
    const [ey, em, ed] = end.slice(0, 10).split("-").map(Number);
    const eDate = new Date(ey, em - 1, ed - 1);
    const ePad = (n: number) => String(n).padStart(2, "0");
    const e = `${eDate.getFullYear()}-${ePad(eDate.getMonth() + 1)}-${ePad(eDate.getDate())}`;
    if (s === e) {
      return formatDate(s);
    }
    return `${formatDate(s)} – ${formatDate(e)}`;
  }

  const sd = parseLocal(start);
  const ed = parseLocal(end);

  const dateStr = formatDate(start.slice(0, 10));
  const timeStr = `${pad(sd.getHours())}:${pad(sd.getMinutes())} – ${pad(ed.getHours())}:${pad(ed.getMinutes())}`;

  // Gleicher Tag?
  if (start.slice(0, 10) === end.slice(0, 10)) {
    return `${dateStr}, ${timeStr}`;
  }
  return `${dateStr} ${pad(sd.getHours())}:${pad(sd.getMinutes())} – ${formatDate(end.slice(0, 10))} ${pad(ed.getHours())}:${pad(ed.getMinutes())}`;
}

function parseLocal(isoStr: string): Date {
  if (!isoStr.endsWith("Z") && !isoStr.includes("+")) {
    // Naive string → als lokale Zeit parsen
    return new Date(isoStr.replace("T", "T"));
  }
  return new Date(isoStr);
}

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString("de-DE", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

const pad = (n: number) => String(n).padStart(2, "0");

// ── Positionierung ────────────────────────────────────────────────────────────

function computePosition(
  anchor: { x: number; y: number },
  popupWidth: number,
  popupHeight: number,
): { top: number; left: number } {
  const MARGIN = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = anchor.x + MARGIN;
  if (left + popupWidth > vw - MARGIN) {
    left = anchor.x - popupWidth - MARGIN;
  }
  if (left < MARGIN) left = MARGIN;

  let top = anchor.y;
  if (top + popupHeight > vh - MARGIN) {
    top = vh - popupHeight - MARGIN;
  }
  if (top < MARGIN) top = MARGIN;

  return { top, left };
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  popup: (top: number, left: number) => ({
    position: "fixed" as const,
    top,
    left,
    zIndex: 900,
    background: "#1e1e1e",
    border: "1px solid #2e2e2e",
    borderRadius: "0.625rem",
    width: "19.5rem",
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    fontFamily: "DM Sans, sans-serif",
    color: "#e8e6e3",
    overflow: "hidden",
    animation: "popupIn 0.15s ease",
  }),
  colorBar: (color: string) => ({
    height: "3px",
    background: color,
  }),
  body: {
    padding: "0.875rem 1rem",
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.5rem",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "0.5rem",
  },
  summary: {
    fontSize: "0.9375rem",
    fontWeight: 600,
    lineHeight: 1.3,
    color: "#f0eeeb",
    letterSpacing: "-0.01em",
    flex: 1,
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#555",
    fontSize: "1.125rem",
    cursor: "pointer",
    lineHeight: 1,
    padding: "0.0625rem",
    flexShrink: 0,
    borderRadius: "0.25rem",
  },
  metaRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.5rem",
    fontSize: "0.8125rem",
    color: "#999",
    lineHeight: 1.4,
  },
  metaIcon: {
    fontSize: "0.75rem",
    marginTop: "0.125rem",
    flexShrink: 0,
    color: "#666",
    width: "0.875rem",
    textAlign: "center" as const,
  },
  calDot: (color: string) => ({
    display: "inline-block",
    width: "0.5rem",
    height: "0.5rem",
    borderRadius: "50%",
    background: color,
    marginTop: "0.25rem",
    flexShrink: 0,
  }),
  descriptionText: {
    fontSize: "0.8125rem",
    color: "#aaa",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  },
  divider: {
    height: "1px",
    background: "#262626",
    margin: "0.25rem 0",
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.375rem",
    paddingTop: "0.125rem",
  },
  btnEdit: {
    background: "none",
    border: "1px solid #2e2e2e",
    borderRadius: "0.375rem",
    color: "#aaa",
    padding: "0.3125rem 0.625rem",
    fontSize: "0.8125rem",
    fontFamily: "DM Sans, sans-serif",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: "0.3rem",
  },
  btnDelete: {
    background: "none",
    border: "1px solid #3a1a1a",
    borderRadius: "0.375rem",
    color: "#c46a6a",
    padding: "0.3125rem 0.625rem",
    fontSize: "0.8125rem",
    fontFamily: "DM Sans, sans-serif",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: "0.3rem",
  },
  btnDeleteConfirm: {
    background: "#5a1f1f",
    border: "1px solid #8b3030",
    borderRadius: "0.375rem",
    color: "#e88",
    padding: "0.3125rem 0.625rem",
    fontSize: "0.8125rem",
    fontFamily: "DM Sans, sans-serif",
    cursor: "pointer",
    fontWeight: 500,
  },
  btnDeleteLoading: {
    opacity: 0.5,
    cursor: "not-allowed",
    background: "none",
    border: "1px solid #3a1a1a",
    borderRadius: "0.375rem",
    color: "#c46a6a",
    padding: "0.3125rem 0.625rem",
    fontSize: "0.8125rem",
    fontFamily: "DM Sans, sans-serif",
  },
};

// Animation einmalig injizieren
if (
  typeof document !== "undefined" &&
  !document.getElementById("popup-style")
) {
  const style = document.createElement("style");
  style.id = "popup-style";
  style.textContent = `
    @keyframes popupIn {
      from { opacity: 0; transform: scale(0.96); }
      to   { opacity: 1; transform: scale(1); }
    }
  `;
  document.head.appendChild(style);
}

// ── Komponente ────────────────────────────────────────────────────────────────

export function EventPopup({
  event,
  calendarColor,
  calendarName,
  anchorPos,
  onClose,
  onEdit,
  onDuplicate,
  onCopy,
  onDeleted,
}: Props) {
  const { showToast } = useToast();
  const popupRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [recurringDeleteDialog, setRecurringDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  // Position nach Mount berechnen (wenn DOM-Größe bekannt)
  useEffect(() => {
    const popup = popupRef.current;
    if (!popup) return;
    const { offsetWidth: w, offsetHeight: h } = popup;
    setPos(computePosition(anchorPos, w || 288, h || 200));
  }, [anchorPos]);

  // Klick außerhalb schließt
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Timeout damit der initial-Click das Popup nicht sofort schließt
    const id = setTimeout(
      () => document.addEventListener("mousedown", handler),
      50,
    );
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  // Esc schließt
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // ⌘C / Strg+C kopiert den Termin (Einfügen via ⌘V auf dem Kalender)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        onCopy(event);
        showToast("Termin kopiert", "success");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [event, onCopy, showToast]);

  const executeDelete = useCallback(async (recurrenceId?: string | null, mode?: "single" | "future" | "all") => {
    setDeleting(true);
    try {
      await deleteEvent(event.uid, { etag: event.etag ?? undefined, recurrence_id: recurrenceId, mode });
      showToast("Termin gelöscht", "success");
      onDeleted(event.uid, recurrenceId, mode);
      onClose();
    } catch (err) {
      const writeErr = err as WriteError;
      if (writeErr.type === "conflict") {
        showToast(
          "Termin wurde extern geändert – bitte Seite neu laden.",
          "warning",
        );
      } else if (writeErr.type === "caldav_down") {
        showToast(
          "CalDAV-Server nicht erreichbar – Termin konnte nicht gelöscht werden.",
          "error",
        );
      } else {
        showToast("Fehler beim Löschen.", "error");
      }
      setDeleting(false);
      setConfirmDelete(false);
      setRecurringDeleteDialog(false);
    }
  }, [event, onDeleted, onClose, showToast]);

  const handleExport = useCallback(async () => {
    try {
      await downloadIcsEventExport(event.uid);
    } catch {
      showToast("Export fehlgeschlagen.", "error");
    }
  }, [event.uid, showToast]);

  const handleDeleteClick = useCallback(() => {
    if (event.is_recurring) {
      setRecurringDeleteDialog(true);
    } else {
      setConfirmDelete(true);
    }
  }, [event.is_recurring]);

  const timeStr = formatDateTime(event.start, event.end, event.all_day);

  const popup = (
    <div ref={popupRef} style={S.popup(pos.top, pos.left)}>
      <div style={S.colorBar(calendarColor)} />
      <div style={S.body}>
        {/* Titel + Schließen */}
        <div style={S.header}>
          <span style={S.summary}>{event.summary}</span>
          <button style={S.closeBtn} onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>

        {/* Zeitangabe */}
        <div style={S.metaRow}>
          <span style={S.metaIcon}>◷</span>
          <span>{timeStr}</span>
        </div>

        {/* Kalender */}
        <div style={S.metaRow}>
          <span style={S.calDot(calendarColor)} />
          <span>{calendarName}</span>
        </div>

        {/* Ort */}
        {event.location && (
          <div style={S.metaRow}>
            <span style={S.metaIcon}>⌖</span>
            <span>{event.location}</span>
          </div>
        )}

        {/* Beschreibung */}
        {event.description && (
          <>
            <div style={S.divider} />
            <p style={S.descriptionText}>{event.description}</p>
          </>
        )}

        {/* Aktions-Buttons */}
        <div style={S.divider} />
        <div style={S.actions}>
          {confirmDelete ? (
            <>
              <button
                style={S.btnEdit}
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
              >
                Abbrechen
              </button>
              <button
                style={deleting ? S.btnDeleteLoading : S.btnDeleteConfirm}
                onClick={() => executeDelete()}
                disabled={deleting}
              >
                {deleting ? "Löschen…" : "Wirklich löschen"}
              </button>
            </>
          ) : (
            <>
              <button
                style={S.btnEdit}
                onClick={handleExport}
                title="Als .ics exportieren"
                aria-label="Als .ics exportieren"
              >
                ⭳
              </button>
              <button
                style={S.btnEdit}
                onClick={() => {
                  onClose();
                  onEdit(event);
                }}
              >
                ✎ Bearbeiten
              </button>
              <button
                style={S.btnEdit}
                onClick={() => {
                  onClose();
                  onDuplicate(event);
                }}
                title="Termin duplizieren"
                aria-label="Termin duplizieren"
              >
                ⧉
              </button>
              <button
                style={S.btnDelete}
                onClick={handleDeleteClick}
              >
                ✕ Löschen
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {popup}
      {recurringDeleteDialog && createPortal(
        <div className="modal-backdrop" onClick={() => setRecurringDeleteDialog(false)} onMouseDown={(e) => e.nativeEvent.stopPropagation()}>
          <div className="rec-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="rec-dialog-header">
              <h3 className="rec-dialog-title">Termin löschen</h3>
              <p className="rec-dialog-sub">„{event.summary}" ist ein Serientermin.</p>
            </div>
            <div className="rec-dialog-options">
              <button
                className="rec-option"
                onClick={() => { setRecurringDeleteDialog(false); executeDelete(event.recurrence_id, "single"); }}
                disabled={deleting}
              >
                <div className="rec-option-title">Nur diesen Termin</div>
                <div className="rec-option-desc">
                  Nur diese eine Instanz wird gelöscht. Die Serie bleibt bestehen.
                </div>
              </button>
              <button
                className="rec-option"
                onClick={() => { setRecurringDeleteDialog(false); executeDelete(event.recurrence_id, "future"); }}
                disabled={deleting}
              >
                <div className="rec-option-title">Dieser und alle folgenden</div>
                <div className="rec-option-desc">
                  Dieser Termin und alle folgenden Instanzen werden gelöscht.
                </div>
              </button>
              <button
                className="rec-option"
                onClick={() => { setRecurringDeleteDialog(false); executeDelete(undefined, "all"); }}
                disabled={deleting}
              >
                <div className="rec-option-title">Alle Termine der Serie</div>
                <div className="rec-option-desc">
                  Die gesamte Serie wird unwiderruflich gelöscht.
                </div>
              </button>
            </div>
            <div className="rec-dialog-footer">
              <button className="rec-cancel" onClick={() => setRecurringDeleteDialog(false)}>
                Abbrechen
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

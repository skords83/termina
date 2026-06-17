import { useState, useRef, useEffect } from "react";
import { parseNaturalEvent, ParsedEvent } from "../utils/naturalParser";

interface NaturalInputBarProps {
  calendars: { id: string; name: string; color: string }[];
  defaultCalendarId?: string;
  onConfirm: (event: ParsedEvent & { calendar_id: string }) => Promise<void>;
  onClose: () => void;
}

function formatPreviewDate(iso: string): string {
  if (!iso) return "";
  const d = iso.includes("T") ? new Date(iso) : (() => {
    const [y, m, day] = iso.split("-").map(Number);
    return new Date(y, m - 1, day);
  })();

  const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
  const dateStr = `${WEEKDAYS[d.getDay()]}, ${d.getDate()}. ${MONTHS[d.getMonth()]}`;

  if (!iso.includes("T")) return dateStr;
  const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${dateStr} ${timeStr}`;
}

function NaturalInputBar({
  calendars,
  defaultCalendarId,
  onConfirm,
  onClose,
}: NaturalInputBarProps) {
  const [text, setText] = useState("");
  const [calendarId, setCalendarId] = useState(defaultCalendarId || calendars[0]?.id || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (dropdownOpen) setDropdownOpen(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, dropdownOpen]);

  // Close on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (triggerRef.current && !triggerRef.current.closest(".natural-cal-picker")?.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  const openDropdown = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuStyle({
      position: "fixed",
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      zIndex: 9999,
    });
    setDropdownOpen(true);
  };

  const parsed = text.trim() ? parseNaturalEvent(text) : null;

  const handleSubmit = async () => {
    if (!parsed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onConfirm({ ...parsed, calendar_id: calendarId });
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Fehler beim Speichern");
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && parsed) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const cal = calendars.find((c) => c.id === calendarId);

  return (
    <div className="natural-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="natural-modal">
        <div className="natural-header">
          <span className="natural-title">Termin in Fließtext eingeben</span>
          <button className="natural-close" onClick={onClose}>✕</button>
        </div>

        <div className="natural-input-row">
          <input
            ref={inputRef}
            className="natural-input"
            type="text"
            placeholder='z.B. „Morgen 14 Uhr Zahnarzt" oder „Freitag Abendessen mit Sara im Vapiano"'
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={saving}
          />
        </div>

        {parsed ? (
          <div className="natural-preview">
            <div className="natural-preview-title">
              <span className="natural-preview-dot" style={{ background: cal?.color || "#888" }} />
              {parsed.summary}
            </div>
            <div className="natural-preview-meta">
              <span>{formatPreviewDate(parsed.start)}</span>
              {!parsed.all_day && <span> – {formatPreviewDate(parsed.end)}</span>}
              {parsed.all_day && <span> (Ganztägig)</span>}
              {parsed.location && <span> · 📍 {parsed.location}</span>}
            </div>
          </div>
        ) : text.trim() ? (
          <div className="natural-preview natural-preview-empty">
            Kein Datum erkannt – Termin wird auf heute 09:00 gesetzt
          </div>
        ) : (
          <div className="natural-hints">
            <span className="natural-hint">„Morgen 14 Uhr Zahnarzt"</span>
            <span className="natural-hint">„Freitag 18 Uhr Abendessen im Vapiano"</span>
            <span className="natural-hint">„Am 15.7. ganztägig Betriebsausflug"</span>
            <span className="natural-hint">„Nächsten Montag von 10 bis 12 Uhr Meeting"</span>
          </div>
        )}

        {error && <div className="natural-error">{error}</div>}

        <div className="natural-footer">
          <div className="natural-cal-select">
            <label className="natural-cal-label">Kalender:</label>

            <div className="natural-cal-picker">
              <button
                ref={triggerRef}
                type="button"
                className="natural-cal-trigger"
                onClick={openDropdown}
                disabled={saving}
              >
                <span className="natural-cal-trigger-dot" style={{ background: cal?.color || "#888" }} />
                <span className="natural-cal-trigger-name">{cal?.name ?? "–"}</span>
                <span className="natural-cal-trigger-arrow">{dropdownOpen ? "▴" : "▾"}</span>
              </button>

              {dropdownOpen && (
                <div className="natural-cal-menu" style={menuStyle}>
                  {calendars.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`natural-cal-option${c.id === calendarId ? " natural-cal-option--active" : ""}`}
                      onClick={() => { setCalendarId(c.id); setDropdownOpen(false); }}
                    >
                      <span className="natural-cal-option-dot" style={{ background: c.color || "#888" }} />
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="natural-actions">
            <button className="natural-btn-cancel" onClick={onClose} disabled={saving}>
              Abbrechen
            </button>
            <button
              className="natural-btn-save"
              onClick={handleSubmit}
              disabled={!text.trim() || saving}
            >
              {saving ? "Speichern…" : "Speichern ↵"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export { NaturalInputBar };
export default NaturalInputBar;
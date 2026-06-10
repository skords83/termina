import { useState, useMemo, useEffect, useRef } from "react";
import { CalendarEvent, Calendar } from "../types/index";

interface SearchModalProps {
  events: CalendarEvent[];
  calendars: Calendar[];
  onClose: () => void;
  onEventClick: (event: CalendarEvent, rect: DOMRect) => void;
}

function parseLocalDate(str: string): Date {
  if (!str) return new Date();
  if (str.includes("T")) return new Date(str);
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDateShort(str: string): string {
  const d = parseLocalDate(str);
  const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
  return `${d.getDate()}. ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatTime(str: string): string {
  const d = parseLocalDate(str);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function highlight(text: string, query: string): React.ReactNode {
  if (!query || !text) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="search-highlight">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

/**
 * Returns a ~120-char snippet of `text` centred around the first occurrence
 * of `query`, with leading/trailing ellipses where text was cut.
 * Returns null if `query` is not found in `text`.
 */
function descriptionSnippet(text: string, query: string): string | null {
  if (!text || !query) return null;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;
  const HALF = 55;
  const start = Math.max(0, idx - HALF);
  const end = Math.min(text.length, idx + query.length + HALF);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

export default function SearchModal({
  events,
  calendars,
  onClose,
  onEventClick,
}: SearchModalProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const calMap = useMemo(() => {
    const m: Record<string, Calendar> = {};
    calendars.forEach((c) => (m[c.id] = c));
    return m;
  }, [calendars]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    return events
      .filter((ev) => {
        return (
          ev.summary?.toLowerCase().includes(q) ||
          ev.description?.toLowerCase().includes(q) ||
          ev.location?.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        // Prioritize future events, then sort by date
        const now = Date.now();
        const aTime = parseLocalDate(a.start).getTime();
        const bTime = parseLocalDate(b.start).getTime();
        const aFuture = aTime >= now;
        const bFuture = bTime >= now;
        if (aFuture && !bFuture) return -1;
        if (!aFuture && bFuture) return 1;
        return aFuture
          ? aTime - bTime           // future: soonest first
          : bTime - aTime;          // past: most recent first
      })
      .slice(0, 50);
  }, [query, events]);

  return (
    <div className="search-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-modal">
        <div className="search-input-row">
          <span className="search-icon">⌕</span>
          <input
            ref={inputRef}
            className="search-input"
            type="text"
            placeholder="Termine suchen…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="search-clear" onClick={() => setQuery("")}>✕</button>
          )}
        </div>

        <div className="search-results">
          {query.trim() === "" && (
            <div className="search-placeholder">Tipp, Ort oder Beschreibung eingeben…</div>
          )}
          {query.trim() !== "" && results.length === 0 && (
            <div className="search-placeholder">Keine Ergebnisse für „{query}"</div>
          )}
          {results.map((ev) => {
            const cal = calMap[ev.calendar_id];
            const color = cal?.color || "#888";
            return (
              <div
                key={`${ev.uid}_${ev.start}`}
                className="search-result"
                onClick={(e) =>
                  onEventClick(ev, (e.currentTarget as HTMLElement).getBoundingClientRect())
                }
              >
                <div className="search-result-color" style={{ background: color }} />
                <div className="search-result-body">
                  <div className="search-result-title">
                    {highlight(ev.summary || "(kein Titel)", query)}
                  </div>
                  <div className="search-result-meta">
                    <span>{formatDateShort(ev.start)}</span>
                    {!ev.all_day && <span> · {formatTime(ev.start)}</span>}
                    {ev.location && (
                      <span> · {highlight(ev.location, query)}</span>
                    )}
                    <span className="search-result-cal"> · {cal?.name}</span>
                  </div>
                  {(() => {
                    const snippet = descriptionSnippet(ev.description ?? "", query);
                    return snippet ? (
                      <div className="search-result-desc">
                        {highlight(snippet, query)}
                      </div>
                    ) : null;
                  })()}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
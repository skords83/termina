import { useEffect, useRef } from 'react';
import { CalendarEvent, Calendar } from '../types';

interface Props {
  event: CalendarEvent;
  calendar: Calendar | undefined;
  onClose: () => void;
}

function parseLocalDate(iso: string): Date {
  const datePart = iso.slice(0, 10);
  const [y, m, d] = datePart.split('-').map(Number);
  if (iso.length === 10) return new Date(y, m - 1, d);
  const hasTimezone = iso.includes('+') || iso.endsWith('Z');
  if (hasTimezone) return new Date(iso);
  const timePart = iso.slice(11, 19);
  const [h, min, s] = timePart.split(':').map(Number);
  return new Date(y, m - 1, d, h, min, s ?? 0);
}

function formatDate(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatTime(iso: string): string {
  return parseLocalDate(iso).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function localDateStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function EventPopup({ event, calendar, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const color = calendar?.color ?? '#888';

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const startDate = parseLocalDate(event.start);
  const endDate = parseLocalDate(event.end);

  // For all-day events the end is exclusive → show end - 1 day
  const displayEnd = event.all_day
    ? new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - 1)
    : endDate;

  const sameDay =
    localDateStr(startDate) === localDateStr(displayEnd);

  // Build date/time string
  let dateLabel: string;
  if (event.all_day) {
    dateLabel = sameDay
      ? formatDate(event.start)
      : `${formatDate(event.start)} – ${formatDate(localDateStr(displayEnd))}`;
  } else {
    const timeStr = `${formatTime(event.start)} – ${formatTime(event.end)}`;
    dateLabel = sameDay
      ? `${formatDate(event.start)}, ${timeStr}`
      : `${formatDate(event.start)}, ${formatTime(event.start)} – ${formatDate(event.end)}, ${formatTime(event.end)}`;
  }

  return (
    <div className="popup-overlay">
      <div className="popup" ref={ref} role="dialog" aria-modal="true">
        <div className="popup-bar" style={{ background: color }} />

        <div className="popup-header">
          <span className="popup-title">{event.summary ?? '(kein Titel)'}</span>
          <button className="popup-close" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>

        <div className="popup-meta">
          <div className="popup-row">
            <svg className="popup-icon-svg" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.4"/>
              <path d="M5 2v2M11 2v2M2 7h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
            <span>{dateLabel}</span>
          </div>

          {event.location && (
            <div className="popup-row">
              <svg className="popup-icon-svg" viewBox="0 0 16 16" fill="none">
                <path d="M8 1.5C5.515 1.5 3.5 3.515 3.5 6c0 3.5 4.5 8.5 4.5 8.5s4.5-5 4.5-8.5C12.5 3.515 10.485 1.5 8 1.5Z" stroke="currentColor" strokeWidth="1.4"/>
                <circle cx="8" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.3"/>
              </svg>
              <span>{event.location}</span>
            </div>
          )}

          {calendar && (
            <div className="popup-row">
              <span className="popup-cal-dot" style={{ background: color }} />
              <span className="popup-cal-name">{calendar.name}</span>
            </div>
          )}

          {event.description && (
            <div className="popup-row popup-description">
              <svg className="popup-icon-svg" viewBox="0 0 16 16" fill="none" style={{ marginTop: 2 }}>
                <path d="M3 4h10M3 7h10M3 10h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
              <span>{event.description}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

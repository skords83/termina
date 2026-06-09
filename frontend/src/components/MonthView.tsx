import { useMemo } from 'react';
import { CalendarEvent, Calendar } from '../types';

interface Props {
  year: number;
  month: number; // 0-indexed
  events: CalendarEvent[];
  calendars: Calendar[];
  visibleCalendarIds: Set<string>;
}

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseLocalDate(iso: string): Date {
  // "2026-06-15" or "2026-06-15T10:00:00+02:00"
  if (iso.length === 10) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(iso);
}

function formatTime(iso: string): string {
  const d = parseLocalDate(iso);
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

export function MonthView({ year, month, events, calendars, visibleCalendarIds }: Props) {
  const today = new Date();

  const calendarMap = useMemo(
    () => new Map(calendars.map((c) => [c.id, c])),
    [calendars]
  );

  // Build grid cells
  const cells = useMemo(() => {
    const firstDay = new Date(year, month, 1);
    const startOffset = (firstDay.getDay() + 6) % 7; // Mon=0
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrev = new Date(year, month, 0).getDate();

    const result: { date: Date; current: boolean }[] = [];

    for (let i = startOffset - 1; i >= 0; i--) {
      result.push({ date: new Date(year, month - 1, daysInPrev - i), current: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      result.push({ date: new Date(year, month, d), current: true });
    }
    while (result.length % 7 !== 0) {
      const next = result.length - startOffset - daysInMonth + 1;
      result.push({ date: new Date(year, month + 1, next), current: false });
    }

    return result;
  }, [year, month]);

  // Group events by date string
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      if (!visibleCalendarIds.has(ev.calendar_id)) continue;
      const key = isoDate(parseLocalDate(ev.start));
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ev);
    }
    // Sort events per day by start time
    for (const [, evs] of map) {
      evs.sort((a, b) => a.start.localeCompare(b.start));
    }
    return map;
  }, [events, visibleCalendarIds]);

  function isToday(date: Date) {
    return isoDate(date) === isoDate(today);
  }

  return (
    <div className="month-view">
      {/* Header row */}
      <div className="month-header">
        {WEEKDAYS.map((d) => (
          <div key={d} className="month-weekday">{d}</div>
        ))}
      </div>

      {/* Day grid */}
      <div className="month-grid">
        {cells.map(({ date, current }, i) => {
          const key = isoDate(date);
          const dayEvents = eventsByDate.get(key) ?? [];

          return (
            <div
              key={i}
              className={[
                'day-cell',
                current ? '' : 'day-cell--other',
                isToday(date) ? 'day-cell--today' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className="day-number">{date.getDate()}</span>
              <div className="event-list">
                {dayEvents.slice(0, 4).map((ev) => {
                  const cal = calendarMap.get(ev.calendar_id);
                  return (
                    <div
                      key={ev.uid}
                      className="event-item"
                      style={{ '--event-color': cal?.color ?? '#888' } as React.CSSProperties}
                      title={ev.location ? `${ev.summary}\n${ev.location}` : ev.summary}
                    >
                      {!ev.all_day && (
                        <span className="event-time">{formatTime(ev.start)}</span>
                      )}
                      <span className="event-title">{ev.summary}</span>
                    </div>
                  );
                })}
                {dayEvents.length > 4 && (
                  <div className="event-more">+{dayEvents.length - 4} weitere</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

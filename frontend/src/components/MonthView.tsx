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

function localDateStr(date: Date): string {
  // timezone-safe: uses local year/month/day, never UTC
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseLocalDate(iso: string): Date {
  // Parse as local time to avoid UTC-shift at timezone boundaries (MESZ = UTC+2).
  // Backend returns naive datetimes like "2026-06-08T00:00:00" without tz suffix.
  const datePart = iso.slice(0, 10);
  const [y, m, d] = datePart.split('-').map(Number);
  if (iso.length === 10) return new Date(y, m - 1, d);
  // Has time component
  const hasTimezone = iso.includes('+') || iso.endsWith('Z');
  if (hasTimezone) return new Date(iso); // browser handles tz-aware strings correctly
  // Naive datetime (no tz) → parse as local
  const timePart = iso.slice(11, 19);
  const [h, min, s] = timePart.split(':').map(Number);
  return new Date(y, m - 1, d, h, min, s ?? 0);
}

function formatTime(iso: string): string {
  const d = parseLocalDate(iso);
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

// Add days to a local date without timezone drift
function addDays(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

interface DayEvent {
  ev: CalendarEvent;
  isStart: boolean;
  isEnd: boolean;
  isMultiDay: boolean;
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

  // Group events by date – multi-day events appear on every day they span
  const eventsByDate = useMemo(() => {
    const map = new Map<string, DayEvent[]>();

    for (const ev of events) {
      if (!visibleCalendarIds.has(ev.calendar_id)) continue;

      const startDate = parseLocalDate(ev.start);
      // For all-day events, end is exclusive in iCal (e.g. end = next day for a 1-day event)
      // For timed events, end is the actual end time
      let endDate = parseLocalDate(ev.end);

      // Normalize: for all-day events, end is exclusive → subtract 1 day for display
      if (ev.all_day) {
        endDate = addDays(endDate, -1);
      }

      const startStr = localDateStr(startDate);
      const endStr = localDateStr(endDate);
      const isMultiDay = startStr !== endStr;

      // Walk every day this event spans
      let cursor = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
      while (localDateStr(cursor) <= endStr) {
        const key = localDateStr(cursor);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({
          ev,
          isStart: key === startStr,
          isEnd: key === endStr,
          isMultiDay,
        });
        cursor = addDays(cursor, 1);
      }
    }

    // Sort: all-day/multi-day first, then by start time
    for (const [, dayEvs] of map) {
      dayEvs.sort((a, b) => {
        const aAllDay = a.ev.all_day || a.isMultiDay ? 0 : 1;
        const bAllDay = b.ev.all_day || b.isMultiDay ? 0 : 1;
        if (aAllDay !== bAllDay) return aAllDay - bAllDay;
        return a.ev.start.localeCompare(b.ev.start);
      });
    }

    return map;
  }, [events, visibleCalendarIds]);

  function isToday(date: Date) {
    return localDateStr(date) === localDateStr(today);
  }

  return (
    <div className="month-view">
      <div className="month-header">
        {WEEKDAYS.map((d) => (
          <div key={d} className="month-weekday">{d}</div>
        ))}
      </div>

      <div className="month-grid">
        {cells.map(({ date, current }, i) => {
          const key = localDateStr(date);
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
                {dayEvents.slice(0, 4).map(({ ev, isStart, isEnd, isMultiDay }) => {
                  const cal = calendarMap.get(ev.calendar_id);
                  const color = cal?.color ?? '#888';
                  const isBlock = ev.all_day || isMultiDay;

                  return (
                    <div
                      key={ev.uid + key}
                      className={[
                        'event-item',
                        isBlock ? 'event-item--block' : '',
                        isBlock && !isStart ? 'event-item--cont' : '',
                        isBlock && !isEnd ? 'event-item--continues' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{ '--event-color': color } as React.CSSProperties}
                      title={ev.location ? `${ev.summary}\n${ev.location}` : ev.summary}
                    >
                      {!isBlock && (
                        <span className="event-time">{formatTime(ev.start)}</span>
                      )}
                      <span className="event-title">
                        {/* Only show title on start day for multi-day, saves space */}
                        {isStart || !isMultiDay ? ev.summary : ''}
                      </span>
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

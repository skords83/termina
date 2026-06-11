import { useMemo, useRef } from "react";
import { CalendarEvent, Calendar } from "../types/index";

interface DayViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onEventClick: (event: CalendarEvent, rect: DOMRect) => void;
  onDayClick: (date: Date) => void;
}

const HOUR_HEIGHT = 64;
const TOTAL_HOURS = 24;
const MIN_EVENT_HEIGHT = 20;

function parseLocalDate(str: string): Date {
  if (!str) return new Date();
  if (str.includes("T")) return new Date(str);
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function toMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function padTwo(n: number): string {
  return String(n).padStart(2, "0");
}

const WEEKDAY_NAMES = [
  "Sonntag", "Montag", "Dienstag", "Mittwoch",
  "Donnerstag", "Freitag", "Samstag",
];
const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

export default function DayView({
  currentDate,
  events,
  calendars,
  onEventClick,
  onDayClick,
}: DayViewProps) {
  const today = new Date();
  const isToday = sameDay(currentDate, today);

  const calMap = useMemo(() => {
    const m: Record<string, Calendar> = {};
    calendars.forEach((c) => (m[c.id] = c));
    return m;
  }, [calendars]);

  const allDayEvents = useMemo(
    () =>
      events.filter((e) => {
        if (!e.all_day) return false;
        const s = parseLocalDate(e.start);
        const en = parseLocalDate(e.end);
        return s <= currentDate && currentDate < en;
      }),
    [events, currentDate]
  );

  const timedEvents = useMemo(
    () =>
      events.filter((e) => {
        if (e.all_day) return false;
        const s = parseLocalDate(e.start);
        return sameDay(s, currentDate);
      }),
    [events, currentDate]
  );

  // Layout with overlap columns
  type LayoutEvent = CalendarEvent & { col: number; totalCols: number };

  const layoutEvents = (evs: CalendarEvent[]): LayoutEvent[] => {
    const sorted = [...evs].sort((a, b) =>
      parseLocalDate(a.start).getTime() - parseLocalDate(b.start).getTime()
    );
    const laid: LayoutEvent[] = [];
    const cols: number[] = [];

    sorted.forEach((ev) => {
      const startMin = toMinutes(parseLocalDate(ev.start));
      const endMin = toMinutes(parseLocalDate(ev.end)) || 24 * 60;
      let col = cols.findIndex((endT) => endT <= startMin);
      if (col === -1) col = cols.length;
      cols[col] = endMin;
      laid.push({ ...ev, col, totalCols: 0 });
    });

    laid.forEach((ev) => {
      const startMin = toMinutes(parseLocalDate(ev.start));
      const endMin = toMinutes(parseLocalDate(ev.end)) || 24 * 60;
      let maxCol = ev.col;
      laid.forEach((other) => {
        const oStart = toMinutes(parseLocalDate(other.start));
        const oEnd = toMinutes(parseLocalDate(other.end)) || 24 * 60;
        if (oStart < endMin && oEnd > startMin) maxCol = Math.max(maxCol, other.col);
      });
      ev.totalCols = maxCol + 1;
    });
    return laid;
  };

  const laidOut = layoutEvents(timedEvents);
  const hours = Array.from({ length: TOTAL_HOURS }, (_, i) => i);

  const scrollInit = (el: HTMLDivElement | null) => {
    if (el) el.scrollTop = 8 * HOUR_HEIGHT - 16;
  };

  return (
    <div className="day-view">
      {/* Header */}
      <div className="day-view-header">
        <div className="day-view-weekday">{WEEKDAY_NAMES[currentDate.getDay()]}</div>
        <div className={`day-view-date${isToday ? " today" : ""}`}>
          {currentDate.getDate()}. {MONTH_NAMES[currentDate.getMonth()]} {currentDate.getFullYear()}
        </div>
        {allDayEvents.length > 0 && (
          <div className="day-view-allday">
            {allDayEvents.map((ev) => {
              const cal = calMap[ev.calendar_id];
              return (
                <div
                  key={ev.uid}
                  className="day-allday-event"
                  style={{ background: cal?.color || "#888" }}
                  onClick={(e) =>
                    onEventClick(ev, (e.currentTarget as HTMLElement).getBoundingClientRect())
                  }
                >
                  {ev.summary}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Scrollable grid */}
      <div className="day-body" ref={scrollInit}>
        <div className="day-grid" style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}>
          {/* Hour labels + lines */}
          {hours.map((h) => (
            <div
              key={h}
              className="day-hour-row"
              style={{ top: h * HOUR_HEIGHT, height: HOUR_HEIGHT }}
            >
              <div className="day-hour-label">
                {h === 0 ? "" : `${padTwo(h)}:00`}
              </div>
              <div className="day-hour-line" />
            </div>
          ))}

          {/* Now indicator */}
          {isToday && (
            <div
              className="day-now-line"
              style={{ top: (toMinutes(today) / 60) * HOUR_HEIGHT }}
            />
          )}

          {/* Events */}
          <div
            className="day-events-col"
            onClick={() => onDayClick(currentDate)}
          >
            {laidOut.map((ev) => {
              const evStart = parseLocalDate(ev.start);
              const evEnd = parseLocalDate(ev.end);
              const startMin = toMinutes(evStart);
              let endMin = toMinutes(evEnd);
              if (endMin <= startMin) endMin = startMin + 30;

              const top = (startMin / 60) * HOUR_HEIGHT;
              const height = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, MIN_EVENT_HEIGHT);

              // Column layout with gap
              const colGap = 3;
              const width = `calc((100% - ${colGap}px) / ${ev.totalCols} - ${colGap}px)`;
              const left = `calc(${ev.col} * (100% - ${colGap}px) / ${ev.totalCols} + ${colGap}px)`;

              const cal = calMap[ev.calendar_id];
              const color = cal?.color || "#888";

              const startLabel = `${padTwo(evStart.getHours())}:${padTwo(evStart.getMinutes())}`;
              const endLabel = `${padTwo(evEnd.getHours())}:${padTwo(evEnd.getMinutes())}`;

              // Progressive disclosure based on available height
              const showTime = height >= 38;
              const showEndTime = height >= 52;
              const showLocation = ev.location != null && height >= 70;

              return (
                <div
                  key={ev.uid}
                  className="day-event"
                  style={{
                    top,
                    height,
                    width,
                    left,
                    borderLeftColor: color,
                    background: color + "1a",
                  }}
                  title={
                    [ev.summary, ev.location].filter(Boolean).join(" · ")
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onEventClick(ev, (e.currentTarget as HTMLElement).getBoundingClientRect());
                  }}
                >
                  {height < 28 ? (
                    /* Ultra-compact: just title in one line */
                    <div className="day-event-compact">
                      <span className="day-event-compact-title">{ev.summary}</span>
                    </div>
                  ) : (
                    <div className="day-event-inner">
                      <div className="day-event-title">{ev.summary}</div>
                      {showTime && (
                        <div className="day-event-time" style={{ color }}>
                          {startLabel}
                          {showEndTime ? ` – ${endLabel}` : ""}
                        </div>
                      )}
                      {showLocation && (
                        <div className="day-event-location">{ev.location}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
import { useMemo, useRef } from "react";
import { CalendarEvent, Calendar } from "../types/index";

interface WeekViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onEventClick: (event: CalendarEvent, rect: DOMRect) => void;
  onDayClick: (date: Date) => void;
}

const HOUR_HEIGHT = 56; // px per hour
const START_HOUR = 0;
const END_HOUR = 24;
const TOTAL_HOURS = END_HOUR - START_HOUR;
// Minimum visible height for an event block (px)
const MIN_EVENT_HEIGHT = 18;

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const monday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + monday);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function parseLocalDate(str: string): Date {
  if (!str) return new Date();
  if (str.includes("T")) {
    if (!str.includes("+") && !str.includes("Z")) {
      return new Date(str);
    }
    return new Date(str);
  }
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

const WEEKDAYS_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

export default function WeekView({
  currentDate,
  events,
  calendars,
  onEventClick,
  onDayClick,
}: WeekViewProps) {
  const weekStart = getWeekStart(currentDate);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = new Date();

  const calMap = useMemo(() => {
    const m: Record<string, Calendar> = {};
    calendars.forEach((c) => (m[c.id] = c));
    return m;
  }, [calendars]);

  const allDayEvents = useMemo(
    () => events.filter((e) => e.all_day),
    [events]
  );
  const timedEvents = useMemo(
    () => events.filter((e) => !e.all_day),
    [events]
  );

  // Group timed events by day index (0=Mon)
  const eventsByDay = useMemo(() => {
    const byDay: CalendarEvent[][] = Array.from({ length: 7 }, () => []);
    timedEvents.forEach((ev) => {
      const evStart = parseLocalDate(ev.start);
      days.forEach((day, i) => {
        if (sameDay(evStart, day) && !byDay[i].some((e) => e.uid === ev.uid)) {
          byDay[i].push(ev);
        }
      });
    });
    return byDay;
  }, [timedEvents, days]);

  const allDayByDay = useMemo(() => {
    const byDay: CalendarEvent[][] = Array.from({ length: 7 }, () => []);
    allDayEvents.forEach((ev) => {
      const evStart = parseLocalDate(ev.start);
      const evEnd = parseLocalDate(ev.end);
      days.forEach((day, i) => {
        if (evStart <= day && day < evEnd && !byDay[i].some((e) => e.uid === ev.uid)) {
          byDay[i].push(ev);
        }
      });
    });
    return byDay;
  }, [allDayEvents, days]);

  const hasAllDay = allDayByDay.some((d) => d.length > 0);
  const hours = Array.from({ length: TOTAL_HOURS }, (_, i) => i + START_HOUR);

  // Scroll to 8:00 on mount
  const didScroll = useRef(false);
  const scrollInit = (el: HTMLDivElement | null) => {
    if (el && !didScroll.current) {
      didScroll.current = true;
      el.scrollTop = 8 * HOUR_HEIGHT - 16;
    }
  };

  // Layout overlapping events into columns
  type LayoutEvent = CalendarEvent & { col: number; totalCols: number };

  function layoutEvents(dayEvents: CalendarEvent[]): LayoutEvent[] {
    const sorted = [...dayEvents].sort((a, b) => {
      return parseLocalDate(a.start).getTime() - parseLocalDate(b.start).getTime();
    });

    const laid: LayoutEvent[] = [];
    const cols: number[] = []; // end-time in minutes for each column

    sorted.forEach((ev) => {
      const evStart = parseLocalDate(ev.start);
      const evEnd = parseLocalDate(ev.end);
      const startMin = toMinutes(evStart);
      const endMin = toMinutes(evEnd) || 24 * 60;

      let col = cols.findIndex((endT) => endT <= startMin);
      if (col === -1) col = cols.length;
      cols[col] = endMin;

      laid.push({ ...ev, col, totalCols: 0 });
    });

    // Fix totalCols: find max overlapping column for each event
    laid.forEach((ev) => {
      const evStart = parseLocalDate(ev.start);
      const evEnd = parseLocalDate(ev.end);
      const startMin = toMinutes(evStart);
      const endMin = toMinutes(evEnd) || 24 * 60;

      let maxCol = ev.col;
      laid.forEach((other) => {
        const otherStart = parseLocalDate(other.start);
        const otherEnd = parseLocalDate(other.end);
        const oStart = toMinutes(otherStart);
        const oEnd = toMinutes(otherEnd) || 24 * 60;
        if (oStart < endMin && oEnd > startMin) {
          maxCol = Math.max(maxCol, other.col);
        }
      });
      ev.totalCols = maxCol + 1;
    });

    return laid;
  }

  return (
    <div className="week-view">
      {/* Header row */}
      <div className="week-header">
        <div className="week-time-gutter" />
        {days.map((day, i) => {
          const isToday = sameDay(day, today);
          return (
            <div
              key={i}
              className={`week-day-header${isToday ? " today" : ""}`}
              onClick={() => onDayClick(day)}
            >
              <span className="week-day-name">{WEEKDAYS_SHORT[i]}</span>
              <span className={`week-day-num${isToday ? " today-num" : ""}`}>
                {day.getDate()}
              </span>
            </div>
          );
        })}
      </div>

      {/* All-day row */}
      {hasAllDay && (
        <div className="week-allday-row">
          <div className="week-time-gutter week-allday-label">ganztägig</div>
          {days.map((_day, i) => (
            <div key={i} className="week-allday-cell">
              {allDayByDay[i].map((ev) => {
                const cal = calMap[ev.calendar_id];
                return (
                  <div
                    key={ev.uid}
                    className="week-allday-event"
                    style={{ background: cal?.color || "#888" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEventClick(ev, (e.currentTarget as HTMLElement).getBoundingClientRect());
                    }}
                  >
                    {ev.summary}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Scrollable grid */}
      <div className="week-body" ref={scrollInit}>
        <div
          className="week-grid"
          style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}
        >
          {/* Hour labels */}
          <div className="week-hours">
            {hours.map((h) => (
              <div
                key={h}
                className="week-hour-row"
                style={{ height: HOUR_HEIGHT }}
              >
                <div className="week-hour-label">
                  {h === 0 ? "" : `${padTwo(h)}:00`}
                </div>
                <div className="week-hour-line" />
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((day, di) => {
            const dayEvs = layoutEvents(eventsByDay[di]);
            const isToday = sameDay(day, today);
            return (
              <div
                key={di}
                className={`week-day-col${isToday ? " today-col" : ""}`}
                onClick={() => onDayClick(day)}
              >
                {/* Now indicator */}
                {isToday && (() => {
                  const nowMin = toMinutes(today);
                  const top = (nowMin / 60) * HOUR_HEIGHT;
                  return (
                    <div className="week-now-line" style={{ top }} />
                  );
                })()}

                {dayEvs.map((ev) => {
                  const evStart = parseLocalDate(ev.start);
                  const evEnd = parseLocalDate(ev.end);
                  const startMin = toMinutes(evStart);
                  let endMin = toMinutes(evEnd);
                  if (endMin <= startMin) endMin = startMin + 30;
                  const durationMin = endMin - startMin;

                  const top = (startMin / 60) * HOUR_HEIGHT;
                  const height = Math.max((durationMin / 60) * HOUR_HEIGHT, MIN_EVENT_HEIGHT);

                  // Leave a 2px gap between columns
                  const colGap = 2;
                  const width = `calc((100% - ${colGap}px) / ${ev.totalCols} - ${colGap}px)`;
                  const left = `calc(${ev.col} * (100% - ${colGap}px) / ${ev.totalCols} + ${colGap}px)`;

                  const cal = calMap[ev.calendar_id];
                  const color = cal?.color || "#888";

                  // How much content we can show
                  const showTime = height >= 36;
                  const startLabel = `${padTwo(evStart.getHours())}:${padTwo(evStart.getMinutes())}`;

                  return (
                    <div
                      key={ev.uid}
                      className="week-event"
                      style={{
                        top,
                        height,
                        width,
                        left,
                        borderLeftColor: color,
                        background: color + "22",
                      }}
                      title={ev.summary}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEventClick(ev, (e.currentTarget as HTMLElement).getBoundingClientRect());
                      }}
                    >
                      {/* Single-line layout for very short events */}
                      {height < 36 ? (
                        <div className="week-event-compact">
                          <span
                            className="week-event-compact-dot"
                            style={{ background: color }}
                          />
                          <span className="week-event-compact-title">{ev.summary}</span>
                        </div>
                      ) : (
                        /* Normal layout */
                        <div className="week-event-body">
                          <div className="week-event-title">{ev.summary}</div>
                          {showTime && (
                            <div className="week-event-time" style={{ color }}>
                              {startLabel}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
import { useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CalendarEvent, Calendar } from "../types/index";

interface WeekViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onEventClick: (event: CalendarEvent, rect: DOMRect) => void;
  onDayClick: (date: Date) => void;
  onEventResize: (event: CalendarEvent, newEnd: Date) => void;
}

const HOUR_HEIGHT = 56;
const START_HOUR = 0;
const END_HOUR = 24;
const TOTAL_HOURS = END_HOUR - START_HOUR;
const MIN_EVENT_HEIGHT = 18;
const RESIZE_SNAP_MINUTES = 15;

// Konstante: per-pixel = Minuten — wird auch im App-Level DragEnd-Handler genutzt
export const WEEK_PX_PER_MINUTE = HOUR_HEIGHT / 60;

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
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

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${padTwo(d.getMonth() + 1)}-${padTwo(d.getDate())}`;
}

const WEEKDAYS_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

// ── Draggable Event ─────────────────────────────────────────────────────────

function DraggableWeekEvent({
  ev,
  top,
  height,
  width,
  left,
  color,
  startLabel,
  showTime,
  onEventClick,
  onEventResize,
}: {
  ev: CalendarEvent;
  top: number;
  height: number;
  width: string;
  left: string;
  color: string;
  startLabel: string;
  showTime: boolean;
  onEventClick: (event: CalendarEvent, rect: DOMRect) => void;
  onEventResize: (event: CalendarEvent, newEnd: Date) => void;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `week-event-${ev.uid}-${ev.recurrence_id ?? ev.start}`,
    data: { event: ev, source: 'week' },
  });

  const [resizeHeight, setResizeHeight] = useState<number | null>(null);
  const resizeStartY = useRef(0);
  const resizeBaseHeight = useRef(0);

  const handleResizeStart = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    resizeStartY.current = e.clientY;
    resizeBaseHeight.current = height;
    setResizeHeight(height);

    const snap = (rawHeight: number) => {
      const rawMinutes = rawHeight / WEEK_PX_PER_MINUTE;
      return Math.max(
        RESIZE_SNAP_MINUTES,
        Math.round(rawMinutes / RESIZE_SNAP_MINUTES) * RESIZE_SNAP_MINUTES
      );
    };

    const onMove = (me: PointerEvent) => {
      const deltaY = me.clientY - resizeStartY.current;
      const snappedMinutes = snap(resizeBaseHeight.current + deltaY);
      setResizeHeight(Math.max(snappedMinutes * WEEK_PX_PER_MINUTE, MIN_EVENT_HEIGHT));
    };
    const onUp = (ue: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const deltaY = ue.clientY - resizeStartY.current;
      const snappedMinutes = snap(resizeBaseHeight.current + deltaY);
      setResizeHeight(null);
      const baseMinutes = resizeBaseHeight.current / WEEK_PX_PER_MINUTE;
      if (snappedMinutes !== Math.round(baseMinutes)) {
        const evStart = parseLocalDate(ev.start);
        const newEnd = new Date(evStart.getTime() + snappedMinutes * 60000);
        onEventResize(ev, newEnd);
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const displayHeight = resizeHeight ?? height;

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`week-event${isDragging ? " week-event--dragging" : ""}${resizeHeight !== null ? " week-event--resizing" : ""}`}
      style={{
        top,
        height: displayHeight,
        width,
        left,
        "--event-color": color,
      } as CSSProperties}
      title={ev.summary}
      onClick={(e) => {
        e.stopPropagation();
        onEventClick(ev, (e.currentTarget as HTMLElement).getBoundingClientRect());
      }}
    >
      {displayHeight < 36 ? (
        <div className="week-event-compact">
          <span className="week-event-compact-dot" />
          <span className="week-event-compact-title">{ev.summary}</span>
        </div>
      ) : (
        <div className="week-event-body">
          <div className="week-event-title">
            <span className="week-event-title-text">{ev.summary}</span>
            {ev.is_recurring && (
              <span className="recur-icon" title="Wiederholt sich" aria-label="Wiederholt sich">⟲</span>
            )}
          </div>
          {showTime && (
            <div className="week-event-time">
              {startLabel}
            </div>
          )}
        </div>
      )}
      <div
        className="week-event-resize-handle"
        onPointerDown={handleResizeStart}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

// ── Droppable Day Column ────────────────────────────────────────────────────

function DroppableDayCol({
  day,
  isToday,
  children,
  onDayClick,
}: {
  day: Date;
  isToday: boolean;
  children: React.ReactNode;
  onDayClick: (date: Date) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `week-day-${dateStr(day)}`,
    data: { dateStr: dateStr(day), target: 'week' },
  });

  return (
    <div
      ref={setNodeRef}
      className={[
        "week-day-col",
        isToday ? "today-col" : "",
        isOver ? "week-day-col--drop-over" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => onDayClick(day)}
    >
      {children}
    </div>
  );
}

// ── Hauptkomponente ─────────────────────────────────────────────────────────

export default function WeekView({
  currentDate,
  events,
  calendars,
  onEventClick,
  onDayClick,
  onEventResize,
}: WeekViewProps) {
  const weekStart = getWeekStart(currentDate);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = new Date();

  const calMap = useMemo(() => {
    const m: Record<string, Calendar> = {};
    calendars.forEach((c) => (m[c.id] = c));
    return m;
  }, [calendars]);

  const allDayEvents = useMemo(() => events.filter((e) => e.all_day), [events]);
  const timedEvents = useMemo(() => events.filter((e) => !e.all_day), [events]);

  const eventsByDay = useMemo(() => {
    const byDay: CalendarEvent[][] = Array.from({ length: 7 }, () => []);
    timedEvents.forEach((ev) => {
      const evStart = parseLocalDate(ev.start);
      days.forEach((day, i) => {
        if (sameDay(evStart, day) && !byDay[i].some((e) => e.uid === ev.uid && e.start === ev.start)) {
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

  const didScroll = useRef(false);
  const scrollInit = (el: HTMLDivElement | null) => {
    if (el && !didScroll.current) {
      didScroll.current = true;
      el.scrollTop = 8 * HOUR_HEIGHT - 16;
    }
  };

  type LayoutEvent = CalendarEvent & { col: number; totalCols: number };

  function layoutEvents(dayEvents: CalendarEvent[]): LayoutEvent[] {
    const sorted = [...dayEvents].sort(
      (a, b) => parseLocalDate(a.start).getTime() - parseLocalDate(b.start).getTime()
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
  }

  return (
    <div className="week-view">
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
                    style={{ "--event-color": cal?.color || "#888" } as CSSProperties}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEventClick(ev, (e.currentTarget as HTMLElement).getBoundingClientRect());
                    }}
                  >
                    <span className="week-allday-event-text">{ev.summary}</span>
                    {ev.is_recurring && (
                      <span className="recur-icon" title="Wiederholt sich" aria-label="Wiederholt sich">⟲</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <div className="week-body" ref={scrollInit}>
        <div className="week-grid" style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}>
          <div className="week-hours">
            {hours.map((h) => (
              <div key={h} className="week-hour-row" style={{ height: HOUR_HEIGHT }}>
                <div className="week-hour-label">
                  {h === 0 ? "" : `${padTwo(h)}:00`}
                </div>
                <div className="week-hour-line" />
              </div>
            ))}
          </div>

          {days.map((day, di) => {
            const dayEvs = layoutEvents(eventsByDay[di]);
            const isToday = sameDay(day, today);
            return (
              <DroppableDayCol
                key={di}
                day={day}
                isToday={isToday}
                onDayClick={onDayClick}
              >
                {isToday &&
                  (() => {
                    const nowMin = toMinutes(today);
                    const top = (nowMin / 60) * HOUR_HEIGHT;
                    return <div className="week-now-line" style={{ top }} />;
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

                  const colGap = 2;
                  const width = `calc((100% - ${colGap}px) / ${ev.totalCols} - ${colGap}px)`;
                  const left = `calc(${ev.col} * (100% - ${colGap}px) / ${ev.totalCols} + ${colGap}px)`;

                  const cal = calMap[ev.calendar_id];
                  const color = cal?.color || "#888";
                  const showTime = height >= 36;
                  const startLabel = `${padTwo(evStart.getHours())}:${padTwo(evStart.getMinutes())}`;

                  return (
                    <DraggableWeekEvent
                      key={ev.uid + ev.start}
                      ev={ev}
                      top={top}
                      height={height}
                      width={width}
                      left={left}
                      color={color}
                      startLabel={startLabel}
                      showTime={showTime}
                      onEventClick={onEventClick}
                      onEventResize={onEventResize}
                    />
                  );
                })}
              </DroppableDayCol>
            );
          })}
        </div>
      </div>
    </div>
  );
}

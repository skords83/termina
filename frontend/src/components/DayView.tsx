import { useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CalendarEvent, Calendar } from "../types/index";

interface DayViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onEventClick: (event: CalendarEvent, rect: DOMRect) => void;
  onDayClick: (date: Date) => void;
  onEventResize: (event: CalendarEvent, newEnd: Date) => void;
}

const HOUR_HEIGHT = 64;
const TOTAL_HOURS = 24;
const MIN_EVENT_HEIGHT = 20;
const RESIZE_SNAP_MINUTES = 15;

export const DAY_PX_PER_MINUTE = HOUR_HEIGHT / 60;

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

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${padTwo(d.getMonth() + 1)}-${padTwo(d.getDate())}`;
}

const WEEKDAY_NAMES = [
  "Sonntag", "Montag", "Dienstag", "Mittwoch",
  "Donnerstag", "Freitag", "Samstag",
];
const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

// ── Draggable Event ─────────────────────────────────────────────────────────

function DraggableDayEvent({
  ev,
  top,
  height,
  width,
  left,
  color,
  startLabel,
  endLabel,
  showTime,
  showEndTime,
  showLocation,
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
  endLabel: string;
  showTime: boolean;
  showEndTime: boolean;
  showLocation: boolean;
  onEventClick: (event: CalendarEvent, rect: DOMRect) => void;
  onEventResize: (event: CalendarEvent, newEnd: Date) => void;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `day-event-${ev.uid}-${ev.recurrence_id ?? ev.start}`,
    data: { event: ev, source: 'day' },
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
      const rawMinutes = rawHeight / DAY_PX_PER_MINUTE;
      const snappedMinutes = Math.max(
        RESIZE_SNAP_MINUTES,
        Math.round(rawMinutes / RESIZE_SNAP_MINUTES) * RESIZE_SNAP_MINUTES
      );
      return snappedMinutes;
    };

    const onMove = (me: PointerEvent) => {
      const deltaY = me.clientY - resizeStartY.current;
      const snappedMinutes = snap(resizeBaseHeight.current + deltaY);
      setResizeHeight(Math.max(snappedMinutes * DAY_PX_PER_MINUTE, MIN_EVENT_HEIGHT));
    };
    const onUp = (ue: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const deltaY = ue.clientY - resizeStartY.current;
      const snappedMinutes = snap(resizeBaseHeight.current + deltaY);
      setResizeHeight(null);
      const baseMinutes = resizeBaseHeight.current / DAY_PX_PER_MINUTE;
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
      className={`day-event${isDragging ? " day-event--dragging" : ""}${resizeHeight !== null ? " day-event--resizing" : ""}`}
      style={{
        top,
        height: displayHeight,
        width,
        left,
        "--event-color": color,
      } as CSSProperties}
      title={[ev.summary, ev.location].filter(Boolean).join(" · ")}
      onClick={(e) => {
        e.stopPropagation();
        onEventClick(ev, (e.currentTarget as HTMLElement).getBoundingClientRect());
      }}
    >
      {displayHeight < 28 ? (
        <div className="day-event-compact">
          <span className="day-event-compact-title">{ev.summary}</span>
        </div>
      ) : (
        <div className="day-event-inner">
          <div className="day-event-title">
            <span className="day-event-title-text">{ev.summary}</span>
            {ev.is_recurring && (
              <span className="recur-icon" title="Wiederholt sich" aria-label="Wiederholt sich">⟲</span>
            )}
          </div>
          {showTime && (
            <div className="day-event-time">
              {startLabel}
              {showEndTime ? ` – ${endLabel}` : ""}
            </div>
          )}
          {showLocation && (
            <div className="day-event-location">{ev.location}</div>
          )}
        </div>
      )}
      <div
        className="day-event-resize-handle"
        onPointerDown={handleResizeStart}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

// ── Droppable Events-Column ─────────────────────────────────────────────────

function DroppableEventsCol({
  currentDate,
  children,
  onDayClick,
}: {
  currentDate: Date;
  children: React.ReactNode;
  onDayClick: (date: Date) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `day-grid-${dateStr(currentDate)}`,
    data: { dateStr: dateStr(currentDate), target: 'day' },
  });

  return (
    <div
      ref={setNodeRef}
      className={`day-events-col${isOver ? " day-events-col--drop-over" : ""}`}
      onClick={() => onDayClick(currentDate)}
    >
      {children}
    </div>
  );
}

// ── Hauptkomponente ─────────────────────────────────────────────────────────

export default function DayView({
  currentDate,
  events,
  calendars,
  onEventClick,
  onDayClick,
  onEventResize,
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

  type LayoutEvent = CalendarEvent & { col: number; totalCols: number };

  const layoutEvents = (evs: CalendarEvent[]): LayoutEvent[] => {
    const sorted = [...evs].sort(
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
  };

  const laidOut = layoutEvents(timedEvents);
  const hours = Array.from({ length: TOTAL_HOURS }, (_, i) => i);

  const scrollInit = (el: HTMLDivElement | null) => {
    if (el) el.scrollTop = 8 * HOUR_HEIGHT - 16;
  };

  return (
    <div className="day-view">
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
                  style={{ "--event-color": cal?.color || "#888" } as CSSProperties}
                  onClick={(e) =>
                    onEventClick(ev, (e.currentTarget as HTMLElement).getBoundingClientRect())
                  }
                >
                  <span className="day-allday-event-text">{ev.summary}</span>
                  {ev.is_recurring && (
                    <span className="recur-icon" title="Wiederholt sich" aria-label="Wiederholt sich">⟲</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="day-body" ref={scrollInit}>
        <div className="day-grid" style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}>
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

          {isToday && (
            <div
              className="day-now-line"
              style={{ top: (toMinutes(today) / 60) * HOUR_HEIGHT }}
            />
          )}

          <DroppableEventsCol currentDate={currentDate} onDayClick={onDayClick}>
            {laidOut.map((ev) => {
              const evStart = parseLocalDate(ev.start);
              const evEnd = parseLocalDate(ev.end);
              const startMin = toMinutes(evStart);
              let endMin = toMinutes(evEnd);
              if (endMin <= startMin) endMin = startMin + 30;

              const top = (startMin / 60) * HOUR_HEIGHT;
              const height = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, MIN_EVENT_HEIGHT);

              const colGap = 3;
              const width = `calc((100% - ${colGap}px) / ${ev.totalCols} - ${colGap}px)`;
              const left = `calc(${ev.col} * (100% - ${colGap}px) / ${ev.totalCols} + ${colGap}px)`;

              const cal = calMap[ev.calendar_id];
              const color = cal?.color || "#888";
              const startLabel = `${padTwo(evStart.getHours())}:${padTwo(evStart.getMinutes())}`;
              const endLabel = `${padTwo(evEnd.getHours())}:${padTwo(evEnd.getMinutes())}`;

              const showTime = height >= 38;
              const showEndTime = height >= 52;
              const showLocation = ev.location != null && height >= 70;

              return (
                <DraggableDayEvent
                  key={ev.uid + ev.start}
                  ev={ev}
                  top={top}
                  height={height}
                  width={width}
                  left={left}
                  color={color}
                  startLabel={startLabel}
                  endLabel={endLabel}
                  showTime={showTime}
                  showEndTime={showEndTime}
                  showLocation={showLocation}
                  onEventClick={onEventClick}
                  onEventResize={onEventResize}
                />
              );
            })}
          </DroppableEventsCol>
        </div>
      </div>
    </div>
  );
}

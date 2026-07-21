import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { CalendarEvent, Calendar } from '../types';

interface Props {
  year: number;
  month: number; // 0-indexed
  events: CalendarEvent[];
  calendars: Calendar[];
  visibleCalendarIds: Set<string>;
  onEventClick: (event: CalendarEvent, e: React.MouseEvent) => void;
  onDayClick: (dateStr: string) => void;
  onMoreClick?: (dateStr: string) => void;
  onWeekClick?: (weekStart: Date) => void;
  onDayOpen?: (dateStr: string) => void;
}

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function getISOWeek(d: Date): number {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const week1 = new Date(date.getFullYear(), 0, 4);
  return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

function localDateStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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

function formatTime(iso: string): string {
  const d = parseLocalDate(iso);
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function addDays(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

interface DayEvent {
  ev: CalendarEvent;
  isStart: boolean;
  isEnd: boolean;
  isMultiDay: boolean;
}

// ── Draggable Event ─────────────────────────────────────────────────────────

function DraggableEvent({
  ev,
  dayKey,
  isStart,
  isEnd,
  isMultiDay,
  color,
  onClick,
}: {
  ev: CalendarEvent;
  dayKey: string;
  isStart: boolean;
  isEnd: boolean;
  isMultiDay: boolean;
  color: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `month-event-${ev.uid}-${dayKey}`,
    data: { event: ev, sourceDayKey: dayKey, source: 'month' },
  });

  const isBlock = ev.all_day || isMultiDay;

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={[
        'event-item',
        isBlock ? 'event-item--block' : '',
        isBlock && !isStart ? 'event-item--cont' : '',
        isBlock && !isEnd ? 'event-item--continues' : '',
        isDragging ? 'event-item--dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--event-color': color, cursor: 'grab' } as React.CSSProperties}
      title={ev.location ? `${ev.summary}\n${ev.location}` : ev.summary}
      onClick={onClick}
    >
      {!isBlock && (
        <span className="event-time">{formatTime(ev.start)}</span>
      )}
      <span className="event-title">
        {isStart || !isMultiDay ? ev.summary : ''}
      </span>
      {ev.is_recurring && (
        <span className="recur-icon" title="Wiederholt sich" aria-label="Wiederholt sich">⟲</span>
      )}
    </div>
  );
}

// ── Droppable Day Cell ──────────────────────────────────────────────────────

function DroppableDayCell({
  dateStr,
  current,
  isToday,
  dayNum,
  children,
  onDayClick,
  onDayOpen,
}: {
  dateStr: string;
  current: boolean;
  isToday: boolean;
  dayNum: number;
  children: React.ReactNode;
  onDayClick: (dateStr: string) => void;
  onDayOpen?: (dateStr: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `month-day-${dateStr}`,
    data: { dateStr, target: 'month' },
  });

  return (
    <div
      ref={setNodeRef}
      className={[
        'day-cell',
        current ? '' : 'day-cell--other',
        isToday ? 'day-cell--today' : '',
        isOver ? 'day-cell--drop-over' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={() => onDayClick(dateStr)}
    >
      <div className="day-cell-header">
        <span
          className={`day-number${onDayOpen ? ' day-number--clickable' : ''}`}
          onClick={(e) => {
            if (!onDayOpen) return;
            e.stopPropagation();
            onDayOpen(dateStr);
          }}
        >
          {dayNum}
        </span>
        <button
          className="day-add-btn"
          onClick={(e) => {
            e.stopPropagation();
            onDayClick(dateStr);
          }}
          title="Termin erstellen"
        >
          +
        </button>
      </div>
      {children}
    </div>
  );
}

// ── Hauptkomponente ─────────────────────────────────────────────────────────

export function MonthView({
  year,
  month,
  events,
  calendars,
  visibleCalendarIds,
  onEventClick,
  onDayClick,
  onMoreClick,
  onWeekClick,
  onDayOpen,
}: Props) {
  const today = new Date();

  const calendarMap = useMemo(
    () => new Map(calendars.map((c) => [c.id, c])),
    [calendars]
  );

  const cells = useMemo(() => {
    const firstDay = new Date(year, month, 1);
    const startOffset = (firstDay.getDay() + 6) % 7;
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

  const eventsByDate = useMemo(() => {
    const map = new Map<string, DayEvent[]>();

    for (const ev of events) {
      if (!visibleCalendarIds.has(ev.calendar_id)) continue;

      const startDate = parseLocalDate(ev.start);
      let endDate = parseLocalDate(ev.end);

      if (ev.all_day) {
        endDate = addDays(endDate, -1);
      }

      const startStr = localDateStr(startDate);
      const endStr = localDateStr(endDate);
      const isMultiDay = startStr !== endStr;

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

  const weeks = useMemo(() => {
    const result: Array<typeof cells> = [];
    for (let i = 0; i < cells.length; i += 7) {
      result.push(cells.slice(i, i + 7));
    }
    return result;
  }, [cells]);

  // Wie viele Termine passen tatsächlich in eine Tageszelle, bevor der
  // Browser sie per `overflow: hidden` kommentarlos abschneidet? Die
  // Zeilenhöhe schwankt (5 vs. 6 Wochen im Monat, Fensterhöhe), darum wird
  // hier live gemessen statt eine feste Zahl anzunehmen — sonst weicht die
  // "+X weitere"-Anzeige von dem ab, was tatsächlich sichtbar ist.
  const gridRef = useRef<HTMLDivElement>(null);
  const [maxFit, setMaxFit] = useState(6);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    function recompute() {
      const list = grid!.querySelector<HTMLElement>('.event-list');
      if (!list) return;
      const available = list.clientHeight;
      const item = list.querySelector<HTMLElement>('.event-item, .event-more');
      const itemHeight = item ? item.getBoundingClientRect().height : 19;
      const gap = 3; // muss mit `.event-list { gap: 3px }` in calendar.css übereinstimmen
      const slot = itemHeight + gap;
      if (slot <= 0 || available <= 0) return;
      setMaxFit(Math.max(1, Math.floor((available + gap) / slot)));
    }

    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [weeks]);

  return (
    <div className="month-view">
      <div className="month-header">
        <div className="month-kw-header">KW</div>
        {WEEKDAYS.map((d) => (
          <div key={d} className="month-weekday">
            {d}
          </div>
        ))}
      </div>

      <div className="month-grid" ref={gridRef}>
        {weeks.map((week, wi) => {
          const kw = getISOWeek(week[0].date);
          const weekStart = week[0].date;
          return (
            <React.Fragment key={wi}>
              <div
                className={`month-kw${onWeekClick ? ' month-kw--clickable' : ''}`}
                onClick={() => onWeekClick?.(weekStart)}
              >
                {kw}
              </div>
              {week.map(({ date, current }, i) => {
          const key = localDateStr(date);
          const dayEvents = eventsByDate.get(key) ?? [];
          const overflow = dayEvents.length > maxFit;
          // Bei Überlauf eine Zeile für den "+X weitere"-Link freihalten,
          // sonst würde der Link selbst wieder abgeschnitten.
          const visibleCount = overflow ? Math.max(1, maxFit - 1) : dayEvents.length;

          return (
            <DroppableDayCell
              key={i}
              dateStr={key}
              current={current}
              isToday={isToday(date)}
              dayNum={date.getDate()}
              onDayClick={onDayClick}
              onDayOpen={onDayOpen}
            >
              <div className="event-list">
                {dayEvents.slice(0, visibleCount).map(({ ev, isStart, isEnd, isMultiDay }) => {
                  const cal = calendarMap.get(ev.calendar_id);
                  const color = cal?.color ?? '#888';
                  return (
                    <DraggableEvent
                      key={ev.uid + key}
                      ev={ev}
                      dayKey={key}
                      isStart={isStart}
                      isEnd={isEnd}
                      isMultiDay={isMultiDay}
                      color={color}
                      onClick={(e) => onEventClick(ev, e)}
                    />
                  );
                })}
                {overflow && (
                  <div
                    className="event-more event-more--clickable"
                    onClick={(e) => {
                      e.stopPropagation();
                      onMoreClick?.(key);
                    }}
                  >
                    +{dayEvents.length - visibleCount} weitere
                  </div>
                )}
              </div>
            </DroppableDayCell>
          );
        })}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

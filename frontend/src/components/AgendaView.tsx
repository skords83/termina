import { useMemo } from "react";
import { CalendarEvent, Calendar } from "../types/index";

interface AgendaViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onEventClick: (event: CalendarEvent, rect: DOMRect) => void;
}

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

function formatDate(date: Date): string {
  const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  const MONTHS = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
  ];
  return `${WEEKDAYS[date.getDay()]}, ${date.getDate()}. ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function formatTime(str: string): string {
  const d = parseLocalDate(str);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const LOOKAHEAD_DAYS = 60;

export default function AgendaView({
  currentDate,
  events,
  calendars,
  onEventClick,
}: AgendaViewProps) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const calMap = useMemo(() => {
    const m: Record<string, Calendar> = {};
    calendars.forEach((c) => (m[c.id] = c));
    return m;
  }, [calendars]);

  // Build list of days from currentDate for LOOKAHEAD_DAYS
  const startDate = new Date(currentDate);
  startDate.setHours(0, 0, 0, 0);

  const grouped = useMemo(() => {
    const days: { date: Date; events: CalendarEvent[] }[] = [];

    for (let i = 0; i < LOOKAHEAD_DAYS; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);

      const seen = new Set<string>();
      const dayEvents = events
        .filter((ev) => {
          const s = parseLocalDate(ev.start);
          let matches = false;
          if (ev.all_day) {
            const end = parseLocalDate(ev.end);
            matches = s <= d && d < end;
          } else {
            matches = sameDay(s, d);
          }
          if (!matches) return false;
          if (seen.has(ev.uid)) return false;
          seen.add(ev.uid);
          return true;
        })
        .sort((a, b) => {
          if (a.all_day && !b.all_day) return -1;
          if (!a.all_day && b.all_day) return 1;
          return parseLocalDate(a.start).getTime() - parseLocalDate(b.start).getTime();
        });

      if (dayEvents.length > 0) {
        days.push({ date: d, events: dayEvents });
      }
    }
    return days;
  }, [events, startDate.getTime()]);

  if (grouped.length === 0) {
    return (
      <div className="agenda-empty">
        <div className="agenda-empty-icon">📅</div>
        <div className="agenda-empty-text">Keine Termine in den nächsten {LOOKAHEAD_DAYS} Tagen.</div>
      </div>
    );
  }

  return (
    <div className="agenda-view">
      {grouped.map(({ date, events: dayEvents }) => {
        const isToday = sameDay(date, today);
        return (
          <div key={date.toISOString()} className="agenda-day-group">
            <div className={`agenda-day-header${isToday ? " today" : ""}`}>
              {isToday ? "Heute – " : ""}
              {formatDate(date)}
            </div>
            <div className="agenda-events">
              {dayEvents.map((ev) => {
                const cal = calMap[ev.calendar_id];
                const color = cal?.color || "#888";
                return (
                  <div
                    key={ev.uid}
                    className="agenda-event"
                    onClick={(e) =>
                      onEventClick(ev, (e.currentTarget as HTMLElement).getBoundingClientRect())
                    }
                  >
                    <div
                      className="agenda-event-color"
                      style={{ background: color }}
                    />
                    <div className="agenda-event-body">
                      <div className="agenda-event-title">{ev.summary}</div>
                      {!ev.all_day && (
                        <div className="agenda-event-time">
                          {formatTime(ev.start)}
                          {ev.end ? ` – ${formatTime(ev.end)}` : ""}
                        </div>
                      )}
                      {ev.all_day && (
                        <div className="agenda-event-time">Ganztägig</div>
                      )}
                      {ev.location && (
                        <div className="agenda-event-location">📍 {ev.location}</div>
                      )}
                    </div>
                    <div className="agenda-event-cal">{cal?.name || ""}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
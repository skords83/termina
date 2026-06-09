import { useMemo, useState } from 'react';
import { useStore } from './store';
import { useCalendars } from './hooks/useCalendars';
import { useEvents } from './hooks/useEvents';
import { LoginForm } from './components/LoginForm';
import { Sidebar } from './components/Sidebar';
import { MonthView } from './components/MonthView';
import { EventPopup } from './components/EventPopup';
import { CalendarEvent } from './types';

const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

export default function App() {
  const { token, setToken, clearToken, activeMonth, setActiveMonth, hiddenCalendars, isCalendarVisible } =
    useStore();

  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

  const { calendars } = useCalendars(token);
  const current = useMemo(() => new Date(activeMonth + 'T00:00:00'), [activeMonth]);

  // Fetch window: full month + 1 week padding on each side
  const { from, to } = useMemo(() => {
    const year = current.getFullYear();
    const month = current.getMonth();
    const from = new Date(year, month - 1, 20).toISOString();
    const to = new Date(year, month + 1, 10).toISOString();
    return { from, to };
  }, [current]);

  const { events, loading: eventsLoading } = useEvents(token, from, to);

  const visibleCalendarIds = useMemo(
    () => new Set(calendars.filter((c) => isCalendarVisible(c.id)).map((c) => c.id)),
    [calendars, hiddenCalendars]
  );

  function toMonthString(year: number, month: number): string {
    return `${year}-${String(month + 1).padStart(2, '0')}-01`;
  }

  function prevMonth() {
    setActiveMonth(toMonthString(current.getFullYear(), current.getMonth() - 1));
  }

  function nextMonth() {
    setActiveMonth(toMonthString(current.getFullYear(), current.getMonth() + 1));
  }

  function goToday() {
    const d = new Date();
    setActiveMonth(toMonthString(d.getFullYear(), d.getMonth()));
  }

  if (!token) {
    return <LoginForm onSuccess={setToken} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <div className="app-logo">
            <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="var(--accent)" />
              <path
                d="M8 16C8 11.582 11.582 8 16 8C20.418 8 24 11.582 24 16V22H8V16Z"
                fill="white"
                fillOpacity="0.9"
              />
              <rect x="11" y="14" width="2" height="5" rx="1" fill="var(--accent)" />
              <rect x="15" y="12" width="2" height="7" rx="1" fill="var(--accent)" />
              <rect x="19" y="15" width="2" height="4" rx="1" fill="var(--accent)" />
            </svg>
            <span className="app-name">Termina</span>
          </div>
        </div>

        <div className="topbar-center">
          <button className="nav-btn nav-btn--lg" onClick={prevMonth}>‹</button>
          <h1 className="month-title">
            {MONTHS[current.getMonth()]} {current.getFullYear()}
          </h1>
          <button className="nav-btn nav-btn--lg" onClick={nextMonth}>›</button>
          <button className="today-btn" onClick={goToday}>Heute</button>
        </div>

        <div className="topbar-right">
          {eventsLoading && <span className="sync-indicator" title="Lädt…" />}
          <button
            className="logout-btn"
            onClick={clearToken}
            title="Abmelden"
          >
            ⎋
          </button>
        </div>
      </header>

      <div className="main">
        <Sidebar calendars={calendars} />
        <main className="content">
          <MonthView
            year={current.getFullYear()}
            month={current.getMonth()}
            events={events}
            calendars={calendars}
            visibleCalendarIds={visibleCalendarIds}
            onEventClick={setSelectedEvent}
          />
        </main>
      </div>

      {selectedEvent && (
        <EventPopup
          event={selectedEvent}
          calendar={calendars.find((c) => c.id === selectedEvent.calendar_id)}
          onClose={() => setSelectedEvent(null)}
        />
      )}
    </div>
  );
}

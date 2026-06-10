import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { useCalendars } from './hooks/useCalendars';
import { useEvents } from './hooks/useEvents';
import { LoginForm } from './components/LoginForm';
import { Sidebar } from './components/Sidebar';
import { MonthView } from './components/MonthView';
import { EventPopup } from './components/EventPopup';
import { EventFormModal } from './components/EventFormModal';
import { useOptimisticStore, useMergedEvents } from './store/eventsSlice';
import { CalendarEvent } from './types';
import WeekView from './components/WeekView';
import DayView from './components/DayView';
import AgendaView from './components/AgendaView';
import SearchModal from './components/SearchModal';
import NaturalInputBar from './components/NaturalInputBar';
import { createEvent } from './api/write';

const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

function getWeekStart(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  const day = r.getDay();
  r.setDate(r.getDate() - (day === 0 ? 6 : day - 1));
  return r;
}

function getWeekEnd(d: Date): Date {
  const r = getWeekStart(d);
  r.setDate(r.getDate() + 6);
  r.setHours(23, 59, 59, 0);
  return r;
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatNavTitle(view: 'month' | 'week' | 'day' | 'agenda', current: Date): string {
  if (view === 'month') {
    return `${MONTHS[current.getMonth()]} ${current.getFullYear()}`;
  }
  if (view === 'week') {
    const ws = getWeekStart(current);
    const we = getWeekEnd(current);
    if (ws.getMonth() === we.getMonth()) {
      return `${ws.getDate()}. – ${we.getDate()}. ${MONTHS[ws.getMonth()]} ${ws.getFullYear()}`;
    }
    return `${ws.getDate()}. ${MONTHS[ws.getMonth()]} – ${we.getDate()}. ${MONTHS[we.getMonth()]} ${we.getFullYear()}`;
  }
  if (view === 'day') {
    const WDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    return `${WDAYS[current.getDay()]}, ${current.getDate()}. ${MONTHS[current.getMonth()]} ${current.getFullYear()}`;
  }
  // agenda
  return `Ab ${current.getDate()}. ${MONTHS[current.getMonth()]} ${current.getFullYear()}`;
}

export default function App() {
  const { token, setToken, clearToken, activeMonth, setActiveMonth, hiddenCalendars, isCalendarVisible } =
    useStore();

  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [anchorPos, setAnchorPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [editModal, setEditModal] = useState<CalendarEvent | null>(null);
  const [createModal, setCreateModal] = useState<{ defaultDate: string } | null>(null);
  const [view, setView] = useState<'month' | 'week' | 'day' | 'agenda'>('month');
  const [showSearch, setShowSearch] = useState(false);
  const [showNatural, setShowNatural] = useState(false);

  // currentDate tracks the "anchor" date for all views
  const [currentDate, setCurrentDate] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });

  // Keep activeMonth (used by Sidebar mini-cal) in sync with currentDate
  useEffect(() => {
    const str = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-01`;
    setActiveMonth(str);
  }, [currentDate]);

  const optimistic = useOptimisticStore();

  // Unified event-click handler: accepts DOMRect (from new views) or MouseEvent (MonthView)
  function handleEventClick(ev: CalendarEvent, rectOrMouse: DOMRect | React.MouseEvent) {
    let x: number, y: number;
    if (rectOrMouse instanceof DOMRect) {
      x = rectOrMouse.left + rectOrMouse.width / 2;
      y = rectOrMouse.top;
    } else {
      (rectOrMouse as React.MouseEvent).stopPropagation();
      x = (rectOrMouse as React.MouseEvent).clientX;
      y = (rectOrMouse as React.MouseEvent).clientY;
    }
    setAnchorPos({ x, y });
    setSelectedEvent(ev);
  }

  // MonthView still uses the old signature — thin wrapper
  function handleEventClickMouse(ev: CalendarEvent, e: React.MouseEvent) {
    handleEventClick(ev, e);
  }

  const { calendars } = useCalendars(token);

  // Sync currentDate ↔ activeMonth when activeMonth changes externally (sidebar mini-cal)
  const activeMonthDate = useMemo(() => new Date(activeMonth + 'T00:00:00'), [activeMonth]);
  useEffect(() => {
    if (
      activeMonthDate.getFullYear() !== currentDate.getFullYear() ||
      activeMonthDate.getMonth() !== currentDate.getMonth()
    ) {
      const d = new Date(activeMonthDate);
      d.setHours(0, 0, 0, 0);
      setCurrentDate(d);
    }
  }, [activeMonth]);

  // Fetch window adapted per view
  const { from, to } = useMemo(() => {
    if (view === 'week') {
      const ws = getWeekStart(currentDate);
      const we = getWeekEnd(currentDate);
      // +/- 1 day padding
      const f = new Date(ws); f.setDate(f.getDate() - 1);
      const t = new Date(we); t.setDate(t.getDate() + 1);
      return { from: f.toISOString(), to: t.toISOString() };
    }
    if (view === 'day') {
      const f = new Date(currentDate); f.setDate(f.getDate() - 1);
      const t = new Date(currentDate); t.setDate(t.getDate() + 2);
      return { from: f.toISOString(), to: t.toISOString() };
    }
    if (view === 'agenda') {
      const f = new Date(currentDate); f.setDate(f.getDate() - 1);
      const t = new Date(currentDate); t.setDate(t.getDate() + 62);
      return { from: f.toISOString(), to: t.toISOString() };
    }
    // month (default) + padding
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const f = new Date(year, month - 1, 20).toISOString();
    const t = new Date(year, month + 1, 10).toISOString();
    return { from: f, to: t };
  }, [view, currentDate]);

  const { events: serverEvents, loading: eventsLoading } = useEvents(token, from, to);
  const events = useMergedEvents(serverEvents);

  const visibleCalendarIds = useMemo(
    () => new Set(calendars.filter((c) => isCalendarVisible(c.id)).map((c) => c.id)),
    [calendars, hiddenCalendars]
  );

  const visibleCalendars = useMemo(
    () => calendars.filter((c) => isCalendarVisible(c.id)),
    [calendars, hiddenCalendars]
  );

  const visibleEvents = useMemo(
    () => events.filter((e) => visibleCalendarIds.has(e.calendar_id)),
    [events, visibleCalendarIds]
  );

  // Navigation — view-aware
  function navigate(dir: 1 | -1) {
    setCurrentDate((prev) => {
      const d = new Date(prev);
      if (view === 'month') {
        d.setMonth(d.getMonth() + dir);
      } else if (view === 'week') {
        d.setDate(d.getDate() + 7 * dir);
      } else if (view === 'day') {
        d.setDate(d.getDate() + dir);
      } else if (view === 'agenda') {
        d.setDate(d.getDate() + 30 * dir);
      }
      return d;
    });
  }

  function goToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    setCurrentDate(d);
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowSearch(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        setShowNatural(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

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
          <button className="nav-btn nav-btn--lg" onClick={() => navigate(-1)}>‹</button>
          <h1 className="month-title">
            {formatNavTitle(view, currentDate)}
          </h1>
          <button className="nav-btn nav-btn--lg" onClick={() => navigate(1)}>›</button>
          <button className="today-btn" onClick={goToday}>Heute</button>
        </div>

        <div className="topbar-right">
          <button
            className="toolbar-btn"
            onClick={() => setShowSearch(true)}
            title="Suche (⌘K)"
          >
            ⌕
          </button>
          <button
            className="toolbar-btn"
            onClick={() => setShowNatural(true)}
            title="Termin in Fließtext eingeben (⌘N)"
          >
            ✎
          </button>
          <div className="view-switcher">
            {(['month', 'week', 'day', 'agenda'] as const).map((v) => (
              <button
                key={v}
                className={['view-btn', view === v ? 'view-btn--active' : ''].filter(Boolean).join(' ')}
                onClick={() => setView(v)}
              >
                {{ month: 'Monat', week: 'Woche', day: 'Tag', agenda: 'Agenda' }[v]}
              </button>
            ))}
          </div>
          {eventsLoading && <span className="sync-indicator" title="Lädt…" />}
          <button className="logout-btn" onClick={clearToken} title="Abmelden">⎋</button>
        </div>
      </header>

      <div className="main">
        <Sidebar calendars={calendars} />
        <main className="content">
          {view === 'month' && (
            <MonthView
              year={currentDate.getFullYear()}
              month={currentDate.getMonth()}
              events={visibleEvents}
              calendars={visibleCalendars}
              visibleCalendarIds={visibleCalendarIds}
              onEventClick={handleEventClickMouse}
              onDayClick={(dateStr) => setCreateModal({ defaultDate: dateStr })}
            />
          )}
          {view === 'week' && (
            <WeekView
              currentDate={currentDate}
              events={visibleEvents}
              calendars={visibleCalendars}
              onEventClick={(ev, rect) => handleEventClick(ev, rect)}
              onDayClick={(date) => {
                setCurrentDate(date);
                setView('day');
              }}
            />
          )}
          {view === 'day' && (
            <DayView
              currentDate={currentDate}
              events={visibleEvents}
              calendars={visibleCalendars}
              onEventClick={(ev, rect) => handleEventClick(ev, rect)}
              onDayClick={(date) => setCreateModal({ defaultDate: toDateStr(date) })}
            />
          )}
          {view === 'agenda' && (
            <AgendaView
              currentDate={currentDate}
              events={visibleEvents}
              calendars={visibleCalendars}
              onEventClick={(ev, rect) => handleEventClick(ev, rect)}
            />
          )}
        </main>
      </div>

      {selectedEvent && (
        <EventPopup
          event={selectedEvent}
          calendarColor={calendars.find((c) => c.id === selectedEvent.calendar_id)?.color ?? '#888'}
          calendarName={calendars.find((c) => c.id === selectedEvent.calendar_id)?.name ?? ''}
          anchorPos={anchorPos}
          onClose={() => setSelectedEvent(null)}
          onEdit={(ev) => { setSelectedEvent(null); setEditModal(ev); }}
          onDeleted={(uid) => {
            optimistic.deleteOptimistic(uid);
            setTimeout(() => optimistic.clearAll(), 6000);
          }}
        />
      )}

      {createModal && (
        <EventFormModal
          mode="create"
          calendars={calendars}
          defaultDate={createModal.defaultDate}
          onClose={() => setCreateModal(null)}
          onSaved={(_uid, ev) => {
            optimistic.addOptimistic(ev);
            setTimeout(() => optimistic.clearAll(), 6000);
          }}
        />
      )}

      {editModal && (
        <EventFormModal
          mode="edit"
          calendars={calendars}
          event={editModal}
          onClose={() => setEditModal(null)}
          onSaved={(_uid, ev) => {
            optimistic.updateOptimistic(ev);
            setTimeout(() => optimistic.clearAll(), 6000);
          }}
        />
      )}

      {showSearch && (
        <SearchModal
          events={visibleEvents}
          calendars={calendars}
          onClose={() => setShowSearch(false)}
          onEventClick={(ev, rect) => {
            setShowSearch(false);
            handleEventClick(ev, rect);
          }}
        />
      )}

      {showNatural && (
        <NaturalInputBar
          calendars={calendars}
          defaultCalendarId={calendars.find((c) => c.name === 'Persönlich')?.id}
          onConfirm={async (parsed) => {
            const { uid } = await createEvent({
              calendar_id: parsed.calendar_id,
              summary: parsed.summary,
              start: parsed.start,
              end: parsed.end,
              all_day: parsed.all_day,
              location: parsed.location,
            });
            optimistic.addOptimistic({
              uid,
              calendar_id: parsed.calendar_id,
              summary: parsed.summary,
              start: parsed.start,
              end: parsed.end,
              all_day: parsed.all_day,
              location: parsed.location ?? undefined,
              etag: null,
              description: null,
            });
            setTimeout(() => optimistic.clearAll(), 6000);
          }}
          onClose={() => setShowNatural(false)}
        />
      )}
    </div>
  );
}
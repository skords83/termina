import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  pointerWithin,
} from '@dnd-kit/core';
import { useStore } from './store';
import { useCalendars } from './hooks/useCalendars';
import { useEvents } from './hooks/useEvents';
import { LoginForm } from './components/LoginForm';
import { Sidebar } from './components/Sidebar';
import { MonthView } from './components/MonthView';
import { EventPopup } from './components/EventPopup';
import { EventFormModal } from './components/EventFormModal';
import { RecurringMoveDialog } from './components/RecurringMoveDialog';
import { useOptimisticStore, useMergedEvents } from './store/eventsSlice';
import { CalendarEvent, MoveMode } from './types';
import WeekView from './components/WeekView';
import DayView from './components/DayView';
import AgendaView from './components/AgendaView';
import SearchModal from './components/SearchModal';
import { NaturalInputBar } from './components/NaturalInputBar';
import { createEvent, moveEvent } from './api/write';

const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

const WEEK_PX_PER_MINUTE = 56 / 60;
const DAY_PX_PER_MINUTE = 64 / 60;
const SNAP_MINUTES = 15;

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

function toIsoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day}T${h}:${mi}:${s}`;
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
  return `Ab ${current.getDate()}. ${MONTHS[current.getMonth()]} ${current.getFullYear()}`;
}

interface PendingMove {
  event: CalendarEvent;
  newStart: Date;
  newEnd: Date;
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

  // DnD-State
  const [activeDrag, setActiveDrag] = useState<CalendarEvent | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);

  const [currentDate, setCurrentDate] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });

  useEffect(() => {
    const str = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-01`;
    setActiveMonth(str);
  }, [currentDate]);

  const optimistic = useOptimisticStore();

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

  function handleEventClickMouse(ev: CalendarEvent, e: React.MouseEvent) {
    handleEventClick(ev, e);
  }

  const { calendars } = useCalendars(token);

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

  const { from, to } = useMemo(() => {
    function localDateStr(d: Date): string {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}T00:00:00`;
    }
    function localDateStrEnd(d: Date): string {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}T23:59:59`;
    }
    if (view === 'week') {
      const ws = getWeekStart(currentDate);
      const we = getWeekEnd(currentDate);
      const f = new Date(ws); f.setDate(f.getDate() - 1);
      const t = new Date(we); t.setDate(t.getDate() + 1);
      return { from: localDateStr(f), to: localDateStrEnd(t) };
    }
    if (view === 'day') {
      const f = new Date(currentDate); f.setDate(f.getDate() - 1);
      const t = new Date(currentDate); t.setDate(t.getDate() + 1);
      return { from: localDateStr(f), to: localDateStrEnd(t) };
    }
    if (view === 'agenda') {
      const f = new Date(currentDate); f.setDate(f.getDate() - 1);
      const t = new Date(currentDate); t.setDate(t.getDate() + 62);
      return { from: localDateStr(f), to: localDateStrEnd(t) };
    }
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    return {
      from: localDateStr(new Date(year, month - 1, 20)),
      to: localDateStrEnd(new Date(year, month + 1, 10)),
    };
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

  // ── DnD ───────────────────────────────────────────────────────────────────

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
  );

  function snap(n: number, step: number): number {
    return Math.round(n / step) * step;
  }

  function computeNewTimes(
    ev: CalendarEvent,
    source: 'month' | 'week' | 'day',
    targetDateStr: string,
    sourceDayKey: string | undefined,
    deltaY: number
  ): { newStart: Date; newEnd: Date } | null {
    const origStart = parseLocalDate(ev.start);
    const origEnd = parseLocalDate(ev.end);
    const duration = origEnd.getTime() - origStart.getTime();
    const targetDate = parseLocalDate(targetDateStr);

    if (source === 'month') {
      const srcKey = sourceDayKey ?? toDateStr(origStart);
      const sourceDay = parseLocalDate(srcKey);
      const dayDelta = Math.round((targetDate.getTime() - sourceDay.getTime()) / 86400000);
      if (dayDelta === 0) return null;
      const newStart = new Date(origStart);
      newStart.setDate(newStart.getDate() + dayDelta);
      const newEnd = new Date(newStart.getTime() + duration);
      return { newStart, newEnd };
    }

    // week or day
    const pxPerMinute = source === 'week' ? WEEK_PX_PER_MINUTE : DAY_PX_PER_MINUTE;
    const rawMinuteDelta = deltaY / pxPerMinute;
    const minuteDelta = snap(rawMinuteDelta, SNAP_MINUTES);

    // Day delta (only meaningful for week view)
    let dayDelta = 0;
    if (source === 'week') {
      const sourceDay = new Date(origStart);
      sourceDay.setHours(0, 0, 0, 0);
      dayDelta = Math.round((targetDate.getTime() - sourceDay.getTime()) / 86400000);
    }

    if (dayDelta === 0 && minuteDelta === 0) return null;

    const newStart = new Date(origStart);
    newStart.setDate(newStart.getDate() + dayDelta);
    newStart.setMinutes(newStart.getMinutes() + minuteDelta);
    const newEnd = new Date(newStart.getTime() + duration);
    return { newStart, newEnd };
  }

  function handleDragStart(e: DragStartEvent) {
    const ev = e.active.data.current?.event as CalendarEvent | undefined;
    setActiveDrag(ev ?? null);
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveDrag(null);
    const { active, over, delta } = e;
    if (!over) return;

    const ev = active.data.current?.event as CalendarEvent | undefined;
    if (!ev) return;
    if (!ev.etag) {
      console.warn('Event hat kein ETag — nicht verschiebbar', ev);
      return;
    }

    const source = active.data.current?.source as 'month' | 'week' | 'day';
    const targetData = over.data.current as { dateStr?: string; target?: string } | undefined;
    if (!targetData?.dateStr) return;

    const sourceDayKey = active.data.current?.sourceDayKey as string | undefined;

    const times = computeNewTimes(ev, source, targetData.dateStr, sourceDayKey, delta.y);
    if (!times) return;

    if (ev.is_recurring) {
      setPendingMove({ event: ev, newStart: times.newStart, newEnd: times.newEnd });
    } else {
      executeMove(ev, 'all', times.newStart, times.newEnd);
    }
  }

  async function executeMove(
    ev: CalendarEvent,
    mode: MoveMode,
    newStart: Date,
    newEnd: Date
  ) {
    const newStartIso = toIsoLocal(newStart);
    const newEndIso = toIsoLocal(newEnd);

    // Optimistic update für nicht-rekurrente / "all"-Verschiebungen
    if (!ev.is_recurring || mode === 'all') {
      optimistic.updateOptimistic({
        ...ev,
        start: newStartIso,
        end: newEndIso,
      });
    }
    // Für single/future: kein optimistic update, da das Event seine UID/Identität
    // möglicherweise ändert (future) oder neue Instanz entsteht.

    try {
      await moveEvent(ev.uid, {
        mode,
        etag: ev.etag!,
        original_start: ev.start,
        new_start: newStartIso,
        new_end: newEndIso,
        recurrence_id: ev.recurrence_id ?? null,
      });
      setTimeout(() => optimistic.clearAll(), 6000);
    } catch (err: any) {
      optimistic.clearAll();
      if (err?.type === 'conflict') {
        alert('Konflikt: Termin wurde extern geändert. Bitte neu laden.');
      } else if (err?.type === 'nextcloud_down') {
        alert('Nextcloud nicht erreichbar.');
      } else if (err?.type === 'bad_request') {
        alert(`Ungültige Anfrage: ${err.message}`);
      } else {
        alert('Verschieben fehlgeschlagen.');
      }
      console.error('moveEvent failed', err);
    }
  }

  function handleRecurringChoice(mode: MoveMode) {
    if (!pendingMove) return;
    const { event, newStart, newEnd } = pendingMove;
    setPendingMove(null);
    executeMove(event, mode, newStart, newEnd);
  }

  if (!token) {
    return <LoginForm onSuccess={setToken} />;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDrag(null)}
    >
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
            <h1 className="month-title">{formatNavTitle(view, currentDate)}</h1>
            <button className="nav-btn nav-btn--lg" onClick={() => navigate(1)}>›</button>
            <button className="today-btn" onClick={goToday}>Heute</button>
          </div>

          <div className="topbar-right">
            <button className="toolbar-btn" onClick={() => setShowSearch(true)} title="Suche (⌘K)">⌕</button>
            <button className="toolbar-btn" onClick={() => setShowNatural(true)} title="Termin in Fließtext eingeben (⌘N)">✎</button>
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
                onMoreClick={(dateStr) => {
                  setCurrentDate(new Date(dateStr + 'T00:00:00'));
                  setView('day');
                }}
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
            onConfirm={async (parsed: import('./utils/naturalParser').ParsedEvent & { calendar_id: string }) => {
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

        {pendingMove && (
          <RecurringMoveDialog
            summary={pendingMove.event.summary}
            onChoose={handleRecurringChoice}
            onCancel={() => setPendingMove(null)}
          />
        )}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeDrag ? (
          <div className="drag-overlay">
            <span
              className="drag-overlay-dot"
              style={{
                background:
                  calendars.find((c) => c.id === activeDrag.calendar_id)?.color ?? '#888',
              }}
            />
            <span className="drag-overlay-title">{activeDrag.summary}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

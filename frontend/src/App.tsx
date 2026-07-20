import { useEffect, useMemo, useRef, useState } from 'react';
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
import { ChangePasswordForm } from './components/ChangePasswordForm';
import AdminUsersPage from './components/AdminUsersPage';
import { Sidebar } from './components/Sidebar';
import { MonthView } from './components/MonthView';
import { EventPopup } from './components/EventPopup';
import { EventFormModal } from './components/EventFormModal';
import { RecurringMoveDialog } from './components/RecurringMoveDialog';
import { useOptimisticStore, useMergedEvents } from './store/eventsSlice';
import { useHistoryStore } from './store/historySlice';
import { useWindowFocusGuard } from './hooks/useWindowFocusGuard';
import { CalendarEvent, MoveMode } from './types';
import WeekView from './components/WeekView';
import DayView from './components/DayView';
import AgendaView from './components/AgendaView';
import SearchModal from './components/SearchModal';
import ImportExportModal from './components/ImportExportModal';
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
  const { user, setUser, clearUser, activeMonth, setActiveMonth, hiddenCalendars, isCalendarVisible } =
    useStore();

  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then(setUser)
      .catch(() => clearUser())
      .finally(() => setAuthLoading(false));
  }, []);

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } finally {
      clearUser();
    }
  }

  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [anchorPos, setAnchorPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [editModal, setEditModal] = useState<CalendarEvent | null>(null);
  const [createModal, setCreateModal] = useState<{ defaultDate: string } | null>(null);
  const [view, setView] = useState<'month' | 'week' | 'day' | 'agenda'>('month');
  const [showSearch, setShowSearch] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showImportExport, setShowImportExport] = useState(false);
  const [showNatural, setShowNatural] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // DnD-State
  const [activeDrag, setActiveDrag] = useState<CalendarEvent | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);

  // Refetch-Trigger: bumpen nach erfolgreichen Schreib-Operationen
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [currentDate, setCurrentDate] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });

  // Aktualisiert currentDate automatisch um Mitternacht und nach Suspend/Resume
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;

    function scheduleNextMidnight() {
      const now = new Date();
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const msUntilMidnight = tomorrow.getTime() - now.getTime();
      timeout = setTimeout(() => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        setCurrentDate(d);
        scheduleNextMidnight();
      }, msUntilMidnight);
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        setCurrentDate(prev => (prev.getTime() === today.getTime() ? prev : today));
        clearTimeout(timeout);
        scheduleNextMidnight();
      }
    }

    scheduleNextMidnight();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      clearTimeout(timeout);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Refs für Keyboard-Handler (stabile Referenz ohne Re-Register)
  const viewRef = useRef(view);
  viewRef.current = view;
  const currentDateRef = useRef(currentDate);
  currentDateRef.current = currentDate;

  useEffect(() => {
    const str = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-01`;
    setActiveMonth(str);
  }, [currentDate]);

  const optimistic = useOptimisticStore();
  const isFocusClick = useWindowFocusGuard();

  function handleEventClick(ev: CalendarEvent, rectOrMouse: DOMRect | React.MouseEvent) {
    if (isFocusClick()) return;
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

  const { calendars } = useCalendars(!!user);

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

  const { events: serverEvents, loading: eventsLoading } = useEvents(!!user, from, to, refreshNonce);
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

  async function handleSync() {
    if (syncing) return;
    setSyncing(true);
    try {
      await fetch('/api/sync', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Fehler ignorieren — Refetch trotzdem
    } finally {
      setTimeout(() => {
        setRefreshNonce((n) => n + 1);
        setSyncing(false);
      }, 800);
    }
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      const anyModalOpen = !!document.querySelector('.natural-overlay, .event-form-overlay, .search-overlay, .event-popup, .recurring-move-overlay, .modal-backdrop');

      // ⌘K → Suche (funktioniert auch aus Inputs)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowSearch(true);
        return;
      }
      // ⌘N → Natural Input (funktioniert auch aus Inputs)
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        setShowNatural(true);
        return;
      }

      // Ab hier: nur wenn kein Input fokussiert
      if (inInput) return;

      // Ab hier: nur wenn kein Modal offen
      if (anyModalOpen) return;

      // ⌘Z / Strg+Z → Undo, ⌘⇧Z / Strg+⇧Z → Redo
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const action = e.shiftKey ? useHistoryStore.getState().redo : useHistoryStore.getState().undo;
        action().then((didApply) => {
          if (didApply) {
            setTimeout(() => setRefreshNonce((n) => n + 1), 1000);
          }
        }).catch((err) => {
          console.error(err);
          alert('Rückgängig/Wiederholen fehlgeschlagen.');
        });
        return;
      }

      // Leertaste → NaturalInputBar
      if (e.key === ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setShowNatural(true);
        return;
      }

      // n → neues Event (EventFormModal, Datum = aktuell selektierter Tag)
      if (e.key === 'n') {
        const d = currentDateRef.current;
        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        setCreateModal({ defaultDate: dateStr });
        return;
      }

      // t → Heute
      if (e.key === 't') {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        setCurrentDate(d);
        return;
      }

      // ← / → → Navigation (Monat/Woche/Tag/Agenda)
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        setCurrentDate((prev) => {
          const d = new Date(prev);
          const v = viewRef.current;
          if (v === 'month') d.setMonth(d.getMonth() + dir);
          else if (v === 'week') d.setDate(d.getDate() + 7 * dir);
          else if (v === 'day') d.setDate(d.getDate() + dir);
          else if (v === 'agenda') d.setDate(d.getDate() + 30 * dir);
          return d;
        });
        return;
      }

      // 1/2/3/4 → View wechseln
      if (e.key === '1') { setView('month'); return; }
      if (e.key === '2') { setView('week'); return; }
      if (e.key === '3') { setView('day'); return; }
      if (e.key === '4') { setView('agenda'); return; }
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

    // Optimistic update nur für nicht-rekurrente Events.
    // Bei rekurrenten Events würde updateOptimistic (uid-gekeyt) alle anderen
    // Expansionen derselben Serie kaputt machen — daher warten wir auf den Refetch.
    if (!ev.is_recurring) {
      optimistic.updateOptimistic({
        ...ev,
        start: newStartIso,
        end: newEndIso,
      });
    }

    try {
      await moveEvent(ev.uid, {
        mode,
        etag: ev.etag!,
        original_start: ev.start,
        new_start: newStartIso,
        new_end: newEndIso,
        recurrence_id: ev.recurrence_id ?? null,
      });

      if (!ev.is_recurring) {
        useHistoryStore.getState().record({
          kind: 'move',
          uid: ev.uid,
          before: ev,
          after: { ...ev, start: newStartIso, end: newEndIso },
        });
      }

      // Backend hat geschrieben + run_sync als BackgroundTask gestartet.
      // Kurz warten, damit der Sync die DB aktualisiert hat, dann refetchen.
      // Der optimistische Override wird von useMergedEvents automatisch
      // aufgeräumt, sobald der Server das neue ETag liefert.
      setTimeout(() => {
        setRefreshNonce((n) => n + 1);
      }, 1000);
    } catch (err: any) {
      // Nur den fehlgeschlagenen Override zurücknehmen, nicht alles wegwerfen.
      if (!ev.is_recurring) {
        optimistic.rollbackUpdate(ev.uid);
      }
      if (err?.type === 'conflict') {
        alert('Konflikt: Termin wurde extern geändert. Bitte neu laden.');
      } else if (err?.type === 'caldav_down') {
        alert('CalDAV-Server nicht erreichbar.');
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

  if (authLoading) {
    return null;
  }

  if (!user) {
    return <LoginForm onSuccess={setUser} />;
  }

  if (user.must_change_password) {
    return <ChangePasswordForm user={user} onSuccess={setUser} onLogout={handleLogout} />;
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
            {/* Suche */}
            <button className="toolbar-btn" onClick={() => setShowSearch(true)} title="Suche (⌘K)">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                <circle cx="7" cy="7" r="4.5" />
                <line x1="10.5" y1="10.5" x2="14" y2="14" />
              </svg>
            </button>
            {/* Fließtext-Eingabe */}
            <button className="toolbar-btn" onClick={() => setShowNatural(true)} title="Termin in Fließtext eingeben (Leertaste)">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 12.5V10l7.5-7.5 2.5 2.5L4.5 12.5H2Z" />
                <line x1="9" y1="4" x2="12" y2="7" />
              </svg>
            </button>
            {/* Import/Export */}
            <button className="toolbar-btn" onClick={() => setShowImportExport(true)} title="Import &amp; Export (.ics)">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2v8" />
                <path d="M4.5 6.5 8 10l3.5-3.5" />
                <path d="M2.5 12.5h11" />
              </svg>
            </button>
            {/* Manueller Sync */}
            <button
              className={`toolbar-btn${syncing ? ' toolbar-btn--spinning' : ''}`}
              onClick={handleSync}
              title="Sync mit CalDAV-Server"
              disabled={syncing}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13.5 8a5.5 5.5 0 1 1-1.1-3.3" />
                <polyline points="13.5 2 13.5 5.5 10 5.5" />
              </svg>
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
            {user.role === 'admin' && (
              <button className="logout-btn" onClick={() => setShowAdmin(true)} title="Nutzerverwaltung">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="6" cy="5" r="2.5" />
                  <path d="M1.5 14c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" />
                  <circle cx="11.5" cy="5.5" r="2" />
                  <path d="M10.5 10.2c1.9.3 3 1.5 3 3.8" />
                </svg>
              </button>
            )}
            <button className="logout-btn" onClick={handleLogout} title="Abmelden">⎋</button>
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
                onDayClick={(dateStr) => { if (!isFocusClick()) setCreateModal({ defaultDate: dateStr }); }}
                onMoreClick={(dateStr) => {
                  setCurrentDate(new Date(dateStr + 'T00:00:00'));
                  setView('day');
                }}
                onWeekClick={(weekStart) => {
                  if (isFocusClick()) return;
                  setCurrentDate(weekStart);
                  setView('week');
                }}
                onDayOpen={(dateStr) => {
                  if (isFocusClick()) return;
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
                  if (isFocusClick()) return;
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
                onDayClick={(date) => { if (!isFocusClick()) setCreateModal({ defaultDate: toDateStr(date) }); }}
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
            onDeleted={(uid, recurrenceId) => {
              if (recurrenceId) {
                setRefreshNonce((n) => n + 1);
              } else {
                if (selectedEvent && !selectedEvent.is_recurring) {
                  useHistoryStore.getState().record({
                    kind: 'delete',
                    uid,
                    before: selectedEvent,
                    after: null,
                  });
                }
                optimistic.deleteOptimistic(uid);
              }
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
              if (!ev.is_recurring) {
                useHistoryStore.getState().record({
                  kind: 'create',
                  uid: ev.uid,
                  before: null,
                  after: ev,
                });
              }
              optimistic.addOptimistic(ev);
              setRefreshNonce((n) => n + 1);
            }}
          />
        )}

        {editModal && (
          <EventFormModal
            mode="edit"
            calendars={calendars}
            event={editModal}
            onClose={() => setEditModal(null)}
            onSaved={(_uid, ev, scope) => {
              if (!editModal.is_recurring) {
                useHistoryStore.getState().record({
                  kind: 'update',
                  uid: ev.uid,
                  before: editModal,
                  after: ev,
                });
              }
              if (scope === 'future') {
                // 'future' spaltet die Serie server-seitig in ein neues Event auf
                // (neue uid) — ein lokales Merge auf die alte uid wäre falsch,
                // stattdessen nach kurzer Wartezeit (CalDAV-Sync) neu laden.
                setTimeout(() => setRefreshNonce((n) => n + 1), 1000);
              } else {
                optimistic.updateOptimistic(ev);
                setRefreshNonce((n) => n + 1);
              }
            }}
          />
        )}

        {showAdmin && (
          <AdminUsersPage calendars={calendars} onClose={() => setShowAdmin(false)} />
        )}

        {showImportExport && (
          <ImportExportModal
            calendars={calendars}
            onClose={() => setShowImportExport(false)}
            onImported={() => setTimeout(() => setRefreshNonce((n) => n + 1), 1000)}
          />
        )}

        {showSearch && (
          <SearchModal
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
              const naturalEvent: CalendarEvent = {
                uid,
                calendar_id: parsed.calendar_id,
                summary: parsed.summary,
                start: parsed.start,
                end: parsed.end,
                all_day: parsed.all_day,
                location: parsed.location ?? undefined,
                etag: null,
                description: null,
              };
              useHistoryStore.getState().record({
                kind: 'create',
                uid,
                before: null,
                after: naturalEvent,
              });
              optimistic.addOptimistic(naturalEvent);
              setRefreshNonce((n) => n + 1);
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
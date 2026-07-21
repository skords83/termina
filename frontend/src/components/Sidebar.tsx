import { useMemo } from 'react';
import { Calendar } from '../types';
import { useStore } from '../store';

interface Props {
  calendars: Calendar[];
  onImportExport: () => void;
  onSync: () => void;
  syncing: boolean;
  isAdmin: boolean;
  onShowAdmin: () => void;
  onLogout: () => void;
}

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

export function Sidebar({ calendars, onImportExport, onSync, syncing, isAdmin, onShowAdmin, onLogout }: Props) {
  const { activeMonth, setActiveMonth, toggleCalendar, isCalendarVisible } = useStore();

  const current = useMemo(() => new Date(activeMonth + 'T00:00:00'), [activeMonth]);
  const today = new Date();

  // Days grid for mini calendar
  const days = useMemo(() => {
    const year = current.getFullYear();
    const month = current.getMonth();
    const firstDay = new Date(year, month, 1);
    // Monday-first: 0=Mon … 6=Sun
    const startOffset = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrev = new Date(year, month, 0).getDate();

    const cells: { date: Date; current: boolean }[] = [];

    // Prev month fill
    for (let i = startOffset - 1; i >= 0; i--) {
      cells.push({ date: new Date(year, month - 1, daysInPrev - i), current: false });
    }
    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: new Date(year, month, d), current: true });
    }
    // Next month fill to complete grid (multiple of 7)
    while (cells.length % 7 !== 0) {
      const next = cells.length - startOffset - daysInMonth + 1;
      cells.push({ date: new Date(year, month + 1, next), current: false });
    }

    return cells;
  }, [current]);

  function toMonthString(year: number, month: number): string {
    return `${year}-${String(month + 1).padStart(2, '0')}-01`;
  }

  function prevMonth() {
    setActiveMonth(toMonthString(current.getFullYear(), current.getMonth() - 1));
  }

  function nextMonth() {
    setActiveMonth(toMonthString(current.getFullYear(), current.getMonth() + 1));
  }

  function goToDay(date: Date) {
    setActiveMonth(toMonthString(date.getFullYear(), date.getMonth()));
  }

  function isToday(date: Date) {
    return (
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
    );
  }

  return (
    <aside className="sidebar">
      {/* Mini Calendar */}
      <div className="mini-cal">
        <div className="mini-cal-header">
          <button className="nav-btn" onClick={prevMonth} aria-label="Vorheriger Monat">‹</button>
          <span className="mini-cal-title">
            {MONTHS[current.getMonth()]} {current.getFullYear()}
          </span>
          <button className="nav-btn" onClick={nextMonth} aria-label="Nächster Monat">›</button>
        </div>

        <div className="mini-cal-grid">
          {WEEKDAYS.map((d) => (
            <span key={d} className="mini-day-label">{d}</span>
          ))}
          {days.map(({ date, current: isCurrent }, i) => (
            <button
              key={i}
              className={[
                'mini-day',
                isCurrent ? '' : 'mini-day--other',
                isToday(date) ? 'mini-day--today' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => goToDay(date)}
            >
              {date.getDate()}
            </button>
          ))}
        </div>
      </div>

      {/* Calendar List */}
      <div className="cal-list">
        <p className="cal-list-label">Kalender</p>
        {calendars.map((cal) => (
          <button
            key={cal.id}
            className={`cal-item ${isCalendarVisible(cal.id) ? '' : 'cal-item--hidden'}`}
            onClick={() => toggleCalendar(cal.id)}
            title={cal.name}
          >
            <span
              className="cal-dot"
              style={{ background: isCalendarVisible(cal.id) ? cal.color : 'transparent', borderColor: cal.color }}
            />
            <span className="cal-name">{cal.name}</span>
          </button>
        ))}
      </div>

      {/* Sidebar Actions: Import/Sync, Nutzerverwaltung, Abmelden */}
      <div className="sidebar-actions">
        <button className="toolbar-btn" onClick={onImportExport} title="Import &amp; Export (.ics)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2v8" />
            <path d="M4.5 6.5 8 10l3.5-3.5" />
            <path d="M2.5 12.5h11" />
          </svg>
        </button>
        <button
          className={`toolbar-btn${syncing ? ' toolbar-btn--spinning' : ''}`}
          onClick={onSync}
          title="Sync mit CalDAV-Server"
          disabled={syncing}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.1-3.3" />
            <polyline points="13.5 2 13.5 5.5 10 5.5" />
          </svg>
        </button>
        {isAdmin && (
          <button className="toolbar-btn" onClick={onShowAdmin} title="Nutzerverwaltung">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="6" cy="5" r="2.5" />
              <path d="M1.5 14c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" />
              <circle cx="11.5" cy="5.5" r="2" />
              <path d="M10.5 10.2c1.9.3 3 1.5 3 3.8" />
            </svg>
          </button>
        )}
        <button className="toolbar-btn" onClick={onLogout} title="Abmelden">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6.5 14H3.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3" />
            <path d="M10.5 11.5 14 8l-3.5-3.5" />
            <path d="M14 8H6" />
          </svg>
        </button>
      </div>
    </aside>
  );
}

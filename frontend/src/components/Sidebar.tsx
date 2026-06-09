import { useMemo } from 'react';
import { Calendar } from '../types';
import { useStore } from '../store';

interface Props {
  calendars: Calendar[];
}

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

export function Sidebar({ calendars }: Props) {
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
    </aside>
  );
}

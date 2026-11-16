// Browser fixture: real form and styles, synthetic calendars and API responses.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { EventFormModal } from '../src/components/EventFormModal';
import { ToastProvider } from '../src/components/Toast';
import { useStore } from '../src/store';
import '../src/index.css';
import '../src/components/settings.css';
const query = new URLSearchParams(location.search);
useStore.setState({ user: { id: 1, email: 'test@example.invalid', display_name: 'Test', role: 'user', must_change_password: false,
  ...(query.has('defaults') ? { default_duration_minutes: 90, default_reminder_minutes: 15 } : {}) } });
const calendars = ['Samu', 'Sophine', 'Familie', 'Weiterer Kalender', 'Nur Lesen'].map((name, i) => ({id: String(i), name, color: ['#ed6262','#74be93','#c994df','#f3c35c','#aaaaaa'][i], can_write: i !== 4}));
const event = { uid: 'existing', calendar_id: '1', summary: 'Bestehend', start: '2026-12-14T09:30:00', end: '2026-12-14T11:45:00', all_day: false, location: '  Halle  ', description: 'Notizen\n', reminders: [5, 30], etag: 'etag', is_recurring: true, rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20271214T090000Z' };
createRoot(document.getElementById('root')!).render(<ToastProvider><EventFormModal calendars={calendars} {...(query.has('edit') ? {mode: 'edit' as const, event: query.has('allDay') ? {...event, all_day:true, start:'2026-12-14', end:'2026-12-17'} : event} : {mode: 'create' as const, defaultDate: '2026-12-14'})} onClose={() => {}} onSaved={(_uid, saved) => { (window as any).saved = saved; }} /></ToastProvider>);

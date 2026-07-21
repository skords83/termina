export interface Calendar {
  id: string;
  name: string;
  color: string;
}

export interface CalendarEvent {
  uid: string;
  calendar_id: string;
  summary: string;
  start: string; // ISO 8601
  end: string;
  all_day: boolean;
  location?: string;
  description?: string | null;
  etag?: string | null;
  is_recurring?: boolean;
  recurrence_id?: string | null; // ISO 8601, das ursprüngliche Datum dieser Instanz
  rrule?: string | null;         // RRULE-String, z.B. "FREQ=WEEKLY;UNTIL=20261231T235959Z"
}

export interface CreateEventPayload {
  calendar_id: string;
  summary: string;
  start: string;
  end: string;
  all_day?: boolean;
  location?: string | null;
  description?: string | null;
  rrule?: string | null;
}

export interface UpdateEventPayload {
  etag: string;
  summary: string;
  start: string;
  end: string;
  all_day?: boolean;
  location?: string | null;
  description?: string | null;
  rrule?: string | null;
  /** Nur bei Serientermin + editScope='single'|'future': recurrence_id der Instanz bzw. des Split-Punkts */
  recurrence_id?: string | null;
  /** Nur bei Serientermin: explizite Bearbeitungs-Reichweite */
  mode?: 'single' | 'future' | 'all';
  /** Nur gesetzt, wenn der Termin in einen anderen Kalender verschoben wird (nur nicht-wiederkehrende Termine) */
  calendar_id?: string;
}

export interface DeleteEventPayload {
  etag?: string | null;
  recurrence_id?: string | null;
  mode?: 'single' | 'future' | 'all';
}

export type MoveMode = 'single' | 'future' | 'all';

export interface MoveEventPayload {
  mode: MoveMode;
  etag: string;
  original_start: string;
  new_start: string;
  new_end: string;
  recurrence_id?: string | null;
}

export interface ResizeEventPayload {
  mode: MoveMode;
  etag: string;
  occurrence_start: string;
  new_end: string;
  recurrence_id?: string | null;
}

export interface RestoreOccurrencePayload {
  etag: string;
  recurrence_id: string;
}

export type WriteError =
  | { type: 'conflict' }
  | { type: 'not_found' }
  | { type: 'caldav_down' }
  | { type: 'auth' }
  | { type: 'bad_request'; message: string }
  | { type: 'unknown'; status: number };
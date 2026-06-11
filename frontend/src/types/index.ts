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
}

export interface CreateEventPayload {
  calendar_id: string;
  summary: string;
  start: string;
  end: string;
  all_day?: boolean;
  location?: string | null;
  description?: string | null;
}

export interface UpdateEventPayload {
  etag: string;
  summary: string;
  start: string;
  end: string;
  all_day?: boolean;
  location?: string | null;
  description?: string | null;
}

export interface DeleteEventPayload {
  etag: string;
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

export type WriteError =
  | { type: 'conflict' }
  | { type: 'not_found' }
  | { type: 'nextcloud_down' }
  | { type: 'auth' }
  | { type: 'bad_request'; message: string }
  | { type: 'unknown'; status: number };

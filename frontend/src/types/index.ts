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

export type WriteError =
  | { type: 'conflict' }
  | { type: 'not_found' }
  | { type: 'nextcloud_down' }
  | { type: 'auth' }
  | { type: 'unknown'; status: number };
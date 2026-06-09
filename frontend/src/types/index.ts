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
}
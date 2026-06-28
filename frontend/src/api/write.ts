// frontend/src/api/write.ts
//
// Schreib-Operationen gegen das Backend.

import type {
  CreateEventPayload,
  UpdateEventPayload,
  DeleteEventPayload,
  MoveEventPayload,
  WriteError,
} from '../types';

const getToken = (): string => {
  try {
    const raw = localStorage.getItem('termina-storage');
    if (!raw) return '';
    const parsed = JSON.parse(raw);
    return parsed?.state?.token ?? '';
  } catch {
    return '';
  }
};

const headers = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${getToken()}`,
});

function mapError(status: number, body?: any): WriteError {
  if (status === 400) return { type: 'bad_request', message: body?.detail ?? 'Ungültige Anfrage' };
  if (status === 401) return { type: 'auth' };
  if (status === 404) return { type: 'not_found' };
  if (status === 409) return { type: 'conflict' };
  if (status === 503) return { type: 'caldav_down' };
  return { type: 'unknown', status };
}

async function parseError(res: Response): Promise<WriteError> {
  let body: any = undefined;
  try {
    body = await res.json();
  } catch {
    // ignore
  }
  return mapError(res.status, body);
}

// ── POST /api/events ──────────────────────────────────────────────────────────

export async function createEvent(
  payload: CreateEventPayload
): Promise<{ uid: string }> {
  const res = await fetch('/api/events', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

// ── PUT /api/events/{uid} ─────────────────────────────────────────────────────

export async function updateEvent(
  uid: string,
  payload: UpdateEventPayload
): Promise<{ uid: string }> {
  const res = await fetch(`/api/events/${encodeURIComponent(uid)}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

// ── POST /api/events/{uid}/move ───────────────────────────────────────────────

export async function moveEvent(
  uid: string,
  payload: MoveEventPayload
): Promise<{ uid: string; new_uid?: string }> {
  const res = await fetch(`/api/events/${encodeURIComponent(uid)}/move`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

// ── DELETE /api/events/{uid} ──────────────────────────────────────────────────

export async function deleteEvent(
  uid: string,
  payload: DeleteEventPayload
): Promise<void> {
  const params = new URLSearchParams();
  if (payload.etag) params.set('etag', payload.etag);
  if (payload.recurrence_id) {
    params.set('recurrence_id', payload.recurrence_id);
  }
  const res = await fetch(
    `/api/events/${encodeURIComponent(uid)}?${params.toString()}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${getToken()}` },
    }
  );
  if (!res.ok) throw await parseError(res);
}

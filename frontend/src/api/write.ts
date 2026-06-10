// frontend/src/api/write.ts
//
// Schreib-Operationen gegen das Backend.
// Wirft WriteError-Objekte – niemals rohe HTTP-Fehler.

import type {
  CreateEventPayload,
  UpdateEventPayload,
  DeleteEventPayload,
  WriteError,
} from '../types';

const getToken = (): string =>
  localStorage.getItem('termina_token') ?? '';

const headers = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${getToken()}`,
});

function mapError(status: number): WriteError {
  if (status === 401) return { type: 'auth' };
  if (status === 404) return { type: 'not_found' };
  if (status === 409) return { type: 'conflict' };
  if (status === 503) return { type: 'nextcloud_down' };
  return { type: 'unknown', status };
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
  if (!res.ok) throw mapError(res.status);
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
  if (!res.ok) throw mapError(res.status);
  return res.json();
}

// ── DELETE /api/events/{uid} ──────────────────────────────────────────────────

export async function deleteEvent(
  uid: string,
  payload: DeleteEventPayload
): Promise<void> {
  const res = await fetch(`/api/events/${encodeURIComponent(uid)}`, {
    method: 'DELETE',
    headers: headers(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw mapError(res.status);
}

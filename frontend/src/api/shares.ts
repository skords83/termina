// frontend/src/api/shares.ts
//
// Schreib- und Lese-Operationen für die "Mit Oma + Opa teilen"-Funktion.

import type { CreateEventSharePayload, EventShare, WriteError } from '../types';

const headers = () => ({
  'Content-Type': 'application/json',
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

// ── POST /api/event-shares ───────────────────────────────────────

export async function createEventShare(payload: CreateEventSharePayload): Promise<EventShare> {
  const res = await fetch('/api/event-shares', {
    method: 'POST',
    credentials: 'include',
    headers: headers(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

// ── GET /api/event-shares?source_uid= ────────────────────────────

export async function listEventShares(sourceUid: string, recurrenceId?: string | null): Promise<EventShare[]> {
  const url = new URL('/api/event-shares', window.location.origin);
  url.searchParams.set('source_uid', sourceUid);
  if (recurrenceId) {
    url.searchParams.set('recurrence_id', recurrenceId);
  }
  const res = await fetch(url.toString(), { credentials: 'include' });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

// ── POST /api/event-shares/{id}/sync-snapshot ────────────────────

export async function syncShareSnapshot(shareId: number): Promise<EventShare> {
  const res = await fetch(`/api/event-shares/${shareId}/sync-snapshot`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

// ── POST /api/event-shares/{id}/instances/sync-snapshot ──────────

export async function syncInstanceShareSnapshot(shareId: number, sourceRecurrenceId: string): Promise<void> {
  const res = await fetch(`/api/event-shares/${shareId}/instances/sync-snapshot`, {
    method: 'POST',
    credentials: 'include',
    headers: headers(),
    body: JSON.stringify({ source_recurrence_id: sourceRecurrenceId }),
  });
  if (!res.ok) throw await parseError(res);
}

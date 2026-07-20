// frontend/src/api/ics.ts
//
// ICS-Import/-Export.

import type { WriteError } from '../types';

function mapError(status: number, body?: any): WriteError {
  if (status === 400) return { type: 'bad_request', message: body?.detail ?? 'Ungültige Anfrage' };
  if (status === 401) return { type: 'auth' };
  if (status === 403) return { type: 'bad_request', message: 'Kein Zugriff auf diesen Kalender' };
  if (status === 404) return { type: 'not_found' };
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

function filenameFromContentDisposition(header: string | null): string {
  if (!header) return 'termina-export.ics';
  const match = /filename="?([^"]+)"?/.exec(header);
  return match?.[1] ?? 'termina-export.ics';
}

// ── GET /api/ics/export ──────────────────────────────────────────

export async function downloadIcsExport(calendarId?: string | null): Promise<void> {
  const url = new URL('/api/ics/export', window.location.origin);
  if (calendarId) url.searchParams.set('calendar_id', calendarId);

  const res = await fetch(url.toString(), { credentials: 'include' });
  if (!res.ok) throw await parseError(res);

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filenameFromContentDisposition(res.headers.get('Content-Disposition'));
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

// ── POST /api/ics/import ─────────────────────────────────────────

export interface ImportIcsResult {
  imported: number;
  failed: number;
  total: number;
}

export async function importIcs(
  file: File,
  calendarId: string
): Promise<ImportIcsResult> {
  const formData = new FormData();
  formData.append('calendar_id', calendarId);
  formData.append('file', file);

  const res = await fetch('/api/ics/import', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

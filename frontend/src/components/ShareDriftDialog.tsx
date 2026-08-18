// frontend/src/components/ShareDriftDialog.tsx
//
// Zeigt die berechneten neuen Werte (Original ± Puffer) zur Kontrolle
// vor dem Übernehmen — kein stilles Auto-Überschreiben. Zwei Optionen:
// "Aktualisieren" (Kopie anpassen) oder "Ignorieren" (Snapshot bestätigen).

import { useState } from 'react';
import { updateEvent } from '../api/write';
import { syncShareSnapshot, syncInstanceShareSnapshot } from '../api/shares';
import { apiFetch } from '../hooks/api';
import { useToast } from './Toast';
import type { CalendarEvent, EventShare, WriteError } from '../types';

interface Props {
  share: EventShare;
  sourceEvent: CalendarEvent;
  onClose: () => void;
  onResolved: () => void;
}

function addMinutesIso(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

export function ShareDriftDialog({ share, sourceEvent, onClose, onResolved }: Props) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  const newStart = addMinutesIso(sourceEvent.start, -share.buffer_before_minutes);
  const newEnd = addMinutesIso(sourceEvent.end, share.buffer_after_minutes);
  const newSummary = sourceEvent.summary;

  const isInstance = !!sourceEvent.recurrence_id;
  const mappedRecurrenceId = isInstance
    ? addMinutesIso(sourceEvent.recurrence_id as string, share.buffer_before_minutes)
    : undefined;

  const handleIgnore = async () => {
    setBusy(true);
    try {
      if (isInstance && sourceEvent.recurrence_id) {
        await syncInstanceShareSnapshot(share.id, sourceEvent.recurrence_id);
      } else {
        await syncShareSnapshot(share.id);
      }
      showToast('Abweichung ignoriert', 'info');
      onResolved();
      onClose();
    } catch {
      showToast('Konnte Abweichung nicht ignorieren.', 'error');
      setBusy(false);
    }
  };

  const handleUpdate = async () => {
    setBusy(true);
    try {
      // Aktuellen Zustand der Kopie holen (für etag) — enges Zeitfenster um den neuen Termin.
      const from = new Date(newStart);
      from.setDate(from.getDate() - 1);
      const to = new Date(newEnd);
      to.setDate(to.getDate() + 1);
      const events = await apiFetch<CalendarEvent[]>('/api/events', {
        from: from.toISOString(),
        to: to.toISOString(),
        calendar_id: share.target_calendar_id,
      });
      const target = events.find((e) => e.uid === share.shared_uid);
      if (!target) {
        showToast('Kopie nicht gefunden — evtl. noch nicht synchronisiert.', 'error');
        setBusy(false);
        return;
      }

      await updateEvent(share.shared_uid, {
        etag: target.etag ?? '',
        summary: newSummary,
        start: newStart,
        end: newEnd,
        all_day: sourceEvent.all_day,
        recurrence_id: isInstance ? mappedRecurrenceId : undefined,
        mode: isInstance ? 'single' : share.snapshot_rrule ? 'all' : undefined,
      });

      if (isInstance && sourceEvent.recurrence_id) {
        await syncInstanceShareSnapshot(share.id, sourceEvent.recurrence_id);
      } else {
        await syncShareSnapshot(share.id);
      }
      showToast('Bei Oma + Opa aktualisiert', 'success');
      onResolved();
      onClose();
    } catch (err) {
      const writeErr = err as WriteError;
      if (writeErr.type === 'conflict') {
        showToast('Kopie wurde extern geändert — bitte neu laden.', 'warning');
      } else {
        showToast('Aktualisierung fehlgeschlagen.', 'error');
      }
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="rec-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="rec-dialog-header">
          <h3 className="rec-dialog-title">Abweichung bei Oma + Opa</h3>
          <p className="rec-dialog-sub">
            Neue Werte: „{newSummary}", {new Date(newStart).toLocaleString('de-DE')} – {new Date(newEnd).toLocaleString('de-DE')}
          </p>
        </div>
        <div className="rec-dialog-options">
          <button className="rec-option" onClick={handleUpdate} disabled={busy}>
            <div className="rec-option-title">Aktualisieren</div>
            <div className="rec-option-desc">Die Kopie bei Oma + Opa wird auf diese Werte gesetzt.</div>
          </button>
          <button className="rec-option" onClick={handleIgnore} disabled={busy}>
            <div className="rec-option-title">Ignorieren</div>
            <div className="rec-option-desc">Kopie bleibt unverändert, Hinweis verschwindet bis zur nächsten Abweichung.</div>
          </button>
        </div>
        <div className="rec-dialog-footer">
          <button className="rec-cancel" onClick={onClose} disabled={busy}>
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
}

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
import { addMinutesLocal, mapRecurrenceId, parseLocalDatetime, toBackendDatetime } from '../utils/datetime';
import type { CalendarEvent, EventShare, UpdateEventPayload, WriteError } from '../types';

interface Props {
  share: EventShare;
  sourceEvent: CalendarEvent;
  onClose: () => void;
  onResolved: () => void;
}

/**
 * Baut den updateEvent-Payload für die series-/instance-level Übernahme der
 * Drift-Werte. Als eigene, pure Funktion extrahiert, damit sie ohne
 * Component-Rendering testbar ist (Fix 1: die RRULE darf bei einem
 * series-level Update NIEMALS fehlen, sonst wird die Kopie beim Schreiben
 * stillschweigend in einen nicht-wiederkehrenden Termin verwandelt).
 */
export function buildDriftUpdatePayload(params: {
  etag: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  sourceRrule: string | null | undefined;
  isInstance: boolean;
  mappedRecurrenceId?: string;
  copyHasSeriesRrule: boolean;
}): UpdateEventPayload {
  const { etag, summary, start, end, allDay, sourceRrule, isInstance, mappedRecurrenceId, copyHasSeriesRrule } = params;
  return {
    etag,
    summary,
    start,
    end,
    all_day: allDay,
    // Die aktuelle RRULE der Quelle mitschicken — ohne sie würde ein
    // series-level Update die RRULE der Kopie löschen (Backend defaultet
    // rrule=None), was die Serie der Kopie permanent zerstört.
    rrule: isInstance ? undefined : sourceRrule,
    recurrence_id: isInstance ? mappedRecurrenceId : undefined,
    mode: isInstance ? 'single' : copyHasSeriesRrule ? 'all' : undefined,
  };
}

export function ShareDriftDialog({ share, sourceEvent, onClose, onResolved }: Props) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  const newStart = addMinutesLocal(sourceEvent.start, -share.buffer_before_minutes);
  const newEnd = addMinutesLocal(sourceEvent.end, share.buffer_after_minutes);
  const newSummary = sourceEvent.summary;

  const isInstance = !!sourceEvent.recurrence_id;
  // Die Kopie liegt buffer_before_minutes VOR dem Original, daher wird hier
  // subtrahiert (nicht addiert) — siehe utils/datetime.mapRecurrenceId.
  const mappedRecurrenceId = isInstance
    ? mapRecurrenceId(sourceEvent.recurrence_id as string, share.buffer_before_minutes)
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
      const from = parseLocalDatetime(newStart);
      from.setDate(from.getDate() - 1);
      const to = parseLocalDatetime(newEnd);
      to.setDate(to.getDate() + 1);
      const events = await apiFetch<CalendarEvent[]>('/api/events', {
        from: toBackendDatetime(from),
        to: toBackendDatetime(to),
        calendar_id: share.target_calendar_id,
      });
      const target = events.find((e) => e.uid === share.shared_uid);
      if (!target) {
        showToast('Kopie nicht gefunden — evtl. noch nicht synchronisiert.', 'error');
        setBusy(false);
        return;
      }

      await updateEvent(
        share.shared_uid,
        buildDriftUpdatePayload({
          etag: target.etag ?? '',
          summary: newSummary,
          start: newStart,
          end: newEnd,
          allDay: sourceEvent.all_day,
          sourceRrule: sourceEvent.rrule,
          isInstance,
          mappedRecurrenceId,
          copyHasSeriesRrule: !!share.snapshot_rrule,
        }),
      );

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

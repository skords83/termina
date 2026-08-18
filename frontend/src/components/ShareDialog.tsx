// frontend/src/components/ShareDialog.tsx
//
// Dialog für die Aktion "Mit Oma + Opa teilen": Titel/Start/Ende
// vorausgefüllt aus dem Quelltermin, frei editierbar, plus zwei
// Zeit-Puffer-Felder. Bei Serienterminen wird die ganze Serie kopiert.
// Ganztägige Termine verwenden Datums- statt Datum/Zeit-Felder; die
// Minuten-Puffer sind für sie ausgeblendet (siehe DateTimeField-Zweig in
// EventFormModal.tsx für das gleiche Muster).

import { useState } from 'react';
import { createEventShare } from '../api/shares';
import { useToast } from './Toast';
import { addDaysLocal, addMinutesLocal, parseLocalDatetime, toBackendDatetime } from '../utils/datetime';
import type { CalendarEvent, WriteError } from '../types';

interface Props {
  event: CalendarEvent;
  onClose: () => void;
  onShared: () => void;
}

export function ShareDialog({ event, onClose, onShared }: Props) {
  const { showToast } = useToast();
  const allDay = event.all_day;

  const [summary, setSummary] = useState(event.summary);
  const [start, setStart] = useState(() =>
    allDay
      ? event.start.slice(0, 10)
      : toBackendDatetime(parseLocalDatetime(event.start)),
  );
  const [end, setEnd] = useState(() =>
    allDay
      ? addDaysLocal(event.end.slice(0, 10), -1) // DTEND ist exklusiv -> für Anzeige -1 Tag
      : toBackendDatetime(parseLocalDatetime(event.end)),
  );
  const [bufferBefore, setBufferBefore] = useState(0);
  const [bufferAfter, setBufferAfter] = useState(0);
  const [saving, setSaving] = useState(false);

  const applyBuffers = (before: number, after: number) => {
    setStart(addMinutesLocal(event.start, -before));
    setEnd(addMinutesLocal(event.end, after));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await createEventShare({
        source_uid: event.uid,
        summary,
        start: allDay ? start : `${start}:00`,
        end: allDay ? addDaysLocal(end, 1) : `${end}:00`,
        ...(allDay ? {} : { buffer_before_minutes: bufferBefore, buffer_after_minutes: bufferAfter }),
      });
      showToast('Mit Oma + Opa geteilt', 'success');
      onShared();
      onClose();
    } catch (err) {
      const writeErr = err as WriteError;
      if (writeErr.type === 'bad_request') {
        showToast(writeErr.message, 'error');
      } else {
        showToast('Freigabe konnte nicht angelegt werden.', 'error');
      }
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="rec-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="rec-dialog-header">
          <h3 className="rec-dialog-title">Mit Oma + Opa teilen</h3>
          {event.is_recurring && (
            <p className="rec-dialog-sub">
              „{event.summary}" ist ein Serientermin — die ganze Serie wird kopiert, der Puffer gilt für jede Instanz gleich.
            </p>
          )}
        </div>

        <div className="share-dialog-body">
          <label className="share-field">
            <span>Titel</span>
            <input type="text" value={summary} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <label className="share-field">
            <span>Start</span>
            <input
              type={allDay ? 'date' : 'datetime-local'}
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label className="share-field">
            <span>Ende</span>
            <input
              type={allDay ? 'date' : 'datetime-local'}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          {!allDay && (
            <div className="share-buffer-row">
              <label className="share-field">
                <span>+Min. davor</span>
                <input
                  type="number"
                  min={0}
                  value={bufferBefore}
                  onChange={(e) => {
                    const v = Number(e.target.value) || 0;
                    setBufferBefore(v);
                    applyBuffers(v, bufferAfter);
                  }}
                />
              </label>
              <label className="share-field">
                <span>+Min. danach</span>
                <input
                  type="number"
                  min={0}
                  value={bufferAfter}
                  onChange={(e) => {
                    const v = Number(e.target.value) || 0;
                    setBufferAfter(v);
                    applyBuffers(bufferBefore, v);
                  }}
                />
              </label>
            </div>
          )}
        </div>

        <div className="rec-dialog-footer">
          <button className="rec-cancel" onClick={onClose} disabled={saving}>
            Abbrechen
          </button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Teilen…' : 'Teilen'}
          </button>
        </div>
      </div>
    </div>
  );
}

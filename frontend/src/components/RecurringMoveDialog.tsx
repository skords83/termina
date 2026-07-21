import { useEffect } from 'react';
import type { MoveMode } from '../types';

interface Props {
  summary: string;
  action?: 'move' | 'resize';
  onChoose: (mode: MoveMode) => void;
  onCancel: () => void;
}

export function RecurringMoveDialog({ summary, action = 'move', onChoose, onCancel }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  const isResize = action === 'resize';

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="rec-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="rec-dialog-header">
          <h3 className="rec-dialog-title">{isResize ? 'Termin-Dauer ändern' : 'Termin verschieben'}</h3>
          <p className="rec-dialog-sub">„{summary}" ist ein Serientermin.</p>
        </div>

        <div className="rec-dialog-options">
          <button
            className="rec-option"
            onClick={() => onChoose('single')}
          >
            <div className="rec-option-title">Nur diesen Termin</div>
            <div className="rec-option-desc">
              {isResize
                ? 'Nur diese eine Instanz wird verändert. Die Serie bleibt unverändert.'
                : 'Nur diese eine Instanz wird verschoben. Die Serie bleibt unverändert.'}
            </div>
          </button>

          <button
            className="rec-option"
            onClick={() => onChoose('future')}
          >
            <div className="rec-option-title">Diesen und alle folgenden</div>
            <div className="rec-option-desc">
              Die alte Serie endet vor diesem Termin. Ab hier wird eine neue Serie erstellt.
            </div>
          </button>

          <button
            className="rec-option"
            onClick={() => onChoose('all')}
          >
            <div className="rec-option-title">Alle Termine der Serie</div>
            <div className="rec-option-desc">
              {isResize
                ? 'Alle Termine der Serie erhalten die gleiche neue Dauer.'
                : 'Die gesamte Serie wird um den gleichen Zeitabstand verschoben.'}
            </div>
          </button>
        </div>

        <div className="rec-dialog-footer">
          <button className="rec-cancel" onClick={onCancel}>
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
}

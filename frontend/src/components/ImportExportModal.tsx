import { useEffect, useRef, useState } from 'react';
import type { Calendar } from '../types';
import { downloadIcsExport, importIcs } from '../api/ics';
import { useToast } from './Toast';

interface ImportExportModalProps {
  calendars: Calendar[];
  onClose: () => void;
  onImported: () => void;
}

export default function ImportExportModal({ calendars, onClose, onImported }: ImportExportModalProps) {
  const { showToast } = useToast();
  const [exportCalendarId, setExportCalendarId] = useState<string>('');
  const [importCalendarId, setImportCalendarId] = useState<string>(calendars[0]?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  async function handleExport() {
    setExporting(true);
    try {
      await downloadIcsExport(exportCalendarId || undefined);
    } catch (err: any) {
      showToast(
        err?.type === 'bad_request' ? err.message : 'Export fehlgeschlagen.',
        'error'
      );
    } finally {
      setExporting(false);
    }
  }

  async function handleImport() {
    if (!file || !importCalendarId) return;
    setImporting(true);
    try {
      const result = await importIcs(file, importCalendarId);
      if (result.failed > 0) {
        showToast(
          `${result.imported} von ${result.total} Terminen importiert, ${result.failed} übersprungen.`,
          'error'
        );
      } else {
        showToast(`${result.imported} Termin${result.imported === 1 ? '' : 'e'} importiert.`, 'success');
      }
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (result.imported > 0) onImported();
    } catch (err: any) {
      showToast(
        err?.type === 'bad_request' ? err.message : 'Import fehlgeschlagen.',
        'error'
      );
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="form-modal" onClick={(e) => e.stopPropagation()}>
        <div className="form-modal-header">
          <h2 className="form-modal-title">Import &amp; Export</h2>
          <button className="form-modal-close" onClick={onClose} title="Schließen">✕</button>
        </div>

        <div className="form-section">
          <span className="form-label">Export</span>
          <div className="form-field">
            <label className="form-sublabel" htmlFor="export-calendar">Kalender</label>
            <select
              id="export-calendar"
              className="form-select"
              value={exportCalendarId}
              onChange={(e) => setExportCalendarId(e.target.value)}
            >
              <option value="">Alle Kalender</option>
              {calendars.map((cal) => (
                <option key={cal.id} value={cal.id}>{cal.name}</option>
              ))}
            </select>
          </div>
          <button className="btn-primary" onClick={handleExport} disabled={exporting}>
            {exporting && <span className="btn-spinner" aria-hidden="true" />}
            Als .ics herunterladen
          </button>
        </div>

        <div className="form-section">
          <span className="form-label">Import</span>
          <div className="form-field">
            <label className="form-sublabel" htmlFor="import-calendar">Zielkalender</label>
            <select
              id="import-calendar"
              className="form-select"
              value={importCalendarId}
              onChange={(e) => setImportCalendarId(e.target.value)}
            >
              {calendars.map((cal) => (
                <option key={cal.id} value={cal.id}>{cal.name}</option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <input
              ref={fileInputRef}
              type="file"
              accept=".ics,text/calendar"
              className="form-input"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <p className="form-recur-note">
            Neue Termine werden mit neuer UID angelegt — bestehende Termine werden nicht überschrieben.
          </p>
          <button
            className="btn-primary"
            onClick={handleImport}
            disabled={!file || !importCalendarId || importing}
          >
            {importing && <span className="btn-spinner" aria-hidden="true" />}
            Importieren
          </button>
        </div>

        <div className="form-modal-footer">
          <button className="btn-secondary" onClick={onClose}>Schließen</button>
        </div>
      </div>
    </div>
  );
}

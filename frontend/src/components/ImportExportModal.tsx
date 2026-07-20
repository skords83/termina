import { useEffect, useRef, useState } from 'react';
import type { Calendar } from '../types';
import { downloadIcsExport, importIcs, previewIcsImport, type ImportIcsPreviewEvent } from '../api/ics';
import { useToast } from './Toast';

interface ImportExportModalProps {
  calendars: Calendar[];
  onClose: () => void;
  onImported: () => void;
}

function formatPreviewMeta(ev: ImportIcsPreviewEvent): string {
  if (!ev.start) return '';
  const d = new Date(ev.start);
  const dateStr = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeStr = ev.all_day ? '' : ` ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  const recur = ev.is_recurring ? ' · wiederkehrend' : '';
  const overrides = ev.override_count > 0 ? ` · ${ev.override_count} Ausnahme${ev.override_count === 1 ? '' : 'n'}` : '';
  return `${dateStr}${timeStr}${recur}${overrides}`;
}

export default function ImportExportModal({ calendars, onClose, onImported }: ImportExportModalProps) {
  const { showToast } = useToast();
  const [exportCalendarId, setExportCalendarId] = useState<string>('');
  const [importCalendarId, setImportCalendarId] = useState<string>(calendars[0]?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<ImportIcsPreviewEvent[] | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    setPreview(null);
    if (!file || !importCalendarId) return;
    let cancelled = false;
    setPreviewing(true);
    previewIcsImport(file, importCalendarId)
      .then((result) => {
        if (!cancelled) setPreview(result.events);
      })
      .catch((err: any) => {
        if (cancelled) return;
        showToast(
          err?.type === 'bad_request' ? err.message : 'Vorschau fehlgeschlagen.',
          'error'
        );
        setFile(null);
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, importCalendarId]);

  function chooseFile(f: File | null) {
    if (fileInputRef.current) fileInputRef.current.value = '';
    setFile(f);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) chooseFile(dropped);
  }

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
      chooseFile(null);
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
            <div
              className={`ics-dropzone${isDragging ? ' is-dragging' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
            >
              {file ? (
                <span className="ics-dropzone-file">{file.name}</span>
              ) : (
                <>
                  <span className="ics-dropzone-label">.ics-Datei hierher ziehen oder klicken</span>
                  <span className="ics-dropzone-hint">Nur .ics-Kalenderdateien</span>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".ics,text/calendar"
                className="form-input"
                style={{ display: 'none' }}
                onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
              />
            </div>
          </div>

          {previewing && <p className="ics-preview-summary-line">Vorschau wird geladen…</p>}

          {preview && preview.length > 0 && (
            <div className="form-field">
              <p className="ics-preview-summary-line">
                {preview.length} Termin{preview.length === 1 ? '' : 'e'} gefunden
                {preview.some((p) => p.conflict) && ' · Konflikte rot markiert'}
              </p>
              <div className="ics-preview-list">
                {preview.map((ev, i) => (
                  <div key={i} className={`ics-preview-row${ev.conflict ? ' is-conflict' : ''}`}>
                    <span className="ics-preview-summary">{ev.summary}</span>
                    <span className="ics-preview-meta">{formatPreviewMeta(ev)}</span>
                    {ev.conflict && <span className="ics-preview-conflict-badge">⚠ Überschneidung</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="form-recur-note">
            Neue Termine werden mit neuer UID angelegt — bestehende Termine werden nicht überschrieben.
          </p>
          <button
            className="btn-primary"
            onClick={handleImport}
            disabled={!file || !importCalendarId || importing || previewing}
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

// frontend/src/utils/datetime.ts
//
// Gemeinsame Helfer für naive lokale Datum/Zeit-Strings ("YYYY-MM-DDTHH:mm",
// ohne Zeitzonen-Suffix), wie sie diese App durchgängig an das Backend
// sendet/empfängt (siehe EventFormModal.localDatetimeToISO, GET /events
// recurrence_id, GET /event-shares?recurrence_id=...).
//
// WICHTIG: new Date(str).toISOString() ist hier IMMER falsch — das konvertiert
// nach UTC (anderer Wanduhr-Wert), und ein erneutes new Date(...) interpretiert
// einen Suffix-losen String wieder als lokal, was zu einer stillen
// Zeitzonen-Verschiebung führt. Alle Funktionen hier rechnen deshalb rein mit
// lokalen Date-Feldern (getFullYear/getMonth/... bzw. deren Setter) und rufen
// niemals .toISOString() auf.

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Parst einen naiven lokalen Datum/Zeit-String ("YYYY-MM-DD",
 * "YYYY-MM-DDTHH:mm" oder "YYYY-MM-DDTHH:mm:ss", optional mit einem
 * (zu ignorierenden) "Z"-Suffix von der API) als lokale Wanduhrzeit.
 */
export function parseLocalDatetime(str: string): Date {
  const clean = str.replace(/Z$/, "");
  const [datePart, rawTimePart] = clean.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const timePart = (rawTimePart ?? "00:00:00").split(".")[0]; // Sekundenbruchteile verwerfen
  const [hh, mm, ss] = timePart.split(":").map((v) => Number(v) || 0);
  return new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, ss || 0);
}

/** Formatiert ein Date als naiven lokalen "YYYY-MM-DDTHH:mm"-String (Minutenpräzision). */
export function toBackendDatetime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Formatiert ein Date als naiven lokalen "YYYY-MM-DD"-String (für Ganztags-Felder). */
export function toLocalDateStr(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Addiert `minutes` Minuten zu einem naiven lokalen Datum/Zeit-String und
 * gibt das Ergebnis wieder als naiven lokalen "YYYY-MM-DDTHH:mm"-String
 * zurück — reine lokale Wanduhr-Arithmetik, kein UTC-Roundtrip.
 */
export function addMinutesLocal(localStr: string, minutes: number): string {
  const d = parseLocalDatetime(localStr);
  d.setMinutes(d.getMinutes() + minutes);
  return toBackendDatetime(d);
}

/**
 * Addiert `days` Tage zu einem naiven lokalen Datum-String ("YYYY-MM-DD")
 * und gibt das Ergebnis wieder als "YYYY-MM-DD" zurück. Für die
 * Exklusiv-Ende-Arithmetik bei Ganztags-Terminen.
 */
export function addDaysLocal(dateStr: string, days: number): string {
  const d = parseLocalDatetime(dateStr);
  d.setDate(d.getDate() + days);
  return toLocalDateStr(d);
}

/**
 * Mapt eine recurrence_id des Quelltermins auf die entsprechende Instanz der
 * geteilten Kopie. Die Kopie liegt buffer_before_minutes VOR dem Original
 * (DTSTART der Kopie = Original-Start − buffer_before_minutes, die RRULE wird
 * identisch kopiert), also muss auch die recurrence_id um denselben Betrag
 * ZURÜCKverschoben werden — nicht vorwärts.
 */
export function mapRecurrenceId(sourceRecurrenceId: string, bufferBeforeMinutes: number): string {
  return addMinutesLocal(sourceRecurrenceId, -bufferBeforeMinutes);
}

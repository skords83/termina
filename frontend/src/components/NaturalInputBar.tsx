/**
 * parseNaturalEvent – deutschsprachiger Fließtext-Parser, kein KI-Einsatz.
 *
 * Erkannte Muster (Auswahl):
 *   "Morgen Zahnarzt um 14:30"
 *   "Freitag 18 Uhr Abendessen mit Sara im Vapiano"
 *   "Hortkonferenz heute ab 9 bis 12 Uhr"
 *   "Übermorgen von 10 bis 12 Uhr Teambesprechung"
 *   "Am 15.7. Geburtstag Mama"
 *   "Nächsten Montag ganztägig Betriebsausflug"
 *   "25. Juni 2026 Hochzeit, Rathaus"
 */

export interface ParsedEvent {
  summary: string;
  start: string;
  end: string;
  all_day: boolean;
  location?: string;
}

// ─── Hilfsfunktionen ────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dateToLocalISO(d: Date, allDay = false): string {
  if (allDay) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function addHours(d: Date, h: number): Date {
  const r = new Date(d);
  r.setHours(r.getHours() + h);
  return r;
}

function setTime(d: Date, hours: number, minutes: number): Date {
  const r = new Date(d);
  r.setHours(hours, minutes, 0, 0);
  return r;
}

// ─── Datumsworte ─────────────────────────────────────────────────────────────

const MONTH_MAP: Record<string, number> = {
  jan: 0, januar: 0,
  feb: 1, februar: 1,
  mär: 2, maer: 2, märz: 2, mar: 2,
  apr: 3, april: 3,
  mai: 4,
  jun: 5, juni: 5,
  jul: 6, juli: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  okt: 9, oktober: 9,
  nov: 10, november: 10,
  dez: 11, dezember: 11,
};

const WEEKDAY_MAP: Record<string, number> = {
  montag: 1, mo: 1,
  dienstag: 2, di: 2,
  mittwoch: 3, mi: 3,
  donnerstag: 4, do: 4,
  freitag: 5, fr: 5,
  samstag: 6, sa: 6,
  sonntag: 0, so: 0,
};

// ─── Datum erkennen ───────────────────────────────────────────────────────────

interface DateResult {
  date: Date;
  consumed: string;
}

function resolveDate(input: string): DateResult | null {
  const lower = input.toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (/\bheute\b/.test(lower))      return { date: new Date(today), consumed: "heute" };
  if (/\bmorgen\b/.test(lower))     return { date: addDays(today, 1), consumed: "morgen" };
  if (/\bübermorgen\b/.test(lower)) return { date: addDays(today, 2), consumed: "übermorgen" };

  // "nächsten Montag"
  const nextWeekday = lower.match(
    /n[äa]chste[ns]?\s+(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|mo|di|mi|do|fr|sa|so)\b/
  );
  if (nextWeekday) {
    const target = WEEKDAY_MAP[nextWeekday[1]];
    if (target !== undefined) {
      const d = new Date(today);
      d.setDate(d.getDate() + 1);
      while (d.getDay() !== target) d.setDate(d.getDate() + 1);
      if (d <= today) d.setDate(d.getDate() + 7);
      return { date: d, consumed: nextWeekday[0] };
    }
  }

  // plain weekday
  const weekdayMatch = lower.match(
    /\b(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|mo|di|mi|do|fr|sa|so)\b/
  );
  if (weekdayMatch) {
    const target = WEEKDAY_MAP[weekdayMatch[1]];
    if (target !== undefined) {
      const d = new Date(today);
      if (d.getDay() === target) {
        d.setDate(d.getDate() + 7);
      } else {
        d.setDate(d.getDate() + 1);
        while (d.getDay() !== target) d.setDate(d.getDate() + 1);
      }
      return { date: d, consumed: weekdayMatch[0] };
    }
  }

  // "15.7." / "15.07.2026"
  const dotDate = lower.match(/\b(\d{1,2})\.\s*(\d{1,2})\.?\s*(\d{4})?\b/);
  if (dotDate) {
    const day = parseInt(dotDate[1]);
    const month = parseInt(dotDate[2]) - 1;
    const year = dotDate[3] ? parseInt(dotDate[3]) : today.getFullYear();
    const d = new Date(year, month, day);
    if (isNaN(d.getTime())) return null;
    if (d < today && !dotDate[3]) d.setFullYear(d.getFullYear() + 1);
    return { date: d, consumed: dotDate[0] };
  }

  // "15. Juli 2026"
  const monthNameDate = lower.match(
    /(\d{1,2})\.\s*(jan(?:uar)?|feb(?:ruar)?|m[äa]r(?:z)?|apr(?:il)?|mai|jun(?:i)?|jul(?:i)?|aug(?:ust)?|sep(?:t(?:ember)?)?|okt(?:ober)?|nov(?:ember)?|dez(?:ember)?)\s*(\d{4})?/
  );
  if (monthNameDate) {
    const day = parseInt(monthNameDate[1]);
    const month = MONTH_MAP[monthNameDate[2].toLowerCase()];
    const year = monthNameDate[3] ? parseInt(monthNameDate[3]) : today.getFullYear();
    const d = new Date(year, month, day);
    if (isNaN(d.getTime())) return null;
    if (d < today && !monthNameDate[3]) d.setFullYear(d.getFullYear() + 1);
    return { date: d, consumed: monthNameDate[0] };
  }

  const inDays = lower.match(/\bin\s+(\d+)\s+tagen?\b/);
  if (inDays) return { date: addDays(today, parseInt(inDays[1])), consumed: inDays[0] };

  const inWeeks = lower.match(/\bin\s+(\d+)\s+wochen?\b/);
  if (inWeeks) return { date: addDays(today, parseInt(inWeeks[1]) * 7), consumed: inWeeks[0] };

  return null;
}

// ─── Zeit erkennen ───────────────────────────────────────────────────────────
// Erkennt: "14:30", "14.30 Uhr", "14 Uhr", "um 14", "ab 9", "ab 9 Uhr"

interface TimeResult {
  hours: number;
  minutes: number;
  consumed: string;
}

function resolveTime(input: string): TimeResult | null {
  const lower = input.toLowerCase();

  // "14:30 Uhr" / "14:30" / "14.30 Uhr"
  const hhmm = lower.match(/\b(\d{1,2})[:\.](\d{2})\s*(?:uhr)?\b/);
  if (hhmm) {
    return { hours: parseInt(hhmm[1]), minutes: parseInt(hhmm[2]), consumed: hhmm[0] };
  }

  // "14 Uhr" / "um 14 Uhr" / "ab 14 Uhr"
  const withUhr = lower.match(/(?:(?:um|ab)\s+)?(\d{1,2})\s*uhr\b/);
  if (withUhr) {
    return { hours: parseInt(withUhr[1]), minutes: 0, consumed: withUhr[0] };
  }

  // "um 9" (explicit "um")
  const umHour = lower.match(/\bum\s+(\d{1,2})\b/);
  if (umHour) {
    return { hours: parseInt(umHour[1]), minutes: 0, consumed: umHour[0] };
  }

  // "ab 9" / "ab 14" – "ab" als Startzeit-Präfix
  const abHour = lower.match(/\bab\s+(\d{1,2})\b/);
  if (abHour) {
    return { hours: parseInt(abHour[1]), minutes: 0, consumed: abHour[0] };
  }

  return null;
}

// ─── End-Zeit erkennen ────────────────────────────────────────────────────────

interface EndTimeResult {
  hours: number;
  minutes: number;
  consumed: string;
}

function resolveEndTime(input: string): EndTimeResult | null {
  const lower = input.toLowerCase();

  // "bis 16:00 Uhr" / "bis 16.30"
  const bisFull = lower.match(/\bbis\s+(\d{1,2})[:\.](\d{2})\s*(?:uhr)?\b/);
  if (bisFull) {
    return { hours: parseInt(bisFull[1]), minutes: parseInt(bisFull[2]), consumed: bisFull[0] };
  }

  // "bis 16 Uhr" / "bis 16"
  const bisHour = lower.match(/\bbis\s+(\d{1,2})\s*(?:uhr)?\b/);
  if (bisHour) {
    return { hours: parseInt(bisHour[1]), minutes: 0, consumed: bisHour[0] };
  }

  // "von X bis Y" – komplettes Muster, nur Y extrahieren
  const vonBis = lower.match(
    /\b(?:von|ab)\s+\d{1,2}(?:[:\.]?\d{2})?\s*(?:uhr)?\s+bis\s+(\d{1,2})(?:[:\.](\d{2}))?\s*(?:uhr)?\b/
  );
  if (vonBis) {
    return {
      hours: parseInt(vonBis[1]),
      minutes: vonBis[2] ? parseInt(vonBis[2]) : 0,
      consumed: vonBis[0],
    };
  }

  return null;
}

// ─── Ort erkennen ────────────────────────────────────────────────────────────

const LOCATION_TRIGGERS = [
  /\b(?:im|in|bei|am|an|auf|beim)\s+([A-ZÄÖÜ][^,\.!?]*?)(?:\s*[,\.!?]|$)/,
  /,\s*([A-ZÄÖÜ][^,\.!?]{2,30})(?:\s*[,\.!?]|$)/,
];

function resolveLocation(input: string): string | undefined {
  for (const re of LOCATION_TRIGGERS) {
    const m = input.match(re);
    if (m) {
      const loc = m[1].trim();
      if (/^\d/.test(loc)) continue;
      if (loc.split(" ").length === 1 && loc.length < 5) continue;
      return loc;
    }
  }
  return undefined;
}

// ─── Ganztägig ────────────────────────────────────────────────────────────────

function isAllDay(input: string): boolean {
  return /\bganztägig\b|\bganztagig\b|\bganz tag\b|\bganze tag\b/i.test(input);
}

// ─── Zusammenfassung ─────────────────────────────────────────────────────────

function extractSummary(input: string, consumed: string[]): string {
  let text = input;

  for (const c of consumed) {
    // case-insensitive replace of the exact consumed token
    text = text.replace(new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), " ");
  }

  text = text
    .replace(/\bam\b/gi, " ")
    .replace(/\bum\b/gi, " ")
    .replace(/\bab\b/gi, " ")   // ← "ab" als Präfix bereinigen
    .replace(/\bvon\b/gi, " ")
    .replace(/\bbis\b/gi, " ")
    .replace(/\bganztägig\b/gi, " ")
    .replace(/\bganztagig\b/gi, " ")
    .replace(/\bjeden?\b/gi, " ")
    .replace(/\bnächste[ns]?\b/gi, " ")
    .replace(/\bin\s+\d+\s+(?:tagen?|wochen?)\b/gi, " ")
    .replace(/\buhr\b/gi, " ")
    .replace(/[,\.!?]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return text || "Neuer Termin";
}

// ─── Haupt-Parser ─────────────────────────────────────────────────────────────

export function parseNaturalEvent(input: string): ParsedEvent | null {
  if (!input.trim()) return null;

  const consumed: string[] = [];

  // 1. Endzeit VOR Startzeit suchen (damit "von X bis Y" korrekt konsumiert wird)
  const allDay = isAllDay(input);
  const endTimeResult = allDay ? null : resolveEndTime(input);

  // 2. Datum
  const dateResult = resolveDate(input);
  let baseDate: Date;
  if (dateResult) {
    baseDate = dateResult.date;
    consumed.push(dateResult.consumed);
  } else {
    baseDate = new Date();
    baseDate.setHours(0, 0, 0, 0);
  }

  if (allDay) consumed.push("ganztägig", "ganztagig", "ganze tag", "ganz tag");

  // 3. Startzeit
  const timeResult = allDay ? null : resolveTime(input);
  let startDate: Date;
  if (timeResult) {
    startDate = setTime(baseDate, timeResult.hours, timeResult.minutes);
    consumed.push(timeResult.consumed);
  } else if (allDay) {
    startDate = new Date(baseDate);
    startDate.setHours(0, 0, 0, 0);
  } else {
    startDate = setTime(baseDate, 9, 0);
  }

  // 4. Endzeit anwenden
  let endDate: Date;
  if (endTimeResult) {
    endDate = setTime(baseDate, endTimeResult.hours, endTimeResult.minutes);
    consumed.push(endTimeResult.consumed);
    if (endDate <= startDate) endDate = addHours(startDate, 1);
  } else if (allDay) {
    endDate = addDays(startDate, 1);
  } else {
    endDate = addHours(startDate, 1);
  }

  // 5. Ort
  const location = resolveLocation(input);

  // 6. Zusammenfassung
  const summary = extractSummary(input, consumed);

  return {
    summary,
    start: dateToLocalISO(startDate, allDay),
    end: dateToLocalISO(endDate, allDay),
    all_day: allDay,
    location,
  };
}
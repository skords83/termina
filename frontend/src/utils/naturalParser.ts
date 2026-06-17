/**
 * parseNaturalEvent  –  v2
 *
 * Parst deutschsprachige Fließtext-Eingaben zu CalDAV-Event-Feldern.
 * Kein KI-Einsatz – reine Regex/Heuristik.
 *
 * v2 Fixes:
 *  1. Unicode-aware Wortgrenzen (Umlaute brechen \b nicht mehr)
 *  2. Dot-Zeiten (8.30) werden nicht mehr als Datum fehlinterpretiert
 *  3. Datum-Tokens vor Zeit-Parsing entfernt (kein Doppel-Match)
 *  4. [bereits gefixt] Case-insensitive consumed-Replacement
 *  5. "von X bis Y" extrahiert Startzeit auch ohne Doppelpunkt
 *  6. Location-Regex stoppt vor Zeitausdrücken (um/von/bis + Zahl)
 *  7. Wochentage/Datumswörter als Location geblockt
 *  8. "bis X" ignoriert Nicht-Zeit-Einheiten (km, %, etc.)
 *  9. Stunden/Minuten-Validierung (0-23 / 0-59)
 * 10. "Guten Morgen" wird nicht mehr als Datum geparst
 * 11. MONTH_MAP no-op-Replace entfernt
 */

export interface ParsedEvent {
  summary: string;
  start: string;       // ISO-like "YYYY-MM-DDTHH:MM:00" or "YYYY-MM-DD" for all-day
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

function isValidTime(h: number, m: number): boolean {
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Unicode-aware Wortgrenzen für Deutsch ───────────────────────────────────
//
// JavaScript's \b behandelt ä, ö, ü, ß als Nicht-Wortzeichen.
// Dadurch matcht z.B. \bfr\b fälschlicherweise in "Frühdienst",
// weil \b zwischen 'r' und 'ü' feuert.
//
// Diese Lookbehind/Lookahead-Konstrukte respektieren deutsche Buchstaben.

const NLB = "(?<![a-zA-ZäöüÄÖÜß])";   // Not Letter Before
const NLA = "(?![a-zA-ZäöüÄÖÜß])";    // Not Letter After

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

const WEEKDAY_FULL = "montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag";
const WEEKDAY_SHORT = "mo|di|mi|do|fr|sa|so";
const WEEKDAY_ALL = WEEKDAY_FULL + "|" + WEEKDAY_SHORT;

const WEEKDAY_MAP: Record<string, number> = {
  montag: 1, mo: 1,
  dienstag: 2, di: 2,
  mittwoch: 3, mi: 3,
  donnerstag: 4, do: 4,
  freitag: 5, fr: 5,
  samstag: 6, sa: 6,
  sonntag: 0, so: 0,
};

// Schnelles Lookup für Location-Blacklist
const WEEKDAY_NAMES = new Set(Object.keys(WEEKDAY_MAP));

// ─── Datum erkennen ───────────────────────────────────────────────────────────

interface DateResult {
  date: Date;
  consumed: string;
}

function resolveDate(input: string): DateResult | null {
  const lower = input.toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // ── "heute" ──
  const heuteM = lower.match(new RegExp(`${NLB}(heute)${NLA}`));
  if (heuteM) {
    return { date: new Date(today), consumed: heuteM[1] };
  }

  // ── "morgen" — aber NICHT "guten morgen" (Begrüßung) ──
  const morgenRe = new RegExp(`${NLB}(morgen)${NLA}`);
  if (morgenRe.test(lower) && !/\bguten?\s+morgen\b/i.test(input)) {
    const m = lower.match(morgenRe);
    if (m) return { date: addDays(today, 1), consumed: m[1] };
  }

  // ── "übermorgen" ──
  const ueberM = lower.match(new RegExp(`${NLB}(übermorgen)${NLA}`));
  if (ueberM) {
    return { date: addDays(today, 2), consumed: ueberM[1] };
  }

  // ── "nächsten Montag" / "nächste Woche Freitag" ──
  const nextWdRe = new RegExp(
    `(n[äa]chste[ns]?\\s+)(${WEEKDAY_ALL})${NLA}`
  );
  const nextWd = lower.match(nextWdRe);
  if (nextWd) {
    const target = WEEKDAY_MAP[nextWd[2]];
    if (target !== undefined) {
      const d = new Date(today);
      d.setDate(d.getDate() + 1);
      while (d.getDay() !== target) d.setDate(d.getDate() + 1);
      if (d <= today) d.setDate(d.getDate() + 7);
      return { date: d, consumed: nextWd[0] };
    }
  }

  // ── Einzelner Wochentag mit Unicode-Grenzen ──
  const wdRe = new RegExp(`${NLB}(${WEEKDAY_ALL})${NLA}`);
  const wdM = lower.match(wdRe);
  if (wdM) {
    const target = WEEKDAY_MAP[wdM[1]];
    if (target !== undefined) {
      const d = new Date(today);
      if (d.getDay() === target) {
        d.setDate(d.getDate() + 7);
      } else {
        d.setDate(d.getDate() + 1);
        while (d.getDay() !== target) d.setDate(d.getDate() + 1);
      }
      return { date: d, consumed: wdM[0] };
    }
  }

  // ── Punkt-Datum: zwingend Punkt NACH dem Monat ──
  // Matcht: "15.7." "15.07." "15.07.2026" — NICHT "8.30" (das ist eine Uhrzeit)
  // Zusätzlich Monats-Validierung (1-12)
  const dotDate = lower.match(
    /\b(\d{1,2})\.(\d{1,2})\.(?:\s*(\d{4}))?/
  );
  if (dotDate) {
    const day = parseInt(dotDate[1]);
    const monthNum = parseInt(dotDate[2]);
    if (monthNum >= 1 && monthNum <= 12 && day >= 1 && day <= 31) {
      const month = monthNum - 1;
      const year = dotDate[3] ? parseInt(dotDate[3]) : today.getFullYear();
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) {
        if (d < today && !dotDate[3]) d.setFullYear(d.getFullYear() + 1);
        return { date: d, consumed: dotDate[0] };
      }
    }
  }

  // ── "15. Juli 2026" / "15. Juli" ──
  const monthNameDate = lower.match(
    /(\d{1,2})\.\s*(jan(?:uar)?|feb(?:ruar)?|m[äa]r(?:z)?|apr(?:il)?|mai|jun(?:i)?|jul(?:i)?|aug(?:ust)?|sep(?:t(?:ember)?)?|okt(?:ober)?|nov(?:ember)?|dez(?:ember)?)\s*(\d{4})?/
  );
  if (monthNameDate) {
    const day = parseInt(monthNameDate[1]);
    const month = MONTH_MAP[monthNameDate[2]];
    if (month !== undefined) {
      const year = monthNameDate[3] ? parseInt(monthNameDate[3]) : today.getFullYear();
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) {
        if (d < today && !monthNameDate[3]) d.setFullYear(d.getFullYear() + 1);
        return { date: d, consumed: monthNameDate[0] };
      }
    }
  }

  // ── "in X Tagen" ──
  const inDays = lower.match(/\bin\s+(\d+)\s+tagen?\b/);
  if (inDays) {
    return { date: addDays(today, parseInt(inDays[1])), consumed: inDays[0] };
  }

  // ── "in X Wochen" ──
  const inWeeks = lower.match(/\bin\s+(\d+)\s+wochen?\b/);
  if (inWeeks) {
    return { date: addDays(today, parseInt(inWeeks[1]) * 7), consumed: inWeeks[0] };
  }

  return null;
}

// ─── Zeit erkennen ───────────────────────────────────────────────────────────

interface TimeResult {
  hours: number;
  minutes: number;
  consumed: string;
}

function resolveTime(input: string): TimeResult | null {
  const lower = input.toLowerCase();

  // ── "von 8:30 bis …" / "von 8.30 bis …" — Startzeit aus "von X bis" ──
  const vonBisHHMM = lower.match(
    /\b(von\s+(\d{1,2})[:\.](\d{2})\s*(?:uhr)?)\s+bis\b/
  );
  if (vonBisHHMM) {
    const h = parseInt(vonBisHHMM[2]), m = parseInt(vonBisHHMM[3]);
    if (isValidTime(h, m)) {
      return { hours: h, minutes: m, consumed: vonBisHHMM[1] };
    }
  }

  // ── "von 8 bis …" — Startzeit ohne Minuten ──
  const vonBisH = lower.match(
    /\b(von\s+(\d{1,2})\s*(?:uhr)?)\s+bis\b/
  );
  if (vonBisH) {
    const h = parseInt(vonBisH[2]);
    if (isValidTime(h, 0)) {
      return { hours: h, minutes: 0, consumed: vonBisH[1] };
    }
  }

  // ── "14:30 Uhr" / "14:30" / "14.30 Uhr" ──
  const hhmm = lower.match(/\b(\d{1,2})[:\.](\d{2})\s*(?:uhr)?\b/);
  if (hhmm) {
    const h = parseInt(hhmm[1]), m = parseInt(hhmm[2]);
    if (isValidTime(h, m)) {
      return { hours: h, minutes: m, consumed: hhmm[0] };
    }
  }

  // ── "14 Uhr" / "um 14 Uhr" ──
  const hourOnly = lower.match(/(?:um\s+)?(\d{1,2})\s*uhr\b/);
  if (hourOnly) {
    const h = parseInt(hourOnly[1]);
    if (isValidTime(h, 0)) {
      return { hours: h, minutes: 0, consumed: hourOnly[0] };
    }
  }

  // ── "um 9" (mit explizitem "um", ohne "Uhr") ──
  // Negativer Lookahead: nicht matchen wenn direkt :, . oder Ziffer folgt
  // (der User hat explizit Minuten angegeben, die aber invalid waren)
  const umHour = lower.match(/\bum\s+(\d{1,2})(?![:\.\d])\b/);
  if (umHour) {
    const h = parseInt(umHour[1]);
    if (isValidTime(h, 0)) {
      return { hours: h, minutes: 0, consumed: umHour[0] };
    }
  }

  return null;
}

// ─── End-Zeit erkennen ────────────────────────────────────────────────────────

interface EndTimeResult {
  hours: number;
  minutes: number;
  consumed: string;
}

// Einheiten die "bis X" NICHT als Uhrzeit qualifizieren
const BIS_UNIT_BLOCK =
  "(?!\\s*(?:km|m|%|€|euro|cent|min(?:uten?)?|std|stunden?|st[üu]ck|mal|tage?n?|wochen?|monate?n?|jahr(?:en?)?|grad)\\b)";

function resolveEndTime(input: string): EndTimeResult | null {
  const lower = input.toLowerCase();

  // ── "bis 16:00 Uhr" / "bis 16.30" ──
  const bisFull = lower.match(/\bbis\s+(\d{1,2})[:\.](\d{2})\s*(?:uhr)?\b/);
  if (bisFull) {
    const h = parseInt(bisFull[1]), m = parseInt(bisFull[2]);
    if (isValidTime(h, m)) {
      return { hours: h, minutes: m, consumed: bisFull[0] };
    }
  }

  // ── "bis 16 Uhr" / "bis 16" (mit Einheiten-Ausschluss) ──
  const bisHourRe = new RegExp(
    `\\bbis\\s+(\\d{1,2})\\s*(?:uhr)?\\b${BIS_UNIT_BLOCK}`
  );
  const bisHour = lower.match(bisHourRe);
  if (bisHour) {
    const h = parseInt(bisHour[1]);
    if (isValidTime(h, 0)) {
      return { hours: h, minutes: 0, consumed: bisHour[0] };
    }
  }

  return null;
}

// ─── Ort erkennen ────────────────────────────────────────────────────────────

const LOCATION_TRIGGERS = [
  // Präposition + Großbuchstabe, stoppt vor Zeitmarkern (um/von/bis/ab + Zahl)
  /\b(?:im|in|bei|am|an|auf|beim)\s+([A-ZÄÖÜ][^,\.!?]*?)(?:\s+(?:um|von|bis|ab)\s+\d|\s*[,\.!?]|$)/,
  // Komma-basiert: "..., Rathaus"
  /,\s*([A-ZÄÖÜ][^,\.!?]{2,30})(?:\s*[,\.!?]|$)/,
];

function resolveLocation(input: string): string | undefined {
  for (const re of LOCATION_TRIGGERS) {
    const m = input.match(re);
    if (m) {
      const loc = m[1].trim();
      // Überspringen wenn mit Ziffer beginnt
      if (/^\d/.test(loc)) continue;
      // Überspringen bei sehr kurzen Einzelwörtern (≤2 Zeichen)
      if (loc.split(" ").length === 1 && loc.length < 3) continue;
      // Überspringen wenn erstes Wort ein Wochentag ist
      const firstWord = loc.split(/\s+/)[0].toLowerCase();
      if (WEEKDAY_NAMES.has(firstWord)) continue;
      // Überspringen bei Datumswörtern
      if (/^(heute|morgen|übermorgen|nächste[nrs]?|ganztägig)/i.test(firstWord)) continue;
      // Überspringen bei Monatsnamen
      if (MONTH_MAP[firstWord] !== undefined) continue;
      return loc;
    }
  }
  return undefined;
}

// ─── Ganztägig erkennen ───────────────────────────────────────────────────────

function isAllDay(input: string): boolean {
  return /\bganztägig\b|\bganztagig\b|\bganz tag\b|\bganze tag\b/i.test(input);
}

// ─── Zusammenfassung aus Rest-Text extrahieren ────────────────────────────────

function extractSummary(input: string, consumed: string[]): string {
  let text = input;

  // Consumed Tokens entfernen (case-insensitive)
  for (const c of consumed) {
    if (!c) continue;
    text = text.replace(new RegExp(escapeRegExp(c), "gi"), " ");
  }

  // Füllwörter entfernen
  text = text
    .replace(/\bam\b/gi, " ")
    .replace(/\bum\b/gi, " ")
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

  // 1. Datum
  const dateResult = resolveDate(input);
  let baseDate: Date;
  let inputForTime = input;
  if (dateResult) {
    baseDate = dateResult.date;
    consumed.push(dateResult.consumed);
    // Datum-Tokens aus dem Input entfernen damit der Zeit-Parser
    // sie nicht nochmal matcht (z.B. "15.07." nicht als 15:07)
    inputForTime = input.replace(
      new RegExp(escapeRegExp(dateResult.consumed), "gi"),
      (m) => " ".repeat(m.length),
    );
  } else {
    baseDate = new Date();
    baseDate.setHours(0, 0, 0, 0);
  }

  // 2. Ganztägig?
  const allDay = isAllDay(input);
  if (allDay) consumed.push("ganztägig", "ganztagig", "ganze tag", "ganz tag");

  // 3. Startzeit (auf bereinigtem Input, ohne Datum-Tokens)
  const timeResult = allDay ? null : resolveTime(inputForTime);
  let startDate: Date;
  if (timeResult) {
    startDate = setTime(baseDate, timeResult.hours, timeResult.minutes);
    consumed.push(timeResult.consumed);
  } else if (allDay) {
    startDate = new Date(baseDate);
    startDate.setHours(0, 0, 0, 0);
  } else {
    // Keine Zeit gefunden: Default 09:00
    startDate = setTime(baseDate, 9, 0);
  }

  // 4. Endzeit (ebenfalls auf bereinigtem Input)
  const endTimeResult = allDay ? null : resolveEndTime(inputForTime);
  let endDate: Date;
  if (endTimeResult) {
    endDate = setTime(baseDate, endTimeResult.hours, endTimeResult.minutes);
    consumed.push(endTimeResult.consumed);
    // Sanity: Ende muss nach Start liegen
    if (endDate <= startDate) endDate = addHours(startDate, 1);
  } else if (allDay) {
    // Ganztägig: Ende = nächster Tag (iCal exklusiv)
    endDate = addDays(startDate, 1);
  } else {
    // Default: 1 Stunde
    endDate = addHours(startDate, 1);
  }

  // 5. Ort
  const location = resolveLocation(input);

  // 6. Zusammenfassung (was übrig bleibt)
  const summary = extractSummary(input, consumed);

  return {
    summary,
    start: dateToLocalISO(startDate, allDay),
    end: dateToLocalISO(endDate, allDay),
    all_day: allDay,
    location,
  };
}
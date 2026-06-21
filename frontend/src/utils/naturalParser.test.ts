import { describe, it, expect, beforeEach, vi } from "vitest";
import { parseNaturalEvent } from "./naturalParser";

// Pin "today" so tests are deterministic
function fakeToday(dateStr: string) {
  const fake = new Date(dateStr + "T00:00:00");
  vi.useFakeTimers();
  vi.setSystemTime(fake);
}

beforeEach(() => {
  fakeToday("2026-06-21");
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function date(r: ReturnType<typeof parseNaturalEvent>) {
  return r!.start.slice(0, 10);
}
function startTime(r: ReturnType<typeof parseNaturalEvent>) {
  return r!.start.slice(11, 16);
}
function endTime(r: ReturnType<typeof parseNaturalEvent>) {
  return r!.end.slice(11, 16);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Bestehende Funktionalität (Regression Guard)
// ═══════════════════════════════════════════════════════════════════════════

describe("existing: date recognition", () => {
  it("heute", () => {
    const r = parseNaturalEvent("heute 10 Uhr Meeting");
    expect(date(r)).toBe("2026-06-21");
    expect(r!.summary).toBe("Meeting");
  });

  it("morgen", () => {
    const r = parseNaturalEvent("morgen 14 Uhr Zahnarzt");
    expect(date(r)).toBe("2026-06-22");
    expect(r!.summary).toBe("Zahnarzt");
  });

  it("übermorgen", () => {
    const r = parseNaturalEvent("übermorgen Termin");
    expect(date(r)).toBe("2026-06-23");
  });

  it("guten morgen is not a date", () => {
    const r = parseNaturalEvent("guten morgen 10 Uhr Call");
    expect(date(r)).toBe("2026-06-21"); // today, not tomorrow
  });

  it("nächsten Montag", () => {
    // 2026-06-21 is a Sunday, so nächsten Montag = 2026-06-22
    const r = parseNaturalEvent("nächsten Montag Meeting");
    expect(date(r)).toBe("2026-06-22");
  });

  it("single weekday (Freitag)", () => {
    // 2026-06-21 = Sunday, next Freitag = 2026-06-26
    const r = parseNaturalEvent("Freitag Kino");
    expect(date(r)).toBe("2026-06-26");
  });

  it("dot-date with trailing dot: 24.06.", () => {
    const r = parseNaturalEvent("24.06. Hausarbeit");
    expect(date(r)).toBe("2026-06-24");
  });

  it("dot-date with year: 15.07.2026", () => {
    const r = parseNaturalEvent("15.07.2026 Geburtstag");
    expect(date(r)).toBe("2026-07-15");
  });

  it("month name date: 15. Juli", () => {
    const r = parseNaturalEvent("15. Juli Party");
    expect(date(r)).toBe("2026-07-15");
  });

  it("in 3 Tagen", () => {
    const r = parseNaturalEvent("in 3 Tagen Termin");
    expect(date(r)).toBe("2026-06-24");
  });

  it("in 2 Wochen", () => {
    const r = parseNaturalEvent("in 2 Wochen Urlaub");
    expect(date(r)).toBe("2026-07-05");
  });
});

describe("existing: time recognition", () => {
  it("von 8:30 bis 10", () => {
    const r = parseNaturalEvent("heute von 8:30 bis 10 Meeting");
    expect(startTime(r)).toBe("08:30");
    expect(endTime(r)).toBe("10:00");
  });

  it("14:30 Uhr", () => {
    const r = parseNaturalEvent("morgen 14:30 Uhr Zahnarzt");
    expect(startTime(r)).toBe("14:30");
  });

  it("14 Uhr", () => {
    const r = parseNaturalEvent("morgen 14 Uhr Kaffee");
    expect(startTime(r)).toBe("14:00");
  });

  it("um 9", () => {
    const r = parseNaturalEvent("heute um 9 Standup");
    expect(startTime(r)).toBe("09:00");
  });

  it("von 10 bis 12", () => {
    const r = parseNaturalEvent("heute von 10 bis 12 Workshop");
    expect(startTime(r)).toBe("10:00");
    expect(endTime(r)).toBe("12:00");
  });

  it("default time is 09:00", () => {
    const r = parseNaturalEvent("morgen Meeting");
    expect(startTime(r)).toBe("09:00");
  });

  it("default end time is +1h", () => {
    const r = parseNaturalEvent("morgen 14 Uhr Meeting");
    expect(endTime(r)).toBe("15:00");
  });
});

describe("existing: all-day", () => {
  it("ganztägig", () => {
    const r = parseNaturalEvent("morgen ganztägig Ausflug");
    expect(r!.all_day).toBe(true);
    expect(r!.start).toBe("2026-06-22");
    expect(r!.end).toBe("2026-06-23");
  });
});

describe("existing: location", () => {
  it("im Rathaus", () => {
    const r = parseNaturalEvent("morgen 14 Uhr im Rathaus Besprechung");
    expect(r!.location).toBe("Rathaus Besprechung");
  });

  it("bei Sara", () => {
    const r = parseNaturalEvent("Freitag 18 Uhr bei Sara Essen");
    expect(r!.location).toBe("Sara Essen");
  });
});

describe("existing: summary extraction", () => {
  it("removes consumed tokens", () => {
    const r = parseNaturalEvent("morgen 14 Uhr Zahnarzt");
    expect(r!.summary).toBe("Zahnarzt");
  });

  it("defaults to Neuer Termin", () => {
    const r = parseNaturalEvent("morgen um 9");
    expect(r!.summary).toBe("Neuer Termin");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Neue Features
// ═══════════════════════════════════════════════════════════════════════════

describe("new: dot-date without trailing dot", () => {
  it("24.06 without trailing dot", () => {
    const r = parseNaturalEvent("am 24.06 von 10 bis 12 Hausarbeit");
    expect(date(r)).toBe("2026-06-24");
    expect(startTime(r)).toBe("10:00");
    expect(endTime(r)).toBe("12:00");
    expect(r!.summary).toBe("Hausarbeit");
  });

  it("5.7 short format", () => {
    const r = parseNaturalEvent("5.7 Grillparty");
    expect(date(r)).toBe("2026-07-05");
  });

  it("still works with trailing dot", () => {
    const r = parseNaturalEvent("24.06. Hausarbeit");
    expect(date(r)).toBe("2026-06-24");
  });

  it("does not confuse 8.30 as date (time format)", () => {
    const r = parseNaturalEvent("morgen 8.30 Meeting");
    expect(date(r)).toBe("2026-06-22");
    expect(startTime(r)).toBe("08:30");
  });
});

describe("new: 'am' as date prefix", () => {
  it("am Montag", () => {
    const r = parseNaturalEvent("am Montag Friseur");
    expect(date(r)).toBe("2026-06-22");
    expect(r!.summary).toBe("Friseur");
  });

  it("am Freitag 14 Uhr", () => {
    const r = parseNaturalEvent("am Freitag 14 Uhr Workshop");
    expect(date(r)).toBe("2026-06-26");
  });

  it("am 24.06", () => {
    const r = parseNaturalEvent("am 24.06 Termin");
    expect(date(r)).toBe("2026-06-24");
  });
});

describe("new: 'nächste Woche Freitag' fix", () => {
  it("nächste Woche Freitag", () => {
    // 2026-06-21 = Sunday → next week Freitag = 2026-06-26
    const r = parseNaturalEvent("nächste Woche Freitag 10 Uhr Meeting");
    expect(date(r)).toBe("2026-06-26");
  });

  it("nächste Woche Montag", () => {
    const r = parseNaturalEvent("nächste Woche Montag Standup");
    expect(date(r)).toBe("2026-06-22");
  });
});

describe("new: 'diesen/kommenden' + weekday", () => {
  it("diesen Mittwoch", () => {
    const r = parseNaturalEvent("diesen Mittwoch Arzt");
    expect(date(r)).toBe("2026-06-24");
  });

  it("kommenden Freitag", () => {
    const r = parseNaturalEvent("kommenden Freitag Kino");
    expect(date(r)).toBe("2026-06-26");
  });
});

describe("new: day-part times", () => {
  it("morgens → 08:00", () => {
    const r = parseNaturalEvent("morgen morgens Joggen");
    expect(startTime(r)).toBe("08:00");
  });

  it("vormittags → 10:00", () => {
    const r = parseNaturalEvent("Montag vormittags Einkaufen");
    expect(startTime(r)).toBe("10:00");
  });

  it("mittags → 12:00", () => {
    const r = parseNaturalEvent("morgen mittags Lunch");
    expect(startTime(r)).toBe("12:00");
  });

  it("nachmittags → 14:00", () => {
    const r = parseNaturalEvent("Freitag nachmittags Sport");
    expect(startTime(r)).toBe("14:00");
  });

  it("abends → 18:00", () => {
    const r = parseNaturalEvent("morgen abends Kino");
    expect(startTime(r)).toBe("18:00");
  });

  it("nachts → 22:00", () => {
    const r = parseNaturalEvent("Samstag nachts Party");
    expect(startTime(r)).toBe("22:00");
  });

  it("exact time takes priority over day-part", () => {
    const r = parseNaturalEvent("morgen abends 20 Uhr Kino");
    expect(startTime(r)).toBe("20:00");
  });
});

describe("new: 'ab' as start time marker", () => {
  it("ab 15 Uhr", () => {
    const r = parseNaturalEvent("Freitag ab 15 Uhr Workshop");
    expect(startTime(r)).toBe("15:00");
  });

  it("ab 9:30", () => {
    const r = parseNaturalEvent("morgen ab 9:30 Seminar");
    expect(startTime(r)).toBe("09:30");
  });
});

describe("new: duration as end time", () => {
  it("2 Stunden", () => {
    const r = parseNaturalEvent("morgen 14 Uhr Meeting 2 Stunden");
    expect(startTime(r)).toBe("14:00");
    expect(endTime(r)).toBe("16:00");
  });

  it("90 Minuten", () => {
    const r = parseNaturalEvent("morgen 10 Uhr Yoga 90 Minuten");
    expect(startTime(r)).toBe("10:00");
    expect(endTime(r)).toBe("11:30");
  });

  it("1.5 Stunden", () => {
    const r = parseNaturalEvent("morgen 9 Uhr Training 1.5 Stunden");
    expect(startTime(r)).toBe("09:00");
    expect(endTime(r)).toBe("10:30");
  });
});

describe("new: relative times", () => {
  it("in 30 Minuten", () => {
    vi.setSystemTime(new Date("2026-06-21T14:00:00"));
    const r = parseNaturalEvent("in 30 Minuten Telko");
    expect(startTime(r)).toBe("14:30");
  });

  it("in 2 Stunden", () => {
    vi.setSystemTime(new Date("2026-06-21T10:00:00"));
    const r = parseNaturalEvent("in 2 Stunden Lunch");
    expect(startTime(r)).toBe("12:00");
  });
});

describe("new: time range without 'von'", () => {
  it("10 bis 12 Uhr", () => {
    const r = parseNaturalEvent("Montag 10 bis 12 Uhr Meeting");
    expect(startTime(r)).toBe("10:00");
    expect(endTime(r)).toBe("12:00");
  });

  it("10 bis 12 (without Uhr)", () => {
    const r = parseNaturalEvent("Montag 10 bis 12 Meeting");
    expect(startTime(r)).toBe("10:00");
    expect(endTime(r)).toBe("12:00");
  });

  it("9:30 bis 11:00", () => {
    const r = parseNaturalEvent("morgen 9:30 bis 11:00 Besprechung");
    expect(startTime(r)).toBe("09:30");
    expect(endTime(r)).toBe("11:00");
  });
});

describe("new: location with articles", () => {
  it("in der Bibliothek", () => {
    const r = parseNaturalEvent("Montag 10 Uhr in der Bibliothek lernen");
    expect(r!.location).toBe("Bibliothek lernen");
  });

  it("auf dem Sportplatz", () => {
    const r = parseNaturalEvent("Freitag 16 Uhr auf dem Sportplatz Training");
    expect(r!.location).toBe("Sportplatz Training");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Original failing example from user
// ═══════════════════════════════════════════════════════════════════════════

describe("new: hyphen time ranges", () => {
  it("8-12", () => {
    const r = parseNaturalEvent("morgen 8-12 Meeting");
    expect(startTime(r)).toBe("08:00");
    expect(endTime(r)).toBe("12:00");
  });

  it("8:30-12:00", () => {
    const r = parseNaturalEvent("morgen 8:30-12:00 Workshop");
    expect(startTime(r)).toBe("08:30");
    expect(endTime(r)).toBe("12:00");
  });

  it("14-16", () => {
    const r = parseNaturalEvent("Freitag 14-16 Sport");
    expect(startTime(r)).toBe("14:00");
    expect(endTime(r)).toBe("16:00");
    expect(r!.summary).toBe("Sport");
  });

  it("9-17 Uhr", () => {
    const r = parseNaturalEvent("morgen 9-17 Uhr Arbeit");
    expect(startTime(r)).toBe("09:00");
    expect(endTime(r)).toBe("17:00");
  });
});

describe("new: explicit date priority over weekday", () => {
  it("Do 25.6 uses the explicit date", () => {
    const r = parseNaturalEvent("Frühdienst Do 25.6 8-12");
    expect(date(r)).toBe("2026-06-25");
    expect(r!.summary).toBe("Frühdienst");
  });

  it("Mi 1.7 uses explicit date even if not a Wednesday", () => {
    // 2026-07-01 is a Wednesday, but the point is the explicit date wins
    const r = parseNaturalEvent("Mi 1.7 Meeting");
    expect(date(r)).toBe("2026-07-01");
  });
});

describe("user's second failing input", () => {
  it("Frühdienst Do 25.6 8-12", () => {
    const r = parseNaturalEvent("Frühdienst Do 25.6 8-12");
    expect(date(r)).toBe("2026-06-25");
    expect(startTime(r)).toBe("08:00");
    expect(endTime(r)).toBe("12:00");
    expect(r!.summary).toBe("Frühdienst");
  });
});

describe("user's original failing input", () => {
  it("am 24.06 von 10 bis 12 Hausarbeit", () => {
    const r = parseNaturalEvent("am 24.06 von 10 bis 12 Hausarbeit");
    expect(date(r)).toBe("2026-06-24");
    expect(startTime(r)).toBe("10:00");
    expect(endTime(r)).toBe("12:00");
    expect(r!.summary).toBe("Hausarbeit");
    expect(r!.all_day).toBe(false);
  });
});

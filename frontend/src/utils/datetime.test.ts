// frontend/src/utils/datetime.test.ts
//
// Reine Funktionstests für die naive-lokale Datum/Zeit-Arithmetik, die von
// ShareDialog, ShareDriftDialog und EventPopup für die "Mit Oma + Opa
// teilen"-Funktion genutzt wird. Kein UTC-Roundtrip — siehe datetime.ts.

import { describe, it, expect } from "vitest";
import {
  parseLocalDatetime,
  toBackendDatetime,
  toLocalDateStr,
  addMinutesLocal,
  addDaysLocal,
  mapRecurrenceId,
} from "./datetime";

describe("parseLocalDatetime", () => {
  it("parses a naive local datetime string as local wall-clock time (no UTC conversion)", () => {
    const d = parseLocalDatetime("2026-08-17T10:30:00");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // 0-based
    expect(d.getDate()).toBe(17);
    expect(d.getHours()).toBe(10);
    expect(d.getMinutes()).toBe(30);
  });

  it("parses a minute-precision string (no seconds)", () => {
    const d = parseLocalDatetime("2026-08-17T10:30");
    expect(d.getHours()).toBe(10);
    expect(d.getMinutes()).toBe(30);
  });

  it("parses a bare date string as local midnight", () => {
    const d = parseLocalDatetime("2026-08-17");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(17);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
});

describe("toBackendDatetime", () => {
  it("formats a Date as naive local YYYY-MM-DDTHH:mm with zero-padding", () => {
    const d = new Date(2026, 0, 5, 9, 5, 0); // 5. Jan 2026, 09:05
    expect(toBackendDatetime(d)).toBe("2026-01-05T09:05");
  });
});

describe("toLocalDateStr", () => {
  it("formats a Date as naive local YYYY-MM-DD with zero-padding", () => {
    const d = new Date(2026, 0, 5);
    expect(toLocalDateStr(d)).toBe("2026-01-05");
  });
});

describe("addMinutesLocal", () => {
  it("returns the same value unchanged for a buffer of 0", () => {
    expect(addMinutesLocal("2026-08-17T10:00", 0)).toBe("2026-08-17T10:00");
  });

  it("adds a positive buffer crossing an hour boundary", () => {
    expect(addMinutesLocal("2026-08-17T10:45", 30)).toBe("2026-08-17T11:15");
  });

  it("subtracts minutes crossing a day boundary", () => {
    expect(addMinutesLocal("2026-08-17T00:10", -20)).toBe("2026-08-16T23:50");
  });

  it("never converts through UTC (no offset shift for any buffer, including 0)", () => {
    // Regression guard for the original bug: new Date(iso).toISOString() shifted
    // every value by the local UTC offset, even when minutes=0.
    const input = "2026-08-17T12:30";
    const result = addMinutesLocal(input, 0);
    expect(result).toBe(input);
  });
});

describe("addDaysLocal", () => {
  it("adds a day across a month boundary", () => {
    expect(addDaysLocal("2026-08-31", 1)).toBe("2026-09-01");
  });

  it("supports negative days", () => {
    expect(addDaysLocal("2026-09-01", -1)).toBe("2026-08-31");
  });
});

describe("mapRecurrenceId", () => {
  it("subtracts buffer_before_minutes from the source recurrence id (not add)", () => {
    // Shared copy's DTSTART = source.start - buffer_before_minutes, so every
    // instance on the copy sits buffer_before_minutes EARLIER than the
    // corresponding source instance.
    const sourceRid = "2026-08-17T10:00:00";
    const bufferBefore = 30;
    expect(mapRecurrenceId(sourceRid, bufferBefore)).toBe("2026-08-17T09:30");
    // explicitly assert it is NOT the (buggy) addition
    expect(mapRecurrenceId(sourceRid, bufferBefore)).not.toBe("2026-08-17T10:30");
  });

  it("is a no-op for a buffer of 0", () => {
    expect(mapRecurrenceId("2026-08-17T10:00:00", 0)).toBe("2026-08-17T10:00");
  });

  it("crosses a day boundary correctly", () => {
    expect(mapRecurrenceId("2026-08-17T00:10:00", 20)).toBe("2026-08-16T23:50");
  });
});

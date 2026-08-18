// frontend/src/components/ShareDriftDialog.test.ts
//
// Testet die reine Payload-Bau-Funktion aus ShareDriftDialog.tsx —
// insbesondere Fix 1: ein series-level "Aktualisieren" darf die RRULE der
// geteilten Kopie niemals weglassen (sonst wird die Serie beim Schreiben
// stillschweigend zu einem Einzeltermin, Datenverlust).

import { describe, it, expect } from "vitest";
import { buildDriftUpdatePayload } from "./ShareDriftDialog";

describe("buildDriftUpdatePayload", () => {
  it("includes the source rrule on a series-level (non-instance) update", () => {
    const payload = buildDriftUpdatePayload({
      etag: "etag-1",
      summary: "Kaffee mit Oma",
      start: "2026-08-17T09:30",
      end: "2026-08-17T10:30",
      allDay: false,
      sourceRrule: "FREQ=WEEKLY;UNTIL=20261231T235959Z",
      isInstance: false,
      copyHasSeriesRrule: true,
    });

    expect(payload.rrule).toBe("FREQ=WEEKLY;UNTIL=20261231T235959Z");
    expect(payload.mode).toBe("all");
    expect(payload.recurrence_id).toBeUndefined();
  });

  it("includes the rrule even for a pure title-only edit of a series", () => {
    // Regression guard: the bug affected ANY series-level drift resolution,
    // including edits that only touch the title.
    const payload = buildDriftUpdatePayload({
      etag: "etag-1",
      summary: "Neuer Titel",
      start: "2026-08-17T09:30",
      end: "2026-08-17T10:30",
      allDay: false,
      sourceRrule: "FREQ=DAILY",
      isInstance: false,
      copyHasSeriesRrule: true,
    });

    expect(payload.rrule).toBe("FREQ=DAILY");
  });

  it("omits rrule/mode for a non-recurring share (no series to preserve)", () => {
    const payload = buildDriftUpdatePayload({
      etag: "etag-1",
      summary: "Einzeltermin",
      start: "2026-08-17T09:30",
      end: "2026-08-17T10:30",
      allDay: false,
      sourceRrule: null,
      isInstance: false,
      copyHasSeriesRrule: false,
    });

    expect(payload.rrule).toBeNull();
    expect(payload.mode).toBeUndefined();
  });

  it("targets a single instance via recurrence_id and does not send rrule", () => {
    const payload = buildDriftUpdatePayload({
      etag: "etag-1",
      summary: "Kaffee mit Oma",
      start: "2026-08-17T09:30",
      end: "2026-08-17T10:30",
      allDay: false,
      sourceRrule: "FREQ=WEEKLY",
      isInstance: true,
      mappedRecurrenceId: "2026-08-17T09:00",
      copyHasSeriesRrule: true,
    });

    expect(payload.mode).toBe("single");
    expect(payload.recurrence_id).toBe("2026-08-17T09:00");
    expect(payload.rrule).toBeUndefined();
  });
});

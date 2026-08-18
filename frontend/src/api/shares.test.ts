// frontend/src/api/shares.test.ts
//
// Regression guard: listEventShares muss recurrence_id als Query-Param
// mitschicken, wenn eine übergeben wird — sonst liefert das Backend nur
// series-level has_drift statt instance-level Drift für die aktuell
// geöffnete Instanz (siehe EventPopup.tsx driftShare-Lookup).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { listEventShares } from "./shares";

function mockFetchOnce(body: unknown = []) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
  } as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("listEventShares", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    // vite.config.ts runs tests under environment: "node" (no jsdom), so
    // listEventShares' `window.location.origin` needs a stub here.
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
  });

  it("sends only source_uid when no recurrence id is given", async () => {
    const fetchMock = mockFetchOnce();

    await listEventShares("event-uid-1");

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/api/event-shares");
    expect(calledUrl.searchParams.get("source_uid")).toBe("event-uid-1");
    expect(calledUrl.searchParams.has("recurrence_id")).toBe(false);
  });

  it("includes recurrence_id as-is (naive-local string, no reformatting) when provided", async () => {
    const fetchMock = mockFetchOnce();

    await listEventShares("event-uid-1", "2026-08-14T09:00:00");

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("source_uid")).toBe("event-uid-1");
    expect(calledUrl.searchParams.get("recurrence_id")).toBe("2026-08-14T09:00:00");
  });

  it("omits recurrence_id when it is null", async () => {
    const fetchMock = mockFetchOnce();

    await listEventShares("event-uid-1", null);

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.has("recurrence_id")).toBe(false);
  });
});

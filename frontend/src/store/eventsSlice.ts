// frontend/src/store/eventsSlice.ts
//
// Erweiterung des Zustand-Stores für Optimistic UI.
//
// INTEGRATION: Diese Logik in den bestehenden Store (`store/index.ts`) einbauen.
// Statt den gesamten Store zu ersetzen, werden hier die neuen State-Teile
// und Actions beschrieben, die hinzugefügt werden müssen.
//
// Voraussetzung: Der Store hat bereits `events: CalendarEvent[]` oder nutzt
// aktuell `useEvents`-Hook mit lokalem State. Falls Events bisher NUR im
// Hook-State leben, sollte man sie in den Store heben – oder den unten
// gezeigten `useOptimisticEvents`-Hook verwenden, der neben dem Hook-State läuft.

import { create } from 'zustand';
import type { CalendarEvent } from '../types';

// ── Option A: Separater Optimistic-Slice ─────────────────────────────────────
//
// Dieser Store verwaltet AUSSCHLIESSLICH optimistische Overrides.
// Der bestehende useEvents-Hook bleibt unverändert.
// Im CalendarView wird die Merge-Logik angewendet (siehe useOptimisticEvents).

interface OptimisticState {
  // Events die lokal hinzugefügt wurden (CREATE) aber noch nicht vom Server kommen
  added: CalendarEvent[];
  // UIDs die lokal gelöscht wurden
  deleted: Set<string>;
  // Events die lokal bearbeitet wurden (Map uid → updated event)
  updated: Map<string, CalendarEvent>;

  addOptimistic: (event: CalendarEvent) => void;
  updateOptimistic: (event: CalendarEvent) => void;
  deleteOptimistic: (uid: string) => void;
  rollbackAdd: (uid: string) => void;
  rollbackDelete: (uid: string) => void;
  rollbackUpdate: (uid: string) => void;
  clearAll: () => void;
}

export const useOptimisticStore = create<OptimisticState>((set) => ({
  added: [],
  deleted: new Set(),
  updated: new Map(),

  addOptimistic: (event) =>
    set((s) => ({ added: [...s.added, event] })),

  updateOptimistic: (event) =>
    set((s) => {
      const updated = new Map(s.updated);
      updated.set(event.uid, event);
      return { updated };
    }),

  deleteOptimistic: (uid) =>
    set((s) => ({ deleted: new Set([...s.deleted, uid]) })),

  rollbackAdd: (uid) =>
    set((s) => ({ added: s.added.filter((e) => e.uid !== uid) })),

  rollbackDelete: (uid) =>
    set((s) => {
      const deleted = new Set(s.deleted);
      deleted.delete(uid);
      return { deleted };
    }),

  rollbackUpdate: (uid) =>
    set((s) => {
      const updated = new Map(s.updated);
      updated.delete(uid);
      return { updated };
    }),

  clearAll: () =>
    set({ added: [], deleted: new Set(), updated: new Map() }),
}));

// ── Hook: Optimistic-Events mit Server-Events mergen ─────────────────────────
//
// Verwendung in CalendarView / MonthView:
//
//   const serverEvents = useEvents(from, to);
//   const events = useMergedEvents(serverEvents);
//
// Nach einem Refresh (useEvents lädt neu) werden die optimistischen Overrides
// automatisch irrelevant, weil die Server-Daten aktuell sind. clearAll() kann
// nach einem erfolgreichen Refresh aufgerufen werden.

export function useMergedEvents(serverEvents: CalendarEvent[]): CalendarEvent[] {
  const { added, deleted, updated } = useOptimisticStore();

  return [
    // Optimistisch hinzugefügte Events (die noch nicht vom Server kommen)
    ...added.filter((e) => !serverEvents.some((s) => s.uid === e.uid)),
    // Server-Events, gefiltert und mit Updates gemergt
    ...serverEvents
      .filter((e) => !deleted.has(e.uid))
      .map((e) => updated.get(e.uid) ?? e),
  ];
}

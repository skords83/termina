// frontend/src/store/eventsSlice.ts
//
// Optimistic-UI-Store für Termina.
//
// `useOptimisticStore` hält drei Arten von Overrides über die Server-Daten:
//   - `added`:   Events, die lokal angelegt wurden, aber noch nicht vom Server kommen
//   - `deleted`: UIDs, die lokal gelöscht wurden
//   - `updated`: Events, die lokal geändert wurden (Map uid → updated event)
//
// `useMergedEvents(serverEvents)` merged Server-Daten mit den Overrides UND
// räumt die Overrides selbständig auf, sobald der Server konsistent ist
// (Event taucht auf bzw. ist weg bzw. hat ein neueres ETag).
//
// → Es gibt KEINEN Blind-Timer mehr, der irgendwann `clearAll()` aufruft.
//   Genau das war die Ursache dafür, dass neue Termine nach ein paar Sekunden
//   verschwanden, wenn der Refetch noch nicht durch war.

import { useEffect } from 'react';
import { create } from 'zustand';
import type { CalendarEvent } from '../types';

// Schlüssel für eine einzelne Instanz einer wiederkehrenden Serie.
const occurrenceKey = (uid: string, recurrenceId: string) => `${uid}::${recurrenceId}`;

interface OptimisticState {
  added: CalendarEvent[];
  deleted: Set<string>;
  deletedOccurrences: Set<string>;
  updated: Map<string, CalendarEvent>;

  addOptimistic: (event: CalendarEvent) => void;
  updateOptimistic: (event: CalendarEvent) => void;
  // Ohne recurrenceId: löscht die ganze Serie/das ganze Event (Key = uid).
  // Mit recurrenceId: löscht nur diese eine Instanz (Key = uid::recurrenceId),
  // damit z.B. "nur diesen Termin löschen" bei Wiederholungen nicht die
  // gesamte Serie aus der Ansicht entfernt.
  deleteOptimistic: (uid: string, recurrenceId?: string | null) => void;
  rollbackAdd: (uid: string) => void;
  rollbackDelete: (uid: string) => void;
  rollbackDeleteOccurrence: (key: string) => void;
  rollbackUpdate: (uid: string) => void;
  clearAll: () => void;
}

export const useOptimisticStore = create<OptimisticState>((set) => ({
  added: [],
  deleted: new Set(),
  deletedOccurrences: new Set(),
  updated: new Map(),

  addOptimistic: (event) =>
    set((s) => ({ added: [...s.added, event] })),

  updateOptimistic: (event) =>
    set((s) => {
      const updated = new Map(s.updated);
      updated.set(event.uid, event);
      return { updated };
    }),

  deleteOptimistic: (uid, recurrenceId) =>
    set((s) =>
      recurrenceId
        ? { deletedOccurrences: new Set([...s.deletedOccurrences, occurrenceKey(uid, recurrenceId)]) }
        : { deleted: new Set([...s.deleted, uid]) }
    ),

  rollbackAdd: (uid) =>
    set((s) => ({ added: s.added.filter((e) => e.uid !== uid) })),

  rollbackDelete: (uid) =>
    set((s) => {
      const deleted = new Set(s.deleted);
      deleted.delete(uid);
      return { deleted };
    }),

  rollbackDeleteOccurrence: (key) =>
    set((s) => {
      const deletedOccurrences = new Set(s.deletedOccurrences);
      deletedOccurrences.delete(key);
      return { deletedOccurrences };
    }),

  rollbackUpdate: (uid) =>
    set((s) => {
      const updated = new Map(s.updated);
      updated.delete(uid);
      return { updated };
    }),

  clearAll: () =>
    set({ added: [], deleted: new Set(), deletedOccurrences: new Set(), updated: new Map() }),
}));

// ── Hook: Server-Events mit Optimistic-Overrides mergen ──────────────────────
//
// Verwendung:
//   const serverEvents = useEvents(token, from, to, refreshNonce);
//   const events = useMergedEvents(serverEvents);
//
// Sobald `serverEvents` einen optimistischen Eintrag bestätigt (oder das
// Gegenteil), räumt der Hook den Override selbst auf.

export function useMergedEvents(serverEvents: CalendarEvent[]): CalendarEvent[] {
  // Einzelselektoren → minimale Rerenders
  const added = useOptimisticStore((s) => s.added);
  const deleted = useOptimisticStore((s) => s.deleted);
  const deletedOccurrences = useOptimisticStore((s) => s.deletedOccurrences);
  const updated = useOptimisticStore((s) => s.updated);
  const rollbackAdd = useOptimisticStore((s) => s.rollbackAdd);
  const rollbackDelete = useOptimisticStore((s) => s.rollbackDelete);
  const rollbackDeleteOccurrence = useOptimisticStore((s) => s.rollbackDeleteOccurrence);
  const rollbackUpdate = useOptimisticStore((s) => s.rollbackUpdate);

  useEffect(() => {
    // CREATE: Server hat unser optimistisches Event jetzt → Override entfernen.
    //   Das Event kommt jetzt aus serverEvents, kein Flackern.
    added.forEach((e) => {
      if (serverEvents.some((s) => s.uid === e.uid)) {
        rollbackAdd(e.uid);
      }
    });

    // DELETE: Server liefert das gelöschte Event nicht mehr → Override weg.
    deleted.forEach((uid) => {
      if (!serverEvents.some((s) => s.uid === uid)) {
        rollbackDelete(uid);
      }
    });

    // DELETE (einzelne Instanz einer Wiederholung): Server liefert diese
    // Instanz nicht mehr → Override weg.
    deletedOccurrences.forEach((key) => {
      const stillOnServer = serverEvents.some((s) => s.recurrence_id && occurrenceKey(s.uid, s.recurrence_id) === key);
      if (!stillOnServer) {
        rollbackDeleteOccurrence(key);
      }
    });

    // UPDATE: Server hat ein neueres ETag → unser Override ist obsolet.
    //   `localEv.etag` ist das *alte* ETag (vor dem Edit). Sobald der Server
    //   ein anderes, nicht-leeres ETag liefert, ist die Server-Version aktuell.
    //   Solange der Server noch das alte ETag oder etag=null liefert
    //   (Background-Sync noch nicht durch), bleibt der lokale Override aktiv.
    updated.forEach((localEv, uid) => {
      const serverEv = serverEvents.find((s) => s.uid === uid);
      if (serverEv && serverEv.etag && serverEv.etag !== localEv.etag) {
        rollbackUpdate(uid);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverEvents]);

  return [
    // Optimistisch hinzugefügte Events, die noch nicht vom Server kommen
    ...added.filter((e) => !serverEvents.some((s) => s.uid === e.uid)),
    // Server-Events, gefiltert (DELETE) und gemergt (UPDATE)
    ...serverEvents
      .filter((e) => !deleted.has(e.uid))
      .filter((e) => !(e.recurrence_id && deletedOccurrences.has(occurrenceKey(e.uid, e.recurrence_id))))
      .map((e) => updated.get(e.uid) ?? e),
  ];
}
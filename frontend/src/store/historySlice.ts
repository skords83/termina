// frontend/src/store/historySlice.ts
//
// Undo/Redo-Grundgerüst für Termina.
//
// Speichert die letzten ~10 Aktionen (Create, Update, Delete, Move) als
// before/after-Snapshots. Undo/Redo ruft dieselben Schreib-Endpunkte wie die
// normale UI auf (create/update/delete/move) und aktualisiert den optimistischen
// Store — der nächste Refetch (via refreshNonce, siehe App.tsx) gleicht dann mit
// dem Server ab.
//
// Bewusst NUR für nicht-wiederkehrende Events: Undo/Redo für Serientermine
// würde RRULE/EXDATE/Override-Chirurgie rückgängig machen müssen, was ein
// eigenes Feature wäre. Serien-Aktionen werden daher gar nicht erst über
// `record()` auf den Stack gelegt.
//
// Die Schreibaufrufe hier übergeben bewusst KEIN ETag (leerer String), um
// den Conflict-Check im Backend zu umgehen: Termina ist Single-Owner
// (siehe CLAUDE.md), das lokal (noch) nicht synchronisierte ETag aus Punkt 5
// würde sonst zu falschen 409-Konflikten beim Undo führen.

import { create } from 'zustand';
import { createEvent, updateEvent, deleteEvent, moveEvent } from '../api/write';
import { useOptimisticStore } from './eventsSlice';
import type { CalendarEvent, CreateEventPayload, UpdateEventPayload } from '../types';

const MAX_HISTORY = 10;

export interface HistoryAction {
  kind: 'create' | 'update' | 'delete' | 'move';
  uid: string;
  before: CalendarEvent | null; // Zustand vor der Aktion (null bei create)
  after: CalendarEvent | null; // Zustand nach der Aktion (null bei delete)
}

interface HistoryState {
  past: HistoryAction[];
  future: HistoryAction[];
  record: (action: HistoryAction) => void;
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
  clear: () => void;
}

function eventToPayload(ev: CalendarEvent): CreateEventPayload {
  return {
    calendar_id: ev.calendar_id,
    summary: ev.summary,
    start: ev.start,
    end: ev.end,
    all_day: ev.all_day,
    location: ev.location ?? null,
    description: ev.description ?? null,
    rrule: null,
  };
}

function eventToUpdatePayload(ev: CalendarEvent, etag: string): UpdateEventPayload {
  return {
    etag,
    summary: ev.summary,
    start: ev.start,
    end: ev.end,
    all_day: ev.all_day,
    location: ev.location ?? null,
    description: ev.description ?? null,
    rrule: null,
  };
}

async function applyInverse(action: HistoryAction): Promise<HistoryAction> {
  const optimistic = useOptimisticStore.getState();

  switch (action.kind) {
    case 'create': {
      await deleteEvent(action.uid, {});
      optimistic.deleteOptimistic(action.uid);
      return action;
    }
    case 'delete': {
      const before = action.before!;
      const { uid } = await createEvent(eventToPayload(before));
      const restored: CalendarEvent = { ...before, uid, etag: null };
      optimistic.addOptimistic(restored);
      return { ...action, uid, before: restored };
    }
    case 'update': {
      const before = action.before!;
      await updateEvent(action.uid, eventToUpdatePayload(before, ''));
      optimistic.updateOptimistic(before);
      return action;
    }
    case 'move': {
      const before = action.before!;
      const after = action.after!;
      await moveEvent(action.uid, {
        mode: 'all',
        etag: '',
        original_start: after.start,
        new_start: before.start,
        new_end: before.end,
      });
      optimistic.updateOptimistic(before);
      return action;
    }
  }
}

async function applyForward(action: HistoryAction): Promise<HistoryAction> {
  const optimistic = useOptimisticStore.getState();

  switch (action.kind) {
    case 'create': {
      const after = action.after!;
      const { uid } = await createEvent(eventToPayload(after));
      const restored: CalendarEvent = { ...after, uid, etag: null };
      optimistic.addOptimistic(restored);
      return { ...action, uid, after: restored };
    }
    case 'delete': {
      await deleteEvent(action.uid, {});
      optimistic.deleteOptimistic(action.uid);
      return action;
    }
    case 'update': {
      const after = action.after!;
      await updateEvent(action.uid, eventToUpdatePayload(after, ''));
      optimistic.updateOptimistic(after);
      return action;
    }
    case 'move': {
      const before = action.before!;
      const after = action.after!;
      await moveEvent(action.uid, {
        mode: 'all',
        etag: '',
        original_start: before.start,
        new_start: after.start,
        new_end: after.end,
      });
      optimistic.updateOptimistic(after);
      return action;
    }
  }
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  past: [],
  future: [],

  record: (action) =>
    set((s) => ({
      past: [...s.past, action].slice(-MAX_HISTORY),
      future: [],
    })),

  clear: () => set({ past: [], future: [] }),

  undo: async () => {
    const { past } = get();
    if (past.length === 0) return false;
    const action = past[past.length - 1];
    const inverted = await applyInverse(action);
    set((s) => ({
      past: s.past.slice(0, -1),
      future: [...s.future, inverted],
    }));
    return true;
  },

  redo: async () => {
    const { future } = get();
    if (future.length === 0) return false;
    const action = future[future.length - 1];
    const applied = await applyForward(action);
    set((s) => ({
      future: s.future.slice(0, -1),
      past: [...s.past, applied].slice(-MAX_HISTORY),
    }));
    return true;
  },
}));

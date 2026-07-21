// frontend/src/store/historySlice.ts
//
// Undo/Redo-Grundgerüst für Termina.
//
// Speichert die letzten ~10 Aktionen (Create, Update, Delete, Move, Resize)
// als before/after-Snapshots. Undo/Redo ruft dieselben Schreib-Endpunkte wie
// die normale UI auf (create/update/delete/move/resize/restore-occurrence)
// und aktualisiert entweder den optimistischen Store (nicht-rekurrente
// Events) oder stößt über den refreshBus einen Refetch an (rekurrente
// Events, siehe unten).
//
// Serientermine: `scope` ('single' | 'future' | 'all') hält fest, mit
// welcher Reichweite die Aktion ursprünglich ausgeführt wurde.
//   - 'single': betrifft nur die eine Instanz (RECURRENCE-ID). Undo/Redo
//     spielt einfach die Gegenrichtung mit derselben recurrence_id zurück.
//   - 'future': hat serverseitig die Serie an der recurrence_id gesplittet
//     und ein NEUES Event (splitUid) angelegt. Undo muss dieses neue Event
//     löschen und den Master per vollem updateEvent auf `before` (inkl.
//     ursprünglicher, nicht getrimmter RRULE) zurücksetzen. Redo führt die
//     Aktion erneut mit mode:'future' aus und merkt sich die neu vergebene
//     splitUid.
//   - 'all' / undefined: wirkt auf die ganze Serie (oder ist ein
//     nicht-wiederkehrendes Event) — bestehende Logik, jetzt mit
//     rrule-erhaltendem eventToPayload/eventToUpdatePayload.
//
// Für rekurrente Events wird NIE der optimistische Overlay-Store benutzt
// (der ist uid-gekeyt und würde die RRULE-Expansion der Serie verfälschen),
// sondern nach der Schreiboperation der refreshBus gebumpt, den App.tsx
// abonniert hat.
//
// Die Schreibaufrufe hier übergeben bewusst KEIN ETag (leerer String), um
// den Conflict-Check im Backend zu umgehen: Termina ist Single-Owner
// (siehe CLAUDE.md), das lokal (noch) nicht synchronisierte ETag würde
// sonst zu falschen 409-Konflikten beim Undo führen.

import { create } from 'zustand';
import {
  createEvent,
  updateEvent,
  deleteEvent,
  moveEvent,
  resizeEvent,
  restoreOccurrence,
} from '../api/write';
import { useOptimisticStore } from './eventsSlice';
import { useRefreshBus } from './refreshBus';
import type {
  CalendarEvent,
  CreateEventPayload,
  UpdateEventPayload,
  MoveMode,
} from '../types';

const MAX_HISTORY = 10;

export interface HistoryAction {
  kind: 'create' | 'update' | 'delete' | 'move' | 'resize';
  uid: string;
  before: CalendarEvent | null; // Zustand vor der Aktion (null bei create)
  after: CalendarEvent | null; // Zustand nach der Aktion (null bei delete)
  /** Nur bei Serienterminen gesetzt: mit welcher Reichweite die Aktion lief. */
  scope?: MoveMode;
  /** Nur bei scope==='future': uid des serverseitig neu angelegten Folge-Events. */
  splitUid?: string | null;
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
    rrule: ev.rrule ?? null,
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
    rrule: ev.rrule ?? null,
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
      if (action.scope === 'single') {
        await restoreOccurrence(action.uid, {
          etag: '',
          recurrence_id: before.recurrence_id!,
        });
        useRefreshBus.getState().bump();
        return action;
      }
      if (action.scope === 'future') {
        await updateEvent(action.uid, eventToUpdatePayload(before, ''));
        useRefreshBus.getState().bump();
        return action;
      }
      const { uid } = await createEvent(eventToPayload(before));
      const restored: CalendarEvent = { ...before, uid, etag: null };
      if (before.is_recurring) {
        useRefreshBus.getState().bump();
      } else {
        optimistic.addOptimistic(restored);
      }
      return { ...action, uid, before: restored };
    }
    case 'update': {
      const before = action.before!;
      if (action.scope === 'single') {
        await updateEvent(action.uid, {
          ...eventToUpdatePayload(before, ''),
          recurrence_id: before.recurrence_id,
        });
        useRefreshBus.getState().bump();
        return action;
      }
      if (action.scope === 'future') {
        if (action.splitUid) {
          await deleteEvent(action.splitUid, {});
        }
        await updateEvent(action.uid, eventToUpdatePayload(before, ''));
        useRefreshBus.getState().bump();
        return action;
      }
      await updateEvent(action.uid, eventToUpdatePayload(before, ''));
      if (before.is_recurring) {
        useRefreshBus.getState().bump();
      } else {
        optimistic.updateOptimistic(before);
      }
      return action;
    }
    case 'move': {
      const before = action.before!;
      const after = action.after!;
      if (action.scope === 'single') {
        await moveEvent(action.uid, {
          mode: 'single',
          etag: '',
          original_start: after.start,
          new_start: before.start,
          new_end: before.end,
          recurrence_id: before.recurrence_id,
        });
        useRefreshBus.getState().bump();
        return action;
      }
      if (action.scope === 'future') {
        if (action.splitUid) {
          await deleteEvent(action.splitUid, {});
        }
        await updateEvent(action.uid, eventToUpdatePayload(before, ''));
        useRefreshBus.getState().bump();
        return action;
      }
      await moveEvent(action.uid, {
        mode: 'all',
        etag: '',
        original_start: after.start,
        new_start: before.start,
        new_end: before.end,
      });
      if (before.is_recurring) {
        useRefreshBus.getState().bump();
      } else {
        optimistic.updateOptimistic(before);
      }
      return action;
    }
    case 'resize': {
      const before = action.before!;
      if (action.scope === 'single') {
        await resizeEvent(action.uid, {
          mode: 'single',
          etag: '',
          occurrence_start: before.start,
          new_end: before.end,
          recurrence_id: before.recurrence_id,
        });
        useRefreshBus.getState().bump();
        return action;
      }
      if (action.scope === 'future') {
        if (action.splitUid) {
          await deleteEvent(action.splitUid, {});
        }
        await updateEvent(action.uid, eventToUpdatePayload(before, ''));
        useRefreshBus.getState().bump();
        return action;
      }
      await resizeEvent(action.uid, {
        mode: 'all',
        etag: '',
        occurrence_start: before.start,
        new_end: before.end,
      });
      if (before.is_recurring) {
        useRefreshBus.getState().bump();
      } else {
        optimistic.updateOptimistic(before);
      }
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
      const before = action.before!;
      if (action.scope === 'single') {
        await deleteEvent(action.uid, {
          etag: '',
          recurrence_id: before.recurrence_id,
          mode: 'single',
        });
        useRefreshBus.getState().bump();
        return action;
      }
      if (action.scope === 'future') {
        await deleteEvent(action.uid, {
          etag: '',
          recurrence_id: before.recurrence_id,
          mode: 'future',
        });
        useRefreshBus.getState().bump();
        return action;
      }
      await deleteEvent(action.uid, {});
      if (before.is_recurring) {
        useRefreshBus.getState().bump();
      } else {
        optimistic.deleteOptimistic(action.uid);
      }
      return action;
    }
    case 'update': {
      const after = action.after!;
      if (action.scope === 'single') {
        await updateEvent(action.uid, {
          ...eventToUpdatePayload(after, ''),
          recurrence_id: after.recurrence_id,
        });
        useRefreshBus.getState().bump();
        return action;
      }
      if (action.scope === 'future') {
        const before = action.before!;
        const result = await updateEvent(action.uid, {
          ...eventToUpdatePayload(after, ''),
          recurrence_id: before.recurrence_id,
          mode: 'future',
        });
        useRefreshBus.getState().bump();
        return { ...action, splitUid: result.new_uid ?? null };
      }
      await updateEvent(action.uid, eventToUpdatePayload(after, ''));
      if (after.is_recurring) {
        useRefreshBus.getState().bump();
      } else {
        optimistic.updateOptimistic(after);
      }
      return action;
    }
    case 'move': {
      const before = action.before!;
      const after = action.after!;
      if (action.scope === 'single') {
        await moveEvent(action.uid, {
          mode: 'single',
          etag: '',
          original_start: before.start,
          new_start: after.start,
          new_end: after.end,
          recurrence_id: before.recurrence_id,
        });
        useRefreshBus.getState().bump();
        return action;
      }
      if (action.scope === 'future') {
        const result = await moveEvent(action.uid, {
          mode: 'future',
          etag: '',
          original_start: before.start,
          new_start: after.start,
          new_end: after.end,
          recurrence_id: before.recurrence_id,
        });
        useRefreshBus.getState().bump();
        return { ...action, splitUid: result.new_uid ?? null };
      }
      await moveEvent(action.uid, {
        mode: 'all',
        etag: '',
        original_start: before.start,
        new_start: after.start,
        new_end: after.end,
      });
      if (after.is_recurring) {
        useRefreshBus.getState().bump();
      } else {
        optimistic.updateOptimistic(after);
      }
      return action;
    }
    case 'resize': {
      const before = action.before!;
      const after = action.after!;
      if (action.scope === 'single') {
        await resizeEvent(action.uid, {
          mode: 'single',
          etag: '',
          occurrence_start: before.start,
          new_end: after.end,
          recurrence_id: before.recurrence_id,
        });
        useRefreshBus.getState().bump();
        return action;
      }
      if (action.scope === 'future') {
        const result = await resizeEvent(action.uid, {
          mode: 'future',
          etag: '',
          occurrence_start: before.start,
          new_end: after.end,
          recurrence_id: before.recurrence_id,
        });
        useRefreshBus.getState().bump();
        return { ...action, splitUid: result.new_uid ?? null };
      }
      await resizeEvent(action.uid, {
        mode: 'all',
        etag: '',
        occurrence_start: after.start,
        new_end: after.end,
      });
      if (after.is_recurring) {
        useRefreshBus.getState().bump();
      } else {
        optimistic.updateOptimistic(after);
      }
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

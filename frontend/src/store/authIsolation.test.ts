import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEvent } from '../types';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
});
const { useStore } = await import('./index');
const { useOptimisticStore } = await import('./eventsSlice');
const { useHistoryStore } = await import('./historySlice');

const alice = { id: 1, email: 'alice@test', display_name: 'Alice', role: 'admin', must_change_password: false };
const bob = { ...alice, id: 2, email: 'bob@test', role: 'member' };
const event: CalendarEvent = {
  uid: 'private-event', calendar_id: 'private-calendar', summary: 'Private appointment',
  start: '2026-09-16T09:00:00', end: '2026-09-16T10:00:00', all_day: false,
  etag: 'v1', description: null, is_recurring: false, recurrence_id: null,
};

function addPrivateState() {
  useOptimisticStore.getState().addOptimistic(event);
  useOptimisticStore.getState().updateOptimistic(event);
  useOptimisticStore.getState().deleteOptimistic(event.uid);
  useHistoryStore.getState().record({ kind: 'create', uid: event.uid, before: null, after: event });
}
function expectEmpty() {
  expect(useOptimisticStore.getState().added).toEqual([]);
  expect(useOptimisticStore.getState().updated.size).toBe(0);
  expect(useOptimisticStore.getState().deleted.size).toBe(0);
  expect(useHistoryStore.getState().past).toEqual([]);
  expect(useHistoryStore.getState().future).toEqual([]);
}

beforeEach(() => { useStore.getState().clearUser(); storage.clear(); });

describe('account isolation', () => {
  it('removes appointments, undo history and calendar preferences on logout', () => {
    useStore.getState().setUser(alice);
    addPrivateState();
    useStore.getState().toggleCalendar(event.calendar_id);
    useStore.getState().clearUser();
    expectEmpty();
    expect(useStore.getState().user).toBeNull();
    expect(useStore.getState().hiddenCalendars.size).toBe(0);
  });
  it('does not expose optimistic appointments or undo history to another account', () => {
    useStore.getState().setUser(alice);
    addPrivateState();
    useStore.getState().setUser(bob);
    expectEmpty();
  });
  it('does not discard pending edits when refreshing the same account', () => {
    useStore.getState().setUser(alice);
    addPrivateState();
    useStore.getState().setUser({ ...alice });
    expect(useOptimisticStore.getState().added).toHaveLength(1);
  });
});

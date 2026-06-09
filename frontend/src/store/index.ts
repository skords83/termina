import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AppState {
  // Auth
  token: string | null;
  setToken: (token: string) => void;
  clearToken: () => void;

  // Active month (ISO date string, first of month)
  activeMonth: string;
  setActiveMonth: (month: string) => void;

  // Calendar visibility
  hiddenCalendars: Set<string>;
  toggleCalendar: (id: string) => void;
  isCalendarVisible: (id: string) => boolean;
}

function firstOfMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      token: null,
      setToken: (token) => set({ token }),
      clearToken: () => set({ token: null }),

      activeMonth: firstOfMonth(new Date()),
      setActiveMonth: (month) => set({ activeMonth: month }),

      hiddenCalendars: new Set<string>(),
      toggleCalendar: (id) => {
        const hidden = new Set(get().hiddenCalendars);
        if (hidden.has(id)) hidden.delete(id);
        else hidden.add(id);
        set({ hiddenCalendars: hidden });
      },
      isCalendarVisible: (id) => !get().hiddenCalendars.has(id),
    }),
    {
      name: 'termina-storage',
      partialize: (state) => ({
        token: state.token,
        hiddenCalendars: Array.from(state.hiddenCalendars),
      }),
      merge: (persisted: any, current) => ({
        ...current,
        ...persisted,
        hiddenCalendars: new Set<string>(persisted.hiddenCalendars ?? []),
      }),
    }
  )
);

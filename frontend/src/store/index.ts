import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AuthUser {
  id: number;
  email: string;
  display_name: string;
  role: string;
  must_change_password: boolean;
}

interface AppState {
  // Auth
  user: AuthUser | null;
  setUser: (user: AuthUser) => void;
  clearUser: () => void;

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
      user: null,
      setUser: (user) => set({ user }),
      clearUser: () => set({ user: null }),

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

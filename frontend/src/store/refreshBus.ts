// frontend/src/store/refreshBus.ts
//
// Winziger Pub/Sub-Kanal, damit historySlice.ts (Undo/Redo) einen Refetch
// anstoßen kann, ohne von App.tsx's lokalem refreshNonce-State abhängig zu
// sein. App.tsx abonniert `nonce` und spiegelt Änderungen auf sein eigenes
// refreshNonce (siehe useEffect dort).

import { create } from 'zustand';

interface RefreshBusState {
  nonce: number;
  bump: () => void;
}

export const useRefreshBus = create<RefreshBusState>((set) => ({
  nonce: 0,
  bump: () => set((s) => ({ nonce: s.nonce + 1 })),
}));

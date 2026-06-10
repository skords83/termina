// frontend/src/components/Toast.tsx
//
// Minimales Toast-System für Fehler und Bestätigungen.
// Verwendung:
//   import { useToast } from './Toast';
//   const { showToast } = useToast();
//   showToast('Termin gespeichert', 'success');
//   showToast('Nextcloud nicht erreichbar', 'error');
//
// In App.tsx einbinden:
//   <ToastProvider>
//     <App />
//     <ToastContainer />
//   </ToastProvider>

import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';

type ToastKind = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastContextValue {
  showToast: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let counter = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);

  const showToast = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = ++counter;
      setToasts((prev) => [...prev, { id, message, kind }]);
      const timer = setTimeout(() => dismiss(id), 4000);
      timers.current.set(id, timer);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        style={{
          position: 'fixed',
          bottom: '1.5rem',
          right: '1.5rem',
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          pointerEvents: 'none',
        }}
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}) {
  const bg: Record<ToastKind, string> = {
    success: '#1a3a2a',
    error: '#3a1a1a',
    warning: '#3a2e10',
    info: '#1a2a3a',
  };
  const border: Record<ToastKind, string> = {
    success: '#2d6a45',
    error: '#8b3030',
    warning: '#7a5c18',
    info: '#2a4a6a',
  };
  const icon: Record<ToastKind, string> = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ',
  };

  return (
    <div
      style={{
        pointerEvents: 'all',
        display: 'flex',
        alignItems: 'center',
        gap: '0.625rem',
        padding: '0.625rem 0.875rem',
        background: bg[toast.kind],
        border: `1px solid ${border[toast.kind]}`,
        borderRadius: '0.5rem',
        color: '#e8e6e3',
        fontFamily: 'DM Sans, sans-serif',
        fontSize: '0.875rem',
        lineHeight: 1.4,
        maxWidth: '24rem',
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        cursor: 'pointer',
        animation: 'toastIn 0.2s ease',
      }}
      onClick={() => onDismiss(toast.id)}
    >
      <span
        style={{
          fontFamily: 'monospace',
          color: border[toast.kind],
          flexShrink: 0,
          fontSize: '0.75rem',
        }}
      >
        {icon[toast.kind]}
      </span>
      <span>{toast.message}</span>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

// Globale Animation – einmalig injizieren
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes toastIn {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
}

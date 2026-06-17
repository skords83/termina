/**
 * useWindowFocusGuard
 *
 * Problem: Wenn Termina im Hintergrund läuft und der User draufklickt um das
 * Fenster zu aktivieren, feuert der Browser sowohl das `focus`-Event als auch
 * das `click`-Event auf dem darunter liegenden Element — was ungewollt Modals
 * öffnet.
 *
 * Lösung: Wir merken uns den Zeitpunkt des letzten `window focus`-Events.
 * Kommt ein Klick innerhalb des Schwellwerts (Standard: 200 ms), gilt er als
 * "Focus-Klick" und soll ignoriert werden.
 *
 * Verwendung in App.tsx:
 *
 *   const isFocusClick = useWindowFocusGuard();
 *
 *   // In jedem Click-Handler der etwas öffnet:
 *   if (isFocusClick()) return;
 */
import { useEffect, useRef } from 'react';

export function useWindowFocusGuard(thresholdMs = 200): () => boolean {
  // Wenn das Fenster beim Mount bereits fokussiert ist, setzen wir 0
  // → Guard feuert nie beim ersten Laden.
  const lastFocusTime = useRef<number>(document.hasFocus() ? 0 : Date.now());

  useEffect(() => {
    const onFocus = () => {
      lastFocusTime.current = Date.now();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Gibt true zurück wenn dieser Klick den Focus-Klick darstellt (→ ignorieren)
  return () => Date.now() - lastFocusTime.current < thresholdMs;
}

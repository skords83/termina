import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const sendToken = () => {
        const token = localStorage.getItem('termina_token');
        if (token && reg.active) {
          reg.active.postMessage({ type: 'SET_TOKEN', token });
        }
      };
      if (reg.active) {
        sendToken();
      } else {
        reg.addEventListener('updatefound', () => {
          reg.installing?.addEventListener('statechange', (e) => {
            if ((e.target as ServiceWorker).state === 'activated') sendToken();
          });
        });
      }
    } catch (err) {
      console.warn('SW registration failed:', err);
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

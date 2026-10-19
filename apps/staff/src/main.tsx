import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@churchos/ui/src/styles.css';
import { App } from './App';

// Keep the install prompt: the browser fires it once, often before sign-in finishes. The app offers "Install" from it.
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); (window as any).__installPrompt = e; window.dispatchEvent(new Event('churchos:install-ready')); });

let waiting: ServiceWorker | null = null;

/** A small toast shown when a new version of the app has been downloaded. */
function UpdateToast() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const on = () => setReady(true);
    window.addEventListener('churchos:update-ready', on);
    if (waiting) setReady(true);
    return () => window.removeEventListener('churchos:update-ready', on);
  }, []);
  if (!ready) return null;
  return (
    <div className="toast good" role="status" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      A new version is ready.
      <button type="button" className="btn small ghost" style={{ width: 'auto' }} onClick={() => { waiting?.postMessage('skip-waiting'); setTimeout(() => location.reload(), 300); }}>Refresh</button>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <UpdateToast />
  </StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const announce = (w: ServiceWorker | null) => { if (w) { waiting = w; window.dispatchEvent(new Event('churchos:update-ready')); } };
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // only a real update counts: there is already a controller running the old version
      if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) announce(nw);
        });
      });
    }).catch(() => { /* offline support is optional */ });
  });
}

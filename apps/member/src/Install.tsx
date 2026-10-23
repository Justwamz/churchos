import { useEffect, useState } from 'react';

/** The browser's install prompt, shared by the Home banner and the profile menu. Nothing is offered once the app is installed. */
export function useInstall() {
  const [evt, setEvt] = useState<any>(() => (window as any).__installPrompt ?? null);
  const [installed, setInstalled] = useState(false);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); (window as any).__installPrompt = e; setEvt(e); };
    const onReady = () => setEvt((window as any).__installPrompt ?? null);
    const onInstalled = () => { setInstalled(true); setEvt(null); (window as any).__installPrompt = null; };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('churchos:install-ready', onReady);
    window.addEventListener('appinstalled', onInstalled);
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('churchos:install-ready', onReady); window.removeEventListener('appinstalled', onInstalled); };
  }, []);
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const install = async () => {
    try {
      await evt.prompt();
      const r = await evt.userChoice;
      if (r?.outcome === 'accepted') setInstalled(true);
    } catch { /* the browser decided not to show it */ }
    setEvt(null);
    (window as any).__installPrompt = null;
  };
  const hidden = standalone || installed;
  return { evt, ios, install, hidden, canInstall: !hidden && !!evt, showIosTip: !hidden && !evt && ios };
}

import { useEffect, useState } from 'react';
import { Button } from '@churchos/ui';

const KEY = 'churchos:staff-install-dismissed';

export function useOnline() {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const u = () => setOn(true), d = () => setOn(false);
    window.addEventListener('online', u); window.addEventListener('offline', d);
    return () => { window.removeEventListener('online', u); window.removeEventListener('offline', d); };
  }, []);
  return on;
}

export const isInstalled = () => {
  try { return window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true; } catch { return false; }
};
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent);

/** Install state: whether an install can be offered, and the action to run. */
export function useInstall() {
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener('churchos:install-ready', on);
    window.addEventListener('appinstalled', on);
    return () => { window.removeEventListener('churchos:install-ready', on); window.removeEventListener('appinstalled', on); };
  }, []);
  const installed = isInstalled();
  const prompt = (window as any).__installPrompt;
  const ios = !prompt && isIos();
  const available = !installed && (!!prompt || ios);
  const run = async () => {
    const p = (window as any).__installPrompt;
    if (!p) return;
    try { await p.prompt(); } catch { /* ignore */ }
    (window as any).__installPrompt = null;
    bump((n) => n + 1);
  };
  return { available, installed, run, ios };
}

export function InstallButton() {
  const i = useInstall();
  if (i.installed) return <p className="tiny">The staff app is installed on this phone.</p>;
  if (!i.available) return null;
  return (
    <div className="install-box">
      {i.ios ? <p className="muted">To install the staff app: Tap Share, then Add to Home Screen.</p> : <Button onClick={i.run}>Install the staff app</Button>}
    </div>
  );
}

/** Dismissible banner for the Today screen on phones that have not installed the app. */
export function InstallBanner() {
  const i = useInstall();
  const [gone, setGone] = useState(() => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } });
  if (gone || !i.available) return null;
  const dismiss = () => { setGone(true); try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ } };
  return (
    <div className="install-banner" role="region" aria-label="Install the staff app">
      <div>
        <b>Install the staff app</b>
        <div className="tiny">{i.ios ? 'Tap Share, then Add to Home Screen.' : 'Open it from your home screen, like any other app.'}</div>
      </div>
      <div className="install-actions">
        {!i.ios && <Button small onClick={i.run}>Install</Button>}
        <button type="button" className="install-x" aria-label="Dismiss" onClick={dismiss}>×</button>
      </div>
    </div>
  );
}

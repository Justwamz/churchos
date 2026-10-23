import { useEffect, useState } from 'react';
import { Button } from '@churchos/ui';
import { useBrand } from './Branding';

const KEY = 'churchos:staff-install-dismissed';
const WEEK = 7 * 86_400_000;

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
  const n = useBrand().brand?.name;
  const app = n ? `${n} staff app` : 'staff app';
  if (i.installed) return <p className="tiny">The {app} is installed on this phone.</p>;
  if (!i.available) return null;
  return (
    <div className="install-box">
      {i.ios ? <p className="muted">To install the {app}: Tap Share, then Add to Home Screen.</p> : <Button onClick={i.run}>Install the {app}</Button>}
    </div>
  );
}

/** Install banner state: shown while the app can be installed and was not dismissed in the last week. */
export function useInstallBanner() {
  const i = useInstall();
  const [gone, setGone] = useState(() => { try { return Number(localStorage.getItem(KEY) ?? 0) > Date.now(); } catch { return false; } });
  const dismiss = () => { setGone(true); try { localStorage.setItem(KEY, String(Date.now() + WEEK)); } catch { /* ignore */ } };
  return { show: !gone && i.available, dismiss };
}

/** Dismissible banner for the Today screen on devices that have not installed the app. Dismissing hides it for a week. */
export function InstallBanner({ dismiss }: { dismiss: () => void }) {
  const i = useInstall();
  if (!i.available) return null;
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

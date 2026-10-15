import { useEffect, useState } from 'react';
import { createApi } from '@churchos/ui';

export const api = createApi('churchos:member-token');

export const errText = (e: any) => (e && typeof e.message === 'string' && e.message ? e.message : 'Something went wrong. Please try again.');

/** Tracks whether the browser has a network connection. */
export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return online;
}

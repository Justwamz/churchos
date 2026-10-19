import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

/** What this church calls a gathering. */
export interface Words { one: string; many: string; oneLower: string; manyLower: string }
const DEFAULT: Words = { one: 'Service', many: 'Services', oneLower: 'service', manyLower: 'services' };
const Ctx = createContext<Words>(DEFAULT);

/** Fetches the church's word once after sign-in. Falls back to Service/Services until loaded or on error. */
export function WordsProvider({ children }: { children: ReactNode }) {
  const [w, setW] = useState<Words>(DEFAULT);
  useEffect(() => {
    let live = true;
    api.get('/me/words').then((r: any) => {
      if (live && r && typeof r.one === 'string' && r.one && typeof r.many === 'string' && r.many) {
        setW({ one: r.one, many: r.many, oneLower: r.oneLower || r.one.toLowerCase(), manyLower: r.manyLower || r.many.toLowerCase() });
      }
    }).catch(() => { /* keep the default */ });
    return () => { live = false; };
  }, []);
  return <Ctx.Provider value={w}>{children}</Ctx.Provider>;
}

export const useWords = () => useContext(Ctx);

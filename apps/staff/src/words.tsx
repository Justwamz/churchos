import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './session';

/**
 * What this church calls its gatherings: Service, Mass, Gathering, Meeting, Celebration or its own word.
 * Use `useWords()` anywhere you would have written "service(s)" in screen copy:
 *   const w = useWords();   `Next ${w.oneLower} starts at 10:00`   `${w.many} this week`
 * `one`/`many` are capitalised ('Mass', 'Masses'); `oneLower`/`manyLower` are for the middle of a sentence.
 * Defaults to Service/Services until the church's setting has loaded, so it is always safe to call.
 */
export type Preset = { one: string; many: string };
export type Words = {
  one: string; many: string; oneLower: string; manyLower: string;
  presets: Preset[]; canChange: boolean; loaded: boolean;
  /** Save a new pair (owner only). Throws an Error whose message is ready to show. */
  save: (one: string, many: string) => Promise<void>;
};

const DEFAULTS: Words = {
  one: 'Service', many: 'Services', oneLower: 'service', manyLower: 'services',
  presets: [{ one: 'Service', many: 'Services' }, { one: 'Mass', many: 'Masses' }, { one: 'Gathering', many: 'Gatherings' }, { one: 'Meeting', many: 'Meetings' }, { one: 'Celebration', many: 'Celebrations' }],
  canChange: false, loaded: false, save: async () => {},
};
const Ctx = createContext<Words>(DEFAULTS);
export const useWords = () => useContext(Ctx);

/** Fetches /me/words once after sign-in (and again when the church changes or after saving). Mount inside the signed-in shell. */
export function WordsProvider({ orgId, multiOrg, children }: { orgId?: string; multiOrg?: boolean; children: ReactNode }) {
  const [d, setD] = useState<Omit<Words, 'save'> | null>(null);
  const load = useCallback(() => api.get('/me/words' + (multiOrg && orgId ? `?org=${orgId}` : '')).then((r: any) => setD({
    one: r.one, many: r.many, oneLower: r.oneLower, manyLower: r.manyLower, presets: r.presets?.length ? r.presets : DEFAULTS.presets, canChange: !!r.canChange, loaded: true,
  })).catch(() => { /* keep the defaults: wording is never worth blocking a screen */ }), [orgId, multiOrg]);
  useEffect(() => { load(); }, [load]);
  const save = useCallback(async (one: string, many: string) => {
    try { await api.put('/church/words', { one, many }); } catch (e: any) {
      throw new Error(e?.code === 'bad_word' ? (e.message || 'Use letters only, 2 to 24 characters.') : (e?.message || 'Could not save. Please try again.'));
    }
    await load();
  }, [load]);
  const value = useMemo<Words>(() => ({ ...DEFAULTS, ...(d ?? {}), save }), [d, save]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

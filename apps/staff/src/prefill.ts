import { useEffect, useRef } from 'react';

/**
 * A tiny hand-off so one screen can open another with something filled in (the command bar opens Members with a name in the search box).
 *   sender:   setPrefill('members', 'Mary Wanjiku'); session.go('members');
 *   receiver: usePrefill('members', (v) => setQ(v));   // inside the page component
 * The receiver gets the value when it mounts, and also if it is already open (the event below).
 */
const store = new Map<string, string>();
const EVENT = 'churchos:prefill';

export function setPrefill(page: string, value: string) {
  store.set(page, value);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: page }));
}

export function usePrefill(page: string, apply: (v: string) => void) {
  const fn = useRef(apply);
  fn.current = apply;
  useEffect(() => {
    const take = () => { const v = store.get(page); if (v !== undefined) { store.delete(page); fn.current(v); } };
    take();
    const on = (e: Event) => { if ((e as CustomEvent).detail === page) take(); };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [page]);
}

/**
 * Open a page with one of its forms already showing (quick actions on Today and in the command bar).
 *   sender:   openAction('members', 'add'); session.go('members');
 *   receiver: useAction('members', (a) => { if (a === 'add') setAdding(true); });   // inside the page component
 * Action names are listed in QUICK_ACTIONS (navmap.ts): members 'add', expenses 'record', bookings 'new', messages 'compose'.
 * Like prefill, the handler runs when the page mounts, and also if it is already open. An unclaimed action is dropped after 5 seconds,
 * so it can never pop a form open later by surprise.
 */
const actions = new Map<string, { name: string; at: number }>();
const ACTION_EVENT = 'churchos:action';

export function openAction(page: string, name: string) {
  actions.set(page, { name, at: Date.now() });
  window.dispatchEvent(new CustomEvent(ACTION_EVENT, { detail: page }));
}

export function useAction(page: string, handler: (name: string) => void) {
  const fn = useRef(handler);
  fn.current = handler;
  useEffect(() => {
    const take = () => {
      const a = actions.get(page);
      if (!a) return;
      actions.delete(page);
      if (Date.now() - a.at < 5000) fn.current(a.name);
    };
    take();
    const on = (e: Event) => { if ((e as CustomEvent).detail === page) take(); };
    window.addEventListener(ACTION_EVENT, on);
    return () => window.removeEventListener(ACTION_EVENT, on);
  }, [page]);
}

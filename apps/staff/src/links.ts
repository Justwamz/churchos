import { useCallback, useContext, useEffect, useState } from 'react';
import { SessionCtx } from './session';
import { PAGES } from './nav';

/**
 * Links from notifications: `staff:<pageId>[?key=value&...]` ('staff:expenses?open=exp_1'). Member links ('member:...') are ignored here.
 *   opener:   const open = useOpenLink(); open('staff:expenses?open=exp_1');
 *   receiver: const p = useLinkParams('expenses');   // inside the page component: null, or the params once
 * The params are handed over once (like prefill and actions) and an unclaimed set is dropped after 5 seconds.
 */
export type LinkParams = Record<string, string>;

export function parseLink(link?: string | null): { page: string; params: LinkParams } | null {
  const m = /^staff:([a-z0-9-]+)(?:\?(.*))?$/i.exec((link ?? '').trim());
  if (!m) return null;
  const params: LinkParams = {};
  new URLSearchParams(m[2] ?? '').forEach((v, k) => { params[k] = v; });
  return { page: m[1], params };
}

const store = new Map<string, { params: LinkParams; at: number }>();
const EVENT = 'churchos:link';
const TOAST = 'churchos:toast';

export function notify(text: string) { window.dispatchEvent(new CustomEvent(TOAST, { detail: text })); }
export function onNotify(fn: (text: string) => void) {
  const on = (e: Event) => fn((e as CustomEvent).detail);
  window.addEventListener(TOAST, on);
  return () => window.removeEventListener(TOAST, on);
}

export function useLinkParams(page: string): LinkParams | null {
  const [p, setP] = useState<LinkParams | null>(null);
  useEffect(() => {
    const take = () => {
      const v = store.get(page);
      if (!v) return;
      store.delete(page);
      if (Date.now() - v.at < 5000 && Object.keys(v.params).length) setP(v.params);
    };
    take();
    const on = (e: Event) => { if ((e as CustomEvent).detail === page) take(); };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [page]);
  return p;
}

/** The label for a link's call-to-action button, from the page id and the kind of message. */
const CTA: Record<string, string> = {
  expenses: 'Review expense', 'my-claims': 'View claim', credit: 'Review refund', events: 'Review', bookings: 'Review booking', adverts: 'Review advert',
  suggestions: 'Read suggestion', shop: 'Open shop', integrations: 'Open settings', wallets: 'Top up credit', children: 'Open', today: 'Open Today',
  cash: 'Review cash', 'held-payments': 'Review payment', members: 'Open', transfers: 'Decide', messages: 'Open',
};
export function ctaLabel(link: string | null | undefined, kind?: string): string {
  const l = parseLink(link);
  if (!l) return 'Open';
  if (l.page === 'expenses' && l.params.tab === 'budgets') return 'View budgets';
  if (l.page === 'credit' && l.params.tab === 'refunds') return 'Decide';
  if (/decide|approval|request/i.test(kind ?? '') && !CTA[l.page]) return 'Decide';
  return CTA[l.page] ?? 'Open';
}

/** Returns a function that opens a notification link; false when it is not a staff link. A page the person may not open goes to Today with a friendly message. */
export function useOpenLink() {
  const s = useContext(SessionCtx);
  return useCallback((link?: string | null): boolean => {
    const l = parseLink(link);
    if (!l) return false;
    const def = PAGES.find((p) => p.id === l.page);
    const allowed = !!def && (def.any.includes('*') || def.any.some((a) => s.can(a)));
    if (!allowed) { s.go('today'); notify('You do not have access to that page'); return true; }
    if (Object.keys(l.params).length) {
      store.set(l.page, { params: l.params, at: Date.now() });
      window.dispatchEvent(new CustomEvent(EVENT, { detail: l.page }));
    }
    s.go(l.page);
    return true;
  }, [s]);
}

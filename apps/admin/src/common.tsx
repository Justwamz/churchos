import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, ErrorNote, Field, createApi, phonePretty } from '@churchos/ui';
import { Dialog, Skeleton } from './ui';
import { Icon } from './icons';

/** One API client for the whole admin app: the same token key as always, so it is the same signed-in session. */
export const api = createApi('churchos:admin-token');
export const num = (v: unknown) => Number(v ?? 0);
export const errText = (e: any) => (e && typeof e.message === 'string' && !e.message.trim().startsWith('{') ? e.message : 'Something went wrong. Please try again.');

export type Toast = (t: string, tone?: 'good' | 'bad') => void;
/** Every page receives these. `go` opens another admin page by id. `devTools` is true only when the API says the development test tools are switched on. */
export type PageProps = { toast: Toast; user: any; go: (page: string) => void; devTools: boolean };

/** Shows a skeleton while loading, an error note on failure, and the data once it is here. `rows` sets how many skeleton rows to show. */
export function Load<T>({ s, children, rows = 4 }: { s: { data?: T; error?: string; loading: boolean }; children: (d: T) => ReactNode; rows?: number }) {
  if (s.error) return <ErrorNote>{s.error}</ErrorNote>;
  if (s.data === undefined) return <Skeleton rows={rows} />;
  return <>{children(s.data)}</>;
}

export const METHOD_LABEL: Record<string, string> = { mpesa: 'M-Pesa', airtel: 'Airtel Money', tkash: 'T-Kash', card: 'Card', cash: 'Cash' };

/** True on a phone-width screen (760px or less). Pages use it to pick a compact layout. */
export function usePhone(): boolean {
  const q = '(max-width: 760px)';
  const [p, setP] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(q).matches : false));
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setP(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return p;
}

/** Refresh: a normal ghost button on a desktop, a round icon button in the page header on a phone (CSS hides the word). */
export function RefreshButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className="btn ghost pa-refresh" aria-label="Refresh" onClick={onClick}><Icon name="refresh" size={18} /><span className="pa-refresh-t">Refresh</span></button>;
}

/** Show the first `step` items and a "Show more" button for the rest. Starts again when `key` changes. */
export function usePaged<T>(items: T[], step: number, key = '') {
  const [n, setN] = useState(step);
  useEffect(() => { setN(step); }, [key, step]);
  return { shown: items.slice(0, n), more: items.length > n, left: Math.max(0, items.length - n), showMore: () => setN((c) => c + step), step };
}
export function ShowMore({ paged, noun }: { paged: { more: boolean; left: number; step: number; showMore: () => void }; noun: string }) {
  if (!paged.more) return null;
  return <div className="pa-more-row"><Button kind="ghost" onClick={paged.showMore}>Show {Math.min(paged.left, paged.step)} more {noun} ({paged.left} left)</Button></div>;
}

/** A small "more actions" menu (three dots) so secondary actions do not crowd a card on a phone. */
export function OverflowMenu({ items, label = 'More actions' }: { items: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [open]);
  return (
    <span className="pa-menu">
      <button ref={btn} type="button" className="btn ghost small pa-menu-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name="more" size={20} /></button>
      {open && (
        <>
          <span className="pa-menu-scrim" onClick={() => setOpen(false)} />
          <span className="pa-menu-list" role="menu">
            {items.map((it) => <button key={it.label} type="button" role="menuitem" className={it.danger ? 'danger' : ''} disabled={it.disabled} onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>)}
          </span>
        </>
      )}
    </span>
  );
}

const OTHER = '__other';
/**
 * A reason that must be given: pick a common one from the list, or "Other" and type your own. `value` is the final text (empty until chosen or typed).
 * The parent disables its confirm button until `reasonOk(value, min)`.
 */
export function ReasonPicker({ label = 'Reason (required)', options, value, onChange, min = 3, placeholder = 'Write the reason' }: { label?: string; options: string[]; value: string; onChange: (v: string) => void; min?: number; placeholder?: string }) {
  const [choice, setChoice] = useState('');
  const typed = choice === OTHER;
  return (
    <>
      <Field label={label}>
        <select value={choice} aria-required="true" onChange={(e) => { const c = e.target.value; setChoice(c); onChange(c && c !== OTHER ? c : ''); }}>
          <option value="">Choose a reason…</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
          <option value={OTHER}>Other (type a reason)</option>
        </select>
      </Field>
      {typed && (
        <Field label="Your reason" hint={value.trim().length > 0 && value.trim().length < min ? `Write at least ${min} characters.` : undefined}>
          <input value={value} maxLength={200} autoFocus aria-required="true" onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
        </Field>
      )}
    </>
  );
}
export const reasonOk = (v: string, min = 3) => v.trim().length >= min;

const REVEAL_REASONS = ['Member or church called about this payment', 'Checking a duplicate or failed payment', 'Matching an unmatched (suspense) payment', 'Preparing a refund or reversal'];
const ANON_REASONS = ['Refund for the giver', 'Fraud check on this gift', 'Legal request (court order or police)'];

/** Masked phone number with a logged, time-limited reveal (30 seconds). A reason is required and is recorded in the audit log. */
export function RevealPhone({ paymentId, masked, anonymous, toast }: { paymentId: string; masked: string; anonymous?: boolean; toast: Toast }) {
  const [real, setReal] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const hide = () => { if (timer.current) clearTimeout(timer.current); setReal(undefined); };
  const min = anonymous ? 8 : 3;
  const reveal = async () => {
    setBusy(true);
    try {
      const out = await api.post<any>(`/admin/payments/${paymentId}/reveal`, { reason: reason.trim() });
      setReal(String(out.payer_phone ?? ''));
      setAsking(false); setReason('');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setReal(undefined), 30_000);
    } catch (e: any) { toast(errText(e), 'bad'); setAsking(false); }
    setBusy(false);
  };
  return (
    <span className="reveal">
      <span>{real ? phonePretty(real) : anonymous ? 'Anonymous gift' : (masked || 'Not recorded')}</span>
      {(masked || anonymous) && (real
        ? <Button kind="ghost" small onClick={hide}>Hide</Button>
        : <Button kind="ghost" small onClick={() => { setReason(''); setAsking(true); }}>{anonymous ? 'Look up the giver' : 'Show number'}</Button>)}
      {asking && (
        <Dialog title="Showing a number is recorded in the audit log" onClose={() => setAsking(false)}
          footer={<>
            <Button kind="ghost" onClick={() => setAsking(false)}>Cancel</Button>
            <Button onClick={reveal} disabled={busy || !reasonOk(reason, min)}>{busy ? 'Working…' : 'Show the number'}</Button>
          </>}>
          <p className="muted">The number is shown for 30 seconds, then hidden again. Your reason is saved with your name.</p>
          {anonymous && <p className="muted">The giver chose to stay anonymous to the church. Look them up only for a refund, a fraud check or a legal request, and say which.</p>}
          <ReasonPicker options={anonymous ? ANON_REASONS : REVEAL_REASONS} value={reason} onChange={setReason} min={min} placeholder={anonymous ? 'At least 8 characters' : 'e.g. Member called about this payment'} />
        </Dialog>
      )}
    </span>
  );
}

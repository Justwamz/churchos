import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, ErrorNote, Field, createApi, phonePretty } from '@churchos/ui';
import { Dialog, Skeleton } from './ui';

/** One API client for the whole admin app: the same token key as always, so it is the same signed-in session. */
export const api = createApi('churchos:admin-token');
export const num = (v: unknown) => Number(v ?? 0);
export const errText = (e: any) => (e && typeof e.message === 'string' && !e.message.trim().startsWith('{') ? e.message : 'Something went wrong. Please try again.');

export type Toast = (t: string, tone?: 'good' | 'bad') => void;
/** Every page receives these. `go` opens another admin page by id. */
export type PageProps = { toast: Toast; user: any; go: (page: string) => void };

/** Shows a skeleton while loading, an error note on failure, and the data once it is here. `rows` sets how many skeleton rows to show. */
export function Load<T>({ s, children, rows = 4 }: { s: { data?: T; error?: string; loading: boolean }; children: (d: T) => ReactNode; rows?: number }) {
  if (s.error) return <ErrorNote>{s.error}</ErrorNote>;
  if (s.data === undefined) return <Skeleton rows={rows} />;
  return <>{children(s.data)}</>;
}

export const METHOD_LABEL: Record<string, string> = { mpesa: 'M-Pesa', airtel: 'Airtel Money', tkash: 'T-Kash', card: 'Card', cash: 'Cash' };

/** Masked phone number with a logged, time-limited reveal (30 seconds). The reason is recorded in the audit log. */
export function RevealPhone({ paymentId, masked, anonymous, toast }: { paymentId: string; masked: string; anonymous?: boolean; toast: Toast }) {
  const [real, setReal] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const hide = () => { if (timer.current) clearTimeout(timer.current); setReal(undefined); };
  const reveal = async () => {
    setBusy(true);
    try {
      const out = await api.post<any>(`/admin/payments/${paymentId}/reveal`, { reason: reason.trim() || undefined });
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
        : <Button kind="ghost" small onClick={() => setAsking(true)}>{anonymous ? 'Look up the giver' : 'Show number'}</Button>)}
      {asking && (
        <Dialog title="Showing a number is recorded in the audit log" onClose={() => setAsking(false)}
          footer={<>
            <Button kind="ghost" onClick={() => setAsking(false)}>Cancel</Button>
            <Button onClick={reveal} disabled={busy || (!!anonymous && reason.trim().length < 8)}>{busy ? 'Working…' : 'Show the number'}</Button>
          </>}>
          <p className="muted">The number is shown for 30 seconds, then hidden again.</p>
          {anonymous && <p className="muted">The giver chose to stay anonymous to the church. Look them up only for a refund, a fraud check or a legal request, and say which.</p>}
          <Field label={anonymous ? 'Reason (required)' : 'Reason (optional)'}><input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Member called about this payment" /></Field>
        </Dialog>
      )}
    </span>
  );
}

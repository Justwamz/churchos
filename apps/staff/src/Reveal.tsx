import { useEffect, useState } from 'react';
import { Button, ErrorNote, Field, phonePretty } from '@churchos/ui';
import { api, friendly, useSession } from './session';

/** Masked numbers such as 254711•••001 become 0711•••001. Never tries to un-mask. */
export const maskedPretty = (p: string | null | undefined) => phonePretty(p);

type Revealed = { phone?: string | null; contact_phones?: { guardian: string; phone: string }[] };

/** Asks for an optional reason, then calls the logged reveal endpoint. Shows the real number for 30 seconds. */
export function useReveal(memberId: string) {
  const s = useSession();
  const [asking, setAsking] = useState(false);
  const [data, setData] = useState<Revealed | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => setData(null), 30000);
    return () => clearTimeout(t);
  }, [data]);

  const confirm = async (reason: string) => {
    setBusy(true); setError('');
    try {
      const r = await api.post<Revealed>(`/members/${memberId}/reveal` + s.qs({ branch: undefined }), { fields: ['phone'], reason: reason.trim() || undefined });
      setData(r); setAsking(false);
    } catch (e: any) {
      setError(e.status === 403 ? 'You do not have permission to show phone numbers.' : e.status === 404 ? 'We could not find this member.' : friendly(e.message));
    }
    setBusy(false);
  };
  const dialog = asking && (
    <ReasonDialog busy={busy} error={error} onCancel={() => { setAsking(false); setError(''); }} onConfirm={confirm} />
  );
  return { data, hide: () => setData(null), ask: () => { setError(''); setAsking(true); }, dialog, canReveal: s.can('members.reveal') };
}

function ReasonDialog({ busy, error, onCancel, onConfirm }: { busy: boolean; error: string; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);
  return (
    <div className="modal-scrim" role="presentation" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Show phone number" style={{ width: 'min(420px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); onConfirm(reason); }}>
          <h2 style={{ margin: 0 }}>Show phone number</h2>
          <p className="muted" style={{ margin: 0 }}>Showing a phone number is recorded in the audit log.</p>
          <Field label="Why do you need it? (optional)">
            <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="row"><Button type="submit" disabled={busy}>{busy ? 'Showing…' : 'Show'}</Button><Button kind="ghost" onClick={onCancel}>Cancel</Button></div>
        </form>
      </div>
    </div>
  );
}

/** A member's phone (adult) or guardian contact numbers (child), masked, with a permission-gated Show number action. */
export function MemberPhone({ member, empty }: { member: any; empty?: React.ReactNode }) {
  const r = useReveal(member.id);
  const child = member.category === 'child';
  const masked = child
    ? (member.contact_phones?.length ? member.contact_phones.map((c: any) => maskedPretty(typeof c === 'string' ? c : c.phone)).join(', ') : '')
    : maskedPretty(member.phone);
  if (!masked) return <>{empty ?? '-'}</>;
  return (
    <div>
      {r.data ? (
        <div className="stack" style={{ gap: 2 }}>
          {child
            ? (r.data.contact_phones?.length ? r.data.contact_phones.map((c, i) => <div key={i}>{c.guardian}: <b>{phonePretty(c.phone)}</b></div>) : <div className="tiny">No guardian numbers on file.</div>)
            : <b>{phonePretty(r.data.phone)}</b>}
          <div><Button small kind="ghost" onClick={r.hide}>Hide</Button></div>
        </div>
      ) : (
        <div className="row" style={{ gap: 6 }}>
          <span className={child ? 'tiny' : undefined}>{child ? 'Contact: ' : ''}{masked}</span>
          {r.canReveal && <Button small kind="ghost" onClick={r.ask}>Show number</Button>}
        </div>
      )}
      {r.dialog}
    </div>
  );
}

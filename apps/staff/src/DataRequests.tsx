import { useState } from 'react';
import { Button, ErrorNote, Field, shortDate, useAsync, useToast, Failed } from '@churchos/ui';
import { api, friendly } from './session';
import { Card, EmptyState, PageHeader, Skeleton, StatusChip } from './ui';
import './join-requests.css';

type Req = { id: string; status: string; name: string; phone: string | null; reason: string | null; churches: string[]; createdAt: string; decidedAt: string | null; note: string | null; canDecide: boolean; needsPlatformAdmin: boolean };
const TONE: Record<string, 'wait' | 'done' | 'bad'> = { pending: 'wait', completed: 'done', approved: 'done', declined: 'bad' };
const LABEL: Record<string, string> = { pending: 'Waiting', completed: 'Erased', approved: 'Approved', declined: 'Declined' };

/** People > Data requests: members who asked to close their account and have their details erased. The church owner approves or declines. */
export function DataRequests() {
  const toast = useToast();
  const d = useAsync<{ requests: Req[] }>(() => api.get('/erasure-requests'), []);
  const [asking, setAsking] = useState<{ id: string; kind: 'approve' | 'decline' } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const decide = async (r: Req, approve: boolean) => {
    setBusy(r.id); setErr('');
    try {
      await api.post(`/erasure-requests/${r.id}/decide`, { decision: approve ? 'approve' : 'decline', note: note.trim() });
      toast.show(approve ? 'Done. The account is closed and the personal details are erased.' : 'Declined. The member will see your note.');
      setAsking(null); setNote('');
      d.reload();
    } catch (e: any) { setErr(friendly(e.message)); }
    setBusy(null);
  };

  if (d.error && !d.data) {
    const denied = /missing permission|forbidden|do not have access/i.test(d.error);
    return denied
      ? <EmptyState icon="shield" title="Data requests are not available to you" text="Only the church owner looks after requests to erase a member's data." />
      : <Failed onRetry={d.reload}>{friendly(d.error)}</Failed>;
  }
  const rows = d.data?.requests ?? [];
  return (
    <div className="jr">
      <PageHeader title="Data requests" subtitle="Members who asked to close their account and have their personal details erased." />
      <p className="jr-hint">Approving erases the member's name, phone, date of birth and messages from your records. Gifts, payments and the audit trail are kept for the law (7 years) and cannot be changed. Event credit the member holds is lost.</p>
      {err && <ErrorNote>{err}</ErrorNote>}
      {!d.data ? <Skeleton rows={3} height={120} /> : rows.length === 0 ? (
        <EmptyState icon="shield" title="No data requests" text="When a member asks to erase their data, it shows here." />
      ) : (
        <div className="jr-list">
          {rows.map((r) => (
            <Card key={r.id}>
              <div className="jr-card">
                <div className="jr-head">
                  <div className="jr-who">
                    <div className="jr-name">{r.name}</div>
                    <div className="jr-sub">{[r.phone, `asked ${shortDate(r.createdAt)}`].filter(Boolean).join(' · ')}</div>
                  </div>
                  <StatusChip tone={TONE[r.status] ?? 'off'}>{LABEL[r.status] ?? r.status}</StatusChip>
                </div>
                {r.reason && <p className="jr-msg">{r.reason}</p>}
                {r.churches.length > 0 && <p className="jr-hint">Member of: {r.churches.join(', ')}</p>}
                {r.status !== 'pending' && r.decidedAt && <p className="jr-hint">Decided {shortDate(r.decidedAt)}{r.note ? `: ${r.note}` : ''}</p>}
                {r.status === 'pending' && r.needsPlatformAdmin && <p className="jr-hint">This member belongs to more than one church (or none), so a ChurchOS administrator decides.</p>}
                {r.status === 'pending' && r.canDecide && (asking?.id === r.id ? (
                  <div className="jr-ask" role="group" aria-label={asking.kind === 'approve' ? 'Confirm erasure' : 'Decline'}>
                    <Field label={asking.kind === 'approve' ? 'Note (optional)' : 'Why are you declining?'} hint={asking.kind === 'decline' ? 'The member will see this' : undefined}>
                      <textarea rows={3} maxLength={300} value={note} autoFocus onChange={(e) => setNote(e.target.value)} />
                    </Field>
                    <div className="jr-actions">
                      {asking.kind === 'approve'
                        ? <Button kind="danger" disabled={busy === r.id} onClick={() => decide(r, true)}>{busy === r.id ? 'Erasing...' : 'Yes, erase now'}</Button>
                        : <Button kind="danger" disabled={busy === r.id || note.trim().length < 2} onClick={() => decide(r, false)}>{busy === r.id ? 'Declining...' : 'Decline request'}</Button>}
                      <Button kind="ghost" disabled={busy === r.id} onClick={() => { setAsking(null); setNote(''); }}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div className="jr-actions"><Button onClick={() => { setAsking({ id: r.id, kind: 'approve' }); setNote(''); setErr(''); }}>Approve</Button><Button kind="ghost" onClick={() => { setAsking({ id: r.id, kind: 'decline' }); setNote(''); setErr(''); }}>Decline</Button></div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
      {toast.node}
    </div>
  );
}

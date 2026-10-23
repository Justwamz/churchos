import { useState } from 'react';
import { Button, ErrorNote, Field, Note, Table, kes, shortDate, useAsync } from '@churchos/ui';
import { Card, Dialog, EmptyState, PageHeader, StatusChip } from '../ui';
import { api, errText, Load, num, RefreshButton, type PageProps } from '../common';

type Req = { id: string; status: string; name: string; phone: string | null; reason: string | null; churches: string[]; createdAt: string; decidedAt: string | null; note: string | null; heldCreditCents: number; canDecide: boolean; needsPlatformAdmin: boolean };
const TONE: Record<string, 'wait' | 'done' | 'bad'> = { pending: 'wait', completed: 'done', approved: 'done', declined: 'bad' };
const LABEL: Record<string, string> = { pending: 'Waiting', completed: 'Erased', approved: 'Approved', declined: 'Rejected' };

// ---------------- Data requests (erasure decisions) ----------------

/** People who asked to close their account and have their personal details erased. Platform admins decide the ones no single church can (more than one church, or none). */
export function DataRequests({ toast }: PageProps) {
  const d = useAsync<{ requests: Req[] }>(() => api.get('/erasure-requests'));
  const [ask, setAsk] = useState<{ r: Req; approve: boolean } | undefined>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');

  const close = () => { setAsk(undefined); setNote(''); };
  const decide = async () => {
    if (!ask) return;
    setBusy(true);
    try {
      await api.post(`/erasure-requests/${ask.r.id}/decide`, { decision: ask.approve ? 'approve' : 'decline', note: note.trim() });
      toast(ask.approve ? 'Done. The account is closed and the personal details are erased.' : 'Rejected. The person will see your note.');
      close(); d.reload();
    } catch (e: any) { toast(errText(e), 'bad'); if (e.code === 'already_decided') { close(); d.reload(); } }
    setBusy(false);
  };

  return (
    <>
      <PageHeader title="Data requests" subtitle="People who asked to close their account and have their personal details erased." actions={<RefreshButton onClick={d.reload} />} />
      <Note>Approving erases the name, phone, date of birth and messages everywhere they are held. Gifts, payments and the audit trail are kept for the law (7 years) and cannot be changed. Event credit the person holds is lost. Answer within 30 days.</Note>
      <div style={{ height: 12 }} />
      <div className="row" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button type="button" className={`chip ${filter === 'pending' ? 'on' : ''}`} onClick={() => setFilter('pending')}>Waiting</button>
        <button type="button" className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All requests</button>
      </div>
      {d.error && !d.data && <ErrorNote>{d.error}</ErrorNote>}
      <Card pad={false}>
        <Load s={d} rows={4}>
          {({ requests }) => {
            const rows = filter === 'pending' ? requests.filter((r) => r.status === 'pending') : requests;
            return rows.length === 0 ? <EmptyState icon="shield" title={filter === 'pending' ? 'Nothing is waiting' : 'No data requests'} text="When someone asks to erase their data it shows here." /> : (
              <Table head={['Who', 'Asked', 'Churches', 'Credit held', 'Status', '']}>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.name}</b>{r.phone && <div className="tiny">{r.phone}</div>}{r.reason && <div className="tiny">{r.reason}</div>}</td>
                    <td>{shortDate(r.createdAt)}{r.decidedAt && <div className="tiny">Decided {shortDate(r.decidedAt)}</div>}</td>
                    <td>{r.churches.length ? r.churches.join(', ') : <span className="tiny">No church</span>}{r.status === 'pending' && r.needsPlatformAdmin && <div className="tiny">More than one church, or none: a platform admin decides.</div>}</td>
                    <td>{num(r.heldCreditCents) > 0 ? <b>{kes(r.heldCreditCents)}</b> : <span className="tiny">None</span>}</td>
                    <td><StatusChip tone={TONE[r.status] ?? 'off'}>{LABEL[r.status] ?? r.status}</StatusChip>{r.note && <div className="tiny">{r.note}</div>}</td>
                    <td>{r.status === 'pending' && r.canDecide && <div style={{ display: 'flex', gap: 6 }}><Button small onClick={() => setAsk({ r, approve: true })}>Approve</Button><Button small kind="ghost" onClick={() => setAsk({ r, approve: false })}>Reject</Button></div>}</td>
                  </tr>
                ))}
              </Table>
            );
          }}
        </Load>
      </Card>
      {ask && (
        <Dialog title={ask.approve ? `Erase ${ask.r.name}'s data?` : 'Reject this request'} onClose={close}
          footer={<>
            <Button kind="ghost" onClick={close}>Cancel</Button>
            {ask.approve
              ? <Button kind="danger" onClick={decide} disabled={busy}>{busy ? 'Erasing…' : 'Yes, erase now'}</Button>
              : <Button kind="danger" onClick={decide} disabled={busy || note.trim().length < 2}>{busy ? 'Rejecting…' : 'Reject request'}</Button>}
          </>}>
          {ask.approve
            ? <p className="muted">This cannot be undone.{num(ask.r.heldCreditCents) > 0 ? ` ${kes(ask.r.heldCreditCents)} of event credit is lost.` : ''} Churches: {ask.r.churches.join(', ') || 'none'}.</p>
            : <p className="muted">The person sees your note in their inbox.</p>}
          <Field label={ask.approve ? 'Note (optional)' : 'Why are you rejecting it? (required)'}><textarea rows={3} maxLength={300} value={note} autoFocus onChange={(e) => setNote(e.target.value)} /></Field>
        </Dialog>
      )}
    </>
  );
}

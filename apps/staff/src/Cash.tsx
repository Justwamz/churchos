import { useState } from 'react';
import { Button, Card, Empty, Field, Note, StatusBadge, Table, kes, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, label, useSession } from './session';
import { Load, PageHead } from './bits';

export function Cash() {
  const s = useSession();
  const d = useAsync<any[]>(() => api.get('/cash' + s.qs()), [s.qs()]);
  const toast = useToast();
  const canCount = s.can('cash.count');
  const [form, setForm] = useState({ branchId: '', purpose: 'TITHE', amount: '', note: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const branchId = form.branchId || (s.scope !== 'all' ? s.scope : s.branches[0]?.id ?? '');

  const record = async () => {
    setBusy('form');
    try {
      await api.post('/cash' + s.qs(), { branchId, purpose: form.purpose, amount: form.amount, note: form.note || undefined });
      toast.show('Count recorded. A second person now needs to sign it off.');
      setForm({ ...form, amount: '', note: '' });
      d.reload();
    } catch (e: any) { toast.show(friendly(e.message), 'bad'); }
    setBusy(null);
  };
  const signoff = async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      await api.post(`/cash/${id}/signoff` + s.qs(), { approve });
      toast.show(approve ? 'Count approved.' : 'Count rejected.');
      d.reload();
    } catch (e: any) {
      toast.show(e.code === 'same_person' || /second person/i.test(e.message) ? 'A second person must sign off this count, not the person who counted it.' : friendly(e.message), 'bad');
    }
    setBusy(null);
  };

  return (
    <>
      <PageHead title="Cash" sub="Count the offering, then have a second person confirm it." />
      <Note tone="info">Every cash count needs two different people: one counts and records it, another signs it off. Only then is it added to your collections and the platform fee charged.</Note>
      <div className="stack" style={{ marginTop: 12 }}>
        {canCount && (
          <Card title="Record a counted amount">
            <form className="grid cols-4" onSubmit={(e) => { e.preventDefault(); record(); }}>
              <Field label="Branch">
                <select value={branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
                  {s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
              <Field label="Purpose">
                <select value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })}>
                  <option value="TITHE">Tithe</option><option value="OFFERING">Offering</option>
                </select>
              </Field>
              <Field label="Counted amount (KES)"><input inputMode="decimal" placeholder="12500" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
              <Field label="Note (optional)"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Sunday service" /></Field>
              <div><Button type="submit" disabled={busy === 'form' || !form.amount || !branchId}>{busy === 'form' ? 'Saving…' : 'Record count'}</Button></div>
            </form>
          </Card>
        )}
        <Load loading={d.loading} error={d.error} hasData={!!d.data}>
          <Card title="Cash entries">
            {!d.data || d.data.length === 0 ? <Empty>No cash counts yet.</Empty> : (
              <Table head={['Date', 'Branch', 'Purpose', 'Amount', 'Status', 'Details', '']}>
                {d.data.map((c: any) => {
                  const mine = c.counted_by === s.user.id;
                  return (
                    <tr key={c.id}>
                      <td>{shortDate(c.created_at)}</td>
                      <td>{c.branch_name}</td>
                      <td>{label(c.purpose)}{c.note ? <div className="tiny">{c.note}</div> : null}</td>
                      <td className="num">{kes(c.amount)}</td>
                      <td><StatusBadge status={c.status} /></td>
                      <td>
                        {c.status === 'counted' && <span className="tiny">Counted by {mine ? 'you' : c.counted_by_name}, waiting for a second person</span>}
                        {c.status === 'approved' && <span className="tiny">Approved by {c.approved_by_name}. Platform fee charged: {kes(c.fee)}</span>}
                        {c.status === 'rejected' && <span className="tiny">Rejected by {c.approved_by_name}</span>}
                      </td>
                      <td>
                        {c.status === 'counted' && s.can('cash.approve') && !mine && (
                          <div className="row" style={{ flexWrap: 'nowrap' }}>
                            <Button small disabled={busy === c.id} onClick={() => signoff(c.id, true)}>Approve</Button>
                            <Button small kind="ghost" disabled={busy === c.id} onClick={() => signoff(c.id, false)}>Reject</Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </Card>
        </Load>
      </div>
      {toast.node}
    </>
  );
}

import { useState } from 'react';
import { Badge, Button, Card, Empty, Field, Note, StatusBadge, Table, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load, PageHead } from './bits';

const REL = ['Head', 'Spouse', 'Child', 'Parent', 'Other'];

export function Members() {
  const s = useSession();
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const d = useAsync<any[]>(() => api.get('/members' + s.qs({ q: applied || undefined })), [s.qs(), applied]);
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ fullName: '', phone: '', branchId: '', householdId: '', newHousehold: '', relationship: 'Head' });
  const [busy, setBusy] = useState(false);
  const branchId = f.branchId || (s.scope !== 'all' ? s.scope : s.branches[0]?.id ?? '');
  const households = Array.from(new Map((d.data ?? []).filter((m) => m.household_id).map((m) => [m.household_id, m.household])).entries());

  const add = async () => {
    setBusy(true);
    try {
      const r = await api.post('/members' + s.qs(), {
        fullName: f.fullName, phone: f.phone || undefined, branchId, relationship: f.relationship,
        householdId: f.householdId || undefined, newHousehold: !f.householdId && f.newHousehold ? f.newHousehold : undefined,
      });
      toast.show(`Added. Member number ${r.memberNumber}.`);
      setF({ ...f, fullName: '', phone: '', householdId: '', newHousehold: '' });
      setAdding(false);
      d.reload();
    } catch (e: any) { toast.show(friendly(e.message), 'bad'); }
    setBusy(false);
  };

  return (
    <>
      <PageHead title="Members" sub="Your church family." action={s.can('members.edit') && <Button onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add member'}</Button>} />
      <div className="stack">
        {adding && (
          <Card title="Add a member">
            <form className="grid cols-3" onSubmit={(e) => { e.preventDefault(); add(); }}>
              <Field label="Full name"><input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
              <Field label="Phone (optional)"><input inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="0712 345 678" /></Field>
              <Field label="Branch">
                <select value={branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>
                  {s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
              <Field label="Household">
                <select value={f.householdId} onChange={(e) => setF({ ...f, householdId: e.target.value })}>
                  <option value="">New household</option>
                  {households.map(([id, name]) => <option key={String(id)} value={String(id)}>{String(name)}</option>)}
                </select>
              </Field>
              {!f.householdId && <Field label="New household name" hint="Leave empty for no household"><input value={f.newHousehold} onChange={(e) => setF({ ...f, newHousehold: e.target.value })} placeholder="The Otieno family" /></Field>}
              <Field label="Relationship">
                <select value={f.relationship} onChange={(e) => setF({ ...f, relationship: e.target.value })}>{REL.map((r) => <option key={r}>{r}</option>)}</select>
              </Field>
              <div><Button type="submit" disabled={busy || !f.fullName.trim() || !branchId}>{busy ? 'Saving…' : 'Save member'}</Button></div>
            </form>
          </Card>
        )}
        <Card>
          <form className="row" onSubmit={(e) => { e.preventDefault(); setApplied(q.trim()); }}>
            <input style={{ flex: 1, minWidth: 200 }} placeholder="Search by name, member number or phone" value={q} onChange={(e) => setQ(e.target.value)} />
            <Button type="submit">Search</Button>
          </form>
        </Card>
        <Load loading={d.loading} error={d.error} hasData={!!d.data}>
          <Card title={`Members${d.data ? ` (${d.data.length})` : ''}`}>
            {!d.data || d.data.length === 0 ? <Empty>No members found.</Empty> : (
              <Table head={['Name', 'Member no.', 'Branch', 'Household', 'Relationship']}>
                {d.data.map((m) => (
                  <tr key={m.id}><td><b>{m.full_name}</b></td><td className="mono">{m.member_number}</td><td>{m.branch_name}</td><td>{m.household ?? '-'}</td><td>{m.relationship ?? '-'}</td></tr>
                ))}
              </Table>
            )}
          </Card>
        </Load>
      </div>
      {toast.node}
    </>
  );
}

export function Transfers() {
  const d = useAsync<any[]>(() => api.get('/transfers'), []);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      await api.post(`/transfers/${id}/decide`, { approve });
      toast.show(approve ? 'Transfer approved.' : 'Transfer rejected.');
      d.reload();
    } catch (e: any) { toast.show(friendly(e.message), 'bad'); }
    setBusy(null);
  };
  return (
    <>
      <PageHead title="Transfers" sub="Members asking to join your branches." />
      <Note tone="info">Moving between branches of the same church keeps the member number. Moving to a different church gives the member a new number there, and the old membership is closed, not deleted.</Note>
      <Load loading={d.loading} error={d.error} hasData={!!d.data}>
        <div style={{ marginTop: 12 }}>
          <Card>
            {!d.data || d.data.length === 0 ? <Empty>No transfer requests.</Empty> : (
              <Table head={['Requested', 'Member', 'From', 'To', 'Status', '']}>
                {d.data.map((t) => (
                  <tr key={t.id}>
                    <td>{shortDate(t.created_at)}</td>
                    <td><b>{t.full_name}</b> <span className="tiny">{t.member_number}</span></td>
                    <td>{t.from_name}</td><td>{t.to_name}</td>
                    <td><StatusBadge status={t.status} />{t.to_org_id && t.org_id && t.to_org_id !== t.org_id && <> <Badge tone="info">Other church</Badge></>}</td>
                    <td>{t.status === 'requested' && (
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        <Button small disabled={busy === t.id} onClick={() => decide(t.id, true)}>Approve</Button>
                        <Button small kind="ghost" disabled={busy === t.id} onClick={() => decide(t.id, false)}>Reject</Button>
                      </div>
                    )}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      </Load>
      {toast.node}
    </>
  );
}

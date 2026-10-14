import { useState } from 'react';
import { Badge, Button, Card, Empty, Field, Note, Table, dateOnly, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load, PageHead } from './bits';

const describe = (d: any) => {
  if (!d) return 'Not set yet';
  if (d.type === 'mobile') return `Mobile money${d.phone ? ' ending ' + String(d.phone).slice(-3) : ''}`;
  const num = d.accountNumber ? String(d.accountNumber).replace(/\d(?=\d{4})/g, '•') : '';
  return [d.bank ?? 'Bank', num, d.accountName].filter(Boolean).join(' · ');
};

const statusText = (r: any) => {
  if (r.status === 'requested') return <Badge tone="info">Waiting for ChurchOS approval</Badge>;
  if (r.status === 'approved') return <Badge tone="warn">Approved, takes effect {dateOnly(r.effective_at)} after the 72 hour safety wait</Badge>;
  if (r.status === 'applied') return <Badge tone="good">Applied</Badge>;
  return <Badge tone="bad">Rejected</Badge>;
};

export function Payout() {
  const s = useSession();
  const d = useAsync<any>(() => api.get('/payout-destination' + s.qs()), [s.qs()]);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ branchId: '', type: 'bank', bank: '', accountNumber: '', accountName: '', phone: '' });
  const data = d.data;
  const branchId = f.branchId || (s.scope !== 'all' ? s.scope : data?.branches?.[0]?.id ?? '');
  const hours = data?.coolingOffHours ?? 72;
  const ok = f.type === 'bank' ? f.bank.trim() && f.accountNumber.trim() && f.accountName.trim() : f.phone.trim();

  const submit = async () => {
    setBusy(true);
    try {
      const destination = f.type === 'bank'
        ? { type: 'bank', bank: f.bank.trim(), accountNumber: f.accountNumber.trim(), accountName: f.accountName.trim() }
        : { type: 'mobile', phone: f.phone.trim() };
      await api.post('/payout-destination/requests' + s.qs(), { branchId, destination });
      toast.show('Request sent. It now waits for ChurchOS approval.');
      setF({ ...f, bank: '', accountNumber: '', accountName: '', phone: '' });
      d.reload();
    } catch (e: any) { toast.show(friendly(e.message), 'bad'); }
    setBusy(false);
  };

  return (
    <>
      <PageHead title="Payout account" sub="Where your church's money is paid." />
      <Load loading={d.loading} error={d.error} hasData={!!data}>
        {data && (
          <div className="stack">
            <Note tone="info">To protect your church, a new payout account is approved by ChurchOS and then waits {hours} hours before it takes effect. Until then, payouts keep going to the old account.</Note>
            <Card title="Current accounts">
              <Table head={['Branch', 'Account', 'Verification']}>
                {data.branches.map((b: any) => (
                  <tr key={b.id}><td>{b.name}</td><td>{describe(b.destination)}</td><td>{b.verified ? <Badge tone="good">Verified</Badge> : <Badge tone="warn">Not verified</Badge>}</td></tr>
                ))}
              </Table>
            </Card>
            <Card title="Request a change">
              <form className="grid cols-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
                <Field label="Branch">
                  <select value={branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>
                    {data.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </Field>
                <Field label="Pay to">
                  <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
                    <option value="bank">Bank account</option>
                    <option value="mobile">Mobile money</option>
                  </select>
                </Field>
                {f.type === 'bank' ? (
                  <>
                    <Field label="Bank"><input value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} /></Field>
                    <Field label="Account number"><input inputMode="numeric" autoComplete="off" value={f.accountNumber} onChange={(e) => setF({ ...f, accountNumber: e.target.value })} /></Field>
                    <Field label="Account name"><input value={f.accountName} onChange={(e) => setF({ ...f, accountName: e.target.value })} /></Field>
                  </>
                ) : (
                  <Field label="Mobile money number"><input inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="0712345678" /></Field>
                )}
                <div style={{ alignSelf: 'end', marginBottom: 12 }}><Button type="submit" disabled={busy || !ok || !branchId}>{busy ? 'Sending…' : 'Request change'}</Button></div>
              </form>
            </Card>
            <Card title="Requests">
              {data.requests.length === 0 ? <Empty>No change requests yet.</Empty> : (
                <Table head={['Requested', 'Branch', 'New account', 'Status']}>
                  {data.requests.map((r: any) => (
                    <tr key={r.id}>
                      <td>{shortDate(r.created_at)}</td>
                      <td>{data.branches.find((b: any) => b.id === r.branch_id)?.name ?? '-'}</td>
                      <td>{describe(r.destination)}</td>
                      <td>{statusText(r)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        )}
      </Load>
      {toast.node}
    </>
  );
}

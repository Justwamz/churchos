import { useState } from 'react';
import { Button, Field, dateOnly, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Modal } from './MemberForm';
import { Card, EmptyState, PageHeader, Section, StatusChip } from './ui';
import { Loaded } from './money-bits';
import './money.css';

const describe = (d: any) => {
  if (!d) return 'Not set yet';
  if (d.type === 'mobile') return `Mobile money${d.phone ? ' ending ' + String(d.phone).slice(-3) : ''}`;
  const num = d.accountNumber ? String(d.accountNumber).replace(/\d(?=\d{4})/g, '•') : '';
  return [d.bank ?? 'Bank', num, d.accountName].filter(Boolean).join(' · ');
};

const statusText = (r: any) => {
  if (r.status === 'requested') return <StatusChip tone="info">Waiting for ChurchOS approval</StatusChip>;
  if (r.status === 'approved') return <StatusChip tone="wait">Approved, takes effect {dateOnly(r.effective_at)} after the 72 hour safety wait</StatusChip>;
  if (r.status === 'applied') return <StatusChip tone="done">Applied</StatusChip>;
  return <StatusChip tone="bad">Rejected</StatusChip>;
};

export function Payout() {
  const s = useSession();
  const d = useAsync<any>(() => api.get('/payout-destination' + s.qs()), [s.qs()]);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('accounts');
  const [form, setForm] = useState(false);
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
      setForm(false); setTab('requests');
      d.reload();
    } catch (e: any) { toast.show(friendly(e.message), 'bad'); }
    setBusy(false);
  };

  return (
    <>
      <PageHeader
        title="Payout account"
        subtitle={`Where your church's money is paid. A new account is approved by ChurchOS, then waits ${hours} hours before it takes effect. Until then, payouts keep going to the old account.`}
        actions={data ? <Button onClick={() => setForm(true)}>Request a change</Button> : undefined}
        tabs={[{ id: 'accounts', label: 'Current accounts' }, { id: 'requests', label: 'Requests', badge: data?.requests?.length || undefined }]}
        tab={tab}
        onTab={setTab}
      />
      <Loaded loading={d.loading} error={d.error} hasData={!!data} rows={3}>
        {data && tab === 'accounts' && (
          <Section>
            <Card pad={false} className="mn-wrap">
              <div className="mn-scroll">
                <table className="mn-table">
                  <thead><tr><th>Branch</th><th>Account</th><th>Verification</th></tr></thead>
                  <tbody>
                    {data.branches.map((b: any) => (
                      <tr key={b.id}><td className="mn-first" data-l="Branch"><b>{b.name}</b></td><td data-l="Account">{describe(b.destination)}</td><td data-l="Verification">{b.verified ? <StatusChip tone="done">Verified</StatusChip> : <StatusChip tone="wait">Not verified</StatusChip>}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </Section>
        )}
        {data && tab === 'requests' && (
          <Section>
            {data.requests.length === 0 ? <Card><EmptyState icon="wallet" title="No change requests yet" text="When you ask to change an account, it shows up here." /></Card> : (
              <Card pad={false} className="mn-wrap">
                <div className="mn-scroll">
                  <table className="mn-table">
                    <thead><tr><th>Requested</th><th>Branch</th><th>New account</th><th>Status</th></tr></thead>
                    <tbody>
                      {data.requests.map((r: any) => (
                        <tr key={r.id}>
                          <td className="mn-first" data-l="Requested">{shortDate(r.created_at)}</td>
                          <td data-l="Branch">{data.branches.find((b: any) => b.id === r.branch_id)?.name ?? '-'}</td>
                          <td data-l="New account">{describe(r.destination)}</td>
                          <td data-l="Status">{statusText(r)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </Section>
        )}
      </Loaded>
      {form && data && (
        <Modal title="Request a change" onClose={() => setForm(false)}>
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div className="mn-fields">
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
            </div>
            <div className="mn-btns end">
              <Button kind="ghost" onClick={() => setForm(false)}>Cancel</Button>
              <Button type="submit" disabled={busy || !ok || !branchId}>{busy ? 'Sending…' : 'Request change'}</Button>
            </div>
          </form>
        </Modal>
      )}
      {toast.node}
    </>
  );
}

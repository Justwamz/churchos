import { useState } from 'react';
import { Badge, Button, Card, Empty, Field, Note, Stat, StatusBadge, Table, kes, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, label, methodLabel, useSession } from './session';
import { Load, PageHead } from './bits';
import { maskedPretty } from './Reveal';
import './giving-record.css';

const METHODS = ['mpesa', 'airtel', 'card', 'tkash', 'cash'];

export function Collections() {
  const s = useSession();
  const [f, setF] = useState({ from: '', to: '', purpose: '', method: '', branch: '' });
  const [applied, setApplied] = useState(f);
  const params = (g: typeof f) => {
    const branch = g.branch || (s.scope !== 'all' ? s.scope : '');
    return s.qs({ from: g.from || undefined, to: g.to || undefined, purpose: g.purpose || undefined, method: g.method || undefined, branch: branch || undefined });
  };
  const key = params(applied);
  const d = useAsync<any>(() => api.get('/collections' + key), [key]);
  const toast = useToast();
  const [report, setReport] = useState<any | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const csv = () => window.open(api.url('/collections' + params(applied) + '&format=csv'), '_blank');

  const submit = async () => {
    if (!report) return;
    setBusy(true);
    try {
      await api.post('/reversal-requests' + s.qs(), { paymentId: report.id, reason });
      toast.show('Problem reported. It will be reviewed.');
      setReport(null); setReason('');
    } catch (e: any) { toast.show(friendly(e.message), 'bad'); }
    setBusy(false);
  };

  const x = d.data;
  const purposes = Array.from(new Set<string>(['TITHE', 'OFFERING', ...(x?.byPurpose ?? []).map((r: any) => String(r.key))]));
  const breakdown = (title: string, rows: any[], fmt: (k: string) => string) => (
    <Card title={title}>
      {rows.length === 0 ? <Empty>Nothing in this range.</Empty> : (
        <Table head={[title.replace('By ', ''), 'Count', 'Gross', 'Fee', 'Net']}>
          {rows.map((r) => (
            <tr key={r.key}><td>{fmt(r.key)}</td><td className="num">{r.n}</td><td className="num">{kes(r.gross)}</td><td className="num">{kes(r.fee)}</td><td className="num">{kes(r.net)}</td></tr>
          ))}
        </Table>
      )}
    </Card>
  );

  return (
    <>
      <div className="page-head">
        <div><h1 style={{ margin: 0 }}>Collections</h1><p>Every payment and recorded cash, with the fee shown as one amount.</p><p className="tiny">Phone numbers are partly hidden to protect your members.</p></div>
        <Button kind="ghost" onClick={csv}>Download CSV</Button>
      </div>
      <Card>
        <form className="grid cols-4" onSubmit={(e) => { e.preventDefault(); setApplied(f); }}>
          <Field label="From"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="To"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Field label="Purpose">
            <select value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>
              <option value="">All purposes</option>
              {purposes.map((p) => <option key={p} value={p}>{label(p)}</option>)}
            </select>
          </Field>
          <Field label="Method">
            <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
              <option value="">All methods</option>
              {METHODS.map((m) => <option key={m} value={m}>{methodLabel(m)}</option>)}
            </select>
          </Field>
          {s.branches.length > 1 && (
            <Field label="Branch">
              <select value={f.branch} onChange={(e) => setF({ ...f, branch: e.target.value })}>
                <option value="">{s.scope === 'all' ? 'All branches' : 'Selected branch'}</option>
                {s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
          )}
          <div style={{ alignSelf: 'end', marginBottom: 12 }}><Button type="submit">Apply filters</Button></div>
        </form>
      </Card>
      <div style={{ height: 16 }} />
      <Load loading={d.loading} error={d.error} hasData={!!x}>
        {x && (
          <div className="stack">
            <div className="grid cols-4">
              <Stat label="Gross" value={kes(x.totals.gross)} />
              <Stat label="Fee" value={kes(x.totals.fee)} hint="All fees combined" />
              <Stat label="Net" value={kes(x.totals.net)} tone="good" />
              <Stat label="Payments" value={x.totals.n} />
            </div>
            <div className="grid cols-3">
              {breakdown('By method', x.byMethod, methodLabel)}
              {breakdown('By purpose', x.byPurpose, label)}
              {breakdown('By branch', x.byBranch, (k) => k)}
            </div>
            <Card title="Transactions" action={<span className="tiny">{x.rows.length >= 1000 ? 'Showing the latest 1,000. Download the CSV for more.' : `${x.rows.length} rows`}</span>}>
              {x.rows.length === 0 ? <Empty>No collections match these filters.</Empty> : (
                <Table head={['Date', 'Branch', 'Method', 'Purpose', 'Member / phone', 'Gross', 'Fee', 'Net', 'Status', '']}>
                  {x.rows.map((r: any) => (
                    <tr key={r.id}>
                      <td>{shortDate(r.date)}</td>
                      <td>{r.branch}</td>
                      <td>{r.method === 'anonymous' ? <Badge tone="muted">Anonymous</Badge> : methodLabel(r.method)}</td>
                      <td>{label(r.purpose)}</td>
                      <td>{r.method === 'anonymous' ? (r.member ?? 'Anonymous') : r.member ? <>{r.member} <span className="tiny">{r.member_number}</span></> : maskedPretty(r.phone) || '-'}</td>
                      <td className="num">{kes(r.gross)}</td>
                      <td className="num">{kes(r.fee)}</td>
                      <td className="num">{kes(r.net)}</td>
                      <td><StatusBadge status={r.status} /></td>
                      <td>{s.can('reversals.request') && r.method !== 'cash' && r.method !== 'anonymous' && r.status !== 'reversed' &&
                        <Button kind="ghost" small onClick={() => { setReport(r); setReason(''); }}>Report a problem</Button>}</td>
                    </tr>
                  ))}
                </Table>
              )}
              {x.rows.some((r: any) => r.method === 'anonymous') && <p className="tiny" style={{ marginTop: 8 }}>Anonymous gifts are shown as one total for each day. The church cannot see who gave them.</p>}
            </Card>
          </div>
        )}
      </Load>
      {report && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(23,33,43,.45)', display: 'grid', placeItems: 'center', zIndex: 40, padding: 16 }}>
          <div className="card" style={{ width: 'min(460px,100%)' }}>
            <h3 style={{ marginTop: 0 }}>Report a problem</h3>
            <p className="muted">{kes(report.gross)} on {shortDate(report.date)} ({methodLabel(report.method)}). Are you sure you want to ask for this payment to be reversed?</p>
            <Field label="What went wrong?"><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: sent to the wrong church" /></Field>
            <Note tone="info">A reversal request is reviewed before anything changes.</Note>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button kind="ghost" onClick={() => setReport(null)}>Cancel</Button>
              <Button kind="danger" disabled={busy || !reason.trim()} onClick={submit}>{busy ? 'Sending…' : 'Yes, report it'}</Button>
            </div>
          </div>
        </div>
      )}
      {toast.node}
    </>
  );
}

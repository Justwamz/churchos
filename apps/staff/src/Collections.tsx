import { useState } from 'react';
import { Button, Field, Note, kes, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, label, methodLabel, useSession } from './session';
import { maskedPretty } from './Reveal';
import { Modal } from './MemberForm';
import { Card, EmptyState, PageHeader, Section, Stat, StatTiles, StatusChip } from './ui';
import { Loaded, PayChip } from './money-bits';
import './giving-record.css';

const METHODS = ['mpesa', 'airtel', 'card', 'tkash', 'cash'];

export function Collections() {
  const s = useSession();
  const [f, setF] = useState({ from: '', to: '', purpose: '', method: '', branch: '' });
  const [applied, setApplied] = useState(f);
  const [tab, setTab] = useState('payments');
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

  const csv = () => api.openDownload('/collections' + params(applied) + '&format=csv').catch(() => undefined);

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
    <Card pad={false} className="mn-wrap">
      <div className="mn-pad"><div className="mn-cardhead" style={{ marginTop: 16 }}><h3>{title}</h3></div></div>
      {rows.length === 0 ? <div className="mn-pad mn-inner-empty"><p className="mn-flat-note">Nothing in this range.</p></div> : (
        <div className="mn-scroll">
          <table className="mn-table">
            <thead><tr><th>{title.replace('By ', '')}</th><th className="num">Count</th><th className="num">Gross</th><th className="num">Fee</th><th className="num">Net</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}><td className="mn-first" data-l={title.replace('By ', '')}>{fmt(r.key)}</td><td className="num" data-l="Count">{r.n}</td><td className="num" data-l="Gross">{kes(r.gross)}</td><td className="num" data-l="Fee">{kes(r.fee)}</td><td className="num" data-l="Net">{kes(r.net)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );

  return (
    <>
      <PageHeader
        title="Collections"
        subtitle="Every payment and recorded cash. Phone numbers are partly hidden to protect your members."
        actions={<Button kind="ghost" onClick={csv}>Download CSV</Button>}
        tabs={[{ id: 'payments', label: 'Payments' }, { id: 'summary', label: 'Summary' }]}
        tab={tab}
        onTab={setTab}
      />
      <Section>
        <Card>
          <form className="mn-fields tight" onSubmit={(e) => { e.preventDefault(); setApplied(f); }}>
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
            <div><Button type="submit">Apply filters</Button></div>
          </form>
        </Card>
      </Section>
      <Loaded loading={d.loading} error={d.error} hasData={!!x} rows={4} height={92}>
        {x && (
          <>
            <Section><StatTiles>
              <Stat label="Gross" value={kes(x.totals.gross)} />
              <Stat label="Fee" value={kes(x.totals.fee)} hint="All fees combined" />
              <Stat label="Net" value={kes(x.totals.net)} tone="good" />
              <Stat label="Payments" value={x.totals.n} />
            </StatTiles></Section>
            {tab === 'summary' && (
              <Section>
                <div className="mn-cols">
                  {breakdown('By method', x.byMethod, methodLabel)}
                  {breakdown('By purpose', x.byPurpose, label)}
                  {breakdown('By branch', x.byBranch, (k) => k)}
                </div>
              </Section>
            )}
            {tab === 'payments' && (
              <Section title="Transactions" hint={x.rows.length >= 1000 ? 'Showing the latest 1,000. Download the CSV for more.' : `${x.rows.length} ${x.rows.length === 1 ? 'row' : 'rows'}`}>
                {x.rows.length === 0 ? <Card><EmptyState icon="money" title="No collections match" text="Try a wider date range or fewer filters." /></Card> : (
                  <Card pad={false} className="mn-wrap">
                    <div className="mn-scroll">
                      <table className="mn-table">
                        <thead><tr><th>Date</th><th>Gift</th><th>Member / phone</th><th className="num">Gross</th><th className="num">Fee</th><th className="num">Net</th><th>Status</th><th /></tr></thead>
                        <tbody>
                          {x.rows.map((r: any) => (
                            <tr key={r.id}>
                              <td className="mn-first" data-l="Date"><span>{shortDate(r.date)}<span className="mn-sub">{r.branch}</span></span></td>
                              <td data-l="Gift"><span>{label(r.purpose)}<span className="mn-sub">{r.method === 'anonymous' ? 'Anonymous' : methodLabel(r.method)}</span></span></td>
                              <td data-l="Member / phone">{r.method === 'anonymous' ? (r.member ?? 'Anonymous') : r.member ? <span>{r.member} <span className="mn-sub" style={{ display: 'inline' }}>{r.member_number}</span></span> : maskedPretty(r.phone) || '-'}</td>
                              <td className="num" data-l="Gross">{kes(r.gross)}</td>
                              <td className="num" data-l="Fee">{kes(r.fee)}</td>
                              <td className="num" data-l="Net">{kes(r.net)}</td>
                              <td data-l="Status"><PayChip status={r.status} /></td>
                              <td className="mn-act">{s.can('reversals.request') && r.method !== 'cash' && r.method !== 'anonymous' && r.status !== 'reversed' &&
                                <Button kind="ghost" small onClick={() => { setReport(r); setReason(''); }}>Report a problem</Button>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {x.rows.some((r: any) => r.method === 'anonymous') && <p className="mn-flat-note" style={{ padding: '4px 20px 16px' }}>Anonymous gifts are shown as one total for each day. The church cannot see who gave them.</p>}
                  </Card>
                )}
              </Section>
            )}
          </>
        )}
      </Loaded>
      {report && (
        <Modal title="Report a problem" onClose={() => setReport(null)}>
          <div className="stack">
            <p className="muted" style={{ margin: 0 }}>{kes(report.gross)} on {shortDate(report.date)} ({methodLabel(report.method)}). Are you sure you want to ask for this payment to be reversed?</p>
            <Field label="What went wrong?"><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: sent to the wrong church" /></Field>
            <Note tone="info">A reversal request is reviewed before anything changes.</Note>
            <div className="mn-btns end">
              <Button kind="ghost" onClick={() => setReport(null)}>Cancel</Button>
              <Button kind="danger" disabled={busy || !reason.trim()} onClick={submit}>{busy ? 'Sending…' : 'Yes, report it'}</Button>
            </div>
          </div>
        </Modal>
      )}
      {toast.node}
    </>
  );
}

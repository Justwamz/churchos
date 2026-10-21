import { useState } from 'react';
import { AuditLog, Button, ErrorNote, Field, Note, shortDate, useAsync } from '@churchos/ui';
import { Card, PageHeader, Section, StatusChip, Toolbar } from '../ui';
import { api, errText, num, type PageProps } from '../common';

// ---------------- Test tools ----------------

const PRESETS = [
  { label: 'GRC001#TITHE', ref: 'GRC001#TITHE' }, { label: 'GRC002#OFFERING', ref: 'GRC002#OFFERING' }, { label: 'HPC001#TITHE', ref: 'HPC001#TITHE' },
  { label: 'GRC999#TITHE (wrong code)', ref: 'GRC999#TITHE' }, { label: 'Empty reference', ref: '' },
  { label: 'SMS#GRACE (top up Grace HQ SMS wallet)', ref: 'SMS#GRACE' }, { label: 'WA#GRACE', ref: 'WA#GRACE' },
  { label: 'SMS#GRC001 (Nairobi branch SMS wallet)', ref: 'SMS#GRC001' }, { label: 'SMS#GRC002 (Mombasa branch SMS wallet)', ref: 'SMS#GRC002' },
  { label: 'WA#GRC001', ref: 'WA#GRC001' }, { label: 'SMS#HOPE', ref: 'SMS#HOPE' },
  { label: 'NHF001#TITHE (unverified church: collects but is not paid out)', ref: 'NHF001#TITHE' },
];

export function Tools({ toast }: PageProps) {
  const [phone, setPhone] = useState('0712345678');
  const [amount, setAmount] = useState('1000');
  const [reference, setReference] = useState('GRC001#TITHE');
  const [dup, setDup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<any>();
  const [clock, setClock] = useState<any>();
  const [err, setErr] = useState<string>();

  const send = async () => {
    setBusy(true); setErr(undefined);
    const p = phone.replace(/\s+/g, '').replace(/^0/, '254').replace(/^\+/, '');
    try { const r = await api.post('/admin/simulate/paybill', { phone: p, amount: Number(amount), reference, duplicate: dup }); setOut(r); toast('Payment simulated'); }
    catch (e: any) { setErr(errText(e)); }
    setBusy(false);
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Could not copy. Select the code and copy it by hand.', 'bad'); }
  };
  const advance = async (hours: number) => {
    try { const r = await api.post('/admin/clock/advance', { hours }); setClock(r); toast(`Clock moved forward ${hours} hours. ${num(r.messagesSent)} scheduled messages were sent`); } catch (e: any) { toast(errText(e), 'bad'); }
  };
  return (
    <>
      <PageHeader title="Test tools" subtitle={<StatusChip tone="wait">Development only: simulated PSP</StatusChip>} />
      <div className="pa-two">
        <Section title="Paybill simulator">
          <Card>
            <Field label="Payer phone"><input value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} /></Field>
            <Field label="Amount (KES)"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            <Field label="Account reference"><input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
            <div className="pa-presets" role="group" aria-label="Reference presets">{PRESETS.map((p) => <button key={p.label} type="button" className={`chip ${reference === p.ref ? 'on' : ''}`} onClick={() => setReference(p.ref)}>{p.label}</button>)}</div>
            <label className="pa-check"><input type="checkbox" checked={dup} onChange={(e) => setDup(e.target.checked)} /> Send twice (duplicate delivery). The second copy must be ignored.</label>
            <div className="pa-actions start"><Button onClick={send} disabled={busy || !amount}>{busy ? 'Sending…' : 'Send payment'}</Button></div>
            {err && <ErrorNote>{err}</ErrorNote>}
            {out && (
              <Note tone="good">
                <div className="row between">
                  <span>Transaction code <b><code>{out.providerTxId}</code></b>. Members can paste it in an SMS to test reversal requests.</span>
                  <Button small kind="ghost" onClick={() => copy(out.providerTxId)}>Copy</Button>
                </div>
              </Note>
            )}
          </Card>
        </Section>
        <Section title="Platform clock">
          <Card>
            <p className="muted" style={{ marginTop: 0 }}>Skip the 48 hour hold and the 72 hour reversal window. Money past the hold becomes ready to pay out. Also sends scheduled messages that are due.</p>
            <div className="pa-presets">{[1, 24, 49, 72].map((h) => <Button key={h} kind="ghost" onClick={() => advance(h)}>Advance {h}h</Button>)}</div>
            {clock && <p style={{ marginBottom: 0 }}>Clock now reads <b>{shortDate(clock.now)}</b> (skipped {num(clock.offsetHours)} hours in total).</p>}
          </Card>
        </Section>
      </div>
    </>
  );
}

// ---------------- Audit ----------------

export function Audit(_: PageProps) {
  const t = useAsync(() => api.get<any[]>('/admin/tenants'));
  const [org, setOrg] = useState('');
  return (
    <>
      <PageHeader title="Audit log" subtitle="Every change across every church is recorded here. Entries cannot be edited or deleted." />
      <Toolbar>
        <select value={org} onChange={(e) => setOrg(e.target.value)} aria-label="Church">
          <option value="">All churches</option>
          {(t.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </Toolbar>
      <AuditLog api={api} base="/admin/audit" showOrg qs={org ? `&org=${encodeURIComponent(org)}` : ''} />
    </>
  );
}

import { useEffect, useState } from 'react';
import { API_URL, Button, ErrorNote, Note, kes, shortDate, useToast } from '@churchos/ui';
import { api, friendly, label, methodLabel } from './session';
import { useDebounced } from './MemberForm';
import { Card, EmptyState, PageHeader, Section, SidePanel, StatusChip, Toolbar } from './ui';
import './money.css';
import { StatementCard, StatementSettings } from './Statements';
import './giving-record.css';

const REASONS: [string, string][] = [
  ['statement_request', 'A statement was requested'],
  ['pastoral_visit', 'Pastoral visit'],
  ['audit', 'Audit or review'],
  ['reconciliation', 'Reconciling the books'],
  ['other', 'Other'],
];

const what = (l: any) => (l.project ? l.project : label(l.purpose));
const how = (l: any) => (l.kind === 'cash_gift' ? 'Cash' : methodLabel(String(l.method ?? l.source ?? '')) || label(l.source));

export function GivingRecordModal({ member, onClose }: { member: { id: string; full_name: string }; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [data, setData] = useState<any>(null);
  const query = (csv = false) => `reason=${reason}${reason === 'other' ? `&note=${encodeURIComponent(note.trim())}` : ''}${csv ? '&format=csv' : ''}`;

  const open = async () => {
    setErr('');
    if (!reason) return setErr('Choose a reason first.');
    if (reason === 'other' && !note.trim()) return setErr('Write a short note for “Other”.');
    setBusy(true);
    try { setData(await api.get(`/members/${member.id}/giving-ledger?${query()}`)); }
    catch (e: any) { setErr(friendly(e.message)); }
    setBusy(false);
  };
  const csv = async () => {
    setBusy(true);
    try {
      const token = api.getToken();
      const res = await fetch(`${API_URL}/members/${member.id}/giving-ledger?${query(true)}`, { headers: { 'x-churchos-app': 'staff', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      if (!res.ok) throw new Error('Could not download the file. Try again.');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = `giving-record-${data?.member?.memberNumber ?? 'member'}.csv`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.show('Downloaded. This download is recorded too.');
    } catch (e: any) { toast.show(friendly(e.message), 'bad'); }
    setBusy(false);
  };
  const verify = async () => {
    try {
      const r = await api.get('/giving-ledger/verify');
      toast.show(r.ok ? `The whole ledger is intact (${r.lines} lines checked).` : `The ledger does not match at line ${r.brokenAt}. Tell your administrator.`, r.ok ? 'good' : 'bad');
    } catch (e: any) { toast.show(friendly(e.message), 'bad'); }
  };

  const panelFooter = !data ? (
    <>
      <Button kind="ghost" onClick={onClose}>Cancel</Button>
      <Button disabled={busy} onClick={open}>{busy ? 'Opening…' : 'Open the record'}</Button>
    </>
  ) : undefined;

  return (
    <SidePanel title={data ? `Giving record: ${data.member.name}` : 'Giving record'} subtitle={data ? `${data.member.memberNumber} · ${data.member.branch}` : member.full_name} onClose={onClose} footer={panelFooter} width={620}>
      {!data ? (
        <div className="stack">
          <Note tone="info">{`Opening someone’s giving record is recorded. ${member.full_name} can see who looked and why.`}</Note>
          <div className="gr-reasons" role="radiogroup" aria-label="Reason">
            {REASONS.map(([k, t]) => (
              <label key={k} className={`gr-reason ${reason === k ? 'on' : ''}`}>
                <input type="radio" name="gr-reason" checked={reason === k} onChange={() => setReason(k)} /> {t}
              </label>
            ))}
          </div>
          {reason === 'other' && <input aria-label="Short note" maxLength={120} placeholder="Short note (required, up to 120 characters)" value={note} onChange={(e) => setNote(e.target.value)} />}
          {err && <ErrorNote>{err}</ErrorNote>}
        </div>
      ) : (
        <div className="stack">
          <div className="gr-head">
            {data.integrity?.ok ? <StatusChip tone="done">Record intact</StatusChip> : <StatusChip tone="bad">{`Warning: record does not match at line ${data.integrity?.brokenAt}`}</StatusChip>}
          </div>
          <div className="gr-totals">
            <div className="gr-total"><span className="tiny">Given in total</span><b>{kes(data.totals.given)}</b></div>
            {Object.entries(data.totals.byYear ?? {}).sort().reverse().map(([y, c]) => <div className="gr-total" key={y}><span className="tiny">{y}</span><b>{kes(c as number)}</b></div>)}
          </div>
          <div className="chips">{Object.entries(data.totals.byPurpose ?? {}).map(([p, c]) => <StatusChip key={p} tone="info">{`${label(p)}: ${kes(c as number)}`}</StatusChip>)}</div>
          {data.lines.length === 0 ? <p className="mn-flat-note">No gifts on this record yet.</p> : (
            <div className="gr-scroll">
              <table className="gr-table">
                <thead><tr><th>Date</th><th>What</th><th>How</th><th>Reference</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {data.lines.map((l: any) => (
                    <tr key={l.id} className={l.kind === 'reversal' ? 'rev' : ''}>
                      <td data-l="Date">{shortDate(l.at)}</td>
                      <td data-l="What">{l.kind === 'reversal' ? `Reversal of ${l.reverses ?? 'a gift'}` : what(l)}{l.note ? <div className="tiny">{l.note}</div> : null}</td>
                      <td data-l="How">{how(l)}</td>
                      <td data-l="Reference" className="mono">{l.ref ?? '-'}</td>
                      <td data-l="Amount" className="num">{kes(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mn-btns" style={{ justifyContent: 'space-between' }}>
            <Button small kind="ghost" disabled={busy} onClick={csv}>Download CSV</Button>
            <button type="button" className="tiny" style={{ background: 'none', border: 0, color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer', minHeight: 36 }} onClick={verify}>Check the whole ledger</button>
          </div>
          <p className="mn-flat-note">This record cannot be changed or deleted. Corrections are added as new lines. Downloading is recorded too.</p>
          <StatementCard member={{ id: member.id, name: member.full_name }} years={Object.keys(data.totals.byYear ?? {}).sort().reverse()} reason={reason} note={note} reasonOk={!!reason && (reason !== 'other' || !!note.trim())} />
        </div>
      )}
      {toast.node}
    </SidePanel>
  );
}

export function GivingRecords() {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('find');
  const dq = useDebounced(q.trim());
  const [res, setRes] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<any>(null);
  useEffect(() => {
    if (dq.length < 2) { setRes(null); setErr(''); return; }
    let alive = true;
    api.get<any>('/members/lookup?q=' + encodeURIComponent(dq)).then((r) => alive && (setRes(r.members ?? []), setErr(''))).catch((e) => alive && (setRes([]), setErr(friendly(e.message))));
    return () => { alive = false; };
  }, [dq]);
  return (
    <>
      <PageHeader
        title="Giving records"
        subtitle="Find a member to open their giving record. Every look is recorded, and the member can see who looked and why."
        tabs={[{ id: 'find', label: 'Find a member' }, { id: 'statements', label: 'Statement details' }]}
        tab={tab}
        onTab={setTab}
      />
      {tab === 'find' && (
        <Section>
          <Toolbar>
            <input aria-label="Search members" placeholder="Search by name or member number (at least 2 letters)" value={q} onChange={(e) => setQ(e.target.value)} />
          </Toolbar>
          {err && <ErrorNote>{err}</ErrorNote>}
          {!res && !err && <Card><EmptyState icon="book" title="Start typing a name" text="Results appear here. You will be asked for a reason before a record opens." /></Card>}
          {res && !err && (res.length === 0 ? <Card><EmptyState icon="people" title="No members found" text="Check the spelling or try the member number." /></Card> : (
            <Card pad={false} className="mn-wrap">
              <div className="mn-scroll">
                <table className="mn-table">
                  <thead><tr><th>Name</th><th>Member no.</th><th>Branch</th><th /></tr></thead>
                  <tbody>
                    {res.map((m) => (
                      <tr key={m.id}><td className="mn-first" data-l="Name"><b>{m.name}</b></td><td className="mono" data-l="Member no.">{m.memberNumber}</td><td data-l="Branch">{m.branch}</td>
                        <td className="mn-act"><Button small onClick={() => setOpen({ id: m.id, full_name: m.name })}>Open giving record</Button></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </Section>
      )}
      {tab === 'statements' && <Section><StatementSettings /></Section>}
      {open && <GivingRecordModal member={open} onClose={() => setOpen(null)} />}
    </>
  );
}

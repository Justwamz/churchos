import { useState } from 'react';
import { Button, Card, Empty, Field, Note, StatusBadge, Table, kes, shortDate, useAsync, useToast } from '@churchos/ui';
import { useEffect } from 'react';
import { api, friendly, label, useSession } from './session';
import { Load, PageHead } from './bits';
import { useDebounced } from './MemberForm';
import './giving-record.css';

type Named = { id: string; name: string; number: string; amount: string };

function MemberPick({ taken, onPick }: { taken: string[]; onPick: (m: any) => void }) {
  const s = useSession();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim().length >= 2 ? q.trim() : '');
  const [res, setRes] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!dq) { setRes(null); return; }
    let alive = true;
    api.get<any>('/members/lookup?q=' + encodeURIComponent(dq)).then((r) => alive && (setRes((r.members ?? []).map((m: any) => ({ id: m.id, full_name: m.name, member_number: m.memberNumber }))), setErr(''))).catch((e) => alive && (setRes([]), setErr(friendly(e.message))));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);
  const shown = (res ?? []).filter((m) => !taken.includes(m.id)).slice(0, 6);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <input aria-label="Find a member to name" placeholder="Search by name or member number" value={q} onChange={(e) => setQ(e.target.value)} />
      {err && <div className="tiny" style={{ color: '#b3261e' }}>{/access|members.view/i.test(err) ? 'You need permission to see members before you can name them.' : err}</div>}
      {!err && dq && res && shown.length === 0 && <div className="tiny">No members found.</div>}
      {shown.map((m) => (
        <button type="button" key={m.id} className="btn ghost small" style={{ justifyContent: 'flex-start', textAlign: 'left' }} onClick={() => { onPick(m); setQ(''); }}>{m.full_name} · {m.member_number}</button>
      ))}
    </div>
  );
}

export function Cash() {
  const s = useSession();
  const d = useAsync<any[]>(() => api.get('/cash' + s.qs()), [s.qs()]);
  const toast = useToast();
  const canCount = s.can('cash.count');
  const [form, setForm] = useState({ branchId: '', purpose: 'TITHE', amount: '', note: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [named, setNamed] = useState<Named[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  useEffect(() => { api.get<any[]>('/projects' + s.qs()).then((r) => setProjects(r.filter((p) => p.code))).catch(() => setProjects([])); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [s.qs()]);
  const counted = Number(form.amount) || 0;
  const namedTotal = named.reduce((n, g) => n + (Number(g.amount) || 0), 0);
  const tooMuch = namedTotal > counted + 0.001;
  const badRow = named.some((g) => !(Number(g.amount) > 0));
  const branchId = form.branchId || (s.scope !== 'all' ? s.scope : s.branches[0]?.id ?? '');

  const record = async () => {
    setBusy('form');
    try {
      await api.post('/cash' + s.qs(), { branchId, purpose: form.purpose, amount: form.amount, note: form.note || undefined, ...(named.length ? { gifts: named.map((g) => ({ membershipId: g.id, amount: Number(g.amount) })) } : {}) });
      toast.show('Count recorded. A second person now needs to sign it off.');
      setForm({ ...form, amount: '', note: '' });
      setNamed([]);
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
                <select value={form.purpose} onChange={(e) => { setForm({ ...form, purpose: e.target.value }); }}>
                  <option value="TITHE">Tithe</option><option value="OFFERING">Offering</option>{projects.map((p) => <option key={p.id} value={p.code}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Counted amount (KES)"><input inputMode="decimal" placeholder="12500" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
              <Field label="Note (optional)"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Sunday service" /></Field>
              <div style={{ gridColumn: '1 / -1' }}>
                <details style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '4px 12px' }} open={named.length > 0}>
                  <summary style={{ cursor: 'pointer', padding: '8px 0' }}><b>Know who gave? Name them</b> <span className="tiny">(optional)</span></summary>
                  <div className="stack" style={{ paddingBottom: 10 }}>
                    <div className="tiny">Named gifts are added to those members' giving records after a second person signs off the count.</div>
                    {named.map((g) => (
                      <div key={g.id} className="cash-name-row">
                        <span><b>{g.name}</b> <span className="tiny">{g.number}</span></span>
                        <input className="cash-amt" inputMode="decimal" aria-label={`Amount for ${g.name}`} placeholder="KES" value={g.amount} onChange={(e) => setNamed(named.map((x) => (x.id === g.id ? { ...x, amount: e.target.value } : x)))} />
                        <Button small kind="ghost" onClick={() => setNamed(named.filter((x) => x.id !== g.id))}>Remove</Button>
                      </div>
                    ))}
                    <MemberPick taken={named.map((g) => g.id)} onPick={(m) => setNamed([...named, { id: m.id, name: m.full_name, number: m.member_number, amount: '' }])} />
                    {named.length > 0 && <div className={tooMuch ? 'err' : 'tiny'} style={tooMuch ? { color: '#b3261e' } : undefined}>
                      {tooMuch ? `The named gifts (${kes(Math.round(namedTotal * 100))}) are more than the counted amount (${kes(Math.round(counted * 100))}).` : `${kes(Math.round(namedTotal * 100))} named, ${kes(Math.round((counted - namedTotal) * 100))} not named (given in the plate).`}
                    </div>}
                  </div>
                </details>
              </div>
              <div><Button type="submit" disabled={busy === 'form' || !form.amount || !branchId || tooMuch || badRow}>{busy === 'form' ? 'Saving…' : 'Record count'}</Button></div>
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
                      <td>{label(c.purpose)}{c.known_gifts > 0 ? <div className="tiny">{c.known_gifts} member{c.known_gifts === 1 ? '' : 's'} named ({kes(c.known_total)})</div> : null}{c.note ? <div className="tiny">{c.note}</div> : null}</td>
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

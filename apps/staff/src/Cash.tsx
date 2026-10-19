import { useState } from 'react';
import { Button, Field, kes, shortDate, useAsync, useToast } from '@churchos/ui';
import { useEffect } from 'react';
import { api, friendly, label, useSession } from './session';
import { Modal, useDebounced } from './MemberForm';
import { Card, EmptyState, PageHeader, Section, Stat, StatTiles } from './ui';
import { Loaded, PayChip } from './money-bits';
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
  const [showForm, setShowForm] = useState(false);
  const [tab, setTab] = useState('waiting');
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
      setNamed([]); setShowForm(false);
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

  const all: any[] = d.data ?? [];
  const waiting = all.filter((c) => c.status === 'counted');
  const rows = tab === 'waiting' ? waiting : all;
  const approvedTotal = all.filter((c) => c.status === 'approved').reduce((n, c) => n + Number(c.amount || 0), 0);

  return (
    <>
      <PageHeader
        title="Cash"
        subtitle="One person counts and records it, a different person signs it off. Only then is it added to your collections and the platform fee charged."
        actions={canCount ? <Button onClick={() => setShowForm(true)}>Record a count</Button> : undefined}
        tabs={[{ id: 'waiting', label: 'Waiting for sign-off', badge: waiting.length }, { id: 'all', label: 'All counts' }]}
        tab={tab}
        onTab={setTab}
      />
      <Loaded loading={d.loading} error={d.error} hasData={!!d.data} rows={4}>
        <StatTiles>
          <Stat label="Waiting for sign-off" value={waiting.length} tone={waiting.length ? 'wait' : undefined} />
          <Stat label="Approved total" value={kes(approvedTotal)} tone="good" />
          <Stat label="All counts" value={all.length} />
        </StatTiles>
        <Section title={tab === 'waiting' ? 'Waiting for a second person' : 'All cash counts'}>
          {rows.length === 0 ? (
            <Card><EmptyState icon="money" title={tab === 'waiting' ? 'Nothing waiting' : 'No cash counts yet'} text={canCount ? 'Record the first count when the offering has been counted.' : 'Counts will appear here once they are recorded.'} /></Card>
          ) : (
            <Card pad={false} className="mn-wrap">
              <div className="mn-scroll">
                <table className="mn-table">
                  <thead><tr><th>Date</th><th>Branch</th><th>Purpose</th><th className="num">Amount</th><th>Status</th><th>Details</th><th /></tr></thead>
                  <tbody>
                    {rows.map((c: any) => {
                      const mine = c.counted_by === s.user.id;
                      return (
                        <tr key={c.id}>
                          <td className="mn-first" data-l="Date">{shortDate(c.created_at)}</td>
                          <td data-l="Branch">{c.branch_name}</td>
                          <td data-l="Purpose"><span>{label(c.purpose)}{c.known_gifts > 0 ? <span className="mn-sub">{c.known_gifts} member{c.known_gifts === 1 ? '' : 's'} named ({kes(c.known_total)})</span> : null}{c.note ? <span className="mn-sub">{c.note}</span> : null}</span></td>
                          <td className="num" data-l="Amount"><b>{kes(c.amount)}</b></td>
                          <td data-l="Status"><PayChip status={c.status} /></td>
                          <td data-l="Details">
                            {c.status === 'counted' && <span className="mn-sub">Counted by {mine ? 'you' : c.counted_by_name}, waiting for a second person</span>}
                            {c.status === 'approved' && <span className="mn-sub">Approved by {c.approved_by_name}. Platform fee charged: {kes(c.fee)}</span>}
                            {c.status === 'rejected' && <span className="mn-sub">Rejected by {c.approved_by_name}</span>}
                          </td>
                          <td className="mn-act">
                            {c.status === 'counted' && s.can('cash.approve') && !mine && (
                              <div className="mn-btns end">
                                <Button small disabled={busy === c.id} onClick={() => signoff(c.id, true)}>Approve</Button>
                                <Button small kind="danger" disabled={busy === c.id} onClick={() => signoff(c.id, false)}>Reject</Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      </Loaded>
      {showForm && canCount && (
        <Modal title="Record a counted amount" onClose={() => setShowForm(false)}>
          <form onSubmit={(e) => { e.preventDefault(); record(); }}>
            <div className="mn-fields">
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
            </div>
            <details style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '4px 12px', marginBottom: 16 }} open={named.length > 0}>
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
                {named.length > 0 && <div className={tooMuch ? 'mn-bad' : 'tiny'}>
                  {tooMuch ? `The named gifts (${kes(Math.round(namedTotal * 100))}) are more than the counted amount (${kes(Math.round(counted * 100))}).` : `${kes(Math.round(namedTotal * 100))} named, ${kes(Math.round((counted - namedTotal) * 100))} not named (given in the plate).`}
                </div>}
              </div>
            </details>
            <div className="mn-btns end">
              <Button kind="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button type="submit" disabled={busy === 'form' || !form.amount || !branchId || tooMuch || badRow}>{busy === 'form' ? 'Saving…' : 'Record count'}</Button>
            </div>
          </form>
        </Modal>
      )}
      {toast.node}
    </>
  );
}

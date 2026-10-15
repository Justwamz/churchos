import { useState } from 'react';
import { Badge, Button, Card, Empty, Field, Table, dateOnly, kes, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Hist, Load, PageHead } from './bits';

function Pledges({ id }: { id: string }) {
  const s = useSession();
  const d = useAsync<any[]>(() => api.get(`/projects/${id}/pledges` + s.qs()), [id]);
  return (
    <Load loading={d.loading} error={d.error} hasData={!!d.data}>
      {!d.data || d.data.length === 0 ? <Empty>No pledges yet.</Empty> : (
        <Table head={['Member', 'Pledged', 'Paid so far']}>
          {d.data.map((p) => (
            <tr key={p.id}><td>{p.full_name} <span className="tiny">{p.member_number}</span></td><td className="num">{kes(p.amount)}</td><td className="num">{kes(p.paid)}</td></tr>
          ))}
        </Table>
      )}
    </Load>
  );
}

export function Projects() {
  const s = useSession();
  const d = useAsync<any[]>(() => api.get('/projects' + s.qs()), [s.qs()]);
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reminding, setReminding] = useState<string | null>(null);
  const [f, setF] = useState({ branchId: '', code: '', name: '', description: '', target: '', deadline: '', restricted: false });
  const branchId = f.branchId || (s.scope !== 'all' ? s.scope : s.branches[0]?.id ?? '');

  const create = async () => {
    setBusy(true);
    try {
      await api.post('/projects' + s.qs(), { ...f, branchId, deadline: f.deadline || undefined });
      toast.show('Project created.');
      setAdding(false);
      setF({ ...f, code: '', name: '', description: '', target: '', deadline: '', restricted: false });
      d.reload();
    } catch (e: any) { toast.show(friendly(e.message), 'bad'); }
    setBusy(false);
  };

  const remind = async (id: string) => {
    setReminding(id);
    try {
      const r = await api.post(`/projects/${id}/remind` + s.qs(), {});
      const sms = Number(r.smsSent ?? 0), inApp = Number(r.smsSkippedNoBalance ?? 0);
      toast.show(`Reminders created for ${sms + inApp} members. SMS sent to ${sms}, in-app only for ${inApp}${inApp ? ' (SMS wallet empty)' : ''}.`);
    } catch (e: any) { toast.show(friendly(e.message), 'bad'); }
    setReminding(null);
  };

  return (
    <>
      <PageHead title="Projects" sub="Building funds and special appeals." action={s.can('projects.manage') && <Button onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'New project'}</Button>} />
      <div className="stack">
        {adding && (
          <Card title="Create a project">
            <form className="grid cols-3" onSubmit={(e) => { e.preventDefault(); create(); }}>
              <Field label="Branch">
                <select value={branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>
                  {s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
              <Field label="Code" hint="Used when giving, such as ROOF"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
              <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
              <Field label="Target (KES)"><input inputMode="decimal" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></Field>
              <Field label="Deadline (optional)"><input type="date" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} /></Field>
              <Field label="Description"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
              <label className="row" style={{ marginBottom: 12 }}>
                <input type="checkbox" checked={f.restricted} onChange={(e) => setF({ ...f, restricted: e.target.checked })} /> Restricted fund (money may only be used for this project)
              </label>
              <div><Button type="submit" disabled={busy || !f.code.trim() || !f.name.trim() || !f.target || !branchId}>{busy ? 'Saving…' : 'Create project'}</Button></div>
            </form>
          </Card>
        )}
        <Load loading={d.loading} error={d.error} hasData={!!d.data}>
          {!d.data || d.data.length === 0 ? <Card><Empty>No projects yet.</Empty></Card> : (
            <div className="grid cols-2">
              {d.data.map((p) => {
                const pct = Math.min(100, Math.round((Number(p.raised) / Math.max(1, Number(p.target))) * 100));
                return (
                  <Card key={p.id} title={<>{p.name} <span className="tiny">{p.code}</span></>} action={p.restricted ? <Badge tone="warn">Restricted fund</Badge> : undefined}>
                    {p.description && <p className="muted" style={{ marginTop: 0 }}>{p.description}</p>}
                    <div className="row between" style={{ marginBottom: 6 }}><b className="mono">{kes(p.raised)}</b><span className="tiny">of {kes(p.target)} ({pct}%)</span></div>
                    <div className="progress"><i style={{ width: `${pct}%` }} /></div>
                    <div className="row between tiny" style={{ marginTop: 8 }}>
                      <span>Pledged {kes(p.pledged)}</span>
                      <span>{p.branch_name}{p.deadline ? ` · by ${dateOnly(p.deadline)}` : ''}</span>
                    </div>
                    <div style={{ marginTop: 10 }}>
                      <Hist entity="project" entityId={p.id} title={p.name} />{' '}
                      <Button small kind="ghost" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Hide pledges' : 'Show pledges'}</Button>
                      {s.can('projects.manage') && <> <Button small kind="ghost" disabled={reminding === p.id} onClick={() => remind(p.id)}>{reminding === p.id ? 'Sending…' : 'Send reminders'}</Button></>}
                    </div>
                    {open === p.id && <div style={{ marginTop: 8 }}><Pledges id={p.id} /></div>}
                  </Card>
                );
              })}
            </div>
          )}
        </Load>
      </div>
      {toast.node}
    </>
  );
}

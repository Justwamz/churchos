import { useState } from 'react';
import { Button, Field, dateOnly, kes, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Hist } from './bits';
import { useAction } from './prefill';
import { Modal } from './MemberForm';
import { Card, EmptyState, PageHeader, Section, SidePanel, StatusChip } from './ui';
import { Loaded } from './money-bits';
import './money.css';
import './money-projects.css';

function Pledges({ id }: { id: string }) {
  const s = useSession();
  const d = useAsync<any[]>(() => api.get(`/projects/${id}/pledges` + s.qs()), [id]);
  return (
    <Loaded loading={d.loading} error={d.error} hasData={!!d.data} rows={3}>
      {!d.data || d.data.length === 0 ? <EmptyState icon="heart" title="No pledges yet" text="Members can pledge to this project in the app." /> : (
        <div className="mn-scroll">
          <table className="mn-table">
            <thead><tr><th>Member</th><th className="num">Pledged</th><th className="num">Paid so far</th></tr></thead>
            <tbody>
              {d.data.map((p) => (
                <tr key={p.id}><td className="mn-first" data-l="Member"><span>{p.full_name}<span className="mn-sub">{p.member_number}</span></span></td><td className="num" data-l="Pledged">{kes(p.amount)}</td><td className="num" data-l="Paid so far">{kes(p.paid)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Loaded>
  );
}

export function Projects() {
  const s = useSession();
  const d = useAsync<any[]>(() => api.get('/projects' + s.qs()), [s.qs()]);
  const toast = useToast();
  const [open, setOpen] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reminding, setReminding] = useState<string | null>(null);
  const [f, setF] = useState({ branchId: '', code: '', name: '', description: '', target: '', deadline: '', restricted: false });
  const branchId = f.branchId || (s.scope !== 'all' ? s.scope : s.branches[0]?.id ?? '');
  const manage = s.can('projects.manage');
  useAction('projects', (a) => { if (a === 'new') { if (manage) setAdding(true); else toast.show('You cannot create projects.'); } });

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
      <PageHeader title="Projects" subtitle="Building funds and special appeals." actions={manage ? <Button onClick={() => setAdding(true)}>New project</Button> : undefined} />
      <Loaded loading={d.loading} error={d.error} hasData={!!d.data} rows={3} height={200}>
        {!d.data || d.data.length === 0 ? (
          <Card><EmptyState icon="building" title="No projects yet" text="A project collects gifts for one purpose, like a roof or a new hall." /></Card>
        ) : (
          <Section>
            <div className="mn-cols two">
              {d.data.map((p) => {
                const pct = Math.min(100, Math.round((Number(p.raised) / Math.max(1, Number(p.target))) * 100));
                const bp = p.budget != null ? Math.round((Number(p.spent ?? 0) / Math.max(1, Number(p.budget))) * 100) : 0;
                const col = bp >= 100 ? 'var(--bad)' : bp >= 80 ? 'var(--gold)' : 'var(--good)';
                return (
                  <Card key={p.id}>
                    <div className="pj-head">
                      <div><h3>{p.name}</h3><span className="mn-sub">{p.code} · {p.branch_name}{p.deadline ? ` · by ${dateOnly(p.deadline)}` : ''}</span></div>
                      {p.restricted ? <StatusChip tone="wait">Restricted fund</StatusChip> : null}
                    </div>
                    {p.description && <p className="pj-desc">{p.description}</p>}
                    <div className="pj-raised"><b>{kes(p.raised)}</b><span className="tiny">of {kes(p.target)} ({pct}%)</span></div>
                    <div className="progress"><i style={{ width: `${pct}%` }} /></div>
                    <div className="pj-meta">
                      <span>Pledged {kes(p.pledged)}</span>
                      {p.budget != null
                        ? <span>Budget {kes(p.budget)} · spent {kes(p.spent ?? 0)} (<b className={bp >= 100 ? 'mn-bad' : ''}>{bp}%</b>)</span>
                        : <span>No budget · spent {kes(p.spent ?? 0)}</span>}
                    </div>
                    {p.budget != null && <div className="pj-bar"><i style={{ width: `${Math.min(100, bp)}%`, background: col }} /></div>}
                    <div className="mn-btns pj-actions">
                      <Button small kind="ghost" onClick={() => setOpen(p)}>Pledges</Button>
                      {manage && <Button small kind="ghost" disabled={reminding === p.id} onClick={() => remind(p.id)}>{reminding === p.id ? 'Sending…' : 'Send reminders'}</Button>}
                      <Hist entity="project" entityId={p.id} title={p.name} />
                    </div>
                  </Card>
                );
              })}
            </div>
          </Section>
        )}
      </Loaded>
      {open && (
        <SidePanel title={`Pledges: ${open.name}`} subtitle={`${open.code} · pledged ${kes(open.pledged)}`} onClose={() => setOpen(null)} width={520}>
          <Pledges id={open.id} />
        </SidePanel>
      )}
      {adding && (
        <Modal title="New project" onClose={() => setAdding(false)}>
          <form onSubmit={(e) => { e.preventDefault(); create(); }}>
            <div className="mn-fields">
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
            </div>
            <label className="row" style={{ marginBottom: 16, gap: 10 }}>
              <input type="checkbox" style={{ width: 20, height: 20 }} checked={f.restricted} onChange={(e) => setF({ ...f, restricted: e.target.checked })} /> Restricted fund (money may only be used for this project)
            </label>
            <div className="mn-btns end">
              <Button kind="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              <Button type="submit" disabled={busy || !f.code.trim() || !f.name.trim() || !f.target || !branchId}>{busy ? 'Saving…' : 'Create project'}</Button>
            </div>
          </form>
        </Modal>
      )}
      {toast.node}
    </>
  );
}

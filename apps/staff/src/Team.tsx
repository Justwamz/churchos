import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Card as OCard, ErrorNote, Field, Note, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load } from './bits';
import { Modal } from './MemberForm';
import { Card, EmptyState, PageHeader, SidePanel, Skeleton, Stat, StatTiles, StatusChip, Toolbar } from './ui';
import { useAction } from './prefill';
import './team.css';
import './setup.css';

type Assignment = { id: string; roleId: string; role: string; builtIn: boolean; scopeType: string; scopeId: string | null; scope: string; permissionCount: number; canRemove: boolean; lastOwner?: boolean };
type Person = { userId: string; name: string; phone: string; email?: string | null; you: boolean; assignments: Assignment[] };
type Role = { id: string; name: string; builtIn: boolean; permissions: string[]; assigned: number };
type Perm = { key: string; label: string; group: string; hint?: string };
type TeamData = { canManage: boolean; canManageRoles: boolean; wholeChurch: boolean; people: Person[]; roles: Role[]; branches: { id: string; name: string; region?: string }[]; regions: string[] };

const OWNER = 'Organisation Owner';

function groupPerms(keys: string[], catalog: Perm[]) {
  const out: { group: string; labels: string[] }[] = [];
  for (const p of catalog) {
    if (!keys.includes(p.key)) continue;
    let g = out.find((x) => x.group === p.group);
    if (!g) { g = { group: p.group, labels: [] }; out.push(g); }
    g.labels.push(p.label);
  }
  return out;
}

function Confirm({ title, children, confirmLabel, busy, error, onYes, onClose }: { title: string; children: ReactNode; confirmLabel: string; busy: boolean; error: string; onYes: () => void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        {children}
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="row"><Button kind="danger" disabled={busy} onClick={onYes}>{busy ? 'Working...' : confirmLabel}</Button><Button kind="ghost" disabled={busy} onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  );
}

function ScopeSelect({ data, value, onChange }: { data: TeamData; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {data.wholeChurch && <option value="org">Whole church</option>}
      {data.regions.map((r) => <option key={r} value={`region:${r}`}>{r} region</option>)}
      {data.branches.map((b) => <option key={b.id} value={`branch:${b.id}`}>{b.name}</option>)}
    </select>
  );
}
const toScope = (v: string) => (v === 'org' ? { type: 'org' } : { type: v.startsWith('region:') ? 'region' : 'branch', id: v.slice(v.indexOf(':') + 1) });
const defaultScope = (d: TeamData) => (d.wholeChurch ? 'org' : d.regions[0] ? `region:${d.regions[0]}` : d.branches[0] ? `branch:${d.branches[0].id}` : '');

function AddDialog({ data, catalog, person, onClose, onDone }: { data: TeamData; catalog: Perm[]; person?: Person; onClose: () => void; onDone: (m: string) => void }) {
  const s = useSession();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [roleId, setRoleId] = useState('');
  const [scope, setScope] = useState(defaultScope(data));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const sel = data.roles.find((r) => r.id === roleId);
  const groups = sel ? groupPerms(sel.permissions, catalog).map((g) => g.group) : [];
  const needsEmail = !!sel && sel.permissions.includes('wallets.view');
  const canSave = !!roleId && !!scope && (!!person || (!!name.trim() && !!phone.trim()));
  const built = data.roles.filter((r) => r.builtIn);
  const custom = data.roles.filter((r) => !r.builtIn);
  const save = async () => {
    setErr('');
    setBusy(true);
    try {
      const q = s.qs({ branch: undefined });
      if (person) {
        await api.post(`/team/members/${person.userId}/assignments` + q, { roleId, scope: toScope(scope) });
        onDone(`Gave ${person.name || 'them'} the role ${sel?.name}`);
      } else {
        const r = await api.post('/team/members' + q, { name: name.trim(), phone: phone.trim(), roleId, scope: toScope(scope) });
        onDone(r?.needsEmail ? 'Team member added. They will be asked to confirm an email address.' : 'Team member added');
      }
    } catch (e: any) { setErr(friendly(e?.message)); setBusy(false); }
  };
  return (
    <SidePanel title={person ? `Add access for ${person.name || 'this person'}` : 'Add team member'} subtitle="They sign in with their phone number." onClose={onClose}>
      <div className="stack">
        {!person && (
          <>
            <Field label="Full name"><input maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Phone number" hint="They sign in with this phone number and a code we send. If they are already a member, their name stays as it is.">
              <input inputMode="tel" placeholder="0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
          </>
        )}
        <Field label="Role" hint={sel ? (groups.length ? `Can work with: ${groups.join(', ')}.` : 'This role has no permissions yet.') : undefined}>
          <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">Choose a role</option>
            {built.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            {custom.map((r) => <option key={r.id} value={r.id}>{r.name} (your role)</option>)}
          </select>
        </Field>
        <Field label="Where it applies"><ScopeSelect data={data} value={scope} onChange={setScope} /></Field>
        {needsEmail && <Note tone="info">They will be asked to confirm an email address, because this role receives low credit alerts.</Note>}
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button disabled={busy || !canSave} onClick={save}>{busy ? 'Saving...' : person ? 'Give access' : 'Add team member'}</Button><Button kind="ghost" disabled={busy} onClick={onClose}>Cancel</Button></div>
      </div>
    </SidePanel>
  );
}

function People({ data, catalog, reload, toast, addSignal, onSignal }: { data: TeamData; catalog: Perm[]; reload: () => void; toast: (m: string) => void; addSignal: number; onSignal?: () => void }) {
  const s = useSession();
  const [adding, setAdding] = useState<Person | 'new' | null>(null);
  const [removing, setRemoving] = useState<{ p: Person; a: Assignment } | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => { if (addSignal > 0) { if (data.canManage) setAdding('new'); onSignal?.(); } }, [addSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const remove = async () => {
    if (!removing) return;
    setBusy(true); setErr('');
    try {
      await api.post(`/team/assignments/${removing.a.id}/remove` + s.qs({ branch: undefined }), {});
      setRemoving(null); toast('Access taken away'); reload();
    } catch (e: any) { setErr(friendly(e?.message)); }
    setBusy(false);
  };
  const needle = q.trim().toLowerCase();
  const shown = data.people.filter((p) => !needle || [p.name, p.phone, p.email ?? '', ...p.assignments.map((a) => `${a.role} ${a.scope}`)].join(' ').toLowerCase().includes(needle));
  const lastOwner = (a: Assignment) => !!a.lastOwner;
  return (
    <div className="stack">
      <StatTiles>
        <Stat label="People with access" value={data.people.length} />
        <Stat label="Roles" value={data.roles.length} hint={`${data.roles.filter((r) => !r.builtIn).length} of your own`} />
      </StatTiles>
      {!data.wholeChurch && <div className="tiny">You can see and change the people who work in your branches.</div>}
      <Toolbar><input type="search" placeholder="Search by name, phone or role" aria-label="Search the team" value={q} onChange={(e) => setQ(e.target.value)} /></Toolbar>
      {shown.length === 0 ? <Card><EmptyState icon="people" title={data.people.length === 0 ? 'No team members yet' : 'Nobody matches that'} text={data.people.length === 0 ? 'Add the people who help you run the church.' : 'Try a different name, phone or role.'}
        action={data.people.length === 0 && data.canManage ? <Button onClick={() => setAdding('new')}>Add team member</Button> : undefined} /></Card> : (
        <Card pad={false}>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Name</th><th>Phone</th><th>Access</th><th /></tr></thead>
          <tbody>
          {shown.map((p) => (
            <tr key={p.userId}>
              <td className="tm-name"><b>{p.name || 'No name yet'}</b> {p.you && <StatusChip tone="info">You</StatusChip>}{p.email && <div className="tiny" style={{ overflowWrap: 'anywhere' }}>{p.email}</div>}</td>
              <td className="mono">{p.phone}</td>
              <td style={{ minWidth: 220 }}>
                {p.assignments.length === 0 ? <span className="tiny">No access</span> : (
                  <div className="tm-chips">
                    {p.assignments.map((a) => (
                      <span className="tm-access" key={a.id}>
                        <span>{a.role} · {a.scope}</span>
                        <button type="button" className="tm-x" aria-label={`Take the role ${a.role} for ${a.scope} away`} disabled={!a.canRemove}
                          title={lastOwner(a) ? 'A church must always have an Organisation Owner' : a.canRemove ? 'Take this away' : a.role === OWNER ? 'Only an Organisation Owner can take this away' : 'You cannot change access for this place'}
                          onClick={() => { setErr(''); setRemoving({ p, a }); }}>x</button>
                      </span>
                    ))}
                  </div>
                )}
                {p.assignments.some(lastOwner) && <div className="tiny" style={{ marginTop: 4 }}>A church must always have an Organisation Owner.</div>}
              </td>
              <td>{data.canManage && <Button small kind="ghost" onClick={() => setAdding(p)}>Add access</Button>}</td>
            </tr>
          ))}
          </tbody>
        </table></div>
        </Card>
      )}
      {adding && <AddDialog data={data} catalog={catalog} person={adding === 'new' ? undefined : adding} onClose={() => setAdding(null)} onDone={(m) => { setAdding(null); toast(m); reload(); }} />}
      {removing && (
        <Confirm title="Take access away" confirmLabel="Take it away" busy={busy} error={err} onYes={remove} onClose={() => setRemoving(null)}>
          <p style={{ margin: 0 }}>Take the role {removing.a.role} for {removing.a.scope} away from {removing.p.name || 'this person'}?</p>
        </Confirm>
      )}
    </div>
  );
}

function Summary({ keys, catalog, open }: { keys: string[]; catalog: Perm[]; open: boolean }) {
  const groups = groupPerms(keys, catalog);
  if (!groups.length) return <div className="tiny">No permissions yet.</div>;
  const shown = open ? groups : groups.slice(0, 2);
  return (
    <div className="stack" style={{ gap: 10 }}>
      {shown.map((g) => (
        <div className="tm-group" key={g.group}>
          <b>{g.group}</b>
          <div className="tm-chips">{(open ? g.labels : g.labels.slice(0, 4)).map((l) => <span className="tm-perm" key={l}>{l}</span>)}{!open && g.labels.length > 4 && <span className="tiny">+{g.labels.length - 4} more</span>}</div>
        </div>
      ))}
      {!open && groups.length > 2 && <div className="tiny">+{groups.length - 2} more groups</div>}
    </div>
  );
}

function RoleForm({ role, catalog, onClose, onDone }: { role?: Role; catalog: Perm[]; onClose: () => void; onDone: (m: string) => void }) {
  const s = useSession();
  const [name, setName] = useState(role?.name ?? '');
  const [sel, setSel] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [find, setFind] = useState('');
  const groups = useMemo(() => {
    const m = new Map<string, Perm[]>();
    const t = find.trim().toLowerCase();
    for (const p of catalog) if (!t || `${p.label} ${p.hint ?? ''} ${p.group}`.toLowerCase().includes(t)) m.set(p.group, [...(m.get(p.group) ?? []), p]);
    return [...m.entries()];
  }, [catalog, find]);
  const toggle = (k: string) => setSel((c) => { const n = new Set(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const all = (ps: Perm[]) => setSel((c) => { const n = new Set(c); const every = ps.every((p) => n.has(p.key)); ps.forEach((p) => (every ? n.delete(p.key) : n.add(p.key))); return n; });
  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const body = { name: name.trim(), permissions: [...sel] };
      const q = s.qs({ branch: undefined });
      if (role) await api.put(`/team/roles/${role.id}` + q, body); else await api.post('/team/roles' + q, body);
      onDone(role ? 'Role saved' : 'Role created');
    } catch (e: any) { setErr(friendly(e?.message)); setBusy(false); }
  };
  return (
    <SidePanel title={role ? `Edit role: ${role.name}` : 'New role'} subtitle="Tick what people with this role may do." width={560} onClose={onClose}>
      <div className="stack">
        <Field label="Role name" hint="For example Youth treasurer"><input maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="tm-sticky">
          <input type="search" placeholder="Find a permission, for example: refund, member, message" aria-label="Find a permission" value={find} onChange={(e) => setFind(e.target.value)} />
          <div style={{ marginTop: 6 }}><b>{sel.size}</b> {sel.size === 1 ? 'permission' : 'permissions'} selected</div>
        </div>
        {groups.length === 0 && <div className="tiny">Nothing matches that search.</div>}
        {groups.map(([g, ps]) => (
          <OCard key={g} title={g} action={<button type="button" className="tm-link" onClick={() => all(ps)}>{ps.every((p) => sel.has(p.key)) ? 'Clear this group' : 'Select all in this group'}</button>}>
            <div className="tm-pgroup">
              {ps.map((p) => (
                <label className="tm-pitem" key={p.key}>
                  <input type="checkbox" checked={sel.has(p.key)} onChange={() => toggle(p.key)} />
                  <span>{p.label}</span>
                  {p.hint && <span className="tiny">{p.hint}</span>}
                </label>
              ))}
            </div>
          </OCard>
        ))}
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button disabled={busy || !name.trim() || sel.size === 0} onClick={save}>{busy ? 'Saving...' : 'Save role'}</Button><Button kind="ghost" disabled={busy} onClick={onClose}>Cancel</Button></div>
      </div>
    </SidePanel>
  );
}

function Roles({ data, catalog, reload, toast, addSignal }: { data: TeamData; catalog: Perm[]; reload: () => void; toast: (m: string) => void; addSignal: number }) {
  const s = useSession();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<Role | 'new' | null>(null);
  const [del, setDel] = useState<Role | null>(null);
  useEffect(() => { if (addSignal > 0 && data.canManageRoles) setForm('new'); }, [addSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const remove = async () => {
    if (!del) return;
    setBusy(true); setErr('');
    try { await api.post(`/team/roles/${del.id}/delete` + s.qs({ branch: undefined }), {}); setDel(null); toast('Role deleted'); reload(); }
    catch (e: any) { setErr(friendly(e?.message)); }
    setBusy(false);
  };
  const roles = [...data.roles.filter((r) => r.builtIn), ...data.roles.filter((r) => !r.builtIn)];
  return (
    <div className="stack">
      {!data.canManageRoles && <Note>Roles apply to the whole church, so only someone who manages every branch can change them.</Note>}
      <div className="tm-roles">
        {roles.map((r) => (
          <section className="u-card tm-role" key={r.id}>
            <div className="row between" style={{ alignItems: 'flex-start' }}>
              <b style={{ overflowWrap: 'anywhere' }}>{r.name}</b>
              <StatusChip tone={r.builtIn ? 'off' : 'info'}>{r.builtIn ? 'Built in' : 'Your role'}</StatusChip>
            </div>
            <div className="tiny">{r.assigned === 0 ? 'Nobody has this role yet' : r.assigned === 1 ? '1 person has this role' : `${r.assigned} people have this role`}</div>
            <Summary keys={r.permissions} catalog={catalog} open={!!open[r.id]} />
            <div className="row">
              <Button small kind="ghost" onClick={() => setOpen({ ...open, [r.id]: !open[r.id] })}>{open[r.id] ? 'Show less' : r.builtIn ? 'See details' : 'Show all'}</Button>
              {!r.builtIn && data.canManageRoles && <Button small kind="ghost" onClick={() => setForm(r)}>Edit</Button>}
              {!r.builtIn && data.canManageRoles && <Button small kind="ghost" onClick={() => { setErr(''); setDel(r); }}>Delete</Button>}
            </div>
          </section>
        ))}
      </div>
      {form && <RoleForm role={form === 'new' ? undefined : form} catalog={catalog} onClose={() => setForm(null)} onDone={(m) => { setForm(null); toast(m); reload(); }} />}
      {del && (
        <Confirm title="Delete role" confirmLabel="Delete role" busy={busy} error={err} onYes={remove} onClose={() => setDel(null)}>
          <p style={{ margin: 0 }}>Delete the role {del.name}? This cannot be undone.</p>
        </Confirm>
      )}
    </div>
  );
}

export function Team() {
  const s = useSession();
  const toast = useToast();
  const q = s.qs({ branch: undefined });
  const team = useAsync<TeamData>(() => api.get('/team' + q), [s.grant.org.id]);
  const cat = useAsync<Perm[]>(() => api.get('/team/permissions' + q), [s.grant.org.id]);
  const [seg, setSeg] = useState<'people' | 'roles'>('people');
  const [addSignal, setAddSignal] = useState(0);
  const [roleSignal, setRoleSignal] = useState(0);
  const d = team.data;
  useAction('team', (a) => { if (a === 'add') { if (d && !d.canManage) toast.show('You cannot add team members.'); else { setSeg('people'); setAddSignal((n) => n + 1); } } });
  const action = !d ? undefined : seg === 'people'
    ? (d.canManage ? <Button onClick={() => setAddSignal((n) => n + 1)}>Add team member</Button> : undefined)
    : (d.canManageRoles ? <Button onClick={() => setRoleSignal((n) => n + 1)}>New role</Button> : undefined);
  return (
    <div>
      <PageHeader title="Team" subtitle="Give each person only the access they need, for the places you look after."
        actions={action} tabs={[{ id: 'people', label: 'People' }, { id: 'roles', label: 'Roles' }]} tab={seg} onTab={(id) => setSeg(id as 'people' | 'roles')} />
      {(team.loading || cat.loading) && !(team.data && cat.data) && !(team.error ?? cat.error) && <Skeleton rows={4} height={64} />}
      <Load loading={false} error={team.error ?? cat.error} hasData={!!team.data && !!cat.data}>
        {team.data && cat.data && (seg === 'people'
          ? <People data={team.data} catalog={cat.data} reload={team.reload} toast={toast.show} addSignal={addSignal} onSignal={() => setAddSignal(0)} />
          : <Roles data={team.data} catalog={cat.data} reload={team.reload} toast={toast.show} addSignal={roleSignal} />)}
      </Load>
      {toast.node}
    </div>
  );
}

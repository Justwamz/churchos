import { useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, Table, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load } from './bits';
import { Modal, useDebounced } from './MemberForm';
import { GroupFormModal } from './Groups';
import { composePreset } from './ComposeMessage';

function Reach({ r }: { r: { inApp: boolean; sms: boolean; whatsapp: boolean } }) {
  const chip = (on: boolean, t: string) => <Badge tone={on ? 'good' : 'muted'}><span style={{ opacity: on ? 1 : 0.45 }}>{t}</span></Badge>;
  return <div className="chips" style={{ gap: 4 }}>{chip(r.inApp, 'In-app')}{chip(r.sms, 'SMS')}{chip(r.whatsapp, 'WhatsApp')}</div>;
}

function AddPeople({ groupId, existing, onClose, onDone }: { groupId: string; existing: Set<string>; onClose: () => void; onDone: (n: number) => void }) {
  const s = useSession();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const [res, setRes] = useState<any[] | null>(null);
  const [picked, setPicked] = useState<Record<string, any>>({});
  const [role, setRole] = useState<'member' | 'leader'>('member');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!dq) { setRes(null); return; }
    let alive = true;
    api.get<any[]>('/members' + s.qs({ q: dq, branch: undefined })).then((r) => alive && (setRes(r), setErr(''))).catch((e) => alive && setErr(friendly(e.message)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);
  const list = (res ?? []).filter((m) => !existing.has(m.id)).slice(0, 40);
  const ids = Object.keys(picked);
  const hasChild = ids.some((i) => picked[i].category !== 'adult');
  const toggle = (m: any) => setPicked((p) => { const n = { ...p }; if (n[m.id]) delete n[m.id]; else n[m.id] = m; return n; });
  const save = async () => {
    setBusy(true); setErr('');
    try { await api.post(`/groups/${groupId}/members` + s.qs({ branch: undefined }), { membershipIds: ids, role }); onDone(ids.length); }
    catch (e: any) { setErr(friendly(e.message)); setBusy(false); }
  };
  return (
    <Modal title="Add people" onClose={onClose}>
      <div className="stack">
        <input style={{ width: '100%' }} aria-label="Search people" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
        {err && <ErrorNote>{err}</ErrorNote>}
        {dq && !res && !err && <Spinner />}
        {res && list.length === 0 && <Empty>No one found.</Empty>}
        <div className="stack" style={{ gap: 4, maxHeight: 260, overflowY: 'auto' }}>
          {list.map((m) => (
            <label key={m.id} className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <input type="checkbox" checked={!!picked[m.id]} onChange={() => toggle(m)} />
              <span>{m.full_name} <span className="tiny">{m.category === 'child' ? 'Child' : 'Adult'}, {m.branch_name}</span></span>
            </label>
          ))}
        </div>
        {ids.length > 0 && <div className="tiny">{ids.length} chosen: {ids.map((i) => picked[i].full_name).join(', ')}</div>}
        <div className="chips" role="radiogroup" aria-label="Role">
          <button type="button" className={`chip ${role === 'member' ? 'on' : ''}`} onClick={() => setRole('member')}>Member</button>
          <button type="button" className={`chip ${role === 'leader' ? 'on' : ''}`} onClick={() => setRole('leader')}>Leader</button>
        </div>
        {role === 'leader' && <div className="tiny">A leader must be an adult.</div>}
        {role === 'leader' && hasChild && <ErrorNote>A leader must be an adult. Untick the children or choose Member.</ErrorNote>}
        <div className="row"><Button disabled={busy || ids.length === 0 || (role === 'leader' && hasChild)} onClick={save}>{busy ? 'Adding...' : `Add ${ids.length || ''} ${ids.length === 1 ? 'person' : 'people'}`}</Button><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  );
}

export function GroupDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const s = useSession();
  const toast = useToast();
  const d = useAsync<any>(() => api.get(`/groups/${id}` + s.qs({ branch: undefined })), [id]);
  const g = d.data;
  const canManage = s.can('groups.manage');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.show(ok); d.reload(); }
    catch (e: any) { toast.show(friendly(e.message), 'bad'); }
    setBusy(false); setRemoving(null);
  };
  const setRole = (m: any, role: 'leader' | 'member') => act(() => api.post(`/groups/${id}/members/${m.membershipId}/role` + s.qs({ branch: undefined }), { role }), role === 'leader' ? `${m.name} is now a leader.` : `${m.name} is now a member.`);
  const remove = (m: any) => act(() => api.post(`/groups/${id}/members/${m.membershipId}/remove` + s.qs({ branch: undefined }), {}), `${m.name} was removed.`);
  const message = () => { composePreset.groupId = id; s.go('messages'); };

  return (
    <div className="stack">
      <div><Button kind="ghost" small onClick={onBack}>Back to groups</Button></div>
      <Load loading={d.loading} error={d.error} hasData={!!g}>
        {g && (
          <>
            <Card title={g.name} action={<div className="row">{canManage && <Button small kind="ghost" onClick={() => setEditing(true)}>Edit</Button>}{s.can('messages.send') && <Button small onClick={message}>Message this group</Button>}</div>}>
              <div className="tiny">{g.description || 'No description.'}</div>
              <div className="tiny" style={{ marginTop: 6 }}>Group leaders can message their group from the member app.</div>
            </Card>
            <Card title={`People (${g.members.length})`} action={canManage && <Button small onClick={() => setAdding(true)}>Add people</Button>}>
              {g.members.length === 0 ? <Empty>No one is in this group yet.</Empty> : (
                <Table head={['Name', 'Member no.', 'Type', 'Role', 'How we can reach them', '']}>
                  {g.members.map((m: any) => (
                    <tr key={m.membershipId}>
                      <td><b>{m.name}</b><div className="tiny">{m.branch}</div></td>
                      <td className="mono">{m.memberNumber}</td>
                      <td><Badge tone={m.category === 'child' ? 'warn' : 'muted'}>{m.category === 'child' ? 'Child' : 'Adult'}</Badge></td>
                      <td><Badge tone={m.role === 'leader' ? 'info' : 'muted'}>{m.role === 'leader' ? 'Leader' : 'Member'}</Badge></td>
                      <td><Reach r={m.reach} />{m.category === 'child' && <div className="tiny">Reached through guardians</div>}</td>
                      <td>{canManage && (removing === m.membershipId
                        ? <div className="stack" style={{ gap: 4 }}><span className="tiny">Remove {m.name} from this group?</span><div className="row"><Button small kind="danger" disabled={busy} onClick={() => remove(m)}>Yes, remove</Button><Button small kind="ghost" onClick={() => setRemoving(null)}>Keep</Button></div></div>
                        : <div className="row" style={{ gap: 6 }}>
                            {m.role === 'leader' ? <Button small kind="ghost" disabled={busy} onClick={() => setRole(m, 'member')}>Make member</Button>
                              : m.category === 'adult' && <Button small kind="ghost" disabled={busy} onClick={() => setRole(m, 'leader')}>Make leader</Button>}
                            <Button small kind="ghost" disabled={busy} onClick={() => setRemoving(m.membershipId)}>Remove</Button>
                          </div>)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </>
        )}
      </Load>
      {adding && g && <AddPeople groupId={id} existing={new Set(g.members.map((m: any) => m.membershipId))} onClose={() => setAdding(false)} onDone={(n) => { setAdding(false); toast.show(`Added ${n} ${n === 1 ? 'person' : 'people'}.`); d.reload(); }} />}
      {editing && g && <GroupFormModal group={g} onClose={() => setEditing(false)} onDone={() => { setEditing(false); toast.show('Group updated.'); d.reload(); }} />}
      {toast.node}
    </div>
  );
}

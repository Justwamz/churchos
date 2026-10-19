import { useEffect, useState } from 'react';
import { Button, ErrorNote, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Gate, Modal, initials, useDebounced } from './MemberForm';
import { Card, EmptyState, Section, Skeleton, StatusChip } from './ui';
import { GroupFormModal } from './Groups';
import { composePreset } from './ComposeMessage';

function Reach({ r }: { r: { inApp: boolean; sms: boolean; whatsapp: boolean } }) {
  const chip = (on: boolean, t: string) => <StatusChip tone={on ? 'done' : 'off'}>{t}</StatusChip>;
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
        {dq && !res && !err && <Skeleton lines={2} />}
        {res && list.length === 0 && <p className="pp-note">No one found.</p>}
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
        <div className="pp-form-foot"><Button disabled={busy || ids.length === 0 || (role === 'leader' && hasChild)} onClick={save}>{busy ? 'Adding...' : `Add ${ids.length || ''} ${ids.length === 1 ? 'person' : 'people'}`}</Button><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
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
    <div>
      <div style={{ marginBottom: 16 }}><Button kind="ghost" small onClick={onBack}>Back to groups</Button></div>
      <Gate loading={d.loading} error={d.error} hasData={!!g}>
        {g && (
          <>
            <Section title={g.name} hint={g.description || 'No description.'}
              action={<div className="pp-row-flex">{canManage && <Button small kind="ghost" onClick={() => setEditing(true)}>Edit</Button>}{s.can('messages.send') && <Button small onClick={message}>Message this group</Button>}</div>}>
              <Card>
                <div className="pp-row-flex"><StatusChip tone="off">{g.joinPolicy === 'request' ? 'Members can ask to join' : 'By invitation only'}</StatusChip><StatusChip tone="off">{g.posting === 'leaders' ? 'Only leaders post' : 'Everyone can post'}</StatusChip></div>
                <p className="pp-note" style={{ marginTop: 10 }}>Group leaders can message their group from the member app. The wall is private to the group: church staff see the group and its size, not the posts, unless they are in the group.</p>
              </Card>
            </Section>
            <Section title={`People (${g.members.length})`} action={canManage && <Button small onClick={() => setAdding(true)}>Add people</Button>}>
              {g.members.length === 0 ? <EmptyState icon="people" title="No one is in this group yet" text="Add people to get started." /> : (
                <div className="pp-list">
                  {g.members.map((m: any) => (
                    <div key={m.membershipId} className="pp-item static" style={{ gridTemplateColumns: '44px minmax(0,1fr)', alignItems: 'start' }}>
                      <span className={`pp-avatar ${m.category === 'child' ? 'child' : ''}`} aria-hidden="true">{initials(m.name)}</span>
                      <div className="pp-stack tight">
                        <div><div className="pp-name">{m.name} <StatusChip tone={m.role === 'leader' ? 'info' : 'off'}>{m.role === 'leader' ? 'Leader' : 'Member'}</StatusChip>{m.category === 'child' && <StatusChip tone="wait">Child</StatusChip>}</div>
                          <div className="pp-sub">{m.memberNumber} · {m.branch}</div></div>
                        <div><Reach r={m.reach} />{m.category === 'child' && <div className="pp-sub">Reached through guardians</div>}</div>
                        {canManage && (removing === m.membershipId
                          ? <div className="pp-stack tight"><span className="pp-tiny">Remove {m.name} from this group?</span><div className="pp-row-flex"><Button small kind="danger" disabled={busy} onClick={() => remove(m)}>Yes, remove</Button><Button small kind="ghost" onClick={() => setRemoving(null)}>Keep</Button></div></div>
                          : <div className="pp-row-flex">
                              {m.role === 'leader' ? <Button small kind="ghost" disabled={busy} onClick={() => setRole(m, 'member')}>Make member</Button>
                                : m.category === 'adult' && <Button small kind="ghost" disabled={busy} onClick={() => setRole(m, 'leader')}>Make leader</Button>}
                              <Button small kind="ghost" disabled={busy} onClick={() => setRemoving(m.membershipId)}>Remove</Button>
                            </div>)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </>
        )}
      </Gate>
      {adding && g && <AddPeople groupId={id} existing={new Set(g.members.map((m: any) => m.membershipId))} onClose={() => setAdding(false)} onDone={(n) => { setAdding(false); toast.show(`Added ${n} ${n === 1 ? 'person' : 'people'}.`); d.reload(); }} />}
      {editing && g && <GroupFormModal group={g} onClose={() => setEditing(false)} onDone={() => { setEditing(false); toast.show('Group updated.'); d.reload(); }} />}
      {toast.node}
    </div>
  );
}

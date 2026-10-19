import { useState } from 'react';
import { Button, ErrorNote, Field, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Gate, Modal } from './MemberForm';
import { Icon } from './icons';
import { EmptyState, PageHeader, StatusChip } from './ui';
import { GroupDetail } from './GroupDetail';

export function GroupFormModal({ group, onClose, onDone }: { group?: { id: string; name: string; description: string | null; joinPolicy?: string; posting?: string }; onClose: () => void; onDone: (id?: string) => void }) {
  const s = useSession();
  const [name, setName] = useState(group?.name ?? '');
  const [desc, setDesc] = useState(group?.description ?? '');
  const [branch, setBranch] = useState('');
  const [joinPolicy, setJoinPolicy] = useState(group?.joinPolicy ?? 'invite');
  const [posting, setPosting] = useState(group?.posting ?? 'members');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (group) { await api.put(`/groups/${group.id}` + s.qs({ branch: undefined }), { name, description: desc, joinPolicy, posting }); onDone(); }
      else { const r = await api.post<{ id: string }>('/groups' + s.qs({ branch: undefined }), { name, description: desc, branchId: branch || undefined, joinPolicy, posting }); onDone(r.id); }
    } catch (e: any) { setErr(friendly(e.message)); setBusy(false); }
  };
  return (
    <Modal title={group ? 'Edit group' : 'New group'} onClose={onClose}>
      <div className="stack">
        <Field label="Name"><input style={{ width: '100%' }} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description" hint="Optional"><textarea rows={3} style={{ width: '100%' }} maxLength={300} value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
        {!group && (
          <Field label="Which branch is it for?">
            <select value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="">Whole church</option>
              {s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="How people join">
          <select value={joinPolicy} onChange={(e) => setJoinPolicy(e.target.value)}>
            <option value="invite">By invitation only</option>
            <option value="request">Members can ask to join (a leader approves)</option>
          </select>
        </Field>
        <Field label="Who can post on the wall">
          <select value={posting} onChange={(e) => setPosting(e.target.value)}>
            <option value="members">Everyone in the group</option>
            <option value="leaders">Only leaders</option>
          </select>
        </Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="pp-form-foot"><Button disabled={busy || name.trim().length < 2} onClick={save}>{busy ? 'Saving...' : 'Save'}</Button><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  );
}

export function Groups() {
  const s = useSession();
  const toast = useToast();
  const d = useAsync<any[]>(() => api.get('/groups' + s.qs({ branch: undefined })), [s.qs()]);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const canManage = s.can('groups.manage');

  if (open) return <><PageHeader title="Groups" subtitle="People who meet and serve together." /><GroupDetail id={open} onBack={() => { setOpen(null); d.reload(); }} /></>;

  return (
    <>
      <PageHeader title="Groups" subtitle="Group leaders can message their group from the member app." actions={canManage && <Button onClick={() => setCreating(true)}>New group</Button>} />
      <Gate loading={d.loading} error={d.error} hasData={!!d.data}>
        {d.data && (d.data.length === 0 ? (
          <EmptyState icon="people" title="No groups yet" text={canManage ? 'Create a group for a ministry, cell or fellowship.' : 'Groups will show up here.'} action={canManage ? <Button onClick={() => setCreating(true)}>New group</Button> : undefined} />
        ) : (
          <div className="pp-list">
            {d.data.map((g) => (
              <button type="button" key={g.id} className="pp-item" onClick={() => setOpen(g.id)}>
                <span className="pp-avatar home" aria-hidden="true"><Icon name="people" size={20} /></span>
                <div>
                  <div className="pp-name">{g.name}</div>
                  <div className="pp-sub">{g.member_count} {g.member_count === 1 ? 'person' : 'people'} · {g.branch_name ?? 'Whole church'} · {g.leaders ? 'Led by ' + g.leaders : 'No leader yet'}</div>
                  {g.description && <div className="pp-sub">{g.description}</div>}
                </div>
                <span className="pp-side"><StatusChip tone="off">{g.join_policy === 'request' ? 'Members can ask to join' : 'By invitation only'}</StatusChip><StatusChip tone="off">{g.posting === 'leaders' ? 'Only leaders post' : 'Everyone can post'}</StatusChip></span>
                <Icon name="chevron" size={18} className="pp-chev" />
              </button>
            ))}
          </div>
        ))}
      </Gate>
      {creating && <GroupFormModal onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); toast.show('Group created.'); d.reload(); if (id) setOpen(id); }} />}
      {toast.node}
    </>
  );
}

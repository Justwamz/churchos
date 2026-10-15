import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, Field, Table, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load, PageHead } from './bits';
import { Modal } from './MemberForm';
import { GroupDetail } from './GroupDetail';

export function GroupFormModal({ group, onClose, onDone }: { group?: { id: string; name: string; description: string | null }; onClose: () => void; onDone: (id?: string) => void }) {
  const s = useSession();
  const [name, setName] = useState(group?.name ?? '');
  const [desc, setDesc] = useState(group?.description ?? '');
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (group) { await api.put(`/groups/${group.id}` + s.qs({ branch: undefined }), { name, description: desc }); onDone(); }
      else { const r = await api.post<{ id: string }>('/groups' + s.qs({ branch: undefined }), { name, description: desc, branchId: branch || undefined }); onDone(r.id); }
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
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button disabled={busy || name.trim().length < 2} onClick={save}>{busy ? 'Saving...' : 'Save'}</Button><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
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

  if (open) return <><PageHead title="Groups" /><GroupDetail id={open} onBack={() => { setOpen(null); d.reload(); }} /></>;

  return (
    <>
      <PageHead title="Groups" sub="Group leaders can message their group from the member app." action={canManage && <Button onClick={() => setCreating(true)}>New group</Button>} />
      <Load loading={d.loading} error={d.error} hasData={!!d.data}>
        {d.data && (
          <Card>
            {d.data.length === 0 ? <Empty>No groups yet.{canManage ? ' Create your first one.' : ''}</Empty> : (
              <Table head={['Group', 'Branch', 'People', 'Leaders', '']}>
                {d.data.map((g) => (
                  <tr key={g.id}>
                    <td><b>{g.name}</b>{g.description && <div className="tiny">{g.description}</div>}</td>
                    <td>{g.branch_name ?? <Badge tone="info">Whole church</Badge>}</td>
                    <td>{g.member_count}</td>
                    <td>{g.leaders || <span className="tiny">No leader yet</span>}</td>
                    <td><Button small kind="ghost" onClick={() => setOpen(g.id)}>Open</Button></td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}
      </Load>
      {creating && <GroupFormModal onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); toast.show('Group created.'); d.reload(); if (id) setOpen(id); }} />}
      {toast.node}
    </>
  );
}

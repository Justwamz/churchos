import { useState } from 'react';
import { Button, ErrorNote, Field, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Card, EmptyState, Skeleton, StatusChip, Toolbar } from './ui';
import './join-requests.css';

type Req = { id: string; name: string; phone?: string; branch?: string; memberNumber?: string; message?: string; status: string; requestedAt: string; decidedBy?: string; decidedAt?: string; note?: string };
type Filter = 'pending' | 'approved' | 'declined' | 'all';
const FILTERS: { id: Filter; label: string; qs: string }[] = [
  { id: 'pending', label: 'Waiting', qs: 'pending' },
  { id: 'approved', label: 'Approved', qs: 'approved' },
  { id: 'declined', label: 'Declined', qs: 'declined' },
  { id: 'all', label: 'All', qs: 'pending,approved,declined,cancelled' },
];
const TONE: Record<string, 'wait' | 'done' | 'bad' | 'off'> = { pending: 'wait', approved: 'done', declined: 'bad', cancelled: 'off' };
const LABEL: Record<string, string> = { pending: 'Waiting', approved: 'Approved', declined: 'Declined', cancelled: 'Withdrawn' };

/** People > Members > Join requests: people with no church who asked to join. Staff with members.edit approve or decline each one. */
export function JoinRequests({ onChanged, onOpenMember }: { onChanged: () => void; onOpenMember: (name: string) => void }) {
  const s = useSession();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('pending');
  const status = FILTERS.find((f) => f.id === filter)!.qs;
  const d = useAsync<{ pending: number; requests: Req[] }>(() => api.get('/members/join-requests' + s.qs({ status })), [s.qs(), status]);
  const [asking, setAsking] = useState<{ id: string; kind: 'approve' | 'decline' } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [approved, setApproved] = useState<Record<string, string>>({});

  const decide = async (r: Req, approve: boolean) => {
    setBusy(r.id); setErr('');
    try {
      await api.post(`/members/join-requests/${r.id}/decide` + s.qs(), approve ? { approve: true } : { approve: false, note: note.trim() });
      toast.show(approve ? `${r.name} is now a member.` : `Declined. ${r.name} will see your note.`);
      if (approve) setApproved((p) => ({ ...p, [r.id]: r.name }));
      setAsking(null); setNote('');
      d.reload(); onChanged();
    } catch (e: any) { setErr(friendly(e.message)); }
    setBusy(null);
  };

  if (d.error && !d.data) {
    const denied = /missing permission|forbidden|do not have access/i.test(d.error);
    return denied
      ? <EmptyState icon="people" title="Join requests are not available to you" text="Ask someone who can edit members to look after join requests." />
      : <ErrorNote>{friendly(d.error)}</ErrorNote>;
  }
  const rows = d.data?.requests ?? [];
  const canEdit = s.can('members.edit');

  return (
    <div className="jr">
      <Toolbar>
        <div className="chips" role="group" aria-label="Show requests">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={`chip ${filter === f.id ? 'on' : ''}`} aria-pressed={filter === f.id} onClick={() => { setFilter(f.id); setAsking(null); setErr(''); }}>
              {f.label}{f.id === 'pending' && d.data && d.data.pending > 0 ? ` (${d.data.pending})` : ''}
            </button>
          ))}
        </div>
      </Toolbar>
      {err && <ErrorNote>{err}</ErrorNote>}
      {!d.data ? <Skeleton rows={3} height={120} /> : rows.length === 0 ? (
        <EmptyState icon="people" title={filter === 'pending' ? 'Nobody is waiting to join.' : 'Nothing here yet'} text={filter === 'pending' ? 'When someone asks to join your church, you will see them here.' : 'Requests you have decided will show here.'} />
      ) : (
        <div className="jr-list">
          {rows.map((r) => (
            <Card key={r.id}>
              <div className="jr-card">
                <div className="jr-head">
                  <div className="jr-who">
                    <div className="jr-name">{r.name}</div>
                    <div className="jr-sub">{[r.branch, `asked ${shortDate(r.requestedAt)}`].filter(Boolean).join(' · ')}</div>
                  </div>
                  <StatusChip tone={TONE[r.status] ?? 'off'}>{LABEL[r.status] ?? r.status}</StatusChip>
                </div>
                {r.message && <p className="jr-msg">{r.message}</p>}
                <dl className="jr-facts">
                  {r.memberNumber && <div><dt>Member number they typed</dt><dd><span className="jr-mono">{r.memberNumber}</span><span className="jr-hint"> Check it against your records</span></dd></div>}
                  {r.phone && <div><dt>Phone</dt><dd>{r.phone}</dd></div>}
                  {r.status !== 'pending' && r.decidedAt && <div><dt>Decided</dt><dd>{shortDate(r.decidedAt)}{r.decidedBy ? ` by ${r.decidedBy}` : ''}</dd></div>}
                  {r.status === 'declined' && r.note && <div><dt>Your note</dt><dd>{r.note}</dd></div>}
                </dl>
                {r.status === 'pending' && canEdit && (asking?.id === r.id ? (
                  asking.kind === 'approve' ? (
                    <div className="jr-ask" role="group" aria-label="Confirm">
                      <p>Add {r.name} as a member of {r.branch || 'your church'}?</p>
                      <div className="jr-actions"><Button disabled={busy === r.id} onClick={() => decide(r, true)}>{busy === r.id ? 'Adding...' : 'Yes, add'}</Button><Button kind="ghost" disabled={busy === r.id} onClick={() => setAsking(null)}>Cancel</Button></div>
                    </div>
                  ) : (
                    <div className="jr-ask" role="group" aria-label="Decline">
                      <Field label="Why are you declining?" hint="They will see this">
                        <textarea rows={3} maxLength={300} value={note} autoFocus onChange={(e) => setNote(e.target.value)} placeholder="For example: We could not find you in our records. Please see the office." />
                      </Field>
                      <div className="jr-actions"><Button kind="danger" disabled={busy === r.id || note.trim().length < 2} onClick={() => decide(r, false)}>{busy === r.id ? 'Declining...' : 'Decline request'}</Button><Button kind="ghost" disabled={busy === r.id} onClick={() => { setAsking(null); setNote(''); }}>Cancel</Button></div>
                    </div>
                  )
                ) : (
                  <div className="jr-actions"><Button onClick={() => { setAsking({ id: r.id, kind: 'approve' }); setErr(''); }}>Approve</Button><Button kind="ghost" onClick={() => { setAsking({ id: r.id, kind: 'decline' }); setNote(''); setErr(''); }}>Decline</Button></div>
                ))}
                {r.status === 'pending' && !canEdit && <p className="jr-hint">You can see this request. Only people who can edit members can decide it.</p>}
                {(approved[r.id] || r.status === 'approved') && <div className="jr-actions"><Button small kind="ghost" onClick={() => onOpenMember(approved[r.id] ?? r.name)}>Open member</Button></div>}
              </div>
            </Card>
          ))}
        </div>
      )}
      {toast.node}
    </div>
  );
}

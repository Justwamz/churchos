import { useEffect } from 'react';
import { Empty, useAsync } from '@churchos/ui';
import { api, friendly, useSession } from './session';

export const toIso = (v: string) => new Date(`${v}:00+03:00`).toISOString();
export const toLocal = (iso: string | null | undefined) => (iso ? new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 16) : '');

export type AudState = { kind: 'org' | 'branch' | 'group'; branch: string; group: string };

export function initialAudience(a?: { type: string; id?: string }, firstBranch = ''): AudState {
  return { kind: (a?.type as AudState['kind']) ?? 'org', branch: a?.type === 'branch' ? a.id! : firstBranch, group: a?.type === 'group' ? a.id! : '' };
}

export function audienceValue(a: AudState) {
  return a.kind === 'org' ? { type: 'org' } : a.kind === 'branch' ? { type: 'branch', id: a.branch } : { type: 'group', id: a.group };
}

/** Whole church / A branch / A group. Same choices as Adverts. */
export function AudiencePicker({ name, value, onChange }: { name: string; value: AudState; onChange: (v: AudState) => void }) {
  const s = useSession();
  const groups = useAsync<any[]>(() => api.get('/groups' + s.qs({ branch: undefined })), [s.qs()]);
  useEffect(() => {
    if (value.kind === 'group' && !value.group && groups.data?.length) onChange({ ...value, group: groups.data[0].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.kind, value.group, groups.data]);
  const radio = (k: AudState['kind'], text: string) => (
    <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="radio" name={name} checked={value.kind === k} onChange={() => onChange({ ...value, kind: k })} /> <b>{text}</b></label>
  );
  return (
    <div className="stack" style={{ gap: 10 }}>
      {radio('org', 'Whole church')}
      {radio('branch', 'A branch')}
      {value.kind === 'branch' && <select aria-label="Branch" value={value.branch} onChange={(e) => onChange({ ...value, branch: e.target.value })}>{s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
      {radio('group', 'A group')}
      {value.kind === 'group' && (groups.data && groups.data.length > 0
        ? <select aria-label="Group" value={value.group} onChange={(e) => onChange({ ...value, group: e.target.value })}>{groups.data.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
        : <Empty>No groups yet. Create one on the Groups page.</Empty>)}
    </div>
  );
}

const ERR: Record<string, string> = {
  forbidden: 'You can only choose a branch or group that you manage. Pick a different audience.',
  bad_date: 'Please check the dates and times you chose.',
  capacity_too_low: 'More people than that have already said they are coming, so the capacity cannot be lower.',
};

/** Friendly message for an API error. Server messages for dates and capacity are already plain, so they are kept. */
export function explainCommunity(e: any): string {
  if (e?.code === 'forbidden' || e?.status === 403) return ERR.forbidden;
  if ((e?.code === 'bad_date' || e?.code === 'capacity_too_low') && e?.message) return friendly(e.message);
  return (e?.code && ERR[e.code]) || friendly(e?.message);
}

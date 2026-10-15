import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, Field, Note, Spinner, kes, useAsync } from '@churchos/ui';
import { api, errText } from './api';

const ERR: Record<string, string> = {
  forbidden: 'Only a leader of this group can message it, and only people in the group.',
  bad_title: 'Give your message a title of up to 80 characters.',
  bad_body: 'Write a message of up to 1,000 characters.',
  in_past: 'Choose a time in the future.',
  nobody: 'There is nobody to send this to. Choose different people or channels.',
};
const sendError = (e: any) => (e?.code === 'daily_cap' ? errText(e) : ERR[e?.code] ?? errText(e));

function useDebounced(key: string, ms: number, fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => { const t = setTimeout(() => ref.current(), ms); return () => clearTimeout(t); }, [key, ms]);
}

export function MyGroups() {
  const g = useAsync<any[]>(() => api.get('/me/groups'));
  const [open, setOpen] = useState<any | null>(null);
  if (open) return <Composer group={open} onBack={() => setOpen(null)} />;
  const rows = g.data ?? [];
  return (
    <Card title="My groups">
      {g.loading && !g.data ? <Spinner /> : g.error && !g.data ? (
        <div className="stack"><ErrorNote>{g.error}</ErrorNote><Button kind="ghost" onClick={g.reload}>Try again</Button></div>
      ) : !rows.length ? <Empty>You are not in any groups yet.</Empty> : (
        <ul className="list">
          {rows.map((r) => (
            <li key={r.id}>
              <div className="row"><strong>{r.name}</strong><Badge tone={r.role === 'leader' ? 'info' : 'muted'}>{r.role === 'leader' ? 'Leader' : 'Member'}</Badge></div>
              <div className="tiny">{[r.church, r.branch].filter(Boolean).join(' · ')} · {r.memberCount} {r.memberCount === 1 ? 'person' : 'people'}</div>
              {r.canMessage && <div style={{ marginTop: 6 }}><Button kind="ghost" small onClick={() => setOpen(r)}>Message this group</Button></div>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Composer({ group, onBack }: { group: any; onBack: () => void }) {
  const detail = useAsync<any>(() => api.get(`/me/groups/${encodeURIComponent(group.id)}`), [group.id]);
  const [who, setWho] = useState<'all' | 'some'>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [sms, setSms] = useState(false);
  const [wa, setWa] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState('');
  const [step, setStep] = useState<'edit' | 'confirm' | 'done'>('edit');
  const [est, setEst] = useState<any>(null);
  const [estKey, setEstKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [doneMsg, setDoneMsg] = useState('');

  const members: any[] = detail.data?.members ?? [];
  const channels = useMemo(() => [...(sms ? ['sms'] : []), ...(wa ? ['whatsapp'] : [])], [sms, wa]);
  const recipientIds = who === 'some' ? picked : [];
  const key = JSON.stringify([channels, body, recipientIds]);

  useDebounced(key, 400, async () => {
    if (!detail.data || (who === 'some' && !picked.length)) { setEst(null); return; }
    try { setEst(await api.post(`/me/groups/${encodeURIComponent(group.id)}/estimate`, { channels, body, recipientIds })); setEstKey(key); } catch { setEst(null); }
  });

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const allPicked = members.length > 0 && picked.length === members.length;
  const scheduleAt = later && when ? new Date(`${when}:00+03:00`).toISOString() : undefined;
  const ready = title.trim().length > 0 && title.length <= 80 && body.trim().length > 0 && body.length <= 1000 && (who === 'all' || picked.length > 0) && (!later || !!scheduleAt);

  const send = async () => {
    setBusy(true); setError(undefined);
    try {
      await api.post(`/me/groups/${encodeURIComponent(group.id)}/messages`, { channels, title: title.trim(), body, recipientIds, scheduleAt });
      setDoneMsg(scheduleAt ? 'Your message is scheduled.' : 'Your message is on its way.');
      setStep('done');
    } catch (e) { setError(sendError(e)); setStep('edit'); }
    setBusy(false);
  };

  if (step === 'done') {
    return (
      <Card className="receipt"><Note tone="good">{doneMsg}</Note><div style={{ height: 12 }} /><Button onClick={onBack}>Back to my groups</Button></Card>
    );
  }

  return (
    <div className="stack">
      <div className="row"><Button kind="ghost" small onClick={onBack}>Back</Button></div>
      <Card title={`Message ${group.name}`}>
        {detail.loading && !detail.data ? <Spinner /> : detail.error && !detail.data ? <ErrorNote>{detail.error}</ErrorNote> : step === 'confirm' ? (
          <div className="stack">
            <h3 style={{ fontSize: '1.05rem' }}>Ready to {scheduleAt ? 'schedule' : 'send'}?</h3>
            <div><strong>{title}</strong></div>
            <div className="muted" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{body}</div>
            <Estimate est={est} />
            <div className="tiny">Sent {scheduleAt ? `on ${when.replace('T', ' at ')} (East Africa Time)` : 'now'} by {['In-app', ...(sms ? ['SMS'] : []), ...(wa ? ['WhatsApp'] : [])].join(', ')}.</div>
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button disabled={busy} onClick={send}>{busy ? 'Sending…' : scheduleAt ? 'Yes, schedule it' : 'Yes, send it'}</Button>
            <Button kind="ghost" disabled={busy} onClick={() => setStep('edit')}>Go back and edit</Button>
          </div>
        ) : (
          <div className="stack">
            <div>
              <div className="field-label">Who should get it?</div>
              <div className="chips" role="group" aria-label="Who" style={{ marginTop: 6 }}>
                <button type="button" className={`chip ${who === 'all' ? 'on' : ''}`} aria-pressed={who === 'all'} onClick={() => setWho('all')}>Everyone in the group</button>
                <button type="button" className={`chip ${who === 'some' ? 'on' : ''}`} aria-pressed={who === 'some'} onClick={() => setWho('some')}>Choose people</button>
              </div>
            </div>
            {who === 'some' && (
              <div className="stack" style={{ gap: 6 }}>
                <label className="check-row"><input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? [] : members.map((m) => m.id))} /> <strong>Select all ({members.length})</strong></label>
                <div className="pick-list">
                  {members.map((m) => (
                    <label key={m.id} className="check-row"><input type="checkbox" checked={picked.includes(m.id)} onChange={() => toggle(m.id)} /> {m.name}{m.role === 'leader' ? ' (leader)' : ''}</label>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="field-label">How should it be sent?</div>
              <div className="stack" style={{ gap: 6, marginTop: 6 }}>
                <label className="check-row"><input type="checkbox" checked disabled /> In-app (always on)</label>
                <label className="check-row"><input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} /> SMS ({kes(100)} per message)</label>
                <label className="check-row"><input type="checkbox" checked={wa} onChange={(e) => setWa(e.target.checked)} /> WhatsApp ({kes(300)} per message)</label>
              </div>
            </div>
            <Field label="Title" hint={`${title.length}/80`}>
              <input maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Meeting this Friday" />
            </Field>
            <Field label="Message" hint={`${body.length}/1000`}>
              <textarea rows={5} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} />
            </Field>
            <div><button type="button" className="chip" onClick={() => setBody((b) => `${b}{name}`)}>Insert first name</button></div>
            <Estimate est={est} stale={estKey !== key} />
            <div className="chips" role="group" aria-label="When">
              <button type="button" className={`chip ${!later ? 'on' : ''}`} aria-pressed={!later} onClick={() => setLater(false)}>Send now</button>
              <button type="button" className={`chip ${later ? 'on' : ''}`} aria-pressed={later} onClick={() => setLater(true)}>Schedule for later</button>
            </div>
            {later && (
              <Field label="Send at (East Africa Time)">
                <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
              </Field>
            )}
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button disabled={!ready} onClick={() => { setError(undefined); setStep('confirm'); }}>Review message</Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function Estimate({ est, stale }: { est: any; stale?: boolean }) {
  if (!est) return <p className="tiny" style={{ margin: 0 }}>Choose who to message to see how many people it will reach.</p>;
  return (
    <div className="stack" style={{ gap: 6, opacity: stale ? 0.6 : 1 }} aria-live="polite">
      <Note tone="info">This will reach {est.people} {est.people === 1 ? 'person' : 'people'}. About {kes(est.totalCost)}.</Note>
      {est.anyShort && <Note tone="warn">Some people will only get it in the app because the group's credit is low.</Note>}
    </div>
  );
}

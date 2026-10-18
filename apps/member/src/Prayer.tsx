import { useEffect, useId, useState } from 'react';
import { Badge, Button, ErrorNote, useAsync, useToast } from '@churchos/ui';
import { api, errText } from './api';
import { relTime } from './Community';
import { Icon, Sheet, Skeleton } from './ui';

const enc = encodeURIComponent;
const MAX = 600;

const ERR: Record<string, string> = {
  too_many: 'You have sent 10 requests today. Please try again tomorrow.',
  bad_group: 'Please choose one of your groups.',
  bad_audience: 'Please choose who can see your request.',
  not_a_member: 'You need to be a member of a church to do this.',
};
const say = (e: any) => ERR[e?.code] ?? errText(e);

/** A labelled on/off switch with a line of explanation. */
export function SwitchRow({ on, onChange, label, note }: { on: boolean; onChange: (v: boolean) => void; label: string; note?: string }) {
  const id = useId();
  return (
    <div className={`anon-box ${on ? 'on' : ''}`}>
      <div className="anon-row">
        <span id={id} className="anon-label">{label}</span>
        <button type="button" role="switch" aria-checked={on} aria-labelledby={id} className="switch" onClick={() => onChange(!on)}><i /></button>
      </div>
      {note && <p className="tiny anon-text">{note}</p>}
    </div>
  );
}

/** The privacy notice and helplines. Used by Prayer and by booking a pastor or counsellor. */
export function PastoralInfo({ info, title, defaultOpen = false }: { info: any; title: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!info) return null;
  const lines: any[] = info.helplines ?? [];
  return (
    <div className="pr-help">
      <button type="button" className="pr-help-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <strong>{title}</strong>
        <span className={`pr-chev ${open ? 'open' : ''}`}><Icon name="chev" size={18} /></span>
      </button>
      {open && (
        <div className="pr-help-body">
          {info.notice && <p className="pr-notice">{info.notice}</p>}
          {lines.length > 0 && (
            <ul className="plain-list pr-lines">
              {lines.map((h, i) => (
                <li key={i}>
                  <span className="pr-line-main"><strong>{h.name}</strong>{h.note && <span className="tiny">{h.note}</span>}</span>
                  <a className="btn ghost pr-call" href={`tel:${String(h.phone).replace(/[^\d+]/g, '')}`}>{h.phone}</a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const AUD: { key: string; label: string }[] = [
  { key: 'team', label: 'The prayer team only' },
  { key: 'group', label: 'A group I belong to' },
  { key: 'branch', label: 'My branch' },
  { key: 'church', label: 'The whole church' },
];
const audChip = (r: any) => (r.audience === 'team' ? 'Team only' : r.audience === 'group' ? r.groupName || 'Group' : r.audience === 'branch' ? 'Branch' : 'Church');

export function PrayerPage() {
  const info = useAsync<any>(() => api.get('/me/pastoral/info'));
  const feed = useAsync<any>(() => api.get('/me/prayer'));
  const toast = useToast();
  const [answer, setAnswer] = useState<any | null>(null);
  const [down, setDown] = useState<any | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const rows: any[] = feed.data?.requests ?? [];

  const pray = async (r: any) => {
    setBusy(r.id); setError(undefined);
    try { await api.post(`/me/prayer/${enc(r.id)}/pray`, {}); feed.reload(); } catch (e) { setError(say(e)); feed.reload(); }
    setBusy(null);
  };

  return (
    <div className="stack">
      <div className="block pr-top">
        <strong>Your request is only as private as the choice you make below</strong>
        <p className="tiny" style={{ margin: 0 }}>The prayer team only: just the people who pray with the church. A group or your branch: members there can read it. The whole church: everyone in your church can read it. You can always send it without your name.</p>
        <PastoralInfo info={info.data} title="If you need help now" />
      </div>

      <Composer info={info.data} onSent={() => { feed.reload(); toast.show('Your request was sent.'); }} />

      <section className="agenda">
        <h3 className="agenda-month">Prayer requests</h3>
        {error && <ErrorNote>{error}</ErrorNote>}
        {feed.loading && !feed.data ? <div className="card"><Skeleton lines={4} /></div> : feed.error && !feed.data ? (
          <div className="stack"><ErrorNote>{feed.error}</ErrorNote><Button kind="ghost" onClick={feed.reload}>Try again</Button></div>
        ) : !rows.length ? (
          <div className="empty-state"><span className="pr-big" aria-hidden="true">{'🙏'}</span><strong>No prayer requests yet. Be the first to ask.</strong></div>
        ) : (
          <ul className="notice-list pr-list">
            {rows.map((r) => <li key={r.id}><RequestCard r={r} busy={busy === r.id} onPray={() => pray(r)} onAnswer={() => setAnswer(r)} onDown={() => setDown(r)} /></li>)}
          </ul>
        )}
      </section>

      <AnswerSheet r={answer} onClose={() => setAnswer(null)} onDone={() => { feed.reload(); toast.show('Marked as answered. Praise God.'); }} />
      <DownSheet r={down} onClose={() => setDown(null)} onDone={() => { feed.reload(); toast.show('Your request was taken down.'); }} />
      {toast.node}
    </div>
  );
}

function RequestCard({ r, busy, onPray, onAnswer, onDown, compact }: { r: any; busy?: boolean; onPray: () => void; onAnswer?: () => void; onDown?: () => void; compact?: boolean }) {
  if (r.status === 'hidden') {
    return <div className="block pr-card pr-muted"><div className="tiny">{relTime(r.createdAt)}</div><p style={{ margin: 0 }}>{r.takenDownBy === 'you' ? 'You took this down' : 'Taken off the shared list by the prayer team'}</p></div>;
  }
  const answered = r.status === 'answered';
  return (
    <div className="block pr-card">
      <div className="pr-top-row">
        <strong className="ell">{r.mine ? (r.anonymous ? 'You (shown as A member)' : 'You') : r.author}</strong>
        <span className="pr-meta"><span className="badge info">{audChip(r)}</span>{answered && <Badge tone="good">Answered</Badge>}</span>
      </div>
      <div className="tiny">{relTime(r.createdAt)}</div>
      <p className="pr-body">{r.body}</p>
      {answered && r.answeredNote && <blockquote className="pr-quote">{r.answeredNote}</blockquote>}
      <div className="pr-actions">
        <button type="button" className={`btn ${r.prayed ? 'ghost' : 'primary'} pr-pray`} disabled={r.prayed || busy} onClick={onPray}>
          <span aria-hidden="true">{'🙏'}</span> {r.prayed ? 'You prayed' : 'I prayed'} ({r.prayers ?? 0})
        </button>
        {!compact && r.mine && !answered && <button type="button" className="link-btn" onClick={onAnswer}>Mark as answered</button>}
        {!compact && r.mine && <button type="button" className="link-btn pr-danger" onClick={onDown}>Take down</button>}
      </div>
    </div>
  );
}

function Composer({ info, onSent }: { info: any; onSent: () => void }) {
  const groups: any[] = info?.groups ?? [];
  const [body, setBody] = useState('');
  const [aud, setAud] = useState('team');
  const [groupId, setGroupId] = useState('');
  const [anon, setAnon] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => { if (!groupId && groups.length) setGroupId(groups[0].id); }, [groups.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const ok = body.trim().length > 0 && body.length <= MAX && (aud !== 'group' || !!groupId);

  const send = async () => {
    setBusy(true); setError(undefined);
    try {
      await api.post('/me/prayer', { body: body.trim(), audience: aud, groupId: aud === 'group' ? groupId : undefined, anonymous: anon || undefined });
      setBody(''); setAnon(false); onSent();
    } catch (e) { setError(say(e)); }
    setBusy(false);
  };

  return (
    <div className="block pr-compose">
      <h3 style={{ margin: 0 }}>Ask for prayer</h3>
      <label className="field">
        <span className="field-label">Your request</span>
        <textarea rows={4} value={body} maxLength={MAX} onChange={(e) => setBody(e.target.value)} placeholder="Share what you would like people to pray for" />
        <span className="field-hint pr-count">{body.length}/{MAX}</span>
      </label>
      <div role="radiogroup" aria-label="Who can see it?" className="pr-aud">
        <div className="field-label">Who can see it?</div>
        {AUD.filter((a) => a.key !== 'group' || groups.length > 0).map((a) => (
          <label key={a.key} className="check-row">
            <input type="radio" name="pr-aud" checked={aud === a.key} onChange={() => setAud(a.key)} />
            <span>{a.label}</span>
          </label>
        ))}
        {aud === 'group' && (
          <select aria-label="Which group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        )}
      </div>
      <SwitchRow on={anon} onChange={setAnon} label="Send without my name (shown as A member)" note="Nobody but you will see your name." />
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button disabled={!ok || busy} onClick={send}>{busy ? 'Sending…' : 'Send'}</Button>
    </div>
  );
}

function AnswerSheet({ r, onClose, onDone }: { r: any | null; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => { setNote(''); setError(undefined); }, [r?.id]);
  const go = async () => {
    setBusy(true); setError(undefined);
    try { await api.post(`/me/prayer/${enc(r.id)}/answered`, { note: note.trim() || undefined }); onDone(); onClose(); } catch (e) { setError(say(e)); }
    setBusy(false);
  };
  return (
    <Sheet open={!!r} onClose={onClose} title="Mark as answered">
      {r && (
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>Thank you for letting people know. Add a short thank-you if you like.</p>
          <label className="field"><span className="field-label">Thank-you note (optional)</span><textarea rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button disabled={busy} onClick={go}>{busy ? 'Saving…' : 'Mark as answered'}</Button>
        </div>
      )}
    </Sheet>
  );
}

function DownSheet({ r, onClose, onDone }: { r: any | null; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => setError(undefined), [r?.id]);
  const go = async () => {
    setBusy(true); setError(undefined);
    try { await api.post(`/me/prayer/${enc(r.id)}/withdraw`, {}); onDone(); onClose(); } catch (e) { setError(say(e)); }
    setBusy(false);
  };
  return (
    <Sheet open={!!r} onClose={onClose} title="Take this request down?">
      {r && (
        <div className="stack">
          <p className="pr-body" style={{ margin: 0 }}>{r.body}</p>
          <p className="muted" style={{ margin: 0 }}>People will no longer see it.</p>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button kind="danger" disabled={busy} onClick={go}>{busy ? 'Taking down…' : 'Yes, take it down'}</Button>
          <Button kind="ghost" onClick={onClose}>Keep it</Button>
        </div>
      )}
    </Sheet>
  );
}

// ---------------- Home card ----------------

export function HomePrayer({ onOpen }: { onOpen: () => void }) {
  const feed = useAsync<any>(() => api.get('/me/prayer'));
  const [busy, setBusy] = useState<string | null>(null);
  const rows: any[] = (feed.data?.requests ?? []).filter((r: any) => r.status === 'open' && r.audience !== 'team').slice(0, 2);
  if (!rows.length) return null;
  const pray = async (r: any) => {
    setBusy(r.id);
    try { await api.post(`/me/prayer/${enc(r.id)}/pray`, {}); } catch { /* the list refreshes below */ }
    feed.reload(); setBusy(null);
  };
  return (
    <section className="block">
      <div className="block-head"><h3>Prayer</h3><button type="button" className="link-btn" onClick={onOpen}>See all</button></div>
      <ul className="plain-list pr-home">
        {rows.map((r) => (
          <li key={r.id}>
            <div className="tiny">{r.mine ? 'You' : r.author} · {relTime(r.createdAt)}</div>
            <p className="clamp2 pr-body" style={{ margin: '2px 0 6px' }}>{r.body}</p>
            <button type="button" className={`btn ${r.prayed ? 'ghost' : 'primary'} pr-pray`} disabled={r.prayed || busy === r.id} onClick={() => pray(r)}>
              <span aria-hidden="true">{'🙏'}</span> {r.prayed ? 'You prayed' : 'I prayed'} ({r.prayers ?? 0})
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

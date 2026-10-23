import { useEffect, useState } from 'react';
import { Button, ErrorNote, useAsync, useToast } from '@churchos/ui';
import { api, errText } from './api';
import { relTime } from './Community';
import { SwitchRow } from './Prayer';
import { Icon, Skeleton } from './ui';

const MAX = 1000;
const ERR: Record<string, string> = {
  too_many: 'You have sent 5 suggestions today. Please try again tomorrow.',
  bad_category: 'Please choose what your suggestion is about.',
  not_a_member: 'You need to be a member of a church to send a suggestion.',
};
const TONE: Record<string, string> = { new: 'muted', review: 'warn', under_review: 'warn', done: 'good', not_possible: 'muted' };
const tone = (s: string) => TONE[s] ?? 'muted';

function Quote({ s }: { s: any }) {
  return s.response ? <blockquote className="pr-quote">{s.response}</blockquote> : null;
}

export function SuggestionsPage() {
  const info = useAsync<any>(() => api.get('/me/suggestions/info'));
  const mine = useAsync<any>(() => api.get('/me/suggestions'));
  const pub = useAsync<any>(() => api.get('/me/suggestions/published'));
  const toast = useToast();
  const [seg, setSeg] = useState<'mine' | 'said'>('mine');
  const cats: any[] = info.data?.categories ?? [];
  const memberships: any[] = info.data?.memberships ?? [];
  const [category, setCategory] = useState('');
  const [mid, setMid] = useState('');
  const [body, setBody] = useState('');
  const [anon, setAnon] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => { if (!category && cats.length) setCategory(cats[0].key); }, [cats.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!mid && memberships.length) setMid(memberships[0].membershipId); }, [memberships.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const ok = category && body.trim().length >= 10 && body.length <= MAX;

  const send = async () => {
    setBusy(true); setError(undefined);
    try {
      await api.post('/me/suggestions', { category, body: body.trim(), anonymous: anon || undefined, membershipId: memberships.length > 1 ? mid : undefined });
      setBody(''); setAnon(false); setSeg('mine'); mine.reload(); toast.show('Thank you. Your suggestion was sent.');
    } catch (e: any) { setError(ERR[e?.code] ?? errText(e)); }
    setBusy(false);
  };

  const rows: any[] = mine.data?.suggestions ?? [];
  const said: any[] = pub.data?.suggestions ?? [];
  return (
    <div className="stack">
      <div className="block pr-compose">
        <h3 style={{ margin: 0 }}>Send a suggestion</h3>
        {memberships.length > 1 && (
          <label className="field"><span className="field-label">Which church?</span>
            <select value={mid} onChange={(e) => setMid(e.target.value)}>{memberships.map((m) => <option key={m.membershipId} value={m.membershipId}>{m.branch}{m.church ? `, ${m.church}` : ''}</option>)}</select>
          </label>
        )}
        <label className="field"><span className="field-label">What is it about?</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>{cats.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
        </label>
        <label className="field">
          <span className="field-label">Your suggestion</span>
          <textarea rows={4} value={body} maxLength={MAX} onChange={(e) => setBody(e.target.value)} placeholder="Tell your church what could be better" />
          <span className="field-hint pr-count">{body.length}/{MAX}{body.trim().length > 0 && body.trim().length < 10 ? ' · at least 10 characters' : ''}</span>
        </label>
        <SwitchRow on={anon} onChange={setAnon} label="Send without my name" note="The church will see your suggestion but not who sent it. You can still see its answer here." />
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button disabled={!ok || busy} onClick={send}>{busy ? 'Sending…' : 'Send'}</Button>
      </div>

      <div className="seg" role="tablist" aria-label="Suggestions">
        <button type="button" role="tab" aria-selected={seg === 'mine'} className={seg === 'mine' ? 'on' : ''} onClick={() => setSeg('mine')}>My suggestions</button>
        <button type="button" role="tab" aria-selected={seg === 'said'} className={seg === 'said' ? 'on' : ''} onClick={() => setSeg('said')}>You said, we did</button>
      </div>

      {seg === 'mine' && (mine.loading && !mine.data ? <div className="card"><Skeleton lines={3} /></div> : mine.error && !mine.data ? (
        <div className="stack"><ErrorNote>{mine.error}</ErrorNote><Button kind="ghost" onClick={mine.reload}>Try again</Button></div>
      ) : !rows.length ? (
        <div className="empty-state"><Icon name="megaphone" size={40} /><strong>No suggestions yet</strong><span>What you send will show here, with the church's answer.</span></div>
      ) : (
        <ul className="notice-list pr-list">
          {rows.map((s) => (
            <li key={s.id} className="block pr-card">
              <div className="pr-top-row">
                <strong className="ell">{s.categoryLabel}</strong>
                <span className="pr-meta">{s.anonymous && <span className="badge info">Anonymous</span>}<span className={`badge ${tone(s.status)}`}>{s.statusLabel}</span></span>
              </div>
              <div className="tiny">{relTime(s.createdAt)}{s.branch ? ` · ${s.branch}` : ''}</div>
              <p className="pr-body">{s.body}</p>
              <Quote s={s} />
            </li>
          ))}
        </ul>
      ))}

      {seg === 'said' && (pub.loading && !pub.data ? <div className="card"><Skeleton lines={3} /></div> : pub.error && !pub.data ? (
        <div className="stack"><ErrorNote>{pub.error}</ErrorNote><Button kind="ghost" onClick={pub.reload}>Try again</Button></div>
      ) : !said.length ? (
        <div className="empty-state"><Icon name="check" size={40} /><strong>Nothing here yet</strong><span>When your church acts on a suggestion, you will see it here.</span></div>
      ) : (
        <ul className="notice-list pr-list">
          {said.map((s) => (
            <li key={s.id} className="block pr-card">
              <div className="pr-top-row"><strong className="ell">{s.categoryLabel}</strong><span className={`badge ${tone(s.status)}`}>{s.statusLabel}</span></div>
              <p className="pr-body"><strong>You said:</strong> {s.body}</p>
              {s.response && <blockquote className="pr-quote"><strong>We did:</strong> {s.response}</blockquote>}
            </li>
          ))}
        </ul>
      ))}
      {toast.node}
    </div>
  );
}


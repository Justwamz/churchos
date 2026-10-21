import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, Field, Note, dateOnly, useAsync, useToast } from '@churchos/ui';
import { api, errText } from './api';
import { Icon, Sheet, Skeleton } from './ui';

type Hit = { code: string; branch: string; church: string; region?: string };
type Req = { id: string; status: 'pending' | 'approved' | 'declined' | 'cancelled'; church: string; branch: string; note?: string | null; decidedAt?: string | null; requestedAt?: string };
type Status = { linked: boolean; churches: { orgId: string; church: string; branch: string }[]; requests: Req[]; canLinkAtOnce: { code: string; church: string; branch: string }[] };

const friendly = (e: any) => {
  if (e?.code === 'rate_limited' || e?.status === 429) return 'Too many searches. Please wait a minute and try again.';
  if (e?.code === 'unknown_church') return 'We could not find that church. Check the name or code and try again.';
  if (e?.code === 'already_member') return 'You are already a member of that church.';
  if (e?.code === 'duplicate_request') return 'You already have a request waiting for that church.';
  if (e?.code === 'consent_required') return 'Please tick the box to agree before you ask to join.';
  return errText(e);
};

/** One search box with live suggestions after 3 letters (about 300 ms after typing stops). Used on Home and in the Give tab. */
export function ChurchSearch({ onChoose, action = 'Choose', hint }: { onChoose: (c: Hit) => void; action?: string; hint?: string }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const term = q.trim();
  useEffect(() => {
    setError(undefined);
    if (term.length < 3) { setHits(null); setBusy(false); return; }
    let alive = true;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.get(`/public/churches/search?q=${encodeURIComponent(term)}`);
        if (alive) setHits(r?.churches ?? []);
      } catch (e) { if (alive) { setHits(null); setError(friendly(e)); } }
      if (alive) setBusy(false);
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [term]);
  return (
    <div className="lk-search">
      <Field label="Church name or code" hint={hint ?? 'Type at least 3 letters. If your church gave you a code, type it here.'}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Grace or GRC001" autoComplete="off" autoCapitalize="none" />
      </Field>
      {error && <ErrorNote>{error}</ErrorNote>}
      {busy && !hits && <Skeleton lines={2} />}
      {hits && !hits.length && !busy && <Empty>We could not find a church called "{term}". Check the spelling, or ask your church for its code.</Empty>}
      {hits && hits.length > 0 && (
        <ul className="lk-hits" aria-label="Churches found">
          {hits.map((c) => (
            <li key={c.code}>
              <span className="lk-ico" aria-hidden="true"><Icon name="pin" size={22} /></span>
              <span className="lk-hit-text"><strong>{c.church}</strong><span className="tiny">{c.branch}{c.region ? ` · ${c.region}` : ''} · {c.code}</span></span>
              <Button small onClick={() => onChoose(c)}>{action}</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The calm screen shown to a signed-in person who belongs to no church. `onLinked` re-fetches the app data so the tabs unlock. */
export function LinkHome({ user, first, onLinked }: { user: any; first: string; onLinked: () => void }) {
  const status = useAsync<Status>(() => api.get('/me/link/status'));
  const [pick, setPick] = useState<Hit | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [justSent, setJustSent] = useState<string | null>(null);
  const toast = useToast();
  const reloadRef = useRef(status.reload);
  reloadRef.current = status.reload;
  const linkedRef = useRef(false);
  const onLinkedRef = useRef(onLinked);
  onLinkedRef.current = onLinked;

  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') reloadRef.current(); }, 30000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (status.data?.linked && !linkedRef.current) { linkedRef.current = true; onLinkedRef.current(); }
  }, [status.data?.linked]);

  const s = status.data;
  const pending = (s?.requests ?? []).filter((r) => r.status === 'pending');
  const declined = (s?.requests ?? []).filter((r) => r.status === 'declined').sort((a, b) => String(b.decidedAt ?? '').localeCompare(String(a.decidedAt ?? '')))[0];
  const showSearch = searching || (!pending.length && !declined) || (!!declined && searching);
  const showDeclined = !!declined && !searching && !pending.length;

  const cancel = async (id: string) => {
    setBusy(id); setError(undefined);
    try { await api.post(`/me/link/request/${id}/cancel`, {}); setJustSent(null); status.reload(); } catch (e) { setError(friendly(e)); }
    setBusy(null);
  };
  const instant = async (c: { code: string; church: string }) => {
    setBusy(c.code); setError(undefined);
    try { await api.post('/me/link/instant', { code: c.code }); toast.show(`You are linked to ${c.church}`); status.reload(); onLinkedRef.current(); } catch (e) { setError(friendly(e)); }
    setBusy(null);
  };

  if (status.loading && !s) return <div className="card"><Skeleton lines={4} /></div>;
  return (
    <div className="stack lk">
      <div className="greet">
        <h1>{first ? `Welcome, ${first}` : 'Welcome'}</h1>
        <p>You are signed in. Link your church to unlock giving records, services, groups and more.</p>
      </div>

      {status.error && !s && <ErrorNote>{status.error}</ErrorNote>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {(s?.canLinkAtOnce ?? []).map((c) => (
        <section key={c.code} className="lk-staff">
          <div className="lk-staff-top"><span className="lk-ico big" aria-hidden="true"><Icon name="check" size={26} /></span>
          <div className="lk-staff-text">
            <strong>You work for {c.church}</strong>
            <span className="tiny">{c.branch}. As a team member you can link at once, with no approval.</span>
          </div></div>
          <Button disabled={busy === c.code} onClick={() => instant(c)}>{busy === c.code ? 'Linking…' : `Link me to ${c.church} now`}</Button>
        </section>
      ))}

      {pending.length > 0 && (
        <Card title="Waiting for approval">
          {justSent && <Note tone="good">Request sent to {justSent}. They will approve it and you will be told here.</Note>}
          <ul className="lk-reqs">
            {pending.map((r) => (
              <li key={r.id}>
                <div className="lk-req-top"><strong>{r.church}</strong><Badge tone="warn">Pending</Badge></div>
                <span className="tiny">{r.branch}{r.requestedAt ? ` · asked ${dateOnly(r.requestedAt)}` : ''}</span>
                <span className="tiny">You do not need to do anything. This page checks for the answer for you.</span>
                <Button kind="ghost" small disabled={busy === r.id} onClick={() => cancel(r.id)}>{busy === r.id ? 'Cancelling…' : 'Cancel request'}</Button>
              </li>
            ))}
          </ul>
          {!searching && <div className="lk-more"><Button kind="ghost" small onClick={() => setSearching(true)}>Ask another church</Button></div>}
        </Card>
      )}

      {showDeclined && declined && (
        <Card title="Your request was declined">
          <div className="stack">
            <p style={{ margin: 0 }}><strong>{declined.church}</strong> ({declined.branch}) did not approve your request{declined.decidedAt ? ` on ${dateOnly(declined.decidedAt)}` : ''}.</p>
            {declined.note && <Note tone="info">Their note: {declined.note}</Note>}
            <Button onClick={() => setSearching(true)}>Try another church</Button>
          </div>
        </Card>
      )}

      {showSearch && (
        <Card title="Find your church">
          <ChurchSearch onChoose={setPick} />
        </Card>
      )}

      <JoinSheet pick={pick} user={user} onClose={() => setPick(null)} onSent={(c) => { setPick(null); setSearching(false); setJustSent(c); status.reload(); }} />
      {toast.node}
    </div>
  );
}

function JoinSheet({ pick, user, onClose, onSent }: { pick: Hit | null; user: any; onClose: () => void; onSent: (church: string) => void }) {
  const [name, setName] = useState('');
  const [num, setNum] = useState('');
  const [msg, setMsg] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => { if (pick) { setName(String(user?.name ?? '')); setNum(''); setMsg(''); setConsent(false); setError(undefined); } }, [pick?.code]); // eslint-disable-line
  const send = async () => {
    if (!pick) return;
    setBusy(true); setError(undefined);
    try {
      const body: any = { code: pick.code, consent: true };
      if (name.trim()) body.name = name.trim();
      if (num.trim()) body.memberNumber = num.trim();
      if (msg.trim()) body.message = msg.trim();
      const r = await api.post('/me/link/request', body);
      onSent(r?.church ?? pick.church);
    } catch (e) { setError(friendly(e)); }
    setBusy(false);
  };
  return (
    <Sheet open={!!pick} onClose={onClose} title="Ask to join">
      {pick && (
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}><strong>{pick.church}</strong>, {pick.branch}. The church will check your request and you will be told here.</p>
          <Field label="Your name"><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
          <Field label="Member number (optional)" hint="If your church gave you one."><input value={num} onChange={(e) => setNum(e.target.value)} autoCapitalize="characters" /></Field>
          <Field label="Message to the church (optional)"><textarea rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={300} placeholder="e.g. I joined in 2019 and attend the Sunday service" /></Field>
          <label className="lk-consent"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>I agree the church may keep my details</span></label>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button disabled={busy || !consent} onClick={send}>{busy ? 'Sending…' : 'Ask to join'}</Button>
        </div>
      )}
    </Sheet>
  );
}

/** What church-only tabs show until the person is linked. */
export function Locked({ title, onLink, children }: { title?: string; onLink: () => void; children?: ReactNode }) {
  return (
    <div className="lk-locked">
      <span className="lk-lock" aria-hidden="true"><Icon name="link" size={30} /></span>
      <strong>{title ?? 'Link your church to use this'}</strong>
      <p>{children ?? 'This part of the app works with your church. It opens as soon as your church has approved you.'}</p>
      <Button onClick={onLink}>Link my church</Button>
    </div>
  );
}

/** Give tab for a person with no church: pick a church, then the normal gift form runs in visitor mode. */
export function VisitorGiveTab({ onLink, renderGive }: { onLink: () => void; renderGive: (code: string, church: any, back: () => void) => ReactNode }) {
  const [code, setCode] = useState<string | null>(null);
  const church = useAsync<any>(() => (code ? api.get(`/public/church/${encodeURIComponent(code)}`) : Promise.resolve(undefined)), [code]);
  return (
    <div className="stack">
      <Note tone="info">You are giving as a visitor. Link your church to see your giving record and get statements.</Note>
      {!code ? (
        <Card title="Give to a church">
          <ChurchSearch action="Give here" onChoose={(c) => setCode(c.code)} hint="Type at least 3 letters of the church name, or its code." />
        </Card>
      ) : church.loading ? (
        <div className="card"><Skeleton lines={4} /></div>
      ) : church.error || !church.data ? (
        <div className="stack"><ErrorNote>{church.error ?? 'We could not load that church.'}</ErrorNote><Button kind="ghost" onClick={() => setCode(null)}>Choose another church</Button></div>
      ) : (
        renderGive(code, church, () => setCode(null))
      )}
      <Button kind="ghost" onClick={onLink}>Link my church</Button>
    </div>
  );
}

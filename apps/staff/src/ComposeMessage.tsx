import { useEffect, useRef, useState } from 'react';
import { Button, Card, Empty, ErrorNote, Field, Note, Spinner, kes, shortDate, useAsync } from '@churchos/ui';
import { api, useSession } from './session';
import { useDebounced } from './MemberForm';
import { AGE_BANDS, describeAudience, sendError, type Audience } from './audience';
import { DeliveryResult } from './MessageDetail';

/** Lets the Groups page open the compose panel already pointed at a group. */
export const composePreset: { groupId?: string } = {};

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const toIso = (v: string) => new Date(`${v}:00+03:00`).toISOString();

type Kind = 'org' | 'region' | 'branch' | 'group';

export function ComposeMessage({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const s = useSession();
  const groups = useAsync<any[]>(() => api.get('/groups' + s.qs({ branch: undefined })), [s.qs()]);
  const preset = useRef(composePreset.groupId);
  useEffect(() => { composePreset.groupId = undefined; }, []);

  const regions = [...new Set(s.branches.map((b) => b.region).filter(Boolean) as string[])];
  // Only people who manage every branch may reach the whole church; others see 'All my branches'.
  const wholeChurch = s.can('groups.manage') && s.scope === 'all' && s.branches.length > 1;
  const [kind, setKind] = useState<Kind>(preset.current ? 'group' : 'org');
  const [region, setRegion] = useState(regions[0] ?? '');
  const [branch, setBranch] = useState(s.branches[0]?.id ?? '');
  const [group, setGroup] = useState(preset.current ?? '');
  const [who, setWho] = useState<'all' | 'adults' | 'children'>('all');
  const [bands, setBands] = useState<string[]>([]);
  const [sex, setSex] = useState<'' | 'male' | 'female'>('');
  const [sms, setSms] = useState(false);
  const [wa, setWa] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [step, setStep] = useState<'edit' | 'confirm' | 'done'>('edit');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (kind === 'group' && !group && groups.data?.length) setGroup(groups.data[0].id); }, [kind, group, groups.data]);

  const scope: Audience['scope'] | null =
    kind === 'org' ? { type: 'org' } :
    kind === 'region' ? (region ? { type: 'region', id: region } : null) :
    kind === 'branch' ? (branch ? { type: 'branch', id: branch } : null) :
    group ? { type: 'group', id: group } : null;
  const full: Audience | null = scope && { scope, who: kind === 'group' ? 'all' : who, ageBands: bands.length ? bands : undefined, sex: sex || undefined };
  const channels = ['inapp', ...(sms ? ['sms'] : []), ...(wa ? ['whatsapp'] : [])];
  const key = JSON.stringify({ full, channels, body });
  const dKey = useDebounced(key, 400);

  const [est, setEst] = useState<any>(null);
  const [estErr, setEstErr] = useState('');
  const [estBusy, setEstBusy] = useState(false);
  useEffect(() => {
    const p = JSON.parse(dKey);
    if (!p.full) { setEst(null); return; }
    let alive = true;
    setEstBusy(true);
    api.post<any>('/messages/estimate' + s.qs({ branch: undefined }), { audience: p.full, channels: p.channels, body: p.body })
      .then((r) => { if (alive) { setEst(r); setEstErr(''); } })
      .catch((e: any) => { if (alive) { setEst(null); setEstErr(sendError(e.code, e.message)); } })
      .finally(() => { if (alive) setEstBusy(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dKey]);
  const stale = dKey !== key;

  const insertName = () => {
    const el = bodyRef.current;
    const a = el?.selectionStart ?? body.length, b = el?.selectionEnd ?? body.length;
    setBody((x) => x.slice(0, a) + '{name}' + x.slice(b));
    setTimeout(() => { el?.focus(); el?.setSelectionRange(a + 6, a + 6); }, 0);
  };
  const toggleBand = (b: string) => setBands((x) => (x.includes(b) ? x.filter((y) => y !== b) : [...x, b]));

  const review = () => {
    setErr('');
    if (!full) return setErr('Please choose who this message is for.');
    if (!title.trim()) return setErr('Give the message a short title.');
    if (!body.trim()) return setErr('Write the message.');
    if (when === 'later') {
      if (!at) return setErr('Choose a date and time to send.');
      if (Date.parse(`${at}:00+03:00`) < Date.now()) return setErr('That time has already passed. Choose a time in the future, or send now.');
    }
    if (!est || est.people === 0) return setErr('No one matches this audience. Check who you chose and try again.');
    setStep('confirm');
  };

  const send = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.post<any>('/messages' + s.qs({ branch: undefined }), { audience: full, channels, title: title.trim(), body: body.trim(), scheduleAt: when === 'later' ? toIso(at) : undefined });
      setResult(r); setStep('done'); onSent();
    } catch (e: any) { setErr(sendError(e.code, e.message)); setStep('edit'); }
    setBusy(false);
  };

  const audienceText = describeAudience(full ?? undefined, s.branches, groups.data?.find((g) => g.id === group)?.name);
  const whenText = when === 'later' && at ? `on ${shortDate(toIso(at))}` : 'now';

  if (step === 'done' && result) {
    return (
      <Card title={result.status === 'scheduled' ? 'Message scheduled' : 'Message sent'}>
        <div className="stack">
          {result.status === 'scheduled'
            ? <Note tone="good">Your message is scheduled. It will go out on {shortDate(result.scheduledAt)}. You can cancel it from the Messages list until then.</Note>
            : <><Note tone="good">Your message has gone out to {plural(result.summary?.people ?? 0, 'person', 'people')}.</Note><DeliveryResult summary={result.summary} /></>}
          <div><Button onClick={onClose}>Back to messages</Button></div>
        </div>
      </Card>
    );
  }

  if (step === 'confirm' && est) {
    return (
      <Card title="Ready to send?">
        <div className="stack">
          <Note tone="info">Send to <b>{plural(est.people, 'person', 'people')}</b>, cost about <b>{kes(est.totalCost)}</b>, goes out <b>{whenText}</b>.</Note>
          <div><b>{title}</b><div className="tiny">{audienceText}</div><p style={{ whiteSpace: 'pre-wrap' }}>{body}</p></div>
          {err && <ErrorNote>{err}</ErrorNote>}
          <div className="row"><Button disabled={busy} onClick={send}>{busy ? 'Sending...' : when === 'later' ? 'Schedule message' : 'Send now'}</Button><Button kind="ghost" disabled={busy} onClick={() => setStep('edit')}>Back</Button></div>
        </div>
      </Card>
    );
  }

  const radio = (k: Kind, text: string) => (
    <label key={k} className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
      <input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} />
      <b>{text}</b>
    </label>
  );
  const smsParts = est?.sms?.segments ?? 1;
  const bodyLen = body.length;
  const join = (xs: (string | false)[]) => xs.filter(Boolean).join(', ');

  return (
    <div className="stack">
      <div className="row between"><h2 style={{ margin: 0 }}>New message</h2><Button kind="ghost" small onClick={onClose}>Cancel</Button></div>
      <Note tone="info">Choose who it is for and ChurchOS delivers it. You never need phone numbers.</Note>

      <Card title="1. Who is it for?">
        <div className="stack" style={{ gap: 10 }}>
          {radio('org', wholeChurch ? 'Whole church' : 'All my branches')}
          {regions.length > 0 && radio('region', 'A region')}
          {kind === 'region' && <select aria-label="Region" value={region} onChange={(e) => setRegion(e.target.value)}>{regions.map((r) => <option key={r} value={r}>{r}</option>)}</select>}
          {radio('branch', 'A branch')}
          {kind === 'branch' && <select aria-label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)}>{s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
          {radio('group', 'A group')}
          {kind === 'group' && (groups.loading && !groups.data ? <Spinner /> : groups.data && groups.data.length > 0
            ? <select aria-label="Group" value={group} onChange={(e) => setGroup(e.target.value)}>{groups.data.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
            : <Empty>No groups yet. Create one on the Groups page.</Empty>)}
          <hr style={{ border: 0, borderTop: '1px solid var(--line)', width: '100%' }} />
          <b>Narrow it down</b>
          {kind !== 'group' && (
            <div className="chips" role="radiogroup" aria-label="Who">
              {([['all', 'Everyone'], ['adults', 'Adults only'], ['children', 'Parents and guardians of children']] as const).map(([v, t]) => (
                <button key={v} type="button" className={`chip ${who === v ? 'on' : ''}`} onClick={() => setWho(v)}>{t}</button>
              ))}
            </div>
          )}
          <div><div className="tiny" style={{ marginBottom: 6 }}>Age (pick any, or leave empty for all ages)</div>
            <div className="chips">{AGE_BANDS.map((b) => <button key={b} type="button" className={`chip ${bands.includes(b) ? 'on' : ''}`} onClick={() => toggleBand(b)}>{b}</button>)}</div></div>
          <div><div className="tiny" style={{ marginBottom: 6 }}>Sex</div>
            <div className="chips">{([['', 'Any'], ['male', 'Male'], ['female', 'Female']] as const).map(([v, t]) => <button key={v} type="button" className={`chip ${sex === v ? 'on' : ''}`} onClick={() => setSex(v)}>{t}</button>)}</div></div>
          {kind !== 'group' && who === 'children' && <div className="tiny">Children are reached through their guardians.</div>}
        </div>
      </Card>

      <Card title="2. How should it reach them?">
        <div className="stack" style={{ gap: 10 }}>
          <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="checkbox" checked disabled readOnly /> <span><b>In-app</b> <span className="tiny">Always included, free</span></span></label>
          <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} /> <span><b>SMS</b> <span className="tiny">KES 1.00 per 160-character part, per person</span></span></label>
          <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="checkbox" checked={wa} onChange={(e) => setWa(e.target.checked)} /> <span><b>WhatsApp</b> <span className="tiny">KES 3.00 per person, only to people who agreed</span></span></label>
        </div>
      </Card>

      <Card title="3. What do you want to say?">
        <div className="stack">
          <Field label="Title" hint="Shown as the heading in the app"><input style={{ width: '100%' }} maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Message">
            <textarea ref={bodyRef} rows={5} style={{ width: '100%' }} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          <div className="row between">
            <Button small kind="ghost" onClick={insertName}>Insert first name</Button>
            <span className="tiny">{bodyLen} of 1,000 characters</span>
          </div>
          {sms && bodyLen > 0 && <div className="tiny">This will be sent as {plural(smsParts, 'part', 'parts')} by SMS.</div>}
        </div>
      </Card>

      <Card title="4. When?">
        <div className="stack" style={{ gap: 10 }}>
          <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} /> <b>Send now</b></label>
          <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="radio" name="when" checked={when === 'later'} onChange={() => setWhen('later')} /> <b>Schedule for later</b></label>
          {when === 'later' && <Field label="Date and time" hint="East Africa Time. You can cancel until it goes out."><input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>}
        </div>
      </Card>

      <Card title="This message">
        <div className="stack" style={{ gap: 8 }}>
          {estErr && <ErrorNote>{estErr}</ErrorNote>}
          {!estErr && !est && (estBusy || !full) && <Spinner />}
          {est && (
            <div style={{ opacity: stale || estBusy ? 0.6 : 1 }} className="stack">
              <div><b>{est.people === 0 ? 'No one matches this audience yet.' : `This will reach ${plural(est.people, 'person', 'people')}`}</b></div>
              <div>In-app: {est.inApp.reachable.toLocaleString()} will see it in the app{est.inApp.noAccount > 0 && ` (${est.inApp.noAccount.toLocaleString()} have no app account)`}.</div>
              {est.sms && <div>SMS: {est.sms.eligible.toLocaleString()} will get an SMS{(est.sms.optedOut > 0 || est.sms.noPhone > 0) && ` (${join([est.sms.optedOut > 0 && `${est.sms.optedOut} chose not to`, est.sms.noPhone > 0 && `${est.sms.noPhone} have no phone`])})`}.</div>}
              {est.whatsapp && <div>WhatsApp: {est.whatsapp.eligible.toLocaleString()} will get a WhatsApp message{(est.whatsapp.notOptedIn > 0 || est.whatsapp.noPhone > 0) && ` (${join([est.whatsapp.notOptedIn > 0 && `${est.whatsapp.notOptedIn} have not agreed to WhatsApp`, est.whatsapp.noPhone > 0 && `${est.whatsapp.noPhone} have no phone`])})`}.</div>}
              <div><b>About {kes(est.totalCost)}</b></div>
              {(est.wallets ?? []).filter((w: any) => w.short > 0).map((w: any) => (
                <Note key={`${w.walletId}:${w.channel}`} tone="warn">The {w.label} wallet can only cover {w.affordable.toLocaleString()} of {w.recipients.toLocaleString()} messages. The rest will get the message in the app only.</Note>
              ))}
            </div>
          )}
          {err && <ErrorNote>{err}</ErrorNote>}
          <div className="row"><Button disabled={!est || est.people === 0} onClick={review}>Review and send</Button><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
        </div>
      </Card>
    </div>
  );
}

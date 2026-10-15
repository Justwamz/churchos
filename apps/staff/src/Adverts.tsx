import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, Field, Note, kes, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load, PageHead } from './bits';
import { Modal } from './MemberForm';
import { ItemThumb } from './ShopItems';
import './adverts.css';

const STATE: Record<string, { text: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'muted' }> = {
  live: { text: 'Live', tone: 'good' }, scheduled: { text: 'Scheduled', tone: 'info' }, expired: { text: 'Finished', tone: 'muted' },
  draft: { text: 'Draft', tone: 'muted' }, pending: { text: 'Waiting for approval', tone: 'warn' }, awaiting_payment: { text: 'Waiting for payment', tone: 'warn' },
  approved: { text: 'Approved', tone: 'good' }, paused: { text: 'Paused', tone: 'warn' }, ended: { text: 'Ended', tone: 'muted' },
  rejected: { text: 'Not approved', tone: 'bad' }, taken_down: { text: 'Taken down', tone: 'bad' },
};

const ERR: Record<string, string> = {
  not_found: 'That shop item was not found. Choose another one.',
  inactive: 'That item is switched off in the shop. Choose another item, or switch it on first.',
  bad_number: 'Choose a quantity from 1 to 10.',
  no_tickets: 'That event does not sell tickets yet. Set up its tickets first.',
  event_over: 'That event is over or cancelled, so it cannot sell tickets. Choose another event.',
  bad_action: 'Choose where the advert should lead when someone taps it.',
  same_person: 'Someone else must approve this advert, because you created or sent it. Ask a colleague to approve it.',
};
const explain = (e: any) => ERR[e?.code] ?? friendly(e?.message);

const MAX_BYTES = 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const toIso = (v: string) => new Date(`${v}:00+03:00`).toISOString();
const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 16) : '');

type Art = { mime: string; data: string; preview: string };

/** Checks the picture in the browser first. The server checks again and its message is shown if it disagrees. */
function readArtwork(file: File): Promise<Art> {
  return new Promise((resolve, reject) => {
    if (!TYPES.includes(file.type)) return reject(new Error('Use a PNG, JPG or WebP picture.'));
    if (file.size > MAX_BYTES) return reject(new Error('This picture is larger than 1 MB. Make the file smaller and try again.'));
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('We could not read that file.'));
    fr.onload = () => {
      const url = String(fr.result);
      const img = new Image();
      img.onerror = () => reject(new Error('We could not open that picture.'));
      img.onload = () => {
        if (img.naturalWidth < 800) return reject(new Error(`This picture is ${img.naturalWidth} pixels wide. It needs to be at least 800, and 1280 x 720 or more is best.`));
        const ratio = img.naturalWidth / img.naturalHeight;
        if (Math.abs(ratio / (16 / 9) - 1) > 0.03) return reject(new Error(`This picture is ${img.naturalWidth} x ${img.naturalHeight}. It must be widescreen 16:9, for example 1280 x 720.`));
        resolve({ mime: file.type, data: url.slice(url.indexOf(',') + 1), preview: url });
      };
      img.src = url;
    };
    fr.readAsDataURL(file);
  });
}

function Preview({ src, title, body }: { src?: string; title: string; body: string }) {
  return (
    <div className="adv-preview" style={src ? { backgroundImage: `url("${src}")` } : undefined} aria-label="Preview of the advert on the member app">
      {!src && <div className="adv-empty">Your artwork will show here</div>}
      <div className="adv-over"><b>{title || 'Your headline'}</b><span>{body || 'A short line of text'}</span></div>
    </div>
  );
}

// ---------- create and edit ----------

function AdvertForm({ advert, onClose, onSaved }: { advert?: any; onClose: () => void; onSaved: (msg: string) => void }) {
  const s = useSession();
  const groups = useAsync<any[]>(() => api.get('/groups' + s.qs({ branch: undefined })), [s.qs()]);
  const [title, setTitle] = useState<string>(advert?.title ?? '');
  const [body, setBody] = useState<string>(advert?.body ?? '');
  const [link, setLink] = useState<string>(advert?.link ?? '');
  const [art, setArt] = useState<Art | null>(null);
  const [artErr, setArtErr] = useState('');
  const [over, setOver] = useState(false);
  const [kind, setKind] = useState<'org' | 'branch' | 'group'>(advert?.audience?.type ?? 'org');
  const [branch, setBranch] = useState<string>(advert?.audience?.type === 'branch' ? advert.audience.id : s.branches[0]?.id ?? '');
  const [group, setGroup] = useState<string>(advert?.audience?.type === 'group' ? advert.audience.id : '');
  const [period, setPeriod] = useState<'open' | 'dates'>(advert?.endsAt ? 'dates' : 'open');
  const [start, setStart] = useState(toLocal(advert?.startsAt ?? null));
  const [end, setEnd] = useState(toLocal(advert?.endsAt ?? null));
  const [paid, setPaid] = useState(!!advert?.advertiser);
  const [advName, setAdvName] = useState<string>(advert?.advertiser?.name ?? '');
  const [advContact, setAdvContact] = useState<string>(advert?.advertiser?.contact ?? '');
  const [advPrice, setAdvPrice] = useState<string>(advert?.advertiser?.price != null ? String(advert.advertiser.price / 100) : '');
  const [act, setAct] = useState<'details' | 'shop' | 'item' | 'checkout' | 'event'>(advert?.action?.kind ?? 'details');
  const [eventId, setEventId] = useState<string>(advert?.action?.eventId ?? '');
  const events = useAsync<any[]>(() => api.get('/events' + s.qs({ branch: undefined })), [s.grant.org.id]);
  const [itemId, setItemId] = useState<string>(advert?.action?.itemId ?? '');
  const [qty, setQty] = useState<number>(advert?.action?.qty ?? 1);
  const shopItems = useAsync<any[]>(() => api.get('/shop/items' + s.qs({ branch: kind === 'branch' ? branch : undefined })), [kind === 'branch' ? branch : '', s.grant.org.id]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => { if (kind === 'group' && !group && groups.data?.length) setGroup(groups.data[0].id); }, [kind, group, groups.data]);

  const pick = async (f?: File | null) => {
    if (!f) return;
    setArtErr('');
    try { setArt(await readArtwork(f)); } catch (e: any) { setArtErr(e.message); }
  };

  const editingLive = !!advert && !['draft', 'rejected'].includes(advert.status);
  const preview = art?.preview ?? (advert ? api.url(advert.imageUrl) : undefined);

  const save = async () => {
    setErr('');
    if (!title.trim()) return setErr('Write a headline.');
    if (!advert && !art) return setErr('Add the artwork.');
    if (kind === 'group' && !group) return setErr('Choose a group.');
    if (period === 'dates' && (!start || !end)) return setErr('Choose when it starts and when it ends.');
    if (period === 'dates' && Date.parse(`${end}:00+03:00`) <= Date.parse(`${start}:00+03:00`)) return setErr('The end must be after the start.');
    if (act === 'event' && !eventId) return setErr('Choose the event.');
    if ((act === 'item' || act === 'checkout') && !itemId) return setErr('Choose the shop item.');
    if (paid && (!advName.trim() || !(Number(advPrice) > 0))) return setErr('Add the advertiser name and the price they will pay.');
    const audience = kind === 'org' ? { type: 'org' } : kind === 'branch' ? { type: 'branch', id: branch } : { type: 'group', id: group };
    const payload: any = {
      title: title.trim(), body: body.trim(), link: act === 'details' ? link.trim() : '', audience,
      action: act === 'details' ? null : act === 'shop' ? { kind: 'shop' } : act === 'item' ? { kind: 'item', itemId } : act === 'event' ? { kind: 'event', eventId } : { kind: 'checkout', itemId, qty },
      ...(art ? { image: { mime: art.mime, data: art.data } } : {}),
      ...(period === 'dates' ? { startsAt: toIso(start), endsAt: toIso(end) } : advert ? { endsAt: null } : {}),
    };
    if (paid) payload.advertiser = { name: advName.trim(), contact: advContact.trim(), price: Number(advPrice) };
    else if (advert) payload.advertiser = {};
    setBusy(true);
    try {
      if (advert) await api.put(`/adverts/${advert.id}` + s.qs({ branch: undefined }), payload);
      else await api.post('/adverts' + s.qs({ branch: undefined }), payload);
      onSaved(editingLive ? 'Saved. It is offline until someone approves it again.' : advert ? 'Changes saved' : 'Advert saved as a draft. Send it for approval when it is ready.');
    } catch (e: any) { setErr(explain(e)); setBusy(false); }
  };

  const radio = (k: typeof kind, text: string) => (
    <label key={k} className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="radio" name="adaud" checked={kind === k} onChange={() => setKind(k)} /> <b>{text}</b></label>
  );

  return (
    <div className="stack">
      <div className="row between"><h2 style={{ margin: 0 }}>{advert ? 'Edit advert' : 'New advert'}</h2><Button kind="ghost" small onClick={onClose}>Cancel</Button></div>
      {editingLive && <Note tone="warn">Changing a live advert takes it offline until someone approves it again.</Note>}

      <Card title="1. Artwork and words">
        <div className="stack">
          <Preview src={preview} title={title} body={body} />
          <div
            className={`adv-drop ${over ? 'over' : ''}`} role="button" tabIndex={0}
            onClick={() => file.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.current?.click(); } }}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}>
            Drop artwork here. Widescreen 16:9, at least 1280 x 720, PNG, JPG or WebP, up to 1 MB
            <div className="tiny">{art ? 'Picture added. Drop another to replace it.' : advert ? 'Drop a new picture only if you want to change it.' : 'Or click to choose a file.'}</div>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          </div>
          {artErr && <ErrorNote>{artErr}</ErrorNote>}
          <Field label="Headline" hint={`${title.length} of 60 characters`}><input maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Text" hint={`Optional. ${body.length} of 160 characters`}><textarea rows={3} maxLength={160} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
        </div>
      </Card>

      <Card title="2. When someone taps it">
        <div className="stack" style={{ gap: 10 }}>
          {([['details', 'Show the details (and an optional link)'], ['shop', 'Open the shop'], ['item', 'Show one shop item'], ['checkout', 'Go straight to checkout with an item'], ['event', 'Sell tickets for an event']] as const).map(([k, t]) => (
            <label key={k} className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="radio" name="adact" checked={act === k} onChange={() => setAct(k)} /> <b>{t}</b></label>
          ))}
          {act === 'details' && <Field label="Link" hint="Optional. Where people go from the details. Must start with http:// or https://"><input inputMode="url" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} /></Field>}
          {act === 'event' && (
            <Load loading={events.loading} error={events.error} hasData={!!events.data}>
              {events.data && (() => {
                const list = events.data.filter((e) => e.ticketed || e.id === eventId);
                return list.length === 0 ? <Empty>No event sells tickets yet. Set up tickets on an event under Events.</Empty> : (
                  <Field label="Event" hint="Only upcoming events that sell tickets are listed.">
                    <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
                      <option value="">Choose an event</option>
                      {list.map((e) => <option key={e.id} value={e.id}>{e.title} ({shortDate(e.startsAt)})</option>)}
                    </select>
                  </Field>
                );
              })()}
            </Load>
          )}
          {(act === 'item' || act === 'checkout') && (
            <>
              {act === 'checkout' && <Note>The member lands on a checkout with this item already in the basket. Orders are traced back to the advert.</Note>}
              <Load loading={shopItems.loading} error={shopItems.error} hasData={!!shopItems.data}>
                {shopItems.data && (() => {
                  const list = shopItems.data.filter((i) => i.active || i.id === itemId);
                  return list.length === 0 ? <Empty>No shop items yet. Add some under Shop, Items and stock.</Empty> : (
                    <div className="sp-item-pick" role="radiogroup" aria-label="Shop item">
                      {list.map((i) => (
                        <label key={i.id} className={itemId === i.id ? 'on' : ''}>
                          <input type="radio" name="aditem" checked={itemId === i.id} onChange={() => setItemId(i.id)} />
                          <ItemThumb item={i} size={36} />
                          <span style={{ minWidth: 0, flex: 1 }}><b>{i.name}</b>{!i.active && <span className="tiny"> (switched off)</span>}<span className="tiny" style={{ display: 'block' }}>{kes(i.price)} · {i.out ? 'Out of stock' : `${i.stock} in stock`}</span></span>
                        </label>
                      ))}
                    </div>
                  );
                })()}
              </Load>
              {itemId && shopItems.data?.find((i) => i.id === itemId)?.out && <Note tone="warn">This item is out of stock. Members will see it as sold out until you receive more.</Note>}
            </>
          )}
          {act === 'checkout' && (
            <div className="row" style={{ alignItems: 'center' }}>
              <span className="field-label" style={{ margin: 0 }}>How many in the basket</span>
              <div className="sp-step">
                <button type="button" aria-label="One less" disabled={qty <= 1} onClick={() => setQty(qty - 1)}>-</button>
                <span>{qty}</span>
                <button type="button" aria-label="One more" disabled={qty >= 10} onClick={() => setQty(qty + 1)}>+</button>
              </div>
            </div>
          )}
          {advert && <div className="tiny">If this advert is live, changing where it leads takes it offline until someone approves it again.</div>}
        </div>
      </Card>

      <Card title="3. Who should see it?">
        <div className="stack" style={{ gap: 10 }}>
          {radio('org', 'Whole church')}
          {radio('branch', 'A branch')}
          {kind === 'branch' && <select aria-label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)}>{s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
          {radio('group', 'A group')}
          {kind === 'group' && (groups.data && groups.data.length > 0
            ? <select aria-label="Group" value={group} onChange={(e) => setGroup(e.target.value)}>{groups.data.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
            : <Empty>No groups yet. Create one on the Groups page.</Empty>)}
        </div>
      </Card>

      <Card title="4. For how long?">
        <div className="stack" style={{ gap: 10 }}>
          <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="radio" name="adper" checked={period === 'open'} onChange={() => setPeriod('open')} /> <b>Run until I stop it</b></label>
          <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="radio" name="adper" checked={period === 'dates'} onChange={() => setPeriod('dates')} /> <b>Choose dates</b></label>
          {period === 'dates' && (
            <div className="grid cols-2">
              <Field label="Starts" hint="East Africa Time"><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
              <Field label="Ends" hint="East Africa Time"><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
            </div>
          )}
        </div>
      </Card>

      <Card title="5. Is someone paying for it?">
        <div className="stack">
          <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> <b>This is a paid advert from someone else</b></label>
          {paid && (
            <>
              <Note>They pay through a link we give you. The advert goes live when they pay. The normal platform fee applies.</Note>
              <div className="grid cols-2">
                <Field label="Advertiser name"><input maxLength={80} value={advName} onChange={(e) => setAdvName(e.target.value)} /></Field>
                <Field label="How to reach them" hint="Phone or email"><input maxLength={120} value={advContact} onChange={(e) => setAdvContact(e.target.value)} /></Field>
              </div>
              <Field label="Price they pay (KES)" hint="Between KES 10 and KES 150,000"><input inputMode="decimal" value={advPrice} onChange={(e) => setAdvPrice(e.target.value)} /></Field>
            </>
          )}
        </div>
      </Card>

      {err && <ErrorNote>{err}</ErrorNote>}
      <div className="row"><Button disabled={busy} onClick={save}>{busy ? 'Saving...' : advert ? 'Save changes' : 'Save advert'}</Button><Button kind="ghost" disabled={busy} onClick={onClose}>Cancel</Button></div>
    </div>
  );
}

// ---------- the list ----------

function Decide({ advert, onClose, onDone }: { advert: any; onClose: () => void; onDone: (msg: string) => void }) {
  const [reason, setReason] = useState('');
  const [no, setNo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async (approve: boolean) => {
    setBusy(true); setErr('');
    try {
      const r: any = await api.post(`/adverts/${advert.id}/decide`, { approve, reason: approve ? undefined : reason });
      onDone(!approve ? 'Sent back with your reason' : r.status === 'awaiting_payment' ? 'Approved. It goes live when the advertiser pays.' : 'Approved');
    } catch (e: any) { setErr(explain(e)); setBusy(false); }
  };
  return (
    <Modal title="Approve this advert?" onClose={onClose}>
      <div className="stack">
        <Preview src={api.url(advert.imageUrl)} title={advert.title} body={advert.body ?? ''} />
        <div className="tiny">Shown to: {advert.audienceLabel}. {advert.advertiser ? `Paid advert from ${advert.advertiser.name}.` : ''}</div>
        {no && <Field label="Why is it not approved?" hint="The person who made it will see this."><textarea rows={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row">
          {!no ? (
            <>
              <Button disabled={busy} onClick={() => go(true)}>{busy ? 'Saving...' : 'Approve'}</Button>
              <Button kind="ghost" disabled={busy} onClick={() => setNo(true)}>Not approved</Button>
            </>
          ) : (
            <>
              <Button kind="danger" disabled={busy || !reason.trim()} onClick={() => go(false)}>{busy ? 'Saving...' : 'Send back'}</Button>
              <Button kind="ghost" disabled={busy} onClick={() => setNo(false)}>Back</Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function AdvertCard({ a, canManage, onEdit, onDecide, reload, toast }: { a: any; canManage: boolean; onEdit: () => void; onDecide: () => void; reload: () => void; toast: (t: string, tone?: 'good' | 'bad') => void }) {
  const [busy, setBusy] = useState(false);
  const st = STATE[a.state] ?? { text: a.state, tone: 'muted' as const };
  const act = async (verb: string, done: string) => {
    setBusy(true);
    try { await api.post(`/adverts/${a.id}/${verb}`); toast(done); reload(); } catch (e: any) { toast(explain(e), 'bad'); }
    setBusy(false);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(a.payUrl); toast('Payment link copied'); } catch { toast('Could not copy. Select the link and copy it.', 'bad'); }
  };
  const finished = a.status === 'ended' || a.status === 'taken_down';
  const when = a.endsAt ? `${shortDate(a.startsAt)} to ${shortDate(a.endsAt)}` : `From ${shortDate(a.startsAt)}, until stopped`;
  return (
    <section className="card adv-item">
      <div className="adv-thumb" style={{ backgroundImage: `url("${api.url(a.imageUrl)}")` }} role="img" aria-label={`Artwork for ${a.title}`} />
      <div className="stack" style={{ gap: 8, minWidth: 0 }}>
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}><b style={{ overflowWrap: 'anywhere' }}>{a.title}</b>{a.body && <div className="muted" style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{a.body}</div>}</div>
          <Badge tone={st.tone}>{st.text}</Badge>
        </div>
        <div className="tiny">Shown to: {a.audienceLabel}. {when}.{a.advertiser && <> Paid advert from {a.advertiser.name}{a.advertiser.price != null && <> for {kes(a.advertiser.price)}</>}.</>}</div>
        <div className="adv-stats"><span><b>{a.stats.views.toLocaleString()}</b> views</span><span><b>{a.stats.taps.toLocaleString()}</b> taps</span><span><b>{a.stats.viewers.toLocaleString()}</b> people</span></div>
        {a.actionText && <div className="tiny">When tapped: {a.actionText}.</div>}
        {a.stats.orders > 0 && <div className="adv-stats"><span><b>{a.stats.orders.toLocaleString()}</b> {a.stats.orders === 1 ? 'order' : 'orders'}, {kes(a.stats.orderTotal)}</span></div>}
        {a.status === 'rejected' && a.reason && <Note tone="warn">Not approved: {a.reason}</Note>}
        {a.status === 'taken_down' && <Note tone="warn">ChurchOS took this advert down{a.reason ? `: ${a.reason}` : '.'}</Note>}
        {a.status === 'pending' && !a.canApprove && <div className="tiny">Waiting for someone else to approve it.</div>}
        {a.status === 'awaiting_payment' && a.payUrl && (
          <Note>Waiting for {a.advertiser?.name ?? 'the advertiser'} to pay. Send them this link: <span style={{ overflowWrap: 'anywhere' }}><b>{a.payUrl}</b></span>{a.payCode && <> (reference {a.payCode})</>}</Note>
        )}
        <div className="row">
          {a.canApprove && <Button small onClick={onDecide}>Review and approve</Button>}
          {canManage && (a.status === 'draft' || a.status === 'rejected') && <Button small disabled={busy} onClick={() => act('submit', 'Sent for approval')}>Send for approval</Button>}
          {canManage && !finished && <Button small kind="ghost" disabled={busy} onClick={onEdit}>Edit</Button>}
          {canManage && a.status === 'approved' && <Button small kind="ghost" disabled={busy} onClick={() => act('pause', 'Paused')}>Pause</Button>}
          {canManage && a.status === 'paused' && <Button small kind="ghost" disabled={busy} onClick={() => act('resume', 'Resumed')}>Resume</Button>}
          {a.status === 'awaiting_payment' && a.payUrl && <Button small kind="ghost" onClick={copy}>Copy payment link</Button>}
          {canManage && ['approved', 'paused', 'awaiting_payment', 'pending'].includes(a.status) && <Button small kind="ghost" disabled={busy} onClick={() => { if (window.confirm('End this advert? It will stop showing and cannot be started again.')) act('end', 'Ended'); }}>End</Button>}
        </div>
      </div>
    </section>
  );
}

export function Adverts() {
  const s = useSession();
  const toast = useToast();
  const list = useAsync<any[]>(() => api.get('/adverts' + s.qs({ branch: undefined })), [s.grant.org.id]);
  const [mode, setMode] = useState<'list' | 'form'>('list');
  const [editing, setEditing] = useState<any>(null);
  const [deciding, setDeciding] = useState<any>(null);
  const [tab, setTab] = useState<'all' | 'mine'>('all');
  const canManage = s.can('adverts.manage');
  const rows = list.data ?? [];
  const waiting = rows.filter((a) => a.canApprove);
  const shown = tab === 'mine' ? waiting : rows;

  if (mode === 'form') {
    return (
      <div>
        <PageHead title="Adverts" />
        <AdvertForm advert={editing} onClose={() => setMode('list')} onSaved={(m) => { setMode('list'); toast.show(m); list.reload(); }} />
        {toast.node}
      </div>
    );
  }

  return (
    <div>
      <PageHead title="Adverts" sub="Pictures with a short message that show at the top of the member app." action={canManage ? <Button onClick={() => { setEditing(null); setMode('form'); }}>New advert</Button> : undefined} />
      <div className="stack">
        <Note>Someone else must approve every advert before it goes live, so you cannot approve one you created or sent yourself.</Note>
        {s.can('adverts.approve') && (
          <div className="chips" role="tablist">
            <button type="button" className={`chip ${tab === 'all' ? 'on' : ''}`} onClick={() => setTab('all')}>All adverts</button>
            <button type="button" className={`chip ${tab === 'mine' ? 'on' : ''}`} onClick={() => setTab('mine')}>Needs my approval{waiting.length > 0 ? ` (${waiting.length})` : ''}</button>
          </div>
        )}
        <Load loading={list.loading} error={list.error} hasData={!!list.data}>
          {list.data && (shown.length === 0
            ? <Empty>{tab === 'mine' ? 'Nothing is waiting for your approval.' : `No adverts yet.${canManage ? ' Create your first one.' : ''}`}</Empty>
            : <div>{shown.map((a) => <AdvertCard key={a.id} a={a} canManage={canManage} reload={list.reload} toast={toast.show} onEdit={() => { setEditing(a); setMode('form'); }} onDecide={() => setDeciding(a)} />)}</div>)}
        </Load>
      </div>
      {deciding && <Decide advert={deciding} onClose={() => setDeciding(null)} onDone={(m) => { setDeciding(null); toast.show(m); list.reload(); }} />}
      {toast.node}
    </div>
  );
}

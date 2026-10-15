import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, Field, Note, kes, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load, PageHead } from './bits';
import { Modal } from './MemberForm';
import { toIso } from './communityBits';
import './bookings.css';

export const eat = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', hour12: false, ...o });

const DAYS: [string, string][] = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
type Range = [string, string];
type DayState = { open: boolean; ranges: Range[] };
type HoursState = Record<string, DayState>;

const initialHours = (h?: Record<string, Range[]>): HoursState => {
  const out: HoursState = {};
  for (const [k] of DAYS) { const r = h?.[k]; out[k] = r && r.length ? { open: true, ranges: r.map((x) => [x[0], x[1]] as Range) } : { open: false, ranges: [['09:00', '17:00']] }; }
  return out;
};

function HoursEditor({ value, onChange }: { value: HoursState; onChange: (v: HoursState) => void }) {
  const set = (k: string, d: DayState) => onChange({ ...value, [k]: d });
  const copy = () => { const m = value.mon; const next = { ...value }; for (const k of ['tue', 'wed', 'thu', 'fri']) next[k] = { open: m.open, ranges: m.ranges.map((r) => [r[0], r[1]] as Range) }; onChange(next); };
  return (
    <div className="bk-hours">
      <div><Button small kind="ghost" onClick={copy}>Copy Monday to weekdays</Button></div>
      {DAYS.map(([k, name]) => {
        const d = value[k];
        const setRange = (i: number, j: 0 | 1, v: string) => set(k, { ...d, ranges: d.ranges.map((r, x) => (x === i ? (j === 0 ? [v, r[1]] : [r[0], v]) : r) as Range) });
        return (
          <div className="bk-day" key={k}>
            <b>{name}</b>
            <label className="row" style={{ gap: 6, flexWrap: 'nowrap' }}><input type="checkbox" checked={d.open} onChange={(e) => set(k, { ...d, open: e.target.checked })} /> Open</label>
            {d.open ? (
              <div className="bk-ranges">
                {d.ranges.map((r, i) => (
                  <div className="bk-range" key={i}>
                    <input type="time" aria-label={`${name} from`} value={r[0]} onChange={(e) => setRange(i, 0, e.target.value)} />
                    <span className="tiny">to</span>
                    <input type="time" aria-label={`${name} to`} value={r[1]} onChange={(e) => setRange(i, 1, e.target.value)} />
                    {i > 0 && <Button small kind="ghost" onClick={() => set(k, { ...d, ranges: d.ranges.filter((_, x) => x !== i) })}>Remove</Button>}
                  </div>
                ))}
                {d.ranges.length < 3 && <div><Button small kind="ghost" onClick={() => set(k, { ...d, ranges: [...d.ranges, ['14:00', '17:00']] })}>Add a break</Button></div>}
              </div>
            ) : <span className="tiny">Closed</span>}
          </div>
        );
      })}
    </div>
  );
}

const KINDS: Record<string, string> = { person: 'A person', place: 'A place', thing: 'A thing' };

function ResourceForm({ res, onClose, onSaved }: { res?: any; onClose: () => void; onSaved: (m: string) => void }) {
  const s = useSession();
  const owners = useAsync<any[]>(() => (s.can('resources.manage') ? api.get('/resources/owners' + s.qs({ branch: undefined })) : Promise.resolve([])), [s.grant.org.id]);
  const [kind, setKind] = useState<string>(res?.kind ?? 'place');
  const [name, setName] = useState<string>(res?.name ?? '');
  const [desc, setDesc] = useState<string>(res?.description ?? '');
  const [branch, setBranch] = useState<string>(res ? res.branchId ?? '' : s.scope !== 'all' ? s.scope : s.branches[0]?.id ?? '');
  const [cap, setCap] = useState<string>(res?.capacity != null ? String(res.capacity) : '');
  const [owner, setOwner] = useState<string>(res?.ownerUserId ?? '');
  const [slot, setSlot] = useState<number>(res?.slotMinutes ?? 60);
  const [max, setMax] = useState<string>(res?.maxMinutes != null ? String(res.maxMinutes) : '');
  const [hours, setHours] = useState<HoursState>(initialHours(res?.hours));
  const [notice, setNotice] = useState<string>(String(res?.minNoticeHours ?? 24));
  const [ahead, setAhead] = useState<string>(String(res?.maxAdvanceDays ?? 90));
  const [approval, setApproval] = useState<string>(res?.approval ?? 'manual');
  const [price, setPrice] = useState<string>(res?.price != null ? String(res.price / 100) : '');
  const [per, setPer] = useState<string>(res?.pricePer ?? 'booking');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const maxOptions: number[] = [];
  for (let m = slot; m <= 480; m += slot) maxOptions.push(m);
  const mins = (m: number) => (m % 60 === 0 ? `${m / 60} ${m === 60 ? 'hour' : 'hours'}` : m > 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} minutes`);

  const save = async () => {
    setErr('');
    if (!name.trim()) return setErr('Write a name.');
    const h: Record<string, Range[]> = {};
    for (const [k, nm] of DAYS) {
      const d = hours[k];
      if (!d.open) continue;
      for (const r of d.ranges) if (!r[0] || !r[1] || r[0] >= r[1]) return setErr(`Check the times for ${nm}. Each "from" must be before its "to".`);
      h[k] = d.ranges;
    }
    if (Object.keys(h).length === 0) return setErr('Choose at least one day when it can be booked.');
    if (price.trim() && !(Number(price) > 0)) return setErr('Enter the price as a number, or leave it empty for free.');
    const payload = {
      kind, name: name.trim(), description: desc.trim(), branchId: branch || null, capacity: cap.trim() ? Math.floor(Number(cap)) : null,
      ownerUserId: kind === 'person' && owner ? owner : null, slotMinutes: slot, maxMinutes: max ? Number(max) : null, hours: h,
      minNoticeHours: Math.max(0, Math.floor(Number(notice) || 0)), maxAdvanceDays: Math.max(1, Math.floor(Number(ahead) || 90)),
      approval, price: price.trim() ? Number(price) : null, pricePer: per,
    };
    setBusy(true);
    try {
      if (res) await api.put(`/resources/${res.id}` + s.qs({ branch: undefined }), payload);
      else await api.post('/resources' + s.qs({ branch: undefined }), payload);
      onSaved(res ? 'Changes saved' : 'Added');
    } catch (e: any) { setErr(friendly(e?.message)); setBusy(false); }
  };

  return (
    <div className="stack">
      <div className="row between"><h2 style={{ margin: 0 }}>{res ? 'Edit' : 'Add something to book'}</h2><Button kind="ghost" small onClick={onClose}>Cancel</Button></div>
      <Card title="1. About it">
        <div className="stack">
          <Field label="What is it?">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </Field>
          <Field label="Name" hint="For example Main hall, Pastor's diary, Projector"><input maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Details" hint="Optional"><textarea rows={3} maxLength={500} value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
          <div className="grid cols-2">
            <Field label="Where does it belong?" hint="Whole church is only for people who manage every branch.">
              <select value={branch} onChange={(e) => setBranch(e.target.value)} disabled={!!res}>
                <option value="">Whole church</option>
                {s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="Capacity" hint="Optional. How many people it holds."><input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, ''))} /></Field>
          </div>
          {kind === 'person' && (
            <Field label="Whose diary is this?" hint="This person can answer requests for their own time.">
              <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">Nobody in particular</option>
                {(owners.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </Field>
          )}
        </div>
      </Card>
      <Card title="2. When can it be booked?">
        <div className="stack">
          <div className="tiny">All times are East Africa Time, 24 hour clock.</div>
          <HoursEditor value={hours} onChange={setHours} />
          <div className="grid cols-2">
            <Field label="Booking length" hint="People book in blocks of this size.">
              <select value={slot} onChange={(e) => { setSlot(Number(e.target.value)); setMax(''); }}>{[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select>
            </Field>
            <Field label="Longest booking" hint="Optional. The most one booking can last.">
              <select value={max} onChange={(e) => setMax(e.target.value)}><option value="">No limit</option>{maxOptions.map((m) => <option key={m} value={m}>{mins(m)}</option>)}</select>
            </Field>
            <Field label="Minimum notice" hint="Hours before the start that a request must be made."><input inputMode="numeric" value={notice} onChange={(e) => setNotice(e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="How far ahead" hint="Days into the future people can book."><input inputMode="numeric" value={ahead} onChange={(e) => setAhead(e.target.value.replace(/\D/g, ''))} /></Field>
          </div>
        </div>
      </Card>
      <Card title="3. Approval and price">
        <div className="stack">
          <Field label="Approval" hint="Someone must say yes, or it is approved automatically.">
            <select value={approval} onChange={(e) => setApproval(e.target.value)}><option value="manual">Someone must say yes</option><option value="auto">Approved automatically</option></select>
          </Field>
          <div className="grid cols-2">
            <Field label="Price (KES)" hint="Leave empty for free. A priced booking waits for payment after approval and holds the time for 24 hours."><input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
            <Field label="Charged"><select value={per} onChange={(e) => setPer(e.target.value)}><option value="booking">Once per booking</option><option value="hour">Per hour</option></select></Field>
          </div>
        </div>
      </Card>
      {err && <ErrorNote>{err}</ErrorNote>}
      <div className="row"><Button disabled={busy} onClick={save}>{busy ? 'Saving...' : res ? 'Save changes' : 'Add'}</Button><Button kind="ghost" disabled={busy} onClick={onClose}>Cancel</Button></div>
    </div>
  );
}

function Blocks({ res, canManage, onClose }: { res: any; canManage: boolean; onClose: () => void }) {
  const s = useSession();
  const list = useAsync<any[]>(() => api.get(`/resources/${res.id}/blocks` + s.qs({ branch: undefined })), [res.id]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fmt = (iso: string) => eat(iso, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const add = async () => {
    setErr('');
    if (!from || !to) return setErr('Choose when the block starts and ends.');
    if (Date.parse(`${to}:00+03:00`) <= Date.parse(`${from}:00+03:00`)) return setErr('The end must be after the start.');
    setBusy(true);
    try {
      await api.post(`/resources/${res.id}/blocks` + s.qs({ branch: undefined }), { startsAt: toIso(from), endsAt: toIso(to), reason: why.trim() });
      setFrom(''); setTo(''); setWhy(''); list.reload();
    } catch (e: any) { setErr(e?.code === 'has_bookings' ? 'There is already a booking at that time. Cancel it first.' : friendly(e?.message)); }
    setBusy(false);
  };
  const remove = async (id: string) => {
    try { await api.post(`/resources/${res.id}/blocks/${id}/remove` + s.qs({ branch: undefined }), {}); list.reload(); } catch (e: any) { setErr(friendly(e?.message)); }
  };
  return (
    <Modal title={`Blocked times: ${res.name}`} onClose={onClose}>
      <div className="stack">
        <div className="tiny">Block a time when this cannot be booked, for example a holiday or repairs. East Africa Time.</div>
        <Load loading={list.loading} error={list.error} hasData={!!list.data}>
          {list.data && (list.data.length === 0 ? <Empty>Nothing is blocked.</Empty> : (
            <div className="bk-blocks">
              {list.data.map((b) => (
                <div className="bk-item" key={b.id}>
                  <div style={{ minWidth: 0 }}><b>{fmt(b.starts_at)}</b> to <b>{fmt(b.ends_at)}</b>{b.reason && <div className="tiny">{b.reason}</div>}</div>
                  {canManage && <Button small kind="ghost" onClick={() => remove(b.id)}>Remove</Button>}
                </div>
              ))}
            </div>
          ))}
        </Load>
        {canManage && (
          <div className="stack">
            <b>Block a new time</b>
            <div className="grid cols-2">
              <Field label="From"><input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="To"><input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            </div>
            <Field label="Reason" hint="Optional"><input maxLength={120} value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
            <div><Button disabled={busy} onClick={add}>{busy ? 'Saving...' : 'Block this time'}</Button></div>
          </div>
        )}
        {err && <ErrorNote>{err}</ErrorNote>}
      </div>
    </Modal>
  );
}

const priceText = (r: any) => (r.price == null ? 'Free' : `${kes(r.price)} ${r.pricePer === 'hour' ? 'per hour' : 'per booking'}`);

export function Resources() {
  const s = useSession();
  const toast = useToast();
  const list = useAsync<any[]>(() => api.get('/resources' + s.qs({ branch: undefined })), [s.grant.org.id]);
  const [mode, setMode] = useState<'list' | 'form'>('list');
  const [editing, setEditing] = useState<any>(null);
  const [blocks, setBlocks] = useState<any>(null);
  const canManage = s.can('resources.manage');

  const toggle = async (r: any) => {
    try { await api.post(`/resources/${r.id}/active` + s.qs({ branch: undefined }), { active: !r.active }); toast.show(r.active ? 'Switched off' : 'Switched on'); list.reload(); }
    catch (e: any) { toast.show(friendly(e?.message)); }
  };

  if (mode === 'form') {
    return (
      <div>
        <PageHead title="Resources" />
        <ResourceForm res={editing} onClose={() => setMode('list')} onSaved={(m) => { setMode('list'); toast.show(m); list.reload(); }} />
        {toast.node}
      </div>
    );
  }
  const groups: [string, string][] = [['person', 'People'], ['place', 'Places'], ['thing', 'Things']];
  return (
    <div>
      <PageHead title="Resources" sub="The people, places and things members can ask to book." action={canManage ? <Button onClick={() => { setEditing(null); setMode('form'); }}>Add something</Button> : undefined} />
      <Load loading={list.loading} error={list.error} hasData={!!list.data}>
        {list.data && (list.data.length === 0 ? <Empty>Nothing can be booked yet.{canManage ? ' Add your first one.' : ''}</Empty> : (
          <div className="stack" style={{ gap: 24 }}>
            {groups.map(([k, title]) => {
              const rows = list.data!.filter((r) => r.kind === k);
              if (!rows.length) return null;
              return (
                <div className="stack" key={k}>
                  <h2 style={{ margin: 0 }}>{title}</h2>
                  <div className="bk-grid">
                    {rows.map((r) => (
                      <section className={`card bk-res ${r.active ? '' : 'bk-off'}`} key={r.id}>
                        <div className="row between" style={{ alignItems: 'flex-start' }}>
                          <div style={{ minWidth: 0 }}><b>{r.name}</b>{r.description && <div className="muted" style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{r.description}</div>}</div>
                          {!r.active && <Badge tone="muted">Switched off</Badge>}
                        </div>
                        <div className="bk-chips">
                          <Badge tone="info">{r.branchName ?? 'Whole church'}</Badge>
                          <Badge tone={r.price == null ? 'muted' : 'warn'}>{priceText(r)}</Badge>
                          <Badge tone={r.approval === 'auto' ? 'good' : 'muted'}>{r.approval === 'auto' ? 'Approved automatically' : 'Needs approval'}</Badge>
                          {r.capacity ? <Badge tone="muted">Holds {r.capacity}</Badge> : null}
                        </div>
                        {r.kind === 'person' && r.ownerName && <div className="tiny">Diary of {r.ownerName}</div>}
                        <div className="tiny">Booked in blocks of {r.slotMinutes} minutes.</div>
                        <div className="row">
                          {canManage && <Button small kind="ghost" onClick={() => { setEditing(r); setMode('form'); }}>Edit</Button>}
                          {canManage && <Button small kind="ghost" onClick={() => toggle(r)}>{r.active ? 'Switch off' : 'Switch on'}</Button>}
                          <Button small kind="ghost" onClick={() => setBlocks(r)}>Blocked times</Button>
                        </div>
                      </section>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </Load>
      {!canManage && <Note>You can look at what is set up. Ask someone who sets up resources to change it.</Note>}
      {blocks && <Blocks res={blocks} canManage={canManage} onClose={() => setBlocks(null)} />}
      {toast.node}
    </div>
  );
}

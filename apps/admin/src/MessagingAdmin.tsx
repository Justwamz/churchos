import { useState, type ReactNode } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, Field, Note, Spinner, Table, createApi, kes, shortDate, useAsync } from '@churchos/ui';
import './admin-extra.css';

// Same token key as the main admin app, so this is the same signed-in session.
const api = createApi('churchos:admin-token');
const num = (v: unknown) => Number(v ?? 0);
const errText = (e: any) => (e && typeof e.message === 'string' && !e.message.trim().startsWith('{') ? e.message : 'Something went wrong. Please try again.');
type Toast = (t: string, tone?: 'good' | 'bad') => void;

function Head({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {action}
    </div>
  );
}

function Load<T>({ s, children }: { s: { data?: T; error?: string; loading: boolean }; children: (d: T) => ReactNode }) {
  if (s.error) return <ErrorNote>{s.error}</ErrorNote>;
  if (s.data === undefined) return <Spinner />;
  return <>{children(s.data)}</>;
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ---------------- Tariffs ----------------

type Band = { upTo: number | null; price: number };
type Bands = { sms: Band[]; whatsapp: Band[] };
type Row = { upTo: string; price: string };
const CH: { id: 'sms' | 'whatsapp'; label: string }[] = [{ id: 'sms', label: 'SMS' }, { id: 'whatsapp', label: 'WhatsApp' }];
const money = (cents: number) => (cents / 100).toFixed(2);
const fmt = (n: number) => n.toLocaleString('en-KE');
const fromOf = (bands: Band[], i: number) => (i === 0 ? 0 : (bands[i - 1].upTo as number) + 1);

const bandsToRows = (b: Band[]): Row[] => b.map((x) => ({ upTo: x.upTo === null ? '' : String(x.upTo), price: money(x.price) }));
const blankRows = (): Row[] => [{ upTo: '', price: '' }];

/** Turns editor rows into bands, or a plain-language problem. */
function rowsToBands(rows: Row[], label: string): { bands?: Band[]; error?: string } {
  const out: Band[] = [];
  let prev = 0;
  for (let i = 0; i < rows.length; i++) {
    const last = i === rows.length - 1;
    const price = Number(rows[i].price);
    if (!rows[i].price.trim() || !Number.isFinite(price) || price <= 0) return { error: `${label}: enter a price above zero for every band.` };
    const cents = Math.round(price * 100);
    if (cents < 1) return { error: `${label}: the smallest price is KES 0.01.` };
    if (last) { out.push({ upTo: null, price: cents }); break; }
    const upTo = Number(rows[i].upTo);
    if (!rows[i].upTo.trim() || !Number.isInteger(upTo) || upTo < 1) return { error: `${label}: enter a whole number for where each band ends.` };
    if (upTo <= prev) return { error: `${label}: each band must end higher than the one before it.` };
    out.push({ upTo, price: cents });
    prev = upTo;
  }
  return { bands: out };
}

function BandEditor({ label, rows, onChange }: { label: string; rows: Row[]; onChange: (r: Row[]) => void }) {
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const startOf = (i: number) => (i === 0 ? 0 : (Number(rows[i - 1].upTo) || 0) + 1);
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="row between" style={{ marginBottom: 6 }}>
        <b>{label}</b>
        <Button kind="ghost" small onClick={() => onChange([...rows, { upTo: '', price: '' }])}>Add band</Button>
      </div>
      <table className="band-table">
        <thead><tr><th>From (auto)</th><th>Up to</th><th>Price per message (KES)</th><th /></tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const last = i === rows.length - 1;
            return (
              <tr key={i}>
                <td className="band-from">{fmt(startOf(i))}</td>
                <td>
                  {last ? <span className="band-end">and above</span>
                    : <input inputMode="numeric" value={r.upTo} aria-label={`${label} band ${i + 1} ends at`} onChange={(e) => set(i, { upTo: e.target.value.replace(/[^\d]/g, '') })} placeholder="e.g. 3500" />}
                </td>
                <td><input inputMode="decimal" value={r.price} aria-label={`${label} band ${i + 1} price`} onChange={(e) => set(i, { price: e.target.value.replace(/[^\d.]/g, '') })} onBlur={() => { const n = Number(r.price); if (r.price && Number.isFinite(n)) set(i, { price: n.toFixed(2) }); }} placeholder="0.95" /></td>
                <td>{rows.length > 1 && <Button kind="ghost" small onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</Button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 1 && <div className="tiny">One open-ended band is a flat price for every message.</div>}
    </div>
  );
}

const todayEat = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

function BandsView({ bands }: { bands: Bands }) {
  return (
    <div className="grid cols-2">
      {CH.map((c) => (
        <div key={c.id}>
          <b>{c.label}</b>
          <Table head={['Messages in the month', 'Price per message']}>
            {(bands[c.id] ?? []).map((b, i, a) => (
              <tr key={i}>
                <td>{fmt(fromOf(a, i))}{b.upTo === null ? ' and above' : ` to ${fmt(b.upTo)}`}</td>
                <td className="num">{kes(b.price)}</td>
              </tr>
            ))}
          </Table>
        </div>
      ))}
    </div>
  );
}

type Editing = { mode: 'create' } | { mode: 'change'; tariff: any };

function TariffEditor({ editing, onDone, onCancel, toast }: { editing: Editing; onDone: () => void; onCancel: () => void; toast: Toast }) {
  const cur: Bands | undefined = editing.mode === 'change' ? editing.tariff.versions.at(-1)?.bands : undefined;
  const [name, setName] = useState('');
  const [sms, setSms] = useState<Row[]>(cur ? bandsToRows(cur.sms) : blankRows());
  const [wa, setWa] = useState<Row[]>(cur ? bandsToRows(cur.whatsapp) : blankRows());
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  const save = async () => {
    setProblem(undefined);
    if (editing.mode === 'create' && name.trim().length < 2) return setProblem('Give the tariff a name of at least 2 letters.');
    const a = rowsToBands(sms, 'SMS');
    if (a.error) return setProblem(a.error);
    const b = rowsToBands(wa, 'WhatsApp');
    if (b.error) return setProblem(b.error);
    if (date && date < todayEat()) return setProblem('The date cannot be in the past.');
    const effectiveFrom = date && date > todayEat() ? `${date}T00:00:00+03:00` : undefined;
    const bands = { sms: a.bands, whatsapp: b.bands };
    setBusy(true);
    try {
      if (editing.mode === 'create') await api.post('/admin/tariffs', { name: name.trim(), bands, effectiveFrom, note: note.trim() || undefined });
      else await api.put(`/admin/tariffs/${editing.tariff.id}`, { bands, effectiveFrom, note: note.trim() || undefined });
      toast(editing.mode === 'create' ? 'Tariff created' : effectiveFrom ? 'New prices scheduled' : 'New prices saved');
      onDone();
    } catch (e: any) { setProblem(errText(e)); }
    setBusy(false);
  };

  return (
    <Card title={editing.mode === 'create' ? 'Create a tariff' : `Change prices for ${editing.tariff.name}`}>
      <p className="muted" style={{ marginTop: 0 }}>Prices are tiered by how many messages a church sends in a calendar month (East Africa Time). Each message is priced in the band it falls in, and the count starts again on the 1st.</p>
      {editing.mode === 'create' && <Field label="Tariff name"><input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Large churches" /></Field>}
      <BandEditor label="SMS" rows={sms} onChange={setSms} />
      <BandEditor label="WhatsApp" rows={wa} onChange={setWa} />
      <div className="grid cols-2">
        <Field label="Takes effect" hint="Leave empty to start now. It cannot be in the past."><input type="date" min={todayEat()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Note (optional)"><input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Volume discount for large churches" /></Field>
      </div>
      <Note>Messages already sent are never repriced.</Note>
      {problem && <div style={{ marginTop: 12 }}><ErrorNote>{problem}</ErrorNote></div>}
      <div className="row" style={{ marginTop: 14 }}>
        <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : editing.mode === 'create' ? 'Create tariff' : 'Save new prices'}</Button>
        <Button kind="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </Card>
  );
}

function Calculator({ tariffs }: { tariffs: any[] }) {
  const [tid, setTid] = useState(tariffs[0]?.id ?? '');
  const [ch, setCh] = useState<'sms' | 'whatsapp'>('sms');
  const [used, setUsed] = useState('0');
  const [count, setCount] = useState('1000');
  const [res, setRes] = useState<any>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const t = tariffs.find((x) => x.id === tid) ?? tariffs[0];
  const run = async () => {
    setErr(undefined); setRes(undefined);
    const bands = t?.current?.bands;
    if (!bands) return setErr('This tariff has no prices in force yet.');
    setBusy(true);
    try { setRes(await api.post('/admin/tariffs/quote', { bands: bands[ch], used: num(used), count: num(count) })); }
    catch (e: any) { setErr(errText(e)); }
    setBusy(false);
  };
  return (
    <Card title="Calculator">
      <div className="grid cols-4">
        <Field label="Tariff"><select value={t?.id ?? ''} onChange={(e) => setTid(e.target.value)}>{tariffs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="Channel"><select value={ch} onChange={(e) => setCh(e.target.value as any)}>{CH.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></Field>
        <Field label="Already used this month"><input inputMode="numeric" value={used} onChange={(e) => setUsed(e.target.value.replace(/[^\d]/g, ''))} /></Field>
        <Field label="Messages to send"><input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/[^\d]/g, ''))} /></Field>
      </div>
      <Button onClick={run} disabled={busy || !count}>{busy ? 'Working it out…' : 'Work it out'}</Button>
      {err && <div style={{ marginTop: 12 }}><ErrorNote>{err}</ErrorNote></div>}
      {res && (
        <div style={{ marginTop: 14 }}>
          <p><b>If a church has already used {fmt(num(used))} this month and sends {fmt(num(count))} messages, it pays {kes(res.total)} (average {kes(res.average)} each).</b></p>
          <Table head={['Messages', 'Count', 'Price each', 'Cost']}>
            {(res.breakdown ?? []).map((b: any, i: number) => (
              <tr key={i}><td>{fmt(b.from)} to {fmt(b.to)}</td><td className="num">{fmt(b.units)}</td><td className="num">{kes(b.price)}</td><td className="num">{kes(b.cost)}</td></tr>
            ))}
          </Table>
        </div>
      )}
    </Card>
  );
}

export function Tariffs({ toast }: { toast: Toast }) {
  const s = useAsync(() => api.get<any[]>('/admin/tariffs'));
  const orgs = useAsync(() => api.get<any[]>('/admin/tenants'));
  const [editing, setEditing] = useState<Editing>();
  const [showHist, setShowHist] = useState<string>();

  const makeDefault = async (id: string) => {
    try { await api.post(`/admin/tariffs/${id}/default`); toast('Default tariff changed'); s.reload(); } catch (e: any) { toast(errText(e), 'bad'); }
  };
  const assign = async (orgId: string, tariffId: string) => {
    try { await api.put(`/admin/orgs/${orgId}/tariff`, { tariffId: tariffId || null }); toast('Church tariff updated'); s.reload(); } catch (e: any) { toast(errText(e), 'bad'); }
  };
  const done = () => { setEditing(undefined); s.reload(); };

  return (
    <>
      <Head title="Tariffs" sub="What churches pay per message. Prices go down as a church sends more in a month." action={<div className="row"><Button kind="ghost" onClick={s.reload}>Refresh</Button><Button onClick={() => setEditing({ mode: 'create' })}>Create tariff</Button></div>} />
      <Load s={s}>
        {(list) => (
          <div className="tariff-list">
            {editing && <TariffEditor key={editing.mode === 'change' ? editing.tariff.id : 'new'} editing={editing} onDone={done} onCancel={() => setEditing(undefined)} toast={toast} />}
            {list.length === 0 ? <Empty>No tariffs yet.</Empty> : list.map((t) => (
              <Card key={t.id} title={<span>{t.name} {t.isDefault && <Badge tone="good">Default</Badge>}</span>}
                action={<div className="row">
                  <Button kind="ghost" small onClick={() => setEditing({ mode: 'change', tariff: t })}>Change prices</Button>
                  {!t.isDefault && <Button kind="ghost" small onClick={() => makeDefault(t.id)}>Make default</Button>}
                </div>}>
                {t.current ? <BandsView bands={t.current.bands} /> : <Empty>No prices are in force yet.</Empty>}
                <div className="tiny" style={{ marginTop: 8 }}>
                  {t.churches.length === 0 ? 'No churches use this tariff.' : `Used by ${t.churches.length} ${t.churches.length === 1 ? 'church' : 'churches'}${t.isDefault ? ' (including churches without their own tariff)' : ''}.`}
                </div>
                <div style={{ marginTop: 8 }}>
                  <Button kind="ghost" small onClick={() => setShowHist(showHist === t.id ? undefined : t.id)}>{showHist === t.id ? 'Hide history' : `Price history (${t.versions.length})`}</Button>
                  {showHist === t.id && (
                    <ul className="ver-list">
                      {[...t.versions].reverse().map((v: any) => (
                        <li key={v.version}>
                          <div className="row">
                            <b>Version {v.version}</b>
                            <span className="muted">from {shortDate(v.effectiveFrom)}</span>
                            {v.inForce && <Badge tone="good">In force</Badge>}
                            {v.scheduled && <Badge tone="warn">Scheduled</Badge>}
                          </div>
                          {v.note && <div className="tiny">{v.note}</div>}
                          <div className="tiny">
                            {CH.map((c) => `${c.label}: ${(v.bands[c.id] as Band[]).map((b, i, a) => `${fmt(fromOf(a, i))}${b.upTo === null ? '+' : `-${fmt(b.upTo)}`} at ${money(b.price)}`).join(', ')}`).join('. ')}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            ))}
            {list.length > 0 && <Calculator tariffs={list} />}
            <Card title="Which church pays which tariff">
              <p className="muted" style={{ marginTop: 0 }}>Churches use the default tariff unless you give them their own.</p>
              <Load s={orgs}>
                {(os) => os.length === 0 ? <Empty>No churches yet.</Empty> : (
                  <Table head={['Church', 'Tariff']}>
                    {os.map((o) => {
                      const mine = list.find((t) => t.churches.some((c: any) => c.id === o.id));
                      const value = mine && !mine.isDefault ? mine.id : '';
                      return (
                        <tr key={o.id}>
                          <td><b>{o.name}</b></td>
                          <td>
                            <select value={value} aria-label={`Tariff for ${o.name}`} onChange={(e) => assign(o.id, e.target.value)} style={{ maxWidth: 280 }}>
                              <option value="">Default tariff</option>
                              {list.filter((t) => !t.isDefault).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </Table>
                )}
              </Load>
            </Card>
          </div>
        )}
      </Load>
    </>
  );
}

// ---------------- Providers and sender approvals ----------------

const KIND_LABEL: Record<string, string> = { sms_sender: 'SMS sender name', whatsapp_number: 'WhatsApp number', whatsapp_display: 'WhatsApp display name' };
const PCH: Record<string, string> = { sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email' };
const SENDER_TABS: { id: string; label: string }[] = [{ id: 'pending', label: 'Pending' }, { id: 'approved', label: 'Approved' }, { id: 'rejected', label: 'Rejected' }];

export function Providers({ toast }: { toast: Toast }) {
  const prov = useAsync(() => api.get<any[]>('/admin/providers'));
  const [tab, setTab] = useState('pending');
  const reqs = useAsync(() => api.get<any[]>(`/admin/sender-requests?status=${tab}`), [tab]);
  const [rejecting, setRejecting] = useState<any>();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const decide = async (r: any, approve: boolean, why?: string) => {
    setBusy(true);
    try {
      await api.post(`/admin/sender-requests/${r.id}/decide`, { approve, reason: why });
      toast(approve ? 'Approved. The church has been told.' : 'Rejected. The church has been told why.');
      setRejecting(undefined); setReason('');
    } catch (e: any) {
      if (e?.status === 409) { toast('Someone already decided this request.', 'bad'); setRejecting(undefined); setReason(''); }
      else toast(errText(e), 'bad');
    }
    setBusy(false);
    reqs.reload();
  };

  return (
    <>
      <Head title="Providers" sub="Who sends the messages, and which sender names and numbers churches may use." action={<Button kind="ghost" onClick={() => { prov.reload(); reqs.reload(); }}>Refresh</Button>} />
      <Note>Provider accounts and credentials belong to ChurchOS. Churches never see them. In this local build the providers are simulated.</Note>
      <div style={{ height: 16 }} />
      <Card title="Provider accounts">
        <Load s={prov}>
          {(rows) => (
            <Table head={['Channel', 'Provider', 'Status', 'Mode', 'Credentials', 'Sent since start']}>
              {rows.map((p) => (
                <tr key={p.channel}>
                  <td><b>{PCH[p.channel] ?? p.channel}</b></td>
                  <td>{p.name}</td>
                  <td><Badge tone={p.status === 'connected' ? 'good' : 'bad'}>{p.status === 'connected' ? 'Connected' : String(p.status)}</Badge></td>
                  <td>{p.mode === 'development' ? 'Simulated' : p.mode}</td>
                  <td>{Object.entries(p.credentials ?? {}).map(([k, v]) => <div key={k} className="tiny"><code>{k}</code>: {String(v)}</div>)}</td>
                  <td className="num">{num(p.sentSinceStart).toLocaleString()}</td>
                </tr>
              ))}
            </Table>
          )}
        </Load>
      </Card>
      <div style={{ height: 16 }} />
      <Card title="Sender approvals" action={<div className="chips">{SENDER_TABS.map((t) => <button key={t.id} className={`chip ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>}>
        <Load s={reqs}>
          {(rows) => rows.length === 0 ? <Empty>{tab === 'pending' ? 'Nothing is waiting for approval.' : `No ${tab} requests.`}</Empty> : (
            <Table head={['Church', 'Branch', 'What', 'Requested value', 'Asked by', 'When', tab === 'pending' ? '' : 'Status']}>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.org_name}</b></td>
                  <td>{r.branch_name ?? 'Whole church'}</td>
                  <td>{KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td><code>{r.value}</code></td>
                  <td>{r.requested_by_name ?? 'Unknown'}</td>
                  <td>{shortDate(r.created_at)}</td>
                  <td>
                    {r.status === 'pending' ? (
                      <div className="row">
                        <Button small disabled={busy} onClick={() => decide(r, true)}>Approve</Button>
                        <Button small kind="ghost" disabled={busy} onClick={() => { setRejecting(r); setReason(''); }}>Reject</Button>
                      </div>
                    ) : (
                      <>
                        <Badge tone={r.status === 'approved' ? 'good' : 'bad'}>{r.status === 'approved' ? 'Approved' : 'Rejected'}</Badge>
                        {r.reason && <div className="tiny">{r.reason}</div>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Load>
      </Card>
      {rejecting && (
        <Dialog title="Reject this request" onClose={() => setRejecting(undefined)}>
          <p className="muted">{rejecting.org_name} asked for the {(KIND_LABEL[rejecting.kind] ?? rejecting.kind).toLowerCase()} <b>{rejecting.value}</b>. The church is told your reason, so say what they should change.</p>
          <Field label="Reason (required)"><textarea value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The name does not match the church's registered name" /></Field>
          <div className="row">
            <Button kind="danger" disabled={busy || !reason.trim()} onClick={() => decide(rejecting, false, reason.trim())}>{busy ? 'Rejecting…' : 'Reject request'}</Button>
            <Button kind="ghost" onClick={() => setRejecting(undefined)}>Cancel</Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

// ---------------- Advert moderation ----------------

const ASTATE: Record<string, { label: string; tone: any }> = {
  live: { label: 'Live', tone: 'good' }, scheduled: { label: 'Scheduled', tone: 'info' }, expired: { label: 'Ended', tone: 'muted' }, ended: { label: 'Ended', tone: 'muted' },
  paused: { label: 'Paused', tone: 'warn' }, pending: { label: 'Waiting for approval', tone: 'warn' }, draft: { label: 'Draft', tone: 'muted' },
  rejected: { label: 'Not approved', tone: 'bad' }, awaiting_payment: { label: 'Waiting for payment', tone: 'warn' }, taken_down: { label: 'Taken down', tone: 'bad' }, approved: { label: 'Approved', tone: 'good' },
};
const AFILTERS: { id: string; label: string }[] = [
  { id: '', label: 'All' }, { id: 'approved', label: 'Approved' }, { id: 'pending', label: 'Waiting for approval' }, { id: 'awaiting_payment', label: 'Waiting for payment' },
  { id: 'paused', label: 'Paused' }, { id: 'taken_down', label: 'Taken down' }, { id: 'ended', label: 'Ended' },
];

export function Adverts({ toast }: { toast: Toast }) {
  const [status, setStatus] = useState('');
  const s = useAsync(() => api.get<any[]>(`/admin/adverts${status ? `?status=${status}` : ''}`), [status]);
  const [target, setTarget] = useState<any>();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const takeDown = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/adverts/${target.id}/takedown`, { reason: reason.trim() });
      toast('Advert taken down. The church has been told why.');
      setTarget(undefined); setReason('');
    } catch (e: any) {
      toast(e?.status === 409 ? 'This advert is already off.' : errText(e), 'bad');
      if (e?.status === 409) setTarget(undefined);
    }
    setBusy(false);
    s.reload();
  };

  return (
    <>
      <Head title="Adverts" sub="Adverts churches show on the member app home screen. You can take any of them down." action={<Button kind="ghost" onClick={s.reload}>Refresh</Button>} />
      <div className="chips" style={{ marginBottom: 16 }}>
        {AFILTERS.map((f) => <button key={f.id} className={`chip ${status === f.id ? 'on' : ''}`} onClick={() => setStatus(f.id)}>{f.label}</button>)}
      </div>
      <Load s={s}>
        {(rows) => rows.length === 0 ? <Empty>No adverts here.</Empty> : (
          <div className="advert-grid">
            {rows.map((a) => {
              const st = ASTATE[a.state] ?? { label: String(a.state).replace(/_/g, ' '), tone: 'muted' };
              const off = a.status === 'taken_down' || a.status === 'ended';
              return (
                <Card key={a.id} className="advert-card">
                  <img className="advert-thumb" src={api.url(a.imageUrl)} alt={`Artwork for ${a.title}`} loading="lazy" />
                  <div className="row between"><span className="tiny">{a.orgName}</span><Badge tone={st.tone}>{st.label}</Badge></div>
                  <h3>{a.title}</h3>
                  {a.body && <p className="muted pre-wrap">{a.body}</p>}
                  <div className="tiny">Shown to: {a.audienceLabel}</div>
                  <div className="tiny">{shortDate(a.startsAt)}{a.endsAt ? ` to ${shortDate(a.endsAt)}` : ', no end date'}</div>
                  {a.advertiser && <div className="tiny">Advertiser: {a.advertiser.name}{a.advertiser.contact ? ` (${a.advertiser.contact})` : ''}, {a.advertiser.price != null ? kes(a.advertiser.price) : 'no price'}, {a.paid ? 'paid' : 'not paid yet'}</div>}
                  <div className="tiny">{num(a.stats?.views).toLocaleString()} views, {num(a.stats?.taps).toLocaleString()} taps, {num(a.stats?.viewers).toLocaleString()} people</div>
                  {a.reason && <div className="tiny">Reason: {a.reason}</div>}
                  {!off && <div style={{ marginTop: 10 }}><Button kind="danger" small onClick={() => { setTarget(a); setReason(''); }}>Take down</Button></div>}
                </Card>
              );
            })}
          </div>
        )}
      </Load>
      {target && (
        <Dialog title="Take down this advert" onClose={() => setTarget(undefined)}>
          <p className="muted">"{target.title}" from {target.orgName} will stop showing at once. The church is told why. A taken-down advert cannot be switched back on; they create a new one.</p>
          <Field label="Reason (required)"><textarea value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The advert is misleading" /></Field>
          <div className="row">
            <Button kind="danger" disabled={busy || !reason.trim()} onClick={takeDown}>{busy ? 'Taking down…' : 'Take down'}</Button>
            <Button kind="ghost" onClick={() => setTarget(undefined)}>Cancel</Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/** Which messaging plan a church is on: the standard (default) tariff, or a specific one such as volume tiers. Shown on the tenant card (L124). */
export function MessagingPlan({ org, tariffs, toast, onSaved }: { org: any; tariffs: any[]; toast: Toast; onSaved: () => void }) {
  const plan = org.messagingPlan ?? {};
  const isTiered = (t: any) => !!t.current && (t.current.bands.sms.length > 1 || t.current.bands.whatsapp.length > 1);
  const def = tariffs.find((t) => t.isDefault);
  const others = tariffs.filter((t) => !t.isDefault);
  const [kind, setKind] = useState<'standard' | 'custom'>(plan.assigned && !plan.isDefault ? 'custom' : 'standard');
  const [tid, setTid] = useState<string>(plan.assigned && !plan.isDefault ? plan.tariffId : others[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const dirty = kind === 'standard' ? plan.assigned && !plan.isDefault : tid !== plan.tariffId || !plan.assigned;
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/admin/orgs/${org.id}/tariff`, { tariffId: kind === 'standard' ? null : tid });
      toast(kind === 'standard' ? `${org.name} is on the standard plan` : `${org.name} is on ${others.find((t) => t.id === tid)?.name}`);
      onSaved();
    } catch (e: any) { toast(errText(e), 'bad'); }
    setBusy(false);
  };
  const radio = { width: 'auto', minHeight: 0 } as const;
  return (
    <div style={{ margin: '0 0 18px', padding: 14, border: '1px solid var(--line)', borderRadius: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Messaging plan</h3>
        <Badge tone={plan.tiered ? 'info' : 'muted'}>{plan.name ?? 'None'} · {plan.tiered ? 'Tiered by monthly volume' : 'Flat price'}</Badge>
      </div>
      <div style={{ display: 'grid', gap: 8, margin: '10px 0' }}>
        <label><input type="radio" style={radio} checked={kind === 'standard'} onChange={() => setKind('standard')} /> Standard: the platform default{def ? ` (${def.name}${isTiered(def) ? ', tiered' : ', flat price'})` : ''}</label>
        <label><input type="radio" style={radio} checked={kind === 'custom'} disabled={others.length === 0} onChange={() => setKind('custom')} /> A specific plan, for example tiered by monthly volume</label>
        {kind === 'custom' && (
          <select value={tid} aria-label={`Messaging plan for ${org.name}`} onChange={(e) => setTid(e.target.value)} style={{ maxWidth: 360 }}>
            {others.map((t) => <option key={t.id} value={t.id}>{t.name} ({isTiered(t) ? 'tiered' : 'flat'})</option>)}
          </select>
        )}
      </div>
      <div className="row" style={{ alignItems: 'center' }}>
        <Button small disabled={busy || !dirty} onClick={save}>{busy ? 'Saving' : 'Save plan'}</Button>
        <span className="tiny">Applies to messages sent from now on. Bands are defined on the Tariffs page.</span>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { networkMismatch, phoneHint } from '@churchos/shared';
import { Button, ErrorNote, Field, Note, kes, phonePretty, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, methodLabel as baseMethodLabel, useSession } from './session';
const methodLabel = (m: string) => (m === 'cash' ? 'Cash' : baseMethodLabel(m));
import { Card, EmptyState, PageHeader, StatusChip } from './ui';
import { Loaded } from './money-bits';
import { useDebounced } from './MemberForm';
import { ItemsAndStock, ItemThumb, stockError, useItems } from './ShopItems';
import { ShopReports, ShopSales } from './ShopSales';
import { ShopOrders, useOrderCount } from './ShopOrders';
import './shop.css';

const METHODS: [string, string][] = [['cash', 'Cash'], ['mpesa', 'M-Pesa'], ['airtel', 'Airtel Money'], ['tkash', 'T-Kash'], ['card', 'Card']];
const eatToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const num = (v: string) => (v.trim() === '' ? NaN : Number(v));

function saleError(e: any) {
  switch (e?.code) {
    case 'out_of_stock': return friendly(e.message) || 'One of the items has run out. Please check the basket.';
    case 'inactive': return 'One of the items has been switched off. Remove it from the basket.';
    case 'bad_phone': return 'Enter a phone number we can send the payment request to.';
    case 'wrong_network': return friendly(e.message);
    case 'bad_lines': return 'The basket is not right. Remove the items and add them again.';
    default: return stockError(e);
  }
}

function Receipt({ sale, onNew }: { sale: any; onNew: () => void }) {
  return (
    <Card>
      <div className="sp-receipt">
        <div style={{ textAlign: 'center' }}>
          <StatusChip tone="done">Paid</StatusChip>
          <h2 style={{ margin: '8px 0 0' }}>Receipt {sale.receiptNo}</h2>
          <div className="tiny">{shortDate(sale.completedAt ?? sale.createdAt ?? new Date().toISOString())}</div>
        </div>
        <hr />
        {sale.lines.map((l: any, i: number) => <div className="rl" key={i}><span>{l.qty} x {l.name}</span><b>{kes(l.total)}</b></div>)}
        <hr />
        <div className="rl"><b>Total</b><b style={{ fontSize: 20 }}>{kes(sale.total)}</b></div>
        <div className="rl"><span>Paid by</span><span>{methodLabel(sale.method)}</span></div>
        {sale.buyer && <div className="rl"><span>Buyer</span><span>{sale.buyer}</span></div>}
        <div className="tiny" style={{ textAlign: 'center' }}>Thank you</div>
      </div>
      <div className="row sp-noprint" style={{ justifyContent: 'center', marginTop: 16 }}>
        <Button kind="ghost" onClick={() => window.print()}>Print receipt</Button>
        <Button onClick={onNew}>New sale</Button>
      </div>
    </Card>
  );
}

function Waiting({ sale, onDone, onCancelled }: { sale: any; onDone: (s: any) => void; onCancelled: () => void }) {
  const s = useSession();
  const [stale, setStale] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const started = Date.now();
    let alive = true;
    const t = setInterval(async () => {
      if (Date.now() - started > 180_000) { clearInterval(t); if (alive) setStale(true); return; }
      try {
        const r = await api.get(`/shop/sales/${sale.id}` + s.qs({ branch: undefined }));
        if (!alive) return;
        if (r.status === 'completed') { clearInterval(t); onDone(r); }
        else if (r.status === 'lapsed' || r.status === 'voided') { clearInterval(t); setErr('This sale was not paid and has closed. You can start a new one.'); setStale(true); }
      } catch { /* keep trying */ }
    }, 2000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sale.id]);
  const cancel = async () => {
    setBusy(true);
    try { await api.post(`/shop/sales/${sale.id}/cancel` + s.qs({ branch: undefined }), {}); onCancelled(); } catch (e: any) { setErr(friendly(e?.message)); setBusy(false); }
  };
  return (
    <Card>
      <div className="stack" style={{ maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
        <h2>{stale ? 'Still waiting for payment' : 'Waiting for payment'}</h2>
        <div className="sp-total">{kes(sale.total)}</div>
        <div className="muted">Receipt {sale.receiptNo}</div>
        {sale.message && <Note>{sale.message}</Note>}
        {stale && !err && <Note tone="warn">We have not heard back yet. You can keep waiting in Sales, or cancel this sale.</Note>}
        {sale.checkoutUrl && <a className="btn primary" href={sale.checkoutUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', justifyContent: 'center' }}>Open the card page</a>}
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row" style={{ justifyContent: 'center' }}><Button kind="ghost" disabled={busy} onClick={cancel}>Cancel this sale</Button></div>
      </div>
    </Card>
  );
}

type Buyer = { id?: string; name: string };

function BuyerPicker({ value, onChange }: { value: Buyer; onChange: (b: Buyer) => void }) {
  const s = useSession();
  const dq = useDebounced(value.id ? '' : value.name.trim());
  const [res, setRes] = useState<any[]>([]);
  useEffect(() => {
    if (dq.length < 2) { setRes([]); return; }
    let alive = true;
    api.get<any[]>('/members' + s.qs({ q: dq, branch: undefined })).then((r) => alive && setRes(r.slice(0, 5))).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);
  if (value.id) return <div className="chips"><button type="button" className="chip on" aria-label="Remove buyer" onClick={() => onChange({ name: '' })}>{value.name} ×</button></div>;
  return (
    <div className="sp-pick">
      <input value={value.name} maxLength={80} placeholder="Search a member, or type a name" onChange={(e) => onChange({ name: e.target.value })} />
      {res.map((m) => <button type="button" key={m.id} className="btn ghost small" onClick={() => { onChange({ id: m.id, name: m.full_name }); setRes([]); }}>{m.full_name} · {m.member_number}{m.phone ? ` · ${phonePretty(m.phone)}` : ''}</button>)}
    </div>
  );
}

function Till({ branch }: { branch: string }) {
  const s = useSession();
  const items = useItems(branch);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [buyer, setBuyer] = useState<Buyer>({ name: '' });
  const [method, setMethod] = useState('cash');
  const [phone, setPhone] = useState('');
  const [given, setGiven] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sale, setSale] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const toast = useToast();

  const all = (items.data ?? []).filter((i) => i.active);
  const categories = Array.from(new Set(all.map((i) => i.category).filter(Boolean))).sort() as string[];
  const term = q.trim().toLowerCase();
  const shown = all.filter((i) => (!cat || i.category === cat) && (!term || i.name.toLowerCase().includes(term) || (i.code ?? '').toLowerCase().includes(term)));
  const lines = Object.entries(basket).map(([id, qty]) => ({ item: all.find((i) => i.id === id), qty })).filter((l) => l.item) as { item: any; qty: number }[];
  const total = lines.reduce((t, l) => t + l.qty * l.item.price, 0);
  const setQty = (item: any, qty: number) => setBasket((b) => { const n = { ...b }; const v = Math.min(qty, item.stock); if (v <= 0) delete n[item.id]; else n[item.id] = v; return n; });
  const add = (item: any) => setQty(item, (basket[item.id] ?? 0) + 1);

  const mobile = method !== 'cash';
  const hint = phoneHint(method);
  const mismatch = mobile ? networkMismatch(method, phone) : null;
  const givenN = num(given);
  const change = method === 'cash' && Number.isFinite(givenN) ? givenN - total / 100 : null;

  const reset = () => { setBasket({}); setBuyer({ name: '' }); setPhone(''); setGiven(''); setSale(null); setDone(null); setErr(''); items.reload(); };

  const pay = async () => {
    setErr('');
    if (mobile && method !== 'card' && !phone.trim()) return setErr('Enter the buyer phone number to send the payment request to.');
    if (mismatch) return setErr(mismatch);
    setBusy(true);
    try {
      const r = await api.post('/shop/sales' + s.qs({ branch: undefined }), {
        branchId: branch, method, lines: lines.map((l) => ({ itemId: l.item.id, qty: l.qty })),
        buyerMembershipId: buyer.id || undefined, buyerName: !buyer.id && buyer.name.trim() ? buyer.name.trim() : undefined, phone: mobile && phone.trim() ? phone.trim() : undefined,
      });
      if (r.status === 'completed') { setDone(r); items.reload(); } else { setSale(r); items.reload(); }
    } catch (e: any) { setErr(saleError(e)); if (e?.code === 'out_of_stock' || e?.code === 'inactive') items.reload(); }
    setBusy(false);
  };

  if (done) return <Receipt sale={done} onNew={reset} />;
  if (sale) return <Waiting sale={sale} onDone={(r) => { setSale(null); setDone(r); items.reload(); }} onCancelled={() => { toast.show('Sale cancelled'); reset(); }} />;

  return (
    <div className="sp-pos">
      <div className="stack">
        <section className="u-card stack" style={{ gap: 12 }}>
          <input type="search" aria-label="Search items" placeholder="Search by name or code" value={q} onChange={(e) => setQ(e.target.value)} />
          {categories.length > 0 && (
            <div className="chips" role="group" aria-label="Category">
              <button type="button" className={`chip ${cat === '' ? 'on' : ''}`} aria-pressed={cat === ''} onClick={() => setCat('')}>All</button>
              {categories.map((c) => <button type="button" key={c} className={`chip ${cat === c ? 'on' : ''}`} aria-pressed={cat === c} onClick={() => setCat(c)}>{c}</button>)}
            </div>
          )}
        </section>
        <Loaded loading={items.loading} error={items.error} hasData={!!items.data}>
          {items.data && (shown.length === 0 ? <Card><EmptyState icon="money" title={all.length === 0 ? 'Nothing for sale yet' : 'No items match'} text={all.length === 0 ? 'Add some under Items and stock.' : 'Try a different word or category.'} /></Card> : (
            <div className="sp-grid">
              {shown.map((i) => (
                <button type="button" key={i.id} className="sp-tile" disabled={i.out || (basket[i.id] ?? 0) >= i.stock} onClick={() => add(i)}>
                  <ItemThumb item={i} size={56} />
                  <b>{i.name}</b>
                  <span className="sp-price">{kes(i.price)}</span>
                  {i.out ? <span className="sp-tag out">Out of stock</span> : i.low ? <span className="sp-tag">Only {i.stock} left</span> : <span className="tiny">{i.stock} in stock</span>}
                </button>
              ))}
            </div>
          ))}
        </Loaded>
      </div>
      <Card className="sp-basket">
        <div className="stack">
          <div className="mn-cardhead" style={{ margin: 0 }}><h2>Basket</h2></div>
          {lines.length === 0 ? <div className="muted">Tap an item to add it.</div> : (
            <div className="sp-lines">
              {lines.map(({ item, qty }) => (
                <div className="sp-line" key={item.id}>
                  <div className="name"><b>{item.name}</b><div className="tiny">{kes(item.price)} each</div></div>
                  <div className="sp-step">
                    <button type="button" aria-label={`One less ${item.name}`} onClick={() => setQty(item, qty - 1)}>-</button>
                    <span>{qty}</span>
                    <button type="button" aria-label={`One more ${item.name}`} disabled={qty >= item.stock} onClick={() => setQty(item, qty + 1)}>+</button>
                  </div>
                  <div style={{ textAlign: 'right' }}><b>{kes(qty * item.price)}</b><div><button type="button" className="btn ghost small" onClick={() => setQty(item, 0)}>Remove</button></div></div>
                </div>
              ))}
            </div>
          )}
          <div><div className="tiny">Total</div><div className="sp-total">{kes(total)}</div></div>
          <Field label="Buyer" hint="Optional"><BuyerPicker value={buyer} onChange={setBuyer} /></Field>
          <div>
            <div className="field-label" id="sp-pay" style={{ marginBottom: 6 }}>Payment</div>
            <div className="chips" role="group" aria-labelledby="sp-pay">
              {METHODS.map(([k, l]) => <button type="button" key={k} className={`chip ${method === k ? 'on' : ''}`} aria-pressed={method === k} onClick={() => setMethod(k)}>{l}</button>)}
            </div>
          </div>
          {mobile && (
            <Field label={hint.label} hint={hint.help}>
              <input inputMode="tel" placeholder={hint.placeholder} value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
          )}
          {mismatch && <Note tone="warn">{mismatch}</Note>}
          {method === 'cash' && (
            <>
              <Field label="Amount given (KES)" hint="Optional. Only used to work out the change."><input inputMode="decimal" value={given} onChange={(e) => setGiven(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
              {change !== null && total > 0 && (change >= 0 ? <div className="sp-change">Change: {kes(Math.round(change * 100))}</div> : <Note tone="warn">That is {kes(Math.round(-change * 100))} short.</Note>)}
            </>
          )}
          {err && <ErrorNote>{err}</ErrorNote>}
          <button type="button" className="btn primary sp-big" disabled={busy || lines.length === 0} onClick={pay}>{busy ? 'Please wait...' : 'Take payment'}</button>
        </div>
      </Card>
      {toast.node}
    </div>
  );
}

function CloseTill({ branch }: { branch: string }) {
  const s = useSession();
  const [day, setDay] = useState(eatToday);
  const t = useAsync<any>(() => api.get('/shop/till' + s.qs({ branch, day })), [branch, day, s.grant.org.id]);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<any>(null);
  const d = t.data;
  const n = num(counted);
  const diff = d && Number.isFinite(n) ? Math.round(n * 100) - d.expected : null;
  const diffText = diff === null ? '' : diff === 0 ? 'Matches' : diff < 0 ? `${kes(-diff)} short` : `${kes(diff)} over`;
  const close = async () => {
    setErr('');
    if (!Number.isFinite(n) || n < 0) return setErr('Enter the cash you counted. Use 0 if there is none.');
    if (diff !== 0 && !note.trim()) return setErr('The count is different from the sales. Please write a note to explain.');
    setBusy(true);
    try { setResult(await api.post('/shop/till' + s.qs({ branch: undefined }), { branchId: branch, day, counted: n, note: note.trim() || undefined })); t.reload(); }
    catch (e: any) { setErr(e?.code === 'note_required' ? 'The count is different from the sales. Please write a note to explain.' : e?.code === 'already_closed' ? 'The till was already closed for that day.' : friendly(e?.message)); }
    setBusy(false);
  };
  const closed = d?.till;
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <Field label="Day"><input type="date" max={eatToday()} value={day} onChange={(e) => { if (e.target.value) { setDay(e.target.value); setResult(null); setErr(''); } }} style={{ maxWidth: 200 }} /></Field>
      <Loaded loading={t.loading} error={t.error} hasData={!!d}>
        {d && (
          <Card>
            <div className="stack">
              <div className="mn-cardhead" style={{ margin: 0 }}><h2>{closed || result ? 'Till closed' : 'Count the cash'}</h2></div>
              <div>The sales say there should be <b>{kes(d.expected)}</b> in cash from <b>{d.cashSales}</b> cash {d.cashSales === 1 ? 'sale' : 'sales'}.</div>
              {closed ? (
                <>
                  <div className="grid cols-3">
                    <div><div className="tiny">Cash counted</div><b>{kes(closed.counted)}</b></div>
                    <div><div className="tiny">Sales said</div><b>{kes(closed.expected)}</b></div>
                    <div><div className="tiny">Difference</div><b>{closed.variance === 0 ? 'Matches' : closed.variance < 0 ? `${kes(-closed.variance)} short` : `${kes(closed.variance)} over`}</b></div>
                  </div>
                  {closed.note && <div className="muted">Note: {closed.note}</div>}
                  <div className="tiny">Closed by {closed.by || 'a team member'} on {shortDate(closed.at)}.</div>
                  {result && <Note tone="good">{result.message}</Note>}
                  <div><Button kind="ghost" onClick={() => s.go('cash')}>Go to Cash</Button></div>
                </>
              ) : (
                <>
                  <Field label="Cash counted (KES)"><input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
                  {diff !== null && <div className={`sp-diff ${diff === 0 ? 'good' : 'warn'}`}>{diffText}</div>}
                  {diff !== null && diff !== 0 && <Field label="Note" hint="Say why the count is different. Required."><input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
                  <div className="tiny">The count is sent to Cash for a second person to sign off, and the platform fee on cash is charged there.</div>
                  {err && <ErrorNote>{err}</ErrorNote>}
                  <div><Button disabled={busy} onClick={close}>{busy ? 'Saving...' : 'Close the till'}</Button></div>
                </>
              )}
            </div>
          </Card>
        )}
      </Loaded>
    </div>
  );
}

type Seg = 'till' | 'items' | 'sales' | 'orders' | 'reports' | 'close';

export function Shop() {
  const s = useSession();
  const sell = s.can('shop.sell');
  const segs: [Seg, string][] = [...(sell ? [['till', 'Till'] as [Seg, string]] : []), ['items', 'Items and stock'], ['sales', 'Sales'], ...(sell ? [['orders', 'Orders'] as [Seg, string]] : []), ['reports', 'Reports'], ...(sell ? [['close', 'Close till'] as [Seg, string]] : [])];
  const [seg, setSeg] = useState<Seg>(segs[0][0]);
  const [branch, setBranch] = useState(() => (s.scope !== 'all' && s.branches.some((b) => b.id === s.scope) ? s.scope : s.branches[0]?.id ?? ''));
  // When no branch was chosen in the top bar, open on the branch that actually has a shop rather than the first one alphabetically.
  useEffect(() => {
    if (s.scope !== 'all') return;
    let alive = true;
    api.get<any[]>('/shop/items' + s.qs({ branch: undefined })).then((r) => { const b = r.find((i) => s.branches.some((x) => x.id === i.branchId))?.branchId; if (alive && b) setBranch(b); }).catch(() => {});
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const view = s.can('shop.view') || s.can('shop.manage');
  const shownSegs = segs.filter(([k]) => view || k === 'till' || k === 'close');
  const cur = shownSegs.some(([k]) => k === seg) ? seg : shownSegs[0][0];
  const [toPrepare, setToPrepare] = useOrderCount(branch, sell);
  if (!branch) return <ErrorNote>You do not have access to a branch yet.</ErrorNote>;
  return (
    <div>
      <PageHeader
        title="Shop"
        subtitle="Sell Bibles, rosaries, books and more, and keep track of stock."
        actions={s.branches.length > 1 ? (
          <select aria-label="Shop branch" style={{ width: 'auto', minWidth: 200 }} value={branch} onChange={(e) => setBranch(e.target.value)}>
            {s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        ) : undefined}
        tabs={shownSegs.map(([k, l]) => ({ id: k, label: l, badge: k === 'orders' && toPrepare > 0 ? toPrepare : undefined }))}
        tab={cur}
        onTab={(k) => setSeg(k as Seg)}
      />
      {cur === 'till' && <Till key={branch} branch={branch} />}
      {cur === 'items' && <ItemsAndStock key={branch} branch={branch} />}
      {cur === 'sales' && <ShopSales key={branch} branch={branch} />}
      {cur === 'orders' && <ShopOrders key={branch} branch={branch} onCount={setToPrepare} />}
      {cur === 'reports' && <ShopReports key={branch} branch={branch} />}
      {cur === 'close' && <CloseTill key={branch} branch={branch} />}
    </div>
  );
}

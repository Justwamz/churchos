import { networkMismatch, phoneHint } from '@churchos/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthImg, Button, ErrorNote, Field, Note, kes, phonePretty, shortDate, useAsync } from '@churchos/ui';
import { api, errText } from './api';
import { Icon, Sheet, Skeleton } from './ui';

// ---------------- types and helpers ----------------

export type ShopItem = { id: string; branchId?: string; name: string; category?: string | null; price: number; available: boolean; left: number | null; maxQty?: number; imageUrl?: string | null };
/** Where the Shop page should start. 'item' and 'checkout' come from adverts. */
export type ShopIntent =
  | { kind: 'shop' | 'orders'; notice?: string }
  | { kind: 'item'; item: ShopItem; advertId?: string }
  | { kind: 'checkout'; item: ShopItem; qty: number; advertId?: string };

type Line = { id: string; name: string; price: number; imageUrl?: string | null; max: number; qty: number };

const METHODS = [
  { key: 'mpesa', label: 'M-Pesa' },
  { key: 'airtel', label: 'Airtel Money' },
  { key: 'tkash', label: 'T-Kash' },
  { key: 'card', label: 'Card' },
];
const PENDING_KEY = 'churchos:shop-pending';
const basketKey = (b: string) => `churchos:basket:${b}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const maxOf = (i: ShopItem) => Math.max(1, Math.min(10, i.maxQty ?? i.left ?? 10));

const ORDER_ERR: Record<string, string> = {
  bad_number: 'You can order up to 10 of one item. Please lower the number.',
  bad_phone: 'Please enter the phone number to send the payment prompt to.',
  too_many: 'You have 3 orders waiting for payment. Please pay for them or cancel them first, in My orders.',
  too_large: 'An order can be at most KES 150,000. Please split it into two orders.',
  bad_method: 'Please choose M-Pesa, Airtel Money, T-Kash or Card.',
};

const STATE: Record<string, { label: string; tone: string }> = {
  awaiting_payment: { label: 'Waiting for payment', tone: 'warn' },
  to_prepare: { label: 'Paid, being prepared', tone: 'info' },
  ready: { label: 'Ready to collect', tone: 'good' },
  collected: { label: 'Collected', tone: 'muted' },
  lapsed: { label: 'Not paid in time', tone: 'muted' },
};

function readBasket(branch: string | null): Line[] {
  if (!branch) return [];
  try {
    const v = JSON.parse(localStorage.getItem(basketKey(branch)) ?? '[]');
    return Array.isArray(v) ? v.filter((l) => l && typeof l.id === 'string' && l.qty > 0) : [];
  } catch { return []; }
}

function useBasket(branch: string | null) {
  const [lines, setLines] = useState<Line[]>(() => readBasket(branch));
  useEffect(() => { setLines(readBasket(branch)); }, [branch]);
  const save = useCallback((next: Line[]) => {
    setLines(next);
    if (!branch) return;
    try { if (next.length) localStorage.setItem(basketKey(branch), JSON.stringify(next)); else localStorage.removeItem(basketKey(branch)); } catch { /* ignore */ }
  }, [branch]);
  return { lines, save };
}

const lineOf = (i: ShopItem, qty: number): Line => ({ id: i.id, name: i.name, price: i.price, imageUrl: i.imageUrl ?? null, max: maxOf(i), qty: Math.max(1, Math.min(maxOf(i), qty)) });

const TILE_COLOURS = ['#0e5a52', '#b9832a', '#25598f', '#8a4f7d', '#b3322d', '#1d7a4a', '#6b5b3e'];
function Picture({ item, className = '' }: { item: { name: string; imageUrl?: string | null }; className?: string }) {
  const sum = [...item.name].reduce((s, c) => s + c.charCodeAt(0), 0);
  return item.imageUrl
    ? <AuthImg api={api} className={`shop-pic ${className}`} src={item.imageUrl} alt="" loading="lazy" draggable={false} />
    : <span className={`shop-pic shop-pic-tile ${className}`} style={{ background: TILE_COLOURS[sum % TILE_COLOURS.length] }} aria-hidden="true">{(item.name.trim()[0] ?? '?').toUpperCase()}</span>;
}

function Stepper({ value, max, onChange, label }: { value: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label="One less" disabled={value <= 1} onClick={() => onChange(value - 1)}>{'−'}</button>
      <output aria-live="polite">{value}</output>
      <button type="button" aria-label="One more" disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}


// ---------------- page ----------------

export function ShopPage({ user, intent }: { user: any; intent?: ShopIntent }) {
  const startBranch = intent && (intent.kind === 'item' || intent.kind === 'checkout') ? intent.item.branchId ?? '' : '';
  const [branch, setBranch] = useState(startBranch);
  const [seg, setSeg] = useState<'shop' | 'orders'>(intent?.kind === 'orders' ? 'orders' : 'shop');
  const [cat, setCat] = useState('');
  const [product, setProduct] = useState<{ item: ShopItem; buyNow?: boolean } | null>(null);
  const [basketOpen, setBasketOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [notice, setNotice] = useState(intent && 'notice' in intent ? intent.notice : undefined);
  const advertId = useRef<string | undefined>(intent && (intent.kind === 'item' || intent.kind === 'checkout') ? intent.advertId : undefined);
  const handled = useRef(false);

  const q = useAsync<any>(() => api.get(`/me/shop${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`), [branch]);
  const orders = useAsync<any[]>(() => api.get('/me/shop/orders'));
  const branchId: string | null = q.data?.branchId ?? null;
  const { lines, save } = useBasket(branchId);
  const items: ShopItem[] = q.data?.items ?? [];
  const branches: any[] = q.data?.branches ?? [];
  const branchName = branches.find((b) => b.id === branchId)?.name ?? '';

  // keep the basket in step with what is on the shelf
  useEffect(() => {
    if (!q.data || !branchId || q.loading) return;
    const next: Line[] = [];
    for (const l of lines) {
      const it = items.find((i) => i.id === l.id);
      if (!it || !it.available) continue;
      next.push(lineOf(it, l.qty));
    }
    if (JSON.stringify(next) !== JSON.stringify(lines)) save(next);
  }, [q.data, q.loading, branchId]); // eslint-disable-line react-hooks/exhaustive-deps

  // coming back from the card page: show orders, and clear the basket when the order was paid
  useEffect(() => {
    let pending: any = null;
    try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null'); localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
    if (!pending) return;
    setSeg('orders');
    api.get('/me/shop/orders').then((rows: any[]) => {
      const o = rows.find((r) => r.id === pending.orderId);
      if (o && o.state !== 'awaiting_payment' && o.state !== 'lapsed') { try { localStorage.removeItem(basketKey(pending.branchId)); } catch { /* ignore */ } save(readBasket(branchId)); }
      orders.setData(rows);
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // act on an advert once the shelf is loaded
  useEffect(() => {
    if (handled.current || !intent || !q.data || q.loading) return;
    if (intent.kind !== 'item' && intent.kind !== 'checkout') { handled.current = true; return; }
    handled.current = true;
    const it = items.find((i) => i.id === intent.item.id);
    if (!it || !it.available) { setNotice(`Sorry, ${intent.item.name} is sold out right now. Have a look at what else is in the shop.`); return; }
    if (intent.kind === 'item') setProduct({ item: it, buyNow: true });
    else { save([lineOf(it, intent.qty)]); setCheckoutOpen(true); }
  }, [q.data, q.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = lines.reduce((s, l) => s + l.qty, 0);
  const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
  const shown = cat ? items.filter((i) => i.category === cat) : items;
  const awaiting = (orders.data ?? []).filter((o) => o.state === 'awaiting_payment').length;
  const add = (it: ShopItem, qty: number) => {
    const cur = lines.find((l) => l.id === it.id);
    const next = lineOf(it, (cur?.qty ?? 0) + qty);
    save(cur ? lines.map((l) => (l.id === it.id ? next : l)) : [...lines, next]);
  };

  return (
    <div className="stack shop-page">
      <div className="seg" role="tablist" aria-label="Shop">
        <button type="button" role="tab" aria-selected={seg === 'shop'} className={seg === 'shop' ? 'on' : ''} onClick={() => setSeg('shop')}>Shop</button>
        <button type="button" role="tab" aria-selected={seg === 'orders'} className={seg === 'orders' ? 'on' : ''} onClick={() => { setSeg('orders'); orders.reload(); }}>My orders{awaiting > 0 ? ` (${awaiting})` : ''}</button>
      </div>
      {notice && <Note tone="info">{notice}</Note>}

      {seg === 'shop' && (
        q.loading && !q.data ? <div className="card"><Skeleton lines={4} tall /></div>
        : q.error && !q.data ? <div className="stack"><ErrorNote>{q.error}</ErrorNote><Button kind="ghost" onClick={q.reload}>Try again</Button></div>
        : !items.length && !branches.length ? <div className="empty-state"><Icon name="bag" size={40} /><strong>The shop is empty</strong><span>When your church adds things to its shop, you will find them here.</span></div>
        : (
          <>
            {branches.length > 1 && (
              <label className="shop-branch">
                <span className="field-label">Shop at</span>
                <select value={branchId ?? ''} onChange={(e) => { setBranch(e.target.value); setCat(''); }}>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.items})</option>)}
                </select>
              </label>
            )}
            {(q.data?.categories ?? []).length > 0 && (
              <div className="chips shop-cats" role="group" aria-label="Categories">
                <button type="button" className={`chip ${!cat ? 'on' : ''}`} aria-pressed={!cat} onClick={() => setCat('')}>All</button>
                {(q.data.categories as string[]).map((c) => <button key={c} type="button" className={`chip ${cat === c ? 'on' : ''}`} aria-pressed={cat === c} onClick={() => setCat(c)}>{c}</button>)}
              </div>
            )}
            <ul className="shop-grid">
              {shown.map((i) => (
                <li key={i.id}>
                  <button type="button" className={`shop-card ${i.available ? '' : 'out'}`} onClick={() => setProduct({ item: i })} aria-label={`${i.name}, ${kes(i.price)}${i.available ? '' : ', sold out'}`}>
                    <span className="shop-pic-wrap">
                      <Picture item={i} />
                      {!i.available && <span className="shop-sold">Sold out</span>}
                      {i.available && i.left != null && <span className="shop-left">Only {i.left} left</span>}
                    </span>
                    <strong className="shop-name">{i.name}</strong>
                    <span className="shop-price">{kes(i.price)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {!shown.length && <div className="empty">Nothing here yet.</div>}
            {count > 0 && (
              <div className="basket-bar">
                <button type="button" onClick={() => setBasketOpen(true)} aria-label={`View basket, ${count} ${count === 1 ? 'item' : 'items'}, ${kes(total)}`}>
                  <span className="basket-ico"><Icon name="bag" size={22} /><span className="basket-n">{count}</span></span>
                  <span className="basket-text"><strong>{kes(total)}</strong><span>{count} {count === 1 ? 'item' : 'items'}</span></span>
                  <span className="basket-go">View basket</span>
                </button>
              </div>
            )}
          </>
        )
      )}

      {seg === 'orders' && <Orders q={orders} onShop={() => setSeg('shop')} />}

      <ProductSheet state={product} onClose={() => setProduct(null)} inBasket={(id) => lines.find((l) => l.id === id)?.qty ?? 0}
        onAdd={(it, qty) => { add(it, qty); setProduct(null); }}
        onBuy={(it, qty) => { save([lineOf(it, qty)]); setProduct(null); setCheckoutOpen(true); }} />

      <Sheet open={basketOpen} onClose={() => setBasketOpen(false)} title="Your basket">
        {!lines.length ? <div className="empty">Your basket is empty.</div> : (
          <div className="stack">
            <ul className="plain-list">
              {lines.map((l) => (
                <li key={l.id} className="basket-line">
                  <Picture item={l} />
                  <span className="basket-line-main"><strong>{l.name}</strong><span className="tiny">{kes(l.price)} each</span></span>
                  <Stepper value={l.qty} max={l.max} label={`Quantity of ${l.name}`} onChange={(n) => save(lines.map((x) => (x.id === l.id ? { ...x, qty: n } : x)))} />
                  <button type="button" className="icon-btn" aria-label={`Remove ${l.name}`} onClick={() => save(lines.filter((x) => x.id !== l.id))}><Icon name="close" size={20} /></button>
                </li>
              ))}
            </ul>
            <div className="total-row"><span>Total</span><span className="total">{kes(total)}</span></div>
            <Button onClick={() => { setBasketOpen(false); setCheckoutOpen(true); }}>Checkout</Button>
          </div>
        )}
      </Sheet>

      {checkoutOpen && branchId && (
        <Checkout user={user} branchId={branchId} branchName={branchName} lines={lines} total={total} advertId={advertId.current && lines.some((l) => advertIdItem(intent) === l.id) ? advertId.current : undefined}
          onClose={() => setCheckoutOpen(false)}
          onEditBasket={() => { setCheckoutOpen(false); q.reload(); setBasketOpen(true); }}
          onPaid={() => { save([]); orders.reload(); }}
          onOrders={() => { setCheckoutOpen(false); setSeg('orders'); orders.reload(); }} />
      )}
    </div>
  );
}

const advertIdItem = (i?: ShopIntent) => (i && (i.kind === 'item' || i.kind === 'checkout') ? i.item.id : '');

function ProductSheet({ state, onClose, onAdd, onBuy, inBasket }: { state: { item: ShopItem; buyNow?: boolean } | null; onClose: () => void; onAdd: (i: ShopItem, n: number) => void; onBuy: (i: ShopItem, n: number) => void; inBasket: (id: string) => number }) {
  const [qty, setQty] = useState(1);
  useEffect(() => { setQty(1); }, [state?.item.id]);
  const it = state?.item;
  const max = it ? Math.max(1, maxOf(it) - inBasket(it.id)) : 1;
  const full = it ? inBasket(it.id) >= maxOf(it) : false;
  return (
    <Sheet open={!!state} onClose={onClose} title={it?.name}>
      {it && (
        <div className="stack">
          <div className="shop-pic-wrap big">
            <Picture item={it} />
            {!it.available && <span className="shop-sold">Sold out</span>}
          </div>
          <div className="prod-row"><span className="shop-price big">{kes(it.price)}</span>{it.available && it.left != null && <span className="shop-left inline">Only {it.left} left</span>}</div>
          {!it.available ? <Note tone="warn">This item is sold out right now. Please check again soon.</Note> : (
            <>
              {inBasket(it.id) > 0 && <div className="tiny">You already have {inBasket(it.id)} in your basket.</div>}
              {!full && (
                <div className="prod-qty"><span className="field-label">How many?</span><Stepper value={Math.min(qty, max)} max={max} label="Quantity" onChange={setQty} /></div>
              )}
              {full && <Note tone="info">You have the most you can order of this item.</Note>}
              {state?.buyNow && !full && <Button onClick={() => onBuy(it, Math.min(qty, max))}>Buy now, {kes(it.price * Math.min(qty, max))}</Button>}
              {!full && <Button kind={state?.buyNow ? 'ghost' : undefined} onClick={() => onAdd(it, Math.min(qty, max))}>Add to basket</Button>}
              {full && <Button onClick={onClose}>Close</Button>}
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

// ---------------- checkout ----------------

type Order = { id: string; receiptNo: string; state: string; total: number; branchName: string; payUrl?: string | null; collectionCode?: string; lines: any[] };

function Checkout({ user, branchId, branchName, lines, total, advertId, onClose, onEditBasket, onPaid, onOrders }: {
  user: any; branchId: string; branchName: string; lines: Line[]; total: number; advertId?: string;
  onClose: () => void; onEditBasket: () => void; onPaid: () => void; onOrders: () => void;
}) {
  const [method, setMethod] = useState('mpesa');
  const [phone, setPhone] = useState(phonePretty(user?.phone));
  const [phase, setPhase] = useState<'form' | 'waiting' | 'done' | 'slow' | 'cancelled'>('form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; stock?: boolean } | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [paid, setPaid] = useState<Order | null>(null);
  const hint = phoneHint(method);
  const mismatch = method === 'card' ? null : networkMismatch(method, phone);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const pay = async () => {
    setBusy(true); setError(null);
    try {
      const o: Order = await api.post('/me/shop/orders', { branchId, method, phone: method === 'card' ? undefined : phone, lines: lines.map((l) => ({ itemId: l.id, qty: l.qty })), advertId });
      if (!alive.current) return;
      if (method === 'card' && o.payUrl) {
        try { localStorage.setItem(PENDING_KEY, JSON.stringify({ orderId: o.id, branchId })); } catch { /* ignore */ }
        window.location.assign(`${o.payUrl}?return=${encodeURIComponent(`${location.origin}/`)}`);
        return;
      }
      setOrder(o); setPhase('waiting');
      const started = Date.now();
      while (alive.current && Date.now() - started < 180_000) {
        await sleep(2000);
        if (!alive.current) return;
        try {
          const rows: any[] = await api.get('/me/shop/orders');
          const now = rows.find((r) => r.id === o.id);
          if (now && now.state !== 'awaiting_payment') {
            if (now.state === 'lapsed') { setPhase('cancelled'); onPaid(); return; }
            setPaid(now); setPhase('done'); onPaid(); return;
          }
        } catch { /* keep trying */ }
      }
      if (alive.current) setPhase('slow');
    } catch (e: any) {
      const code = e?.code ?? e?.body?.code;
      setError({ text: ORDER_ERR[code] ?? errText(e), stock: code === 'out_of_stock' });
    } finally { if (alive.current) setBusy(false); }
  };

  const cancel = async () => {
    if (!order) return;
    try { await api.post(`/me/shop/orders/${order.id}/cancel`); } catch { /* may already be paid or lapsed */ }
    alive.current = false;
    onOrders();
  };

  const title = phase === 'done' ? 'Order placed' : phase === 'waiting' || phase === 'slow' ? 'Pay for your order' : 'Checkout';
  return (
    <Sheet open onClose={onClose} title={title}>
      {phase === 'form' && (
        <div className="stack">
          <ul className="plain-list">
            {lines.map((l) => (
              <li key={l.id} className="sum-line"><span>{l.qty} x {l.name}</span><strong>{kes(l.qty * l.price)}</strong></li>
            ))}
          </ul>
          <div className="total-row"><span>Total</span><span className="total">{kes(total)}</span></div>
          <p className="shop-collect"><Icon name="pin" size={18} /> <span>You collect your order at <strong>{branchName}</strong>. We will tell you when it is ready.</span></p>
          <div>
            <div className="field-label" id="shop-meth">Pay with</div>
            <div className="chips" role="group" aria-labelledby="shop-meth" style={{ marginTop: 8 }}>
              {METHODS.map((x) => <button key={x.key} type="button" className={`chip ${method === x.key ? 'on' : ''}`} aria-pressed={method === x.key} onClick={() => setMethod(x.key)}>{x.label}</button>)}
            </div>
          </div>
          {method !== 'card' && (
            <Field label={hint.label} hint={hint.help} error={mismatch ?? undefined}>
              <input type="tel" inputMode="tel" autoComplete="tel" placeholder={hint.placeholder} value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!!mismatch} />
            </Field>
          )}
          {error && (
            <div className="stack" style={{ gap: 8 }}>
              <ErrorNote>{error.text}</ErrorNote>
              {error.stock && <Button kind="ghost" onClick={onEditBasket}>Change my basket</Button>}
            </div>
          )}
          <Button disabled={busy || !lines.length || (method !== 'card' && (phone.trim().length < 9 || !!mismatch))} onClick={pay}>
            {busy ? (method === 'card' ? 'Opening card page…' : 'Sending…') : `Pay ${kes(total)}`}
          </Button>
        </div>
      )}

      {phase === 'waiting' && order && (
        <div className="stack shop-wait">
          <div className="spinner" role="status" aria-label="Waiting for payment" />
          <h3>Check your phone and enter your PIN</h3>
          <p>We sent a payment request for <strong>{kes(order.total)}</strong>. This screen updates by itself once you have paid.</p>
          <p className="tiny">Your items are held for 30 minutes.</p>
          <button type="button" className="link-btn" onClick={cancel}>Cancel order</button>
        </div>
      )}

      {phase === 'slow' && order && (
        <div className="stack">
          <Note tone="info">We are still waiting for your payment to come through. If you entered your PIN, your order will show as paid in My orders shortly. Please do not pay twice.</Note>
          <Button onClick={onOrders}>View my orders</Button>
          <button type="button" className="link-btn" onClick={cancel}>Cancel order</button>
        </div>
      )}

      {phase === 'cancelled' && (
        <div className="stack">
          <Note tone="warn">This order was not paid, so it has been released.</Note>
          <Button onClick={onClose}>Back to the shop</Button>
        </div>
      )}

      {phase === 'done' && paid && (
        <div className="stack shop-done">
          <span className="done-ico"><Icon name="check" size={34} /></span>
          <h3>Thank you, your order is paid</h3>
          <div className="code-label">Your collection code</div>
          <div className="code-block" aria-label={`Collection code ${paid.collectionCode}`}>{paid.collectionCode}</div>
          <p className="tiny">Receipt {paid.receiptNo}</p>
          <p><strong>Show this code when you collect</strong> at {paid.branchName}. We will tell you when your order is ready.</p>
          <Button onClick={onOrders}>View my orders</Button>
          <Button kind="ghost" onClick={onClose}>Back to the shop</Button>
        </div>
      )}
    </Sheet>
  );
}

// ---------------- my orders ----------------

function Orders({ q, onShop }: { q: ReturnType<typeof useAsync<any[]>>; onShop: () => void }) {
  const rows = q.data ?? [];
  const waiting = rows.some((o) => o.state === 'awaiting_payment');
  const reload = useRef(q.reload);
  reload.current = q.reload;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') reload.current(); }, 5000);
    return () => clearInterval(t);
  }, [waiting]);
  const [err, setErr] = useState('');
  const cancel = async (o: any) => {
    setErr('');
    try { await api.post(`/me/shop/orders/${o.id}/cancel`); q.reload(); } catch (e) { setErr(errText(e)); q.reload(); }
  };
  if (q.loading && !q.data) return <div className="card"><Skeleton lines={4} /></div>;
  if (q.error && !q.data) return <div className="stack"><ErrorNote>{q.error}</ErrorNote><Button kind="ghost" onClick={q.reload}>Try again</Button></div>;
  if (!rows.length) return <div className="empty-state"><Icon name="receipt" size={40} /><strong>No orders yet</strong><span>When you buy something from the shop, your order and collection code show here.</span><Button small onClick={onShop}>Go to the shop</Button></div>;
  return (
    <div className="stack">
      {err && <ErrorNote>{err}</ErrorNote>}
      <ul className="order-list">
        {rows.map((o) => {
          const s = STATE[o.state] ?? { label: o.state, tone: 'muted' };
          return (
            <li key={o.id} className={`order-card ${o.state}`}>
              <div className="order-top"><span className={`badge ${s.tone}`}>{s.label}</span><span className="tiny">{shortDate(o.createdAt)}</span></div>
              {o.state === 'ready' && <div className="ready-note"><Icon name="check" size={18} /> Ready to collect at {o.branchName}</div>}
              <ul className="order-items">
                {o.lines.map((l: any, i: number) => <li key={i}><span>{l.qty} x {l.name}</span><span>{kes(l.total)}</span></li>)}
              </ul>
              <div className="order-total"><span>Total</span><strong>{kes(o.total)}</strong></div>
              <div className="tiny">{o.branchName} · Receipt {o.receiptNo}</div>
              {o.collectionCode && ['to_prepare', 'ready'].includes(o.state) && (
                <div><div className="code-label">Collection code</div><div className="code-block small">{o.collectionCode}</div></div>
              )}
              {o.state === 'awaiting_payment' && (
                <div className="order-actions">
                  {o.payUrl
                    ? <button type="button" className="btn primary small" onClick={() => { try { localStorage.setItem(PENDING_KEY, JSON.stringify({ orderId: o.id, branchId: o.branchId })); } catch { /* ignore */ } window.location.assign(`${o.payUrl}?return=${encodeURIComponent(`${location.origin}/`)}`); }}>Pay now</button>
                    : <span className="tiny">Check your phone and enter your PIN.</span>}
                  <button type="button" className="link-btn" onClick={() => cancel(o)}>Cancel</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

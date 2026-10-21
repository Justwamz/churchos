import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ErrorNote, Field, kes, shortDate, useToast } from '@churchos/ui';
import { api, friendly, methodLabel, useSession } from './session';
import { Loaded } from './money-bits';
import { Card, EmptyState, Stat, StatTiles, StatusChip, Toolbar } from './ui';
import { Modal, useDebounced } from './MemberForm';
import './shop.css';

const STATES: [string, string][] = [['open', 'Open'], ['to_prepare', 'To prepare'], ['ready', 'Ready'], ['collected', 'Collected'], ['waiting', 'Waiting for payment']];
const TONE: Record<string, { text: string; tone: 'done' | 'wait' | 'info' | 'off' }> = {
  to_prepare: { text: 'To prepare', tone: 'info' }, ready: { text: 'Ready', tone: 'wait' }, collected: { text: 'Collected', tone: 'done' },
  waiting: { text: 'Waiting for payment', tone: 'wait' }, awaiting_payment: { text: 'Waiting for payment', tone: 'wait' },
};
const orderError = (e: any) => e?.code === 'wrong_code' ? 'That code does not match this order. Check it with the member.' : e?.code === 'wrong_state' ? 'This order has already moved on. The list has been refreshed.' : friendly(e?.message);

/** Number of orders to prepare, refreshed every 20 seconds. */
export function useOrderCount(branch: string, enabled: boolean) {
  const s = useSession();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => api.get<any[]>('/shop/orders' + s.qs({ branch, state: 'to_prepare' })).then((r) => alive && setN(r.length)).catch(() => {});
    load();
    const t = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch, enabled, s.grant.org.id]);
  return [n, setN] as const;
}

function HandOver({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const s = useSession();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { await api.post(`/shop/orders/${order.id}/collected` + s.qs({ branch: undefined }), { code: code.trim() || undefined }); onDone(); }
    catch (e: any) { setErr(orderError(e)); setBusy(false); if (e?.code === 'wrong_state') setTimeout(onDone, 1500); }
  };
  return (
    <Modal title={`Hand over ${order.receiptNo}`} onClose={onClose}>
      <div className="stack">
        <div>{order.buyer || 'The member'} is collecting <b>{order.items}</b>, {kes(order.total)}.</div>
        <Field label="Collection code from the member" hint="Ask the member to show the code in their app. You can leave it empty if you know them.">
          <input autoFocus value={code} maxLength={12} autoCapitalize="characters" style={{ textTransform: 'uppercase', letterSpacing: 2 }} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
        </Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button disabled={busy} onClick={go}>{busy ? 'Saving...' : 'Collected'}</Button><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  );
}

export function ShopOrders({ branch, onCount }: { branch: string; onCount?: (n: number) => void }) {
  const s = useSession();
  const toast = useToast();
  const [state, setState] = useState('open');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [hand, setHand] = useState<any>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const r = await api.get<any[]>('/shop/orders' + s.qs({ branch, state, q: dq || undefined }));
      if (my !== seq.current) return;
      setRows(r); setError('');
      if (state === 'open' && !dq) onCount?.(r.filter((o) => o.state === 'to_prepare').length);
    } catch (e: any) { if (my === seq.current) setError(friendly(e?.message)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch, state, dq, s.grant.org.id]);

  useEffect(() => {
    setRows(null);
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const ready = async (o: any) => {
    setBusyId(o.id);
    try { await api.post(`/shop/orders/${o.id}/ready` + s.qs({ branch: undefined }), {}); toast.show(`Marked ready. ${o.buyer || 'The member'} has been told.`); }
    catch (e: any) { toast.show(orderError(e), 'bad'); }
    setBusyId(''); load();
  };

  const open = state === 'open' && !dq;
  const nPrep = (rows ?? []).filter((o) => o.state === 'to_prepare').length;
  const nReady = (rows ?? []).filter((o) => o.state === 'ready').length;
  const nWait = (rows ?? []).filter((o) => o.state === 'waiting' || o.state === 'awaiting_payment').length;
  return (
    <>
      {open && rows && (
        <StatTiles>
          <Stat label="To prepare" value={nPrep} tone={nPrep ? 'info' : undefined} hint="Paid and waiting for you" onClick={() => setState('to_prepare')} />
          <Stat label="Ready" value={nReady} tone={nReady ? 'wait' : undefined} hint="Waiting for the member to collect" onClick={() => setState('ready')} />
          {nWait > 0 && <Stat label="Waiting for payment" value={nWait} hint="Not paid yet" onClick={() => setState('waiting')} />}
        </StatTiles>
      )}
      <section className="u-section shp-sec">
        <Toolbar>
          <input type="search" aria-label="Search orders" placeholder="Receipt, code or name" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="shp-chipset" role="group" aria-label="Order status">
            {STATES.map(([k, l]) => <button type="button" key={k} className={`chip ${state === k ? 'on' : ''}`} aria-pressed={state === k} onClick={() => setState(k)}>{l}</button>)}
          </div>
        </Toolbar>
        <div className="tiny" style={{ margin: '-4px 0 12px' }}>Members pay in the app. A paid order appears here to prepare. Mark it ready and the member is told, then hand it over against their code.</div>
        <Loaded loading={rows === null && !error} error={error && rows === null ? error : ''} hasData={rows !== null} rows={4}>
          {rows && (rows.length === 0 ? (
            <Card><EmptyState icon="receipt" title={open ? 'No orders to prepare' : 'No orders match'} text={open ? 'New paid orders show up here by themselves.' : 'Try another status or a different word.'} /></Card>
          ) : (
            <Card pad={false} className="mn-wrap">
              <div className="mn-scroll">
                <table className="mn-table">
                  <thead><tr><th>Receipt</th><th>Buyer</th><th>Items</th><th className="num">Total</th><th>Status</th><th>When</th><th /></tr></thead>
                  <tbody>
                    {rows.map((o) => {
                      const st = TONE[o.state] ?? { text: o.state, tone: 'off' as const };
                      const when = o.state === 'collected' ? o.collectedAt : o.state === 'ready' ? o.readyAt : o.createdAt;
                      return (
                        <tr key={o.id}>
                          <td className="mn-first"><span><b>{o.receiptNo}</b>{o.collectionCode && o.state !== 'waiting' && <span className="mn-sub">Code <span className="shp-code">{o.collectionCode}</span></span>}</span></td>
                          <td data-l="Buyer"><span>{o.buyer || '-'}{o.buyerPhone && <span className="mn-sub">{o.buyerPhone}</span>}</span></td>
                          <td data-l="Items" style={{ minWidth: 160 }}>{o.items}</td>
                          <td className="num" data-l="Total"><span><b>{kes(o.total)}</b>{o.method && <span className="mn-sub">{methodLabel(o.method)}</span>}</span></td>
                          <td data-l="Status"><StatusChip tone={st.tone}>{st.text}</StatusChip></td>
                          <td data-l="When" style={{ whiteSpace: 'nowrap' }}>{shortDate(when)}</td>
                          <td className="mn-act"><div className="mn-btns end">
                            {o.state === 'to_prepare' && <Button small disabled={busyId === o.id} onClick={() => ready(o)}>Mark ready</Button>}
                            {o.state === 'ready' && <Button small onClick={() => setHand(o)}>Hand over</Button>}
                            {o.state === 'to_prepare' && <Button small kind="ghost" onClick={() => setHand(o)}>Hand over</Button>}
                          </div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </Loaded>
      </section>
      {hand && <HandOver order={hand} onClose={() => setHand(null)} onDone={() => { setHand(null); toast.show('Handed over'); load(); }} />}
      {toast.node}
    </>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Empty, ErrorNote, Field, Note, Table, kes, shortDate, useToast } from '@churchos/ui';
import { api, friendly, methodLabel, useSession } from './session';
import { Load } from './bits';
import { Modal, useDebounced } from './MemberForm';
import './shop.css';

const STATES: [string, string][] = [['open', 'Open'], ['to_prepare', 'To prepare'], ['ready', 'Ready'], ['collected', 'Collected'], ['waiting', 'Waiting for payment']];
const TONE: Record<string, { text: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'muted' }> = {
  to_prepare: { text: 'To prepare', tone: 'warn' }, ready: { text: 'Ready', tone: 'info' }, collected: { text: 'Collected', tone: 'good' },
  waiting: { text: 'Waiting for payment', tone: 'muted' }, awaiting_payment: { text: 'Waiting for payment', tone: 'muted' },
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

  return (
    <div className="stack">
      <Note>Members pay in the app. When an order is paid it appears here to prepare. Mark it ready and the member is told, then hand it over against their code.</Note>
      <section className="card stack" style={{ gap: 12 }}>
        <div className="chips" role="group" aria-label="Order status">
          {STATES.map(([k, l]) => <button type="button" key={k} className={`chip ${state === k ? 'on' : ''}`} aria-pressed={state === k} onClick={() => setState(k)}>{l}</button>)}
        </div>
        <input type="search" aria-label="Search orders" placeholder="Receipt, code or name" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
      </section>
      <Load loading={rows === null && !error} error={error && rows === null ? error : ''} hasData={rows !== null}>
        {rows && (rows.length === 0 ? <Empty>{state === 'open' && !dq ? 'No orders to prepare right now. New paid orders show up here by themselves.' : 'No orders match.'}</Empty> : (
          <Table head={['Receipt', 'Buyer', 'Items', 'Total', 'Status', 'When', '']}>
            {rows.map((o) => {
              const st = TONE[o.state] ?? { text: o.state, tone: 'muted' as const };
              const when = o.state === 'collected' ? o.collectedAt : o.state === 'ready' ? o.readyAt : o.createdAt;
              return (
                <tr key={o.id}>
                  <td style={{ whiteSpace: 'nowrap' }}><b>{o.receiptNo}</b>{o.collectionCode && o.state !== 'waiting' && <div className="tiny">Code {o.collectionCode}</div>}</td>
                  <td style={{ minWidth: 120 }}>{o.buyer || '-'}{o.buyerPhone && <div className="tiny">{o.buyerPhone}</div>}</td>
                  <td style={{ minWidth: 160 }}>{o.items}</td>
                  <td className="sp-num"><b>{kes(o.total)}</b>{o.method && <div className="tiny">{methodLabel(o.method)}</div>}</td>
                  <td><Badge tone={st.tone}>{st.text}</Badge></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{shortDate(when)}</td>
                  <td><div className="row">
                    {o.state === 'to_prepare' && <Button small disabled={busyId === o.id} onClick={() => ready(o)}>Mark ready</Button>}
                    {(o.state === 'to_prepare' || o.state === 'ready') && <Button small kind={o.state === 'ready' ? 'primary' : 'ghost'} onClick={() => setHand(o)}>Hand over</Button>}
                  </div></td>
                </tr>
              );
            })}
          </Table>
        ))}
      </Load>
      {hand && <HandOver order={hand} onClose={() => setHand(null)} onDone={() => { setHand(null); toast.show('Handed over'); load(); }} />}
      {toast.node}
    </div>
  );
}

import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, Field, Stat, Table, kes, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, methodLabel as baseMethodLabel, useSession } from './session';
const methodLabel = (m: string) => (m === 'cash' ? 'Cash' : baseMethodLabel(m));
import { Load } from './bits';
import { Modal } from './MemberForm';
import { StockDialog } from './ShopItems';
import { useDebounced } from './MemberForm';
import './shop.css';

const eatDay = (offset = 0) => new Date(Date.now() + 3 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);
const startOf = (day: string) => new Date(`${day}T00:00:00+03:00`).toISOString();
const STATUS: Record<string, { text: string; tone: 'good' | 'warn' | 'bad' | 'muted' }> = {
  completed: { text: 'Completed', tone: 'good' }, awaiting_payment: { text: 'Waiting for payment', tone: 'warn' }, voided: { text: 'Voided', tone: 'bad' }, lapsed: { text: 'Lapsed', tone: 'muted' },
};
const chip = (on: boolean, label: string, f: () => void) => <button type="button" key={label} className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={f}>{label}</button>;

function SaleDialog({ sale, onClose, onDone }: { sale: any; onClose: () => void; onDone: (m: string) => void }) {
  const s = useSession();
  const d = useAsync<any>(() => api.get(`/shop/sales/${sale.id}` + s.qs({ branch: undefined })), [sale.id]);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const x = d.data ?? sale;
  const st = STATUS[x.status] ?? { text: x.status, tone: 'muted' as const };
  const doVoid = async () => {
    if (!reason.trim()) return setErr('Please say why.');
    setBusy(true); setErr('');
    try { await api.post(`/shop/sales/${sale.id}/void` + s.qs({ branch: undefined }), { reason: reason.trim(), restock }); onDone('Sale voided'); } catch (e: any) { setErr(friendly(e?.message)); setBusy(false); }
  };
  return (
    <Modal title={`Receipt ${sale.receiptNo}`} onClose={onClose}>
      <div className="stack">
        <div className="row"><Badge tone={st.tone}>{st.text}</Badge><span className="tiny">{shortDate(x.createdAt)} · {methodLabel(x.method)} · sold by {x.soldBy || '-'}</span></div>
        <Load loading={d.loading} error={d.error} hasData={!!d.data}>
          <Table head={['Item', 'Qty', 'Price', 'Total']}>
            {(d.data?.lines ?? []).map((l: any, i: number) => <tr key={i}><td>{l.name}</td><td className="sp-num">{l.qty}</td><td className="sp-num">{kes(l.unitPrice)}</td><td className="sp-num">{kes(l.total)}</td></tr>)}
          </Table>
        </Load>
        <div className="row between"><span>Buyer: {x.buyer || 'Not recorded'}</span><b style={{ fontSize: 18 }}>{kes(x.total)}</b></div>
        {x.voidReason && <div className="note warn">Voided: {x.voidReason}</div>}
        {x.canVoid && !voiding && (
          <>
            <div className="tiny">Only cash sales can be voided, within 24 hours. For mobile money or card, ask for a reversal in Payment help.</div>
            <div><Button kind="danger" small onClick={() => setVoiding(true)}>Void this sale</Button></div>
          </>
        )}
        {x.canVoid && voiding && (
          <div className="stack">
            <Field label="Why is it being voided?"><input maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
            <label className="row" style={{ gap: 6, flexWrap: 'nowrap' }}><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Put the items back in stock</label>
            {err && <ErrorNote>{err}</ErrorNote>}
            <div className="row"><Button kind="danger" disabled={busy} onClick={doVoid}>{busy ? 'Saving...' : 'Void the sale'}</Button><Button kind="ghost" onClick={() => setVoiding(false)}>Back</Button></div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function ShopSales({ branch }: { branch: string }) {
  const s = useSession();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim());
  const [status, setStatus] = useState('');
  const [when, setWhen] = useState('today');
  const [open, setOpen] = useState<any>(null);
  const from = when === 'today' ? startOf(eatDay()) : when === 'week' ? startOf(eatDay(-6)) : when === 'month' ? startOf(eatDay().slice(0, 8) + '01') : undefined;
  const list = useAsync<any[]>(() => api.get('/shop/sales' + s.qs({ branch, status: status || undefined, from, q: term || undefined })), [branch, status, when, term, s.grant.org.id]);
  const cancel = async (x: any) => {
    try { await api.post(`/shop/sales/${x.id}/cancel` + s.qs({ branch: undefined }), {}); toast.show('Sale cancelled'); list.reload(); } catch (e: any) { toast.show(friendly(e?.message), 'bad'); }
  };
  const rows = list.data ?? [];
  return (
    <div className="stack">
      <section className="card stack" style={{ gap: 14 }}>
        <label className="field" style={{ margin: 0 }}><span className="field-label">Search</span><input type="search" maxLength={60} placeholder="Receipt number, buyer or item" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <div className="row" style={{ gap: 24 }}>
          <div className="chips" role="group" aria-label="Status">
            {[['', 'All'], ['completed', 'Completed'], ['awaiting_payment', 'Waiting for payment'], ['voided', 'Voided'], ['lapsed', 'Lapsed']].map(([k, l]) => chip(status === k, l, () => setStatus(k)))}
          </div>
          <div className="chips" role="group" aria-label="Dates">
            {[['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['all', 'All']].map(([k, l]) => chip(when === k, l, () => setWhen(k)))}
          </div>
        </div>
      </section>
      <Load loading={list.loading} error={list.error} hasData={!!list.data}>
        {list.data && (rows.length === 0 ? <Empty>No sales match these choices.</Empty> : (
          <Table head={['Receipt', 'When', 'Items', 'Buyer', 'Method', 'Total', 'Status', 'Sold by', '']}>
            {rows.map((x) => {
              const st = STATUS[x.status] ?? { text: x.status, tone: 'muted' as const };
              return (
                <tr key={x.id}>
                  <td><b>{x.receiptNo}</b></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{shortDate(x.createdAt)}</td>
                  <td style={{ minWidth: 160 }}>{x.items}</td>
                  <td>{x.buyer || '-'}</td>
                  <td>{methodLabel(x.method)}</td>
                  <td className="sp-num">{kes(x.total)}</td>
                  <td><Badge tone={st.tone}>{st.text}</Badge></td>
                  <td>{x.soldBy || '-'}</td>
                  <td><div className="row">
                    <Button small kind="ghost" onClick={() => setOpen(x)}>Details</Button>
                    {x.status === 'awaiting_payment' && s.can('shop.sell') && <Button small kind="ghost" onClick={() => cancel(x)}>Cancel</Button>}
                  </div></td>
                </tr>
              );
            })}
          </Table>
        ))}
      </Load>
      {open && <SaleDialog sale={open} onClose={() => setOpen(null)} onDone={(m) => { setOpen(null); toast.show(m); list.reload(); }} />}
      {toast.node}
    </div>
  );
}

const RANGES: [string, string, () => string][] = [
  ['7', '7 days', () => startOf(eatDay(-6))], ['30', '30 days', () => startOf(eatDay(-29))],
  ['month', 'This month', () => startOf(eatDay().slice(0, 8) + '01')], ['90', '90 days', () => startOf(eatDay(-89))],
];

export function ShopReports({ branch }: { branch: string }) {
  const s = useSession();
  const toast = useToast();
  const [range, setRange] = useState('30');
  const [receive, setReceive] = useState<any>(null);
  const r = useAsync<any>(() => api.get('/shop/reports' + s.qs({ branch, from: RANGES.find((x) => x[0] === range)![2]() })), [branch, range, s.grant.org.id]);
  const d = r.data;
  const maxDay = Math.max(1, ...(d?.byDay ?? []).map((x: any) => x.revenue));
  const items = useAsync<any[]>(() => (s.can('shop.manage') ? api.get('/shop/items' + s.qs({ branch })) : Promise.resolve([])), [branch, s.grant.org.id]);
  return (
    <div className="stack">
      <div className="chips" role="group" aria-label="Period">{RANGES.map(([k, l]) => chip(range === k, l, () => setRange(k)))}</div>
      <Load loading={r.loading} error={r.error} hasData={!!d}>
        {d && (
          <>
            <div className="grid cols-4">
              <Stat label="Takings" value={kes(d.totals.revenue)} />
              <Stat label="Sales" value={d.totals.sales} />
              <Stat label="Items sold" value={d.totals.units} />
              {d.canSeeCost && <Stat label="Cost" value={kes(d.totals.cost)} hint={d.totals.costUnknownLines ? `${d.totals.costUnknownLines} sold without a cost price` : undefined} />}
              {d.canSeeCost && <Stat label="Margin" value={kes(d.totals.margin)} tone="good" />}
              {d.stockValue !== null && d.stockValue !== undefined && <Stat label="Stock value at cost" value={kes(d.stockValue)} />}
            </div>
            <Card title="Takings by day">
              {d.byDay.length === 0 ? <Empty>No sales in this period.</Empty> : (
                <>
                  <div className="sp-bars">
                    {d.byDay.map((x: any) => <div className="sp-bar-col" key={x.day} title={`${x.day}: ${kes(x.revenue)} from ${x.sales} sales`}><i style={{ height: `${Math.max(2, (x.revenue / maxDay) * 100)}%` }} /></div>)}
                  </div>
                  <div className="sp-axis">{d.byDay.map((x: any) => <span key={x.day}>{x.day.slice(8)}</span>)}</div>
                  <div className="tiny" style={{ marginTop: 6 }}>Each bar is one day (day of the month shown below). Busiest day: {kes(maxDay)}.</div>
                </>
              )}
            </Card>
            <div className="grid cols-2">
              <Card title="Best sellers">
                {d.byItem.length === 0 ? <Empty>Nothing sold yet.</Empty> : (
                  <Table head={['Item', 'Sold', 'Takings', ...(d.canSeeCost ? ['Margin'] : [])]}>
                    {d.byItem.map((x: any) => <tr key={x.name}><td>{x.name}</td><td className="sp-num">{x.units}</td><td className="sp-num">{kes(x.revenue)}</td>{d.canSeeCost && <td className="sp-num">{x.margin != null ? kes(x.margin) : '-'}</td>}</tr>)}
                  </Table>
                )}
              </Card>
              <div className="stack">
                <Card title="By category">
                  {d.byCategory.length === 0 ? <Empty>Nothing sold yet.</Empty> : (
                    <Table head={['Category', 'Sold', 'Takings']}>
                      {d.byCategory.map((x: any) => <tr key={x.category ?? 'none'}><td>{x.category || 'No category'}</td><td className="sp-num">{x.units}</td><td className="sp-num">{kes(x.revenue)}</td></tr>)}
                    </Table>
                  )}
                </Card>
                <Card title="How people paid">
                  {d.byMethod.length === 0 ? <Empty>Nothing sold yet.</Empty> : (
                    <Table head={['Method', 'Sales', 'Takings']}>
                      {d.byMethod.map((x: any) => <tr key={x.method}><td>{methodLabel(x.method)}</td><td className="sp-num">{x.sales}</td><td className="sp-num">{kes(x.revenue)}</td></tr>)}
                    </Table>
                  )}
                </Card>
              </div>
            </div>
            <Card title="Running low">
              {d.lowStock.length === 0 ? <Empty>Nothing is running low.</Empty> : (
                <Table head={['Item', 'In stock', 'Warn at', '']}>
                  {d.lowStock.map((x: any) => (
                    <tr key={x.id}><td>{x.name}</td><td className="sp-num"><b>{x.stock}</b></td><td className="sp-num">{x.lowStock}</td>
                      <td>{s.can('shop.manage') && <Button small onClick={() => { const it = items.data?.find((i) => i.id === x.id); if (it) setReceive(it); }}>Receive stock</Button>}</td></tr>
                  ))}
                </Table>
              )}
            </Card>
          </>
        )}
      </Load>
      {receive && <StockDialog item={receive} kind="received" onClose={() => setReceive(null)} onSaved={(m) => { setReceive(null); toast.show(m); r.reload(); items.reload(); }} />}
      {toast.node}
    </div>
  );
}

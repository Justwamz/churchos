import { useState } from 'react';
import { Button, ErrorNote, Field, kes, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, methodLabel as baseMethodLabel, useSession } from './session';
const methodLabel = (m: string) => (m === 'cash' ? 'Cash' : baseMethodLabel(m));
import { Loaded } from './money-bits';
import { useDebounced } from './MemberForm';
import { StockDialog } from './ShopItems';
import { Card, EmptyState, SidePanel, Section, Stat, StatTiles, StatusChip, Toolbar } from './ui';
import './shop.css';

const eatDay = (offset = 0) => new Date(Date.now() + 3 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);
const startOf = (day: string) => new Date(`${day}T00:00:00+03:00`).toISOString();
const STATUS: Record<string, { text: string; tone: 'done' | 'wait' | 'bad' | 'off' }> = {
  completed: { text: 'Completed', tone: 'done' }, awaiting_payment: { text: 'Waiting for payment', tone: 'wait' }, voided: { text: 'Voided', tone: 'bad' }, lapsed: { text: 'Lapsed', tone: 'off' },
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
  const st = STATUS[x.status] ?? { text: x.status, tone: 'off' as const };
  const doVoid = async () => {
    if (!reason.trim()) return setErr('Please say why.');
    setBusy(true); setErr('');
    try { await api.post(`/shop/sales/${sale.id}/void` + s.qs({ branch: undefined }), { reason: reason.trim(), restock }); onDone('Sale voided'); } catch (e: any) { setErr(friendly(e?.message)); setBusy(false); }
  };
  return (
    <SidePanel
      title={`Receipt ${sale.receiptNo}`}
      subtitle={`${shortDate(x.createdAt)} · ${methodLabel(x.method)} · sold by ${x.soldBy || '-'}`}
      onClose={onClose}
      footer={voiding
        ? <><Button kind="danger" disabled={busy} onClick={doVoid}>{busy ? 'Saving...' : 'Void the sale'}</Button><Button kind="ghost" onClick={() => setVoiding(false)}>Back</Button></>
        : <Button kind="ghost" onClick={onClose}>Close</Button>}
    >
      <div className="stack">
        <div className="shp-sub"><StatusChip tone={st.tone}>{st.text}</StatusChip></div>
        <Loaded loading={d.loading} error={d.error} hasData={!!d.data} rows={3} height={40}>
          <table className="shp-mini">
            <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Total</th></tr></thead>
            <tbody>{(d.data?.lines ?? []).map((l: any, i: number) => <tr key={i}><td>{l.name}</td><td className="num">{l.qty}</td><td className="num">{kes(l.unitPrice)}</td><td className="num">{kes(l.total)}</td></tr>)}</tbody>
          </table>
        </Loaded>
        <div className="shp-total-row"><span>Buyer: {x.buyer || 'Not recorded'}</span><b>{kes(x.total)}</b></div>
        {x.voidReason && <div className="note warn">Voided: {x.voidReason}</div>}
        {x.canVoid && !voiding && (
          <>
            <div className="tiny">Only cash sales can be voided, within 24 hours. For mobile money or card, ask for a reversal in Payment help.</div>
            <div><Button kind="danger" small onClick={() => setVoiding(true)}>Void this sale</Button></div>
          </>
        )}
        {x.canVoid && voiding && (
          <div className="shp-void">
            <Field label="Why is it being voided?"><input maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
            <label className="shp-check"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Put the items back in stock</label>
            {err && <ErrorNote>{err}</ErrorNote>}
          </div>
        )}
      </div>
    </SidePanel>
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
  const takings = rows.filter((x) => x.status === 'completed').reduce((a, x) => a + x.total, 0);
  const waiting = rows.filter((x) => x.status === 'awaiting_payment').length;
  const filtered = !!status || !!term || when !== 'today';
  return (
    <>
      {list.data && (
        <StatTiles>
          <Stat label="Takings" value={kes(takings)} tone={takings ? 'good' : undefined} />
          <Stat label="Sales" value={rows.length} />
          {waiting > 0 && <Stat label="Waiting for payment" value={waiting} tone={waiting ? 'wait' : undefined} hint={waiting ? 'Tap to see them' : undefined} onClick={() => setStatus("awaiting_payment")} />}
        </StatTiles>
      )}
      <section className="u-section shp-sec">
        <Toolbar>
          <input type="search" aria-label="Search sales" maxLength={60} placeholder="Receipt number, buyer or item" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {[['', 'All statuses'], ['completed', 'Completed'], ['awaiting_payment', 'Waiting for payment'], ['voided', 'Voided'], ['lapsed', 'Lapsed']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <div className="shp-chipset" role="group" aria-label="Dates">
            {[['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['all', 'All']].map(([k, l]) => chip(when === k, l, () => setWhen(k)))}
          </div>
        </Toolbar>
        <Loaded loading={list.loading} error={list.error} hasData={!!list.data} rows={5}>
          {list.data && (rows.length === 0 ? <Card><EmptyState icon="receipt" title={filtered ? 'No sales match' : 'No sales yet today'} text={filtered ? 'Try another date range or clear a filter.' : 'Sales made at the till show up here.'} /></Card> : (
            <Card pad={false} className="mn-wrap">
              <div className="mn-scroll">
                <table className="mn-table">
                  <thead><tr><th>Receipt</th><th>When</th><th>Items</th><th>Buyer</th><th>Paid by</th><th className="num">Total</th><th>Status</th><th>Sold by</th><th /></tr></thead>
                  <tbody>
                    {rows.map((x) => {
                      const st = STATUS[x.status] ?? { text: x.status, tone: 'off' as const };
                      return (
                        <tr key={x.id} className="tap" onClick={() => setOpen(x)}>
                          <td className="mn-first"><b>{x.receiptNo}</b></td>
                          <td data-l="When" style={{ whiteSpace: 'nowrap' }}>{shortDate(x.createdAt)}</td>
                          <td data-l="Items" style={{ minWidth: 160 }}>{x.items}</td>
                          <td data-l="Buyer">{x.buyer || '-'}</td>
                          <td data-l="Paid by" style={{ whiteSpace: 'nowrap' }}>{methodLabel(x.method)}</td>
                          <td className="num" data-l="Total"><b>{kes(x.total)}</b></td>
                          <td data-l="Status"><StatusChip tone={st.tone}>{st.text}</StatusChip></td>
                          <td data-l="Sold by">{x.soldBy || '-'}</td>
                          <td className="mn-act" onClick={(e) => e.stopPropagation()}>
                            {x.status === 'awaiting_payment' && s.can('shop.sell') ? <Button small kind="ghost" onClick={() => cancel(x)}>Cancel</Button> : <Button small kind="ghost" onClick={() => setOpen(x)}>Details</Button>}
                          </td>
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
      {open && <SaleDialog sale={open} onClose={() => setOpen(null)} onDone={(m) => { setOpen(null); toast.show(m); list.reload(); }} />}
      {toast.node}
    </>
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
  const none = (text: string) => <EmptyState icon="list" title={text} />;
  return (
    <>
      <Toolbar>
        <div className="shp-chipset" role="group" aria-label="Period">{RANGES.map(([k, l]) => chip(range === k, l, () => setRange(k)))}</div>
      </Toolbar>
      <Loaded loading={r.loading} error={r.error} hasData={!!d} rows={4} height={90}>
        {d && (
          <>
            <StatTiles>
              <Stat label="Takings" value={kes(d.totals.revenue)} />
              <Stat label="Sales" value={d.totals.sales} />
              <Stat label="Items sold" value={d.totals.units} />
              {d.canSeeCost && <Stat label="Cost" value={kes(d.totals.cost)} hint={d.totals.costUnknownLines ? `${d.totals.costUnknownLines} sold without a cost price` : undefined} />}
              {d.canSeeCost && <Stat label="Margin" value={kes(d.totals.margin)} tone="good" />}
              {d.stockValue !== null && d.stockValue !== undefined && <Stat label="Stock value at cost" value={kes(d.stockValue)} />}
            </StatTiles>
            <Section title="Takings by day">
              <Card>
                {d.byDay.length === 0 ? none('No sales in this period') : (
                  <>
                    <div className="shp-bars-wrap">
                      <div className="sp-bars">
                        {d.byDay.map((x: any) => <div className="sp-bar-col" key={x.day} title={`${x.day}: ${kes(x.revenue)} from ${x.sales} sales`}><i style={{ height: `${Math.max(2, (x.revenue / maxDay) * 100)}%` }} /></div>)}
                      </div>
                      <div className="sp-axis">{d.byDay.map((x: any) => <span key={x.day}>{x.day.slice(8)}</span>)}</div>
                    </div>
                    <div className="tiny" style={{ marginTop: 8 }}>Each bar is one day (day of the month shown below). Busiest day: {kes(maxDay)}.</div>
                  </>
                )}
              </Card>
            </Section>
            <div className="shp-two">
              <Section title="Best sellers">
                <Card>
                  {d.byItem.length === 0 ? none('Nothing sold yet') : (
                    <table className="shp-mini">
                      <thead><tr><th>Item</th><th className="num">Sold</th><th className="num">Takings</th>{d.canSeeCost && <th className="num">Margin</th>}</tr></thead>
                      <tbody>{d.byItem.map((x: any) => <tr key={x.name}><td>{x.name}</td><td className="num">{x.units}</td><td className="num">{kes(x.revenue)}</td>{d.canSeeCost && <td className="num">{x.margin != null ? kes(x.margin) : '-'}</td>}</tr>)}</tbody>
                    </table>
                  )}
                </Card>
              </Section>
              <div>
                <Section title="By category">
                  <Card>
                    {d.byCategory.length === 0 ? none('Nothing sold yet') : (
                      <table className="shp-mini">
                        <thead><tr><th>Category</th><th className="num">Sold</th><th className="num">Takings</th></tr></thead>
                        <tbody>{d.byCategory.map((x: any) => <tr key={x.category ?? 'none'}><td>{x.category || 'No category'}</td><td className="num">{x.units}</td><td className="num">{kes(x.revenue)}</td></tr>)}</tbody>
                      </table>
                    )}
                  </Card>
                </Section>
                <Section title="How people paid">
                  <Card>
                    {d.byMethod.length === 0 ? none('Nothing sold yet') : (
                      <table className="shp-mini">
                        <thead><tr><th>Method</th><th className="num">Sales</th><th className="num">Takings</th></tr></thead>
                        <tbody>{d.byMethod.map((x: any) => <tr key={x.method}><td>{methodLabel(x.method)}</td><td className="num">{x.sales}</td><td className="num">{kes(x.revenue)}</td></tr>)}</tbody>
                      </table>
                    )}
                  </Card>
                </Section>
              </div>
            </div>
            <Section title="Running low">
              <Card>
                {d.lowStock.length === 0 ? none('Nothing is running low') : (
                  <table className="shp-mini">
                    <thead><tr><th>Item</th><th className="num">In stock</th><th className="num">Warn at</th><th /></tr></thead>
                    <tbody>
                      {d.lowStock.map((x: any) => (
                        <tr key={x.id}><td>{x.name}</td><td className="num"><b>{x.stock}</b></td><td className="num">{x.lowStock}</td>
                          <td className="num">{s.can('shop.manage') && <Button small onClick={() => { const it = items.data?.find((i) => i.id === x.id); if (it) setReceive(it); }}>Receive stock</Button>}</td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </Section>
          </>
        )}
      </Loaded>
      {receive && <StockDialog item={receive} kind="received" onClose={() => setReceive(null)} onSaved={(m) => { setReceive(null); toast.show(m); r.reload(); items.reload(); }} />}
      {toast.node}
    </>
  );
}

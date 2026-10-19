import { useState } from 'react';
import { kes, shortDate, useAsync } from '@churchos/ui';
import { api, label, methodLabel, useSession } from './session';
import { Card, EmptyState, PageHeader, Section, SidePanel, Stat, StatTiles } from './ui';
import { Loaded, PayChip } from './money-bits';
import './money.css';

export function Settlements() {
  const s = useSession();
  const d = useAsync<any>(() => api.get('/settlements' + s.qs()), [s.qs()]);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useAsync<any>(() => (open ? api.get(`/settlements/${open}` + s.qs()) : Promise.resolve(undefined)), [open]);
  const x = d.data;
  const sum = (k: string) => (x ? x.balances.reduce((t: number, b: any) => t + Number(b[k] ?? 0), 0) : 0);
  return (
    <>
      <PageHeader title="Settlements" subtitle="Funds are paid out daily after the 48 hour hold. Any amount a branch owes is netted from its next payout." />
      <Loaded loading={d.loading} error={d.error} hasData={!!x} rows={4} height={92}>
        {x && (
          <>
            <StatTiles>
              <Stat label="In 48 hour hold" value={kes(sum('pending'))} tone="wait" />
              <Stat label="Ready to pay out" value={kes(sum('available'))} tone="good" />
              <Stat label="Owed" value={kes(sum('receivable'))} hint="Netted from the next payout" />
            </StatTiles>
            <Section title="Balances by branch">
              {x.balances.length === 0 ? <Card><EmptyState icon="building" title="No branches" /></Card> : (
                <Card pad={false} className="mn-wrap">
                  <div className="mn-scroll">
                    <table className="mn-table">
                      <thead><tr><th>Branch</th><th className="num">In 48h hold</th><th className="num">Ready to pay out</th><th className="num">Owed</th></tr></thead>
                      <tbody>
                        {x.balances.map((b: any) => (
                          <tr key={b.id}><td className="mn-first" data-l="Branch"><span><b>{b.name}</b><span className="mn-sub">{b.code}</span></span></td><td className="num" data-l="In 48h hold">{kes(b.pending)}</td><td className="num" data-l="Ready to pay out">{kes(b.available)}</td><td className="num" data-l="Owed">{kes(b.receivable)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </Section>
            <Section title="Payouts" hint="Select a payout to see its payments">
              {x.payouts.length === 0 ? <Card><EmptyState icon="wallet" title="No payouts yet" text="The first one appears once funds clear the 48 hour hold." /></Card> : (
                <Card pad={false} className="mn-wrap">
                  <div className="mn-scroll">
                    <table className="mn-table">
                      <thead><tr><th>Date</th><th>Branch</th><th className="num">Payments</th><th className="num">Gross</th><th className="num">Debt netted</th><th className="num">Paid</th><th>Status</th></tr></thead>
                      <tbody>
                        {x.payouts.map((p: any) => (
                          <tr key={p.id} className="tap" onClick={() => setOpen(p.id)}>
                            <td className="mn-first" data-l="Date">{shortDate(p.created_at)}</td><td data-l="Branch">{p.branch}</td><td className="num" data-l="Payments">{p.payments}</td>
                            <td className="num" data-l="Gross">{kes(p.gross)}</td><td className="num" data-l="Debt netted">{kes(p.netted)}</td><td className="num" data-l="Paid"><b>{kes(p.paid)}</b></td>
                            <td data-l="Status"><PayChip status={p.status} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </Section>
          </>
        )}
      </Loaded>
      {open && (
        <SidePanel title="Payout detail" subtitle={(() => { const p = x?.payouts.find((q: any) => q.id === open); return p ? `${p.branch} · ${shortDate(p.created_at)}` : undefined; })()} onClose={() => setOpen(null)} width={640}>
          <Loaded loading={detail.loading} error={detail.error} hasData={!!detail.data} rows={4} height={64}>
            {detail.data && (
              <div className="stack">
                <StatTiles>
                  <Stat label="Gross" value={kes(detail.data.payout.gross)} />
                  <Stat label="Debt netted" value={kes(detail.data.payout.netted)} tone={Number(detail.data.payout.netted) ? 'wait' : undefined} />
                  <Stat label="Paid to church" value={kes(detail.data.payout.amount)} tone="good" />
                  <Stat label="Payments" value={detail.data.payments.length} />
                </StatTiles>
                <div className="mn-scroll">
                  <table className="mn-table">
                    <thead><tr><th>Received</th><th>Method</th><th>Purpose</th><th className="num">Gross</th><th className="num">Fee</th><th className="num">Net</th></tr></thead>
                    <tbody>
                      {detail.data.payments.map((p: any) => (
                        <tr key={p.id}><td className="mn-first" data-l="Received">{shortDate(p.received_at)}</td><td data-l="Method">{methodLabel(p.method)}</td><td data-l="Purpose">{label(p.purpose)}</td><td className="num" data-l="Gross">{kes(p.gross)}</td><td className="num" data-l="Fee">{kes(p.fee)}</td><td className="num" data-l="Net">{kes(p.net)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {detail.data.payments.some((p: any) => p.method === 'anonymous') && <p className="mn-flat-note">Anonymous gifts are shown as one total for each day. The church cannot see who gave them.</p>}
              </div>
            )}
          </Loaded>
        </SidePanel>
      )}
    </>
  );
}

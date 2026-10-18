import { useState } from 'react';
import { Card, Empty, Note, Stat, StatusBadge, Table, kes, shortDate, useAsync } from '@churchos/ui';
import { api, label, methodLabel, useSession } from './session';
import { Load, PageHead } from './bits';

export function Settlements() {
  const s = useSession();
  const d = useAsync<any>(() => api.get('/settlements' + s.qs()), [s.qs()]);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useAsync<any>(() => (open ? api.get(`/settlements/${open}` + s.qs()) : Promise.resolve(undefined)), [open]);
  const x = d.data;
  return (
    <>
      <PageHead title="Settlements" sub="What is held, what is ready, and what has been paid out." />
      <Note tone="info">Funds are paid out daily after the 48 hour hold. Any amount a branch owes is netted from its next payout.</Note>
      <Load loading={d.loading} error={d.error} hasData={!!x}>
        {x && (
          <div className="stack" style={{ marginTop: 12 }}>
            <Card title="Balances by branch">
              {x.balances.length === 0 ? <Empty>No branches.</Empty> : (
                <Table head={['Branch', 'In 48h hold', 'Ready to pay out', 'Owed']}>
                  {x.balances.map((b: any) => (
                    <tr key={b.id}><td><b>{b.name}</b> <span className="tiny">{b.code}</span></td><td className="num">{kes(b.pending)}</td><td className="num">{kes(b.available)}</td><td className="num">{kes(b.receivable)}</td></tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card title="Payouts" action={<span className="tiny">Select a payout to see its payments</span>}>
              {x.payouts.length === 0 ? <Empty>No payouts yet. The first one appears once funds clear the 48 hour hold.</Empty> : (
                <Table head={['Date', 'Branch', 'Payments', 'Gross', 'Debt netted', 'Paid', 'Status']}>
                  {x.payouts.map((p: any) => (
                    <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(open === p.id ? null : p.id)}>
                      <td>{shortDate(p.created_at)}</td><td>{p.branch}</td><td className="num">{p.payments}</td>
                      <td className="num">{kes(p.gross)}</td><td className="num">{kes(p.netted)}</td><td className="num"><b>{kes(p.paid)}</b></td>
                      <td><StatusBadge status={p.status} /></td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
            {open && (
              <Card title="Payout detail" action={<button className="btn ghost small" onClick={() => setOpen(null)}>Close</button>}>
                <Load loading={detail.loading} error={detail.error} hasData={!!detail.data}>
                  {detail.data && (
                    <>
                      <div className="grid cols-4" style={{ marginBottom: 12 }}>
                        <Stat label="Gross" value={kes(detail.data.payout.gross)} />
                        <Stat label="Debt netted" value={kes(detail.data.payout.netted)} tone={Number(detail.data.payout.netted) ? 'warn' : undefined} />
                        <Stat label="Paid to church" value={kes(detail.data.payout.amount)} tone="good" />
                        <Stat label="Payments" value={detail.data.payments.length} />
                      </div>
                      <Table head={['Received', 'Method', 'Purpose', 'Gross', 'Fee', 'Net']}>
                        {detail.data.payments.map((p: any) => (
                          <tr key={p.id}><td>{shortDate(p.received_at)}</td><td>{methodLabel(p.method)}</td><td>{label(p.purpose)}</td><td className="num">{kes(p.gross)}</td><td className="num">{kes(p.fee)}</td><td className="num">{kes(p.net)}</td></tr>
                        ))}
                      </Table>
                      {detail.data.payments.some((p: any) => p.method === 'anonymous') && <p className="tiny">Anonymous gifts are shown as one total for each day. The church cannot see who gave them.</p>}
                    </>
                  )}
                </Load>
              </Card>
            )}
          </div>
        )}
      </Load>
    </>
  );
}

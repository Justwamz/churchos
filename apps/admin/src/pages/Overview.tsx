import { useEffect, useState } from 'react';
import { Button, kes, shortDate, useAsync } from '@churchos/ui';
import { Table } from '@churchos/ui';
import { Icon } from '../icons';
import { Card, EmptyState, PageHeader, Section, Skeleton, Stat, StatTiles } from '../ui';
import { Load, api, num, type PageProps } from '../common';

const ACC: Record<string, string> = {
  suspense: 'Unmatched payments (suspense)', fee_revenue: 'Platform fees earned', psp_cost_payable: 'Owed to payment providers',
  in_transit: 'Payouts in transit', branch_pending: 'Churches: in 48h hold', branch_available: 'Churches: ready to pay out',
  branch_receivable: 'Churches: owed to us', branch_paused: 'Churches: paused',
};

/** A calm banner: green when fine, red when not. */
function Banner({ ok, title, children, action, alert }: { ok: boolean; title: string; children?: React.ReactNode; action?: React.ReactNode; alert?: boolean }) {
  return (
    <div className={`pa-banner ${ok ? 'ok' : 'bad'}`} role={alert ? 'alert' : undefined}>
      <span className="pa-banner-ico"><Icon name={ok ? 'check' : 'alert'} size={22} /></span>
      <div className="pa-banner-main">
        <div className="pa-banner-title">{title}</div>
        {children}
      </div>
      {action}
    </div>
  );
}

function AuditBanner() {
  const [v, setV] = useState<any>();
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try { setV(await api.get('/admin/audit/verify')); } catch { /* ignore quietly */ }
    setBusy(false);
  };
  useEffect(() => { check(); }, []);
  if (!v) return busy ? <Skeleton height={64} /> : null;
  const chains: any[] = v.chains ?? [];
  const failing = chains.filter((c) => !c.ok);
  const ok = v.ok !== false && failing.length === 0;
  const total = chains.reduce((n, c) => n + num(c.events), 0);
  return (
    <Banner ok={ok} alert={!ok} title={ok ? `Audit log verified: ${total.toLocaleString()} events across ${chains.length} logs` : 'The audit log does not verify'}
      action={<Button kind="ghost" small onClick={check} disabled={busy}>{busy ? 'Checking…' : 'Verify again'}</Button>}>
      {ok
        ? <div className="pa-banner-text">Nothing changed or removed.</div>
        : failing.map((c, i) => <div key={i} className="pa-banner-text">Log {String(c.chain)}: {c.reason} (event number {String(c.brokenAtSeq)})</div>)}
    </Banner>
  );
}

export function Overview({ go }: PageProps) {
  const rec = useAsync(() => api.get('/admin/reconcile'));
  const rev = useAsync(() => api.get('/admin/revenue'));
  const sus = useAsync(() => api.get('/admin/suspense'));
  const rr = useAsync(() => api.get('/admin/reversal-requests?status=pending,awaiting_second'));
  const kycQ = useAsync(() => api.get<any[]>('/admin/kyc').catch(() => null as any));
  const prQ = useAsync(() => api.get<any[]>('/admin/payout-requests').catch(() => null as any));
  const msgQ = useAsync(() => api.get<any>('/admin/messaging').catch(() => null as any));
  const walletsLow = msgQ.data && Array.isArray(msgQ.data.organisations)
    ? msgQ.data.organisations.reduce((n: number, o: any) => n + (o.wallets ?? []).filter((w: any) => w.state !== 'ok').length, 0) : null;
  const docsWaiting = Array.isArray(kycQ.data) ? kycQ.data.reduce((n: number, o: any) => n + num(o.pendingDocuments), 0) : null;
  const payoutsWaiting = Array.isArray(prQ.data) ? prQ.data.filter((r: any) => r.status === 'requested').length : null;
  const reload = () => { rec.reload(); rev.reload(); sus.reload(); rr.reload(); kycQ.reload(); prQ.reload(); msgQ.reload(); };
  const tone = (n: number) => (n ? 'wait' : 'good') as 'wait' | 'good';

  return (
    <>
      <PageHeader title="Overview" subtitle="Is the money where it should be?" actions={<Button kind="ghost" onClick={reload}>Refresh</Button>} />

      <Section>
        <Load s={rec} rows={1}>
          {(r: any) => (
            <div className={`pa-banner big ${r.ok ? 'ok' : 'bad'}`} role={r.ok ? undefined : 'alert'}>
              <span className="pa-banner-ico"><Icon name={r.ok ? 'check' : 'alert'} size={26} /></span>
              <div className="pa-banner-main">
                <div className="pa-banner-kicker">Money integrity</div>
                <div className="pa-banner-title">{r.ok ? 'Balanced' : 'Mismatch'}</div>
                <div className="pa-banner-text">{r.ok ? 'Our ledger agrees with the payment provider wallet to the cent.' : 'Our ledger and the provider wallet disagree. Investigate before running settlement.'}</div>
              </div>
              <div className="pa-figs">
                <div><span className="tiny">Ledger wallet</span><b>{kes(r.ledgerWallet)}</b></div>
                <div><span className="tiny">Provider wallet</span><b>{kes(r.pspWallet)}</b></div>
                <div><span className="tiny">Difference</span><b className={num(r.difference) === 0 ? 'good' : 'bad'}>{kes(r.difference)}</b><span className="tiny">{r.zeroSum ? 'Ledger entries sum to zero' : 'Ledger entries do NOT sum to zero'}</span></div>
              </div>
            </div>
          )}
        </Load>
        <div style={{ height: 12 }} />
        <AuditBanner />
      </Section>

      <Section title="Needs your attention" hint="Tap a tile to open it.">
        <StatTiles>
          <Load s={sus} rows={1}>{(v: any[]) => <Stat label="Open suspense items" value={v.length} tone={tone(v.length)} hint="Unmatched payments" onClick={() => go('suspense')} />}</Load>
          <Load s={rr} rows={1}>{(v: any[]) => <Stat label="Pending reversals" value={v.length} tone={tone(v.length)} hint="Need a decision" onClick={() => go('reversals')} />}</Load>
          {docsWaiting !== null && <Stat label="Documents to review" value={docsWaiting} tone={tone(docsWaiting)} hint="Church verification" onClick={() => go('kyc')} />}
          {payoutsWaiting !== null && <Stat label="Payout changes waiting" value={payoutsWaiting} tone={tone(payoutsWaiting)} hint="Awaiting approval" onClick={() => go('payout-requests')} />}
          {walletsLow !== null && <Stat label="Wallets low or empty" value={walletsLow} tone={tone(walletsLow)} hint="Messaging" onClick={() => go('messaging')} />}
        </StatTiles>
      </Section>

      <Section title="Platform earnings">
        <Load s={rev} rows={1}>
          {(v: any) => (
            <StatTiles>
              <Stat label="Platform fees earned" value={kes(v.platform_fee)} hint={`${num(v.n)} payments`} tone="good" />
              <Stat label="Provider cost payable" value={kes(v.psp_cost)} hint="Third-party charges" />
              <Stat label="Platform clock" value={shortDate(v.now)} hint={num(v.clockOffsetHours) ? `Skipped ahead ${num(v.clockOffsetHours)} hours` : 'Real time (no offset)'} />
            </StatTiles>
          )}
        </Load>
      </Section>

      <Section title="Account balances">
        <Card pad={false}>
          <Load s={rec} rows={3}>
            {(r: any) => {
              const entries = Object.entries(r.accounts ?? {});
              return entries.length === 0 ? <EmptyState icon="wallet" title="No balances yet" text="Balances appear once the first payment arrives." /> : (
                <Table head={['Account', 'Balance']}>
                  {entries.map(([k, v]) => (
                    <tr key={k}><td>{ACC[k] ?? k.replace(/_/g, ' ')}</td><td className="num">{kes(v as number)}</td></tr>
                  ))}
                </Table>
              );
            }}
          </Load>
        </Card>
      </Section>
    </>
  );
}

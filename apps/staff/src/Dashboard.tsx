import { useEffect, useRef, useState } from 'react';
import { kes, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, label, methodLabel, useSession } from './session';
import { Bars } from './bits';
import { Card, EmptyState, PageHeader, Section, Stat, StatTiles, StatusChip } from './ui';
import { Loaded, PayChip } from './money-bits';

export function Dashboard() {
  const s = useSession();
  const d = useAsync<any>(() => api.get('/dashboard' + s.qs()), [s.qs()]);
  const [feed, setFeed] = useState<any[]>([]);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [live, setLive] = useState(false);
  const toast = useToast();
  const reloadRef = useRef(d.reload);
  reloadRef.current = d.reload;
  const scopeRef = useRef(s.scope);
  scopeRef.current = s.scope;
  const allowed = useRef(new Set<string>());
  allowed.current = new Set(s.branches.map((b) => b.id));
  const showRef = useRef(toast.show);
  showRef.current = toast.show;

  useEffect(() => { if (d.data) setFeed(d.data.recent); }, [d.data]);

  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let closed = false;
    const open = () => {
      es = new EventSource(api.url('/stream/collections'));
      es.onopen = () => setLive(true);
      es.onerror = () => {
        setLive(false);
        if (es && es.readyState === EventSource.CLOSED && !closed) { es.close(); timer = setTimeout(open, 4000); }
      };
      es.addEventListener('payment', (ev) => {
        let p: any;
        try { p = JSON.parse((ev as MessageEvent).data); } catch { return; }
        if (!allowed.current.has(p.branch_id)) return;
        if (scopeRef.current !== 'all' && p.branch_id !== scopeRef.current) return;
        setFeed((f) => (f.some((x) => x.id === p.id) ? f : [p, ...f].slice(0, 30)));
        setFlash((x) => new Set(x).add(p.id));
        showRef.current(`${kes(p.amount_paid)} received at ${p.branch}`);
        reloadRef.current();
      });
    };
    open();
    return () => { closed = true; clearTimeout(timer); es?.close(); };
  }, []);

  const cr = useAsync<any>(() => api.get('/credit/summary').catch(() => null), []);
  const x = d.data;
  const sum = (k: string) => (x ? x.branches.reduce((t: number, b: any) => t + Number(b[k] ?? 0), 0) : 0);
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={<span className="mn-live">Giving as it arrives. {live ? <StatusChip tone="done"><span className="live-dot" style={{ marginRight: 4 }} />Live</StatusChip> : <StatusChip tone="wait">Reconnecting…</StatusChip>}</span>}
      />
      <Loaded loading={d.loading} error={d.error} hasData={!!x} rows={5} height={96}>
        {x && (
          <>
            <StatTiles>
              <Stat label="Today's giving" value={kes(x.today.gross)} hint={`Net ${kes(x.today.net)}`} />
              <Stat label="Payments today" value={Number(x.today.n)} />
              <Stat label="Last 7 days" value={kes(x.week.gross)} hint={`${Number(x.week.n)} payments`} />
              <Stat label="Cash recorded today" value={kes(x.cashToday)} hint="Signed off by two people" />
            </StatTiles>
            {cr.data && (
              <Section title="Event credit">
                <StatTiles>
                  <Stat label="Event credit held" value={kes(cr.data.outstanding)} hint={`${cr.data.holders} ${cr.data.holders === 1 ? 'person' : 'people'}. Not income until spent.`} tone="info" onClick={() => s.go('credit')} />
                </StatTiles>
              </Section>
            )}
            <Section title="Your balance">
              <StatTiles>
                <Stat label="In 48 hour hold" value={kes(sum('pending'))} tone="wait" />
                <Stat label="Ready to pay out" value={kes(sum('available'))} tone="good" />
                <Stat label="Owed" value={kes(sum('receivable'))} hint="Netted from the next payout" />
              </StatTiles>
            </Section>
            <Section title="Today">
              <div className="mn-cols two">
                <Card>
                  <div className="mn-cardhead"><h3>By method</h3></div>
                  {x.byMethod.length === 0 ? <p className="mn-flat-note">No payments yet today.</p> :
                    <Bars rows={x.byMethod.map((r: any) => ({ key: r.method, label: methodLabel(r.method), value: Number(r.gross), hint: `${r.n}` }))} />}
                </Card>
                <Card>
                  <div className="mn-cardhead"><h3>By purpose</h3></div>
                  {x.byPurpose.length === 0 ? <p className="mn-flat-note">No payments yet today.</p> :
                    <Bars rows={x.byPurpose.map((r: any) => ({ key: r.purpose, label: label(r.purpose), value: Number(r.gross), hint: `${r.n}` }))} />}
                </Card>
              </div>
            </Section>
            <Section title="Recent payments" hint="Newest first">
              {feed.length === 0 ? <Card><EmptyState icon="money" title="Nothing yet" text="Payments will appear here the moment they arrive." /></Card> : (
                <Card pad={false} className="mn-wrap">
                  <div className="mn-scroll">
                    <table className="mn-table">
                      <thead><tr><th>When</th><th>Branch</th><th>Method</th><th>Purpose</th><th className="num">Gross</th><th className="num">Fee</th><th className="num">Net</th><th>Status</th></tr></thead>
                      <tbody>
                        {feed.map((p) => (
                          <tr key={p.id} className={flash.has(p.id) ? 'flash' : ''}>
                            <td className="mn-first" data-l="When">{shortDate(p.received_at)}</td>
                            <td data-l="Branch">{p.branch}</td>
                            <td data-l="Method">{methodLabel(p.method)}</td>
                            <td data-l="Purpose">{label(p.purpose)}</td>
                            <td className="num" data-l="Gross">{kes(p.amount_paid)}</td>
                            <td className="num" data-l="Fee">{kes(p.fee)}</td>
                            <td className="num" data-l="Net">{kes(p.net)}</td>
                            <td data-l="Status"><PayChip status={p.stage} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </Section>
            {s.scope === 'all' && x.branches.length > 1 && (
              <Section title="Branches" hint="Select a branch to look closer">
                <Card pad={false} className="mn-wrap">
                  <div className="mn-scroll">
                    <table className="mn-table">
                      <thead><tr><th>Branch</th><th>Code</th><th className="num">Today</th><th className="num">In hold</th><th className="num">Ready to pay out</th><th className="num">Owed</th><th /></tr></thead>
                      <tbody>
                        {x.branches.map((b: any) => (
                          <tr key={b.id} className="tap" onClick={() => s.setScope(b.id)}>
                            <td className="mn-first" data-l="Branch"><b>{b.name}</b></td>
                            <td data-l="Code">{b.code}</td>
                            <td className="num" data-l="Today">{kes(b.todayGross)}</td>
                            <td className="num" data-l="In hold">{kes(b.pending)}</td>
                            <td className="num" data-l="Ready to pay out">{kes(b.available)}</td>
                            <td className="num" data-l="Owed">{kes(b.receivable)}</td>
                            <td className="mn-act">{b.payout_paused ? <StatusChip tone="bad">Payouts paused</StatusChip> : null}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </Section>
            )}
          </>
        )}
      </Loaded>
      {toast.node}
    </>
  );
}

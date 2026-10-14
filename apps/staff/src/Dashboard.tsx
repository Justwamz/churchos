import { useEffect, useRef, useState } from 'react';
import { Badge, Card, Empty, Stat, StatusBadge, Table, kes, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, label, methodLabel, useSession } from './session';
import { Bars, Load, PageHead } from './bits';

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

  const x = d.data;
  const sum = (k: string) => (x ? x.branches.reduce((t: number, b: any) => t + Number(b[k] ?? 0), 0) : 0);
  return (
    <>
      <PageHead
        title="Dashboard"
        sub="Giving as it arrives."
        action={live
          ? <Badge tone="good"><span className="live-dot" />Live</Badge>
          : <Badge tone="warn">Reconnecting…</Badge>}
      />
      <Load loading={d.loading} error={d.error} hasData={!!x}>
        {x && (
          <div className="stack">
            <div className="grid cols-4">
              <Stat label="Today's giving" value={kes(x.today.gross)} hint={`Net ${kes(x.today.net)}`} />
              <Stat label="Payments today" value={Number(x.today.n)} />
              <Stat label="Last 7 days" value={kes(x.week.gross)} hint={`${Number(x.week.n)} payments`} />
              <Stat label="Cash recorded today" value={kes(x.cashToday)} hint="Signed off by two people" />
            </div>
            <div className="grid cols-3">
              <Stat label="In 48 hour hold" value={kes(sum('pending'))} tone="warn" />
              <Stat label="Ready to pay out" value={kes(sum('available'))} tone="good" />
              <Stat label="Owed" value={kes(sum('receivable'))} hint="Netted from the next payout" />
            </div>
            <div className="grid cols-2">
              <Card title="Today by method">
                {x.byMethod.length === 0 ? <Empty>No payments yet today.</Empty> :
                  <Bars rows={x.byMethod.map((r: any) => ({ key: r.method, label: methodLabel(r.method), value: Number(r.gross), hint: `${r.n}` }))} />}
              </Card>
              <Card title="Today by purpose">
                {x.byPurpose.length === 0 ? <Empty>No payments yet today.</Empty> :
                  <Bars rows={x.byPurpose.map((r: any) => ({ key: r.purpose, label: label(r.purpose), value: Number(r.gross), hint: `${r.n}` }))} />}
              </Card>
            </div>
            <Card title="Recent payments" action={<span className="tiny">Newest first</span>}>
              {feed.length === 0 ? <Empty>Payments will appear here the moment they arrive.</Empty> : (
                <Table head={['When', 'Branch', 'Method', 'Purpose', 'Gross', 'Fee', 'Net', 'Status']}>
                  {feed.map((p) => (
                    <tr key={p.id} className={flash.has(p.id) ? 'flash' : ''}>
                      <td>{shortDate(p.received_at)}</td>
                      <td>{p.branch}</td>
                      <td>{methodLabel(p.method)}</td>
                      <td>{label(p.purpose)}</td>
                      <td className="num">{kes(p.amount_paid)}</td>
                      <td className="num">{kes(p.fee)}</td>
                      <td className="num">{kes(p.net)}</td>
                      <td><StatusBadge status={p.stage} /></td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
            {s.scope === 'all' && x.branches.length > 1 && (
              <Card title="Branches" action={<span className="tiny">Select a branch to drill in</span>}>
                <Table head={['Branch', 'Code', 'Today', 'In hold', 'Ready to pay out', 'Owed', '']}>
                  {x.branches.map((b: any) => (
                    <tr key={b.id} style={{ cursor: 'pointer' }} onClick={() => s.setScope(b.id)}>
                      <td><b>{b.name}</b></td>
                      <td>{b.code}</td>
                      <td className="num">{kes(b.todayGross)}</td>
                      <td className="num">{kes(b.pending)}</td>
                      <td className="num">{kes(b.available)}</td>
                      <td className="num">{kes(b.receivable)}</td>
                      <td>{b.payout_paused ? <Badge tone="bad">Payouts paused</Badge> : null}</td>
                    </tr>
                  ))}
                </Table>
              </Card>
            )}
          </div>
        )}
      </Load>
      {toast.node}
    </>
  );
}

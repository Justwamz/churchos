import { Badge, Button, Card, Empty, ErrorNote, Note, useAsync } from '@churchos/ui';
import { api } from './api';
import { Skeleton } from './ui';

const TZ = 'Africa/Nairobi';
const kesC = (c: number | null | undefined) => {
  const v = Number(c ?? 0) / 100;
  const s = Math.abs(v).toLocaleString('en-KE', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '-' : ''}KES ${s}`;
};
const dayTime = (iso: string) => new Date(iso).toLocaleString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ }).replace(/\s?([AP])M/i, (_, x) => ` ${x.toLowerCase()}m`);
const dayOnly = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
const purposeText = (p: string | null | undefined, project?: string | null) => {
  if (project) return `Project: ${project}`;
  if (!p) return 'Gift';
  if (p.startsWith('PROJ-')) return `Project ${p.slice(5)}`;
  return p.charAt(0) + p.slice(1).toLowerCase();
};
const METHOD: Record<string, string> = { mpesa: 'M-Pesa', airtel: 'Airtel Money', tkash: 'T-Kash', card: 'Card', cash: 'Cash' };

export const ANON_EXPLAIN = 'Your church will not see your name or number. They see only a daily total for anonymous gifts. It will not count toward a pledge, and it will not be in the giving record your church keeps. Only you can see it. This cannot be changed later.';

/** The "Give anonymously" switch with its explanation. */
export function AnonSwitch({ on, onChange, disabled, note }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; note?: string }) {
  return (
    <div className={`anon-box ${on ? 'on' : ''}`}>
      <div className="anon-row">
        <span id="anon-l" className="anon-label">Give anonymously</span>
        <button type="button" role="switch" aria-checked={on} aria-labelledby="anon-l" disabled={disabled} className="switch" onClick={() => onChange(!on)}><i /></button>
      </div>
      <p className="tiny anon-text">{note ?? ANON_EXPLAIN}</p>
    </div>
  );
}

export function GivingRecord({ onBack }: { onBack: () => void }) {
  const led = useAsync<any>(() => api.get('/me/giving/ledger'));
  const log = useAsync<any>(() => api.get('/me/giving/access-log'));
  const d = led.data;
  const lines: any[] = d?.lines ?? [];
  const anon: any[] = d?.anonymous ?? [];
  const thisYear = String(new Date().getFullYear());
  const years = Object.entries(d?.totals?.byYear ?? {}).sort((a, b) => Number(b[0]) - Number(a[0])) as [string, number][];
  const purposes = Object.entries(d?.totals?.byPurpose ?? {}).sort((a, b) => Number(b[1]) - Number(a[1])) as [string, number][];
  const all = [...lines.map((l) => ({ ...l, anonymous: false })), ...anon.map((a) => ({ ...a, anonymous: true }))].sort((a, b) => +new Date(b.at) - +new Date(a.at));
  const entries: any[] = log.data?.log ?? [];

  return (
    <div className="stack">
      <div className="row no-print"><Button kind="ghost" small onClick={onBack}>Back</Button></div>
      <Card title="My giving record">
        <p className="muted" style={{ margin: 0 }}>This is the record your church keeps of your named giving. It cannot be changed or deleted: corrections are added as new lines. Only a few people at your church with a special right can open it, and every time they do it is recorded.</p>
      </Card>

      {led.loading && !d ? <div className="card"><Skeleton lines={4} /></div> : led.error && !d ? <div className="stack"><ErrorNote>{led.error}</ErrorNote><Button kind="ghost" onClick={led.reload}>Try again</Button></div> : (
        <>
          <div className="hero-total">
            <span>Given in {thisYear}</span>
            <strong>{kesC(d?.totals?.byYear?.[thisYear] ?? 0)}</strong>
            <small>All time {kesC(d?.totals?.given ?? 0)}{d?.anonymousTotal ? `, including ${kesC(d.anonymousTotal)} given anonymously` : ''}</small>
          </div>
          {(years.length > 1 || purposes.length > 0) && (
            <Card title="Totals">
              <div className="stack">
                {years.length > 0 && <div><div className="field-label">By year</div><ul className="plain-list gr-tot">{years.map(([y, c]) => <li key={y}><span>{y}</span><strong>{kesC(c)}</strong></li>)}</ul></div>}
                {purposes.length > 0 && <div><div className="field-label">By purpose</div><ul className="plain-list gr-tot">{purposes.map(([p, c]) => <li key={p}><span>{purposeText(p)}</span><strong>{kesC(c)}</strong></li>)}</ul></div>}
              </div>
            </Card>
          )}
          <Card title="Lines in your record">
            {!all.length ? <Empty>Nothing in your record yet. Your gifts will be added here.</Empty> : (
              <ul className="list">
                {all.map((l) => {
                  const rev = l.kind === 'reversal';
                  const what = rev ? 'Reversed' : l.kind === 'cash_gift' ? 'Cash recorded by the church' : purposeText(l.purpose, l.project);
                  return (
                    <li key={`${l.anonymous ? 'a' : 'n'}${l.id}`} className={rev ? 'gr-rev' : ''}>
                      <div className="row"><strong>{what}</strong><span className={`amt ${rev ? 'gr-neg' : ''}`}>{kesC(l.amount)}</span></div>
                      <div className="row">
                        <span className="tiny">{dayOnly(l.at)} · {l.anonymous ? `${METHOD[l.method] ?? l.method ?? ''} · ${l.church ?? ''}` : rev ? (l.note || 'A correction added as a new line') : l.kind === 'cash_gift' ? purposeText(l.purpose, l.project) : (l.source ?? METHOD[l.method] ?? l.method)}</span>
                        <span className="gr-chips">
                          {l.anonymous && <Badge tone="info">Anonymous</Badge>}
                          {l.anonymous && l.reversed && <Badge tone="muted">Reversed</Badge>}
                        </span>
                      </div>
                      {l.anonymous && <div className="tiny">Given anonymously. Only you can see these.</div>}
                      {!l.anonymous && l.kind === 'gift' && l.ref && <div className="tiny">Receipt {l.ref}</div>}
                    </li>
                  );
                })}
              </ul>
            )}
            {anon.length > 0 && <p className="tiny" style={{ marginTop: 12 }}>Anonymous gifts are shown here for you only. They are not in the record your church keeps, and they do not count toward a pledge.</p>}
          </Card>
        </>
      )}

      <Card title="Who has looked at my giving record">
        {log.loading && !log.data ? <Skeleton lines={2} /> : log.error && !log.data ? <div className="stack"><ErrorNote>{log.error}</ErrorNote><Button kind="ghost" onClick={log.reload}>Try again</Button></div> : !entries.length ? <Empty>Nobody has opened your giving record.</Empty> : (
          <ul className="list">
            {entries.map((e, i) => (
              <li key={i}>
                <div><strong>{e.who}</strong> {e.action === 'exported' ? 'downloaded' : 'opened'} your giving record, {dayTime(e.at)}.</div>
                <div className="tiny">Reason: {e.reason}{e.note ? `. ${e.note}` : ''}</div>
              </li>
            ))}
          </ul>
        )}
        <p className="tiny" style={{ marginTop: 12 }}>Staff must give a reason each time. If you do not expect someone to have looked, ask your church about it.</p>
      </Card>
      <Note tone="info">Anonymous gifts cannot be linked back to you by the church, and there is no way to reveal one later.</Note>
    </div>
  );
}

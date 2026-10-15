import { useMemo, useState } from 'react';
import { Badge, Button, Empty, useAsync } from '@churchos/ui';
import { api, useSession } from './session';
import { Load, PageHead } from './bits';
import { Modal } from './MemberForm';
import './bookings.css';

const EAT = 3 * 3600_000;
const DAY = 86400_000;
const key = (iso: string) => new Date(new Date(iso).getTime() + EAT).toISOString().slice(0, 10);
const nextKey = (k: string) => new Date(Date.parse(`${k}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
const startOfDayIso = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - EAT).toISOString();
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour12: false, hour: '2-digit', minute: '2-digit' });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const todayKey = () => key(new Date().toISOString());
const cls = (it: any) => (it.type === 'event' ? 'event' : it.status === 'awaiting_payment' ? 'pay' : 'booking');
const timeText = (it: any) => `${clock(it.startsAt)}${it.endsAt ? ` to ${clock(it.endsAt)}` : ''}`;
const longDay = (k: string) => new Date(`${k}T12:00:00Z`).toLocaleDateString('en-KE', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });

function Item({ it }: { it: any }) {
  return (
    <div className="stack" style={{ gap: 2, padding: '8px 0', borderBottom: '1px solid var(--line)', minWidth: 0 }}>
      <div className="row"><b style={{ overflowWrap: 'anywhere' }}>{it.title}</b><Badge tone={it.type === 'event' ? 'good' : 'info'}>{it.type === 'event' ? 'Event' : it.status === 'awaiting_payment' ? 'Booking, awaiting payment' : 'Booking'}</Badge></div>
      <div className="tiny">{timeText(it)}</div>
      {it.resources?.length > 0 && <div className="tiny">{it.type === 'event' ? 'Place' : 'Booked'}: {it.resources.join(', ')}</div>}
      {it.who && <div className="tiny">Asked by {it.who}</div>}
    </div>
  );
}

export function CalendarPage() {
  const s = useSession();
  const [ym, setYm] = useState(() => { const t = todayKey(); return { y: Number(t.slice(0, 4)), m: Number(t.slice(5, 7)) - 1 }; });
  const [resource, setResource] = useState('');
  const [view, setView] = useState<'month' | 'agenda'>('month');
  const [open, setOpen] = useState<string | null>(null);
  const resources = useAsync<any[]>(() => api.get('/resources' + s.qs({ branch: undefined })), [s.grant.org.id]);

  const lead = (new Date(Date.UTC(ym.y, ym.m, 1)).getUTCDay() + 6) % 7;
  const total = Math.ceil((lead + new Date(Date.UTC(ym.y, ym.m + 1, 0)).getUTCDate()) / 7) * 7;
  const cells = Array.from({ length: total }, (_, i) => new Date(Date.UTC(ym.y, ym.m, 1 - lead + i)).toISOString().slice(0, 10));
  const from = startOfDayIso(cells[0]);
  const to = startOfDayIso(nextKey(cells[cells.length - 1]));
  const monthKey = `${ym.y}-${String(ym.m + 1).padStart(2, '0')}`;

  const data = useAsync<any[]>(() => api.get(`/calendar${s.qs({ branch: undefined, from, to, resource: resource || undefined })}`), [s.grant.org.id, from, resource]);
  const byDay = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const it of data.data ?? []) {
      let k = key(it.startsAt);
      const end = key(it.endsAt ?? it.startsAt);
      for (let n = 0; n < 31 && k <= end; n++) { const a = m.get(k) ?? []; a.push(it); m.set(k, a); k = nextKey(k); }
    }
    return m;
  }, [data.data]);

  const move = (d: number) => setYm((v) => { const x = new Date(Date.UTC(v.y, v.m + d, 1)); return { y: x.getUTCFullYear(), m: x.getUTCMonth() }; });
  const today = todayKey();
  const inMonth = (data.data ?? []).filter((it) => key(it.startsAt).slice(0, 7) === monthKey);

  return (
    <div>
      <PageHead title="Calendar" sub="Confirmed bookings and church events in one place. Times are East Africa Time." />
      <div className="cal-head">
        <Button small kind="ghost" onClick={() => move(-1)}>Previous</Button>
        <span className="cal-title">{MONTHS[ym.m]} {ym.y}</span>
        <Button small kind="ghost" onClick={() => move(1)}>Next</Button>
        <Button small kind="ghost" onClick={() => { const t = todayKey(); setYm({ y: Number(t.slice(0, 4)), m: Number(t.slice(5, 7)) - 1 }); }}>Today</Button>
        <select aria-label="Filter by resource" value={resource} onChange={(e) => setResource(e.target.value)}>
          <option value="">Everything</option>
          {(resources.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <div className="chips" style={{ marginLeft: 'auto' }}>
          <button type="button" className={`chip ${view === 'month' ? 'on' : ''}`} onClick={() => setView('month')}>Month</button>
          <button type="button" className={`chip ${view === 'agenda' ? 'on' : ''}`} onClick={() => setView('agenda')}>Agenda</button>
        </div>
      </div>
      <Load loading={data.loading} error={data.error} hasData={!!data.data}>
        {view === 'month' ? (
          <div className="cal-month">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="cal-dow">{d}</div>)}
            {cells.map((k) => {
              const its = byDay.get(k) ?? [];
              return (
                <button type="button" key={k} className={`cal-day ${k.slice(0, 7) !== monthKey ? 'out' : ''} ${k === today ? 'today' : ''}`} onClick={() => setOpen(k)} aria-label={`${longDay(k)}, ${its.length} items`}>
                  <span className="n">{Number(k.slice(8))}</span>
                  {its.slice(0, 3).map((it, i) => <span key={i} className={`cal-it ${cls(it)}`}>{clock(it.startsAt)} {it.title}</span>)}
                  {its.length > 3 && <span className="cal-more">+{its.length - 3} more</span>}
                </button>
              );
            })}
          </div>
        ) : (
          inMonth.length === 0 ? <Empty>Nothing on the calendar this month.</Empty> : (
            <div className="cal-agenda">
              {inMonth.map((it) => (
                <div className="cal-row" key={`${it.type}${it.id}`}>
                  <b>{longDay(key(it.startsAt))}</b>
                  <Item it={it} />
                </div>
              ))}
            </div>
          )
        )}
      </Load>
      <div className="cal-legend">
        <span className="cal-it booking">Booking</span>
        <span className="cal-it pay">Booking awaiting payment</span>
        <span className="cal-it event">Event</span>
      </div>
      {open && (
        <Modal title={longDay(open)} onClose={() => setOpen(null)}>
          {(byDay.get(open) ?? []).length === 0 ? <Empty>Nothing on this day.</Empty> : <div>{(byDay.get(open) ?? []).map((it) => <Item key={`${it.type}${it.id}`} it={it} />)}</div>}
        </Modal>
      )}
    </div>
  );
}

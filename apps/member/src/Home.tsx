import { useMemo, type ReactNode } from 'react';
import { Badge, Button, Empty, kes, shortDate, useAsync } from '@churchos/ui';
import { api } from './api';
import { AdvertSlider } from './Adverts';
import { isUpcomingBooking } from './Booking';
import { parseLink, useOpenMessage } from './Inbox';
import { LinkOffers } from './LinkChurch';
import { kesCents, usePlans } from './RegularGiving';
import { dateShort, isUpcoming, Poster, TICKET_PENDING_KEY } from './Tickets';
import { soonOf, stateOf, useServices, whenOf } from './Services';
import type { ShopIntent } from './Shop';
import { Icon, Skeleton } from './ui';
import { useWords } from './Words';

/** Every place Home can send the member. The shell decides which tab and section each one really is. */
export interface HomeLinks {
  give: (o?: { sub?: 'give' | 'pledges' | 'history' | 'regular'; purpose?: string }) => void;
  inbox: () => void;
  kids: () => void;
  services: () => void;
  tickets: () => void;
  events: () => void;
  bookings: () => void;
  credit: () => void;
  shop: (i?: ShopIntent) => void;
  prayer: () => void;
  suggestions: () => void;
  notices: () => void;
}

const isReceipt = (r: any) => r.kind === 'receipt' || r.kind === 'giving' || r.kind === 'gift';
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
function purposeLabel(p: string | null) {
  if (!p) return 'Gift';
  if (p.startsWith('PROJ-')) return `Project ${p.slice(5)}`;
  return p.charAt(0) + p.slice(1).toLowerCase();
}
const pendingTicket = () => { try { return !!localStorage.getItem(TICKET_PENDING_KEY); } catch { return false; } };

/** ONE card: the service you can check in to now, else your next ticketed event or service, else the next event. */
function NextUp({ links, credit, svc }: { links: HomeLinks; credit: number; svc: ReturnType<typeof useServices> }) {
  const wd = useWords();
  const tickets = useAsync<any>(() => api.get('/me/tickets'));
  const events = useAsync<any[]>(() => api.get('/me/events'));
  const now = Date.now();

  const pick = useMemo(() => {
    const valid = (tickets.data?.tickets ?? []).filter((t: any) => t.status === 'valid' && isUpcoming(t.event));
    valid.sort((a: any, b: any) => +new Date(a.event.startsAt) - +new Date(b.event.startsAt));
    const t = valid[0];
    const ticketed = t ? { ev: t.event, n: valid.filter((x: any) => x.event.id === t.event.id).length } : null;
    const open = svc.services.find((s) => stateOf(s, now) === 'open' && !s.mine?.inPerson && !s.mine?.online);
    const nextSvc = [...svc.services].filter((s) => +new Date(s.endsAt ?? s.startsAt) > now).sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt))[0];
    const nextEvent = (events.data ?? []).filter((e) => e.status !== 'cancelled' && e.status !== 'postponed' && +new Date(e.endsAt ?? e.startsAt) > now).sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt))[0];
    if (open) return { kind: 'checkin' as const, s: open };
    const tt = ticketed ? +new Date(ticketed.ev.startsAt) : Infinity;
    const st = nextSvc ? +new Date(nextSvc.startsAt) : Infinity;
    if (ticketed && tt <= st) return { kind: 'ticket' as const, ...ticketed };
    if (nextSvc) return { kind: 'service' as const, s: nextSvc };
    if (nextEvent) return { kind: 'event' as const, e: nextEvent };
    return null;
  }, [tickets.data, events.data, svc.services, now]); // eslint-disable-line react-hooks/exhaustive-deps

  const loading = (tickets.loading && !tickets.data) || svc.loading;
  if (loading) return <section className="block nu nu-load"><Skeleton lines={3} /></section>;
  if (!pick) return null;

  let title = '', when = '', where = '', chips: ReactNode[] = [], poster: ReactNode = null, actions: ReactNode;
  if (pick.kind === 'checkin' || pick.kind === 'service') {
    const s = pick.s; const st = stateOf(s, now);
    title = s.name; when = whenOf(s.startsAt); where = [s.branch, s.place].filter(Boolean).join(' · ');
    if (st === 'open') chips.push(<Badge key="o" tone="good">Check-in open</Badge>);
    else if (st === 'before') chips.push(<Badge key="b" tone="muted">Check-in opens {soonOf(s.opensAt)}</Badge>);
    if (s.mine?.inPerson || s.mine?.online) chips.push(<Badge key="m" tone="good">{s.mine.inPerson ? 'You are checked in' : 'You watched online'}</Badge>);
    actions = pick.kind === 'checkin' ? <Button onClick={links.services}>Check in</Button> : <Button kind="ghost" onClick={links.services}>{wd.many}</Button>;
  } else if (pick.kind === 'ticket') {
    const ev = pick.ev;
    title = ev.title; when = ev.postponed ? 'Date to be confirmed' : `${dateShort(ev.startsAt)}, ${new Date(ev.startsAt).toLocaleTimeString('en-KE', { hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Nairobi' })}`; where = ev.location ?? '';
    poster = <Poster url={ev.posterUrl} title={ev.title} className="strip" />;
    chips.push(<Badge key="t" tone="info">{pick.n} {pick.n === 1 ? 'ticket' : 'tickets'}</Badge>);
    if (ev.postponed) chips.push(<Badge key="p" tone="warn">Postponed</Badge>);
    actions = <Button onClick={links.tickets}>Show tickets</Button>;
  } else {
    const e = pick.e;
    title = e.title; when = whenOf(e.startsAt); where = e.location ?? '';
    if (e.ticketed) chips.push(<Badge key="e" tone="info">{e.soldOut ? 'Sold out' : !e.ticketFrom ? 'Free tickets' : `Tickets from ${kes(e.ticketFrom).replace(/\.00$/, '')}`}</Badge>);
    actions = <Button kind="ghost" onClick={links.events}>See event</Button>;
  }
  if (credit > 0) chips.push(<Badge key="c" tone="warn">Credit {kes(credit)}</Badge>);
  return (
    <section className="block nu" aria-label="Next up">
      <div className="nu-label">Next up</div>
      <div className="nu-body">
        {poster}
        <div className="nu-text">
          <strong className="nu-title">{title}</strong>
          <span className="nu-when">{when}</span>
          {where && <span className="tiny">{where}</span>}
          {chips.length > 0 && <span className="nu-chips">{chips}</span>}
        </div>
      </div>
      <div className="nu-actions">{actions}</div>
    </section>
  );
}

/** Only when something needs the member: a payment to confirm, credit to use, a booking to pay for, a gift waiting for a PIN, a child to collect. */
function HeadsUp({ links, credit, families }: { links: HomeLinks; credit: number; families: any[] }) {
  const bookings = useAsync<any[]>(() => api.get('/me/bookings'));
  const events = useAsync<any[]>(() => api.get('/me/events'));
  const plans = usePlans();
  const items: { key: string; ico: string; text: string; sub?: string; go: () => void; tone?: string }[] = [];
  const late = families.flatMap((f) => f.children ?? []).filter((c: any) => c.inNow?.late);
  if (late.length) items.push({ key: 'late', ico: 'family', tone: 'warn', text: 'Please collect your child', sub: late.map((c: any) => c.name.split(' ')[0]).join(', ') + ' is waiting to be collected', go: links.kids });
  if (pendingTicket()) items.push({ key: 'tk', ico: 'ticket', tone: 'warn', text: 'A ticket payment is waiting to be confirmed', sub: 'Open My tickets to check it', go: links.tickets });
  const unpaid = (bookings.data ?? []).filter(isUpcomingBooking).find((b) => b.status === 'awaiting_payment');
  if (unpaid) items.push({ key: 'bk', ico: 'calendar', tone: 'warn', text: 'Pay to confirm your booking', sub: unpaid.title, go: links.bookings });
  const waitingPlan = plans.plans.find((p) => p.status !== 'ended' && (p.runs ?? [])[0]?.status === 'prompted');
  if (waitingPlan) items.push({ key: 'rg', ico: 'bell', tone: 'warn', text: 'A gift is waiting for your PIN', sub: 'Check your phone', go: () => links.give({ sub: 'regular' }) });
  if (credit > 0) {
    const n = (events.data ?? []).filter((e) => e.ticketed && !e.soldOut && e.status !== 'cancelled' && e.status !== 'postponed').length;
    items.push({ key: 'cr', ico: 'coin', text: `You have ${kes(credit)} of event credit`, sub: n > 0 ? `${n} upcoming ${n === 1 ? 'event has' : 'events have'} tickets you can use it on` : 'It is used the next time you buy tickets', go: n > 0 ? links.events : links.credit });
  }
  if (!items.length) return null;
  return (
    <section className="block heads-up" aria-label="Heads up">
      <div className="nu-label">Heads up</div>
      <ul className="plain-list">
        {items.map((i) => (
          <li key={i.key}>
            <button type="button" className="mini-msg hu-row" onClick={i.go}>
              <span className={`msg-ico ${i.tone === 'warn' ? 'warn' : ''}`}><Icon name={i.ico} size={18} /></span>
              <span className="mini-text"><strong>{i.text}</strong>{i.sub && <span className="tiny">{i.sub}</span>}</span>
              <Icon name="chev" size={18} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Home({ me, user, families, notif, links, banner, onLinked }: { me: any; user: any; families: any[]; notif: any; links: HomeLinks; banner: ReactNode; onLinked: () => void }) {
  const wd = useWords();
  const m = me?.memberships?.[0];
  const giving = useAsync<any>(() => api.get('/me/giving'));
  const creditQ = useAsync<any>(() => api.get('/me/credit'));
  const svc = useServices();
  const plans = usePlans();
  const first = String(m?.full_name ?? user?.name ?? '').split(' ')[0];
  const household: any[] = me?.household ?? [];
  const children = household.filter((h) => h.relationship === 'Child');
  const recent: any[] = (giving.data?.rows ?? []).slice(0, 3);
  const latest: any[] = (notif.data?.rows ?? []).slice(0, 2);
  const unread = Number(notif.data?.unread ?? 0);
  const openMsg = useOpenMessage(notif.reload);
  const credit = Number(creditQ.data?.total ?? 0);
  const checkInOpen = svc.services.some((s) => stateOf(s) === 'open' && !s.mine?.inPerson && !s.mine?.online);
  const nextRegular = plans.plans.filter((p) => p.status === 'active' && p.nextRunAt && !p.skipNext).sort((a, b) => +new Date(a.nextRunAt) - +new Date(b.nextRunAt))[0];
  const here = families.flatMap((f) => f.children ?? []).filter((c: any) => c.inNow);
  const actions: { ico: string; label: string; on: () => void }[] = [
    { ico: 'give', label: 'Give', on: () => links.give() },
    { ico: 'calendar', label: checkInOpen ? 'Check in' : wd.many, on: links.services },
    { ico: 'ticket', label: 'My tickets', on: links.tickets },
    { ico: 'heart', label: 'Prayer', on: links.prayer },
  ];
  const more: { label: string; on: () => void }[] = [
    { label: 'Notices', on: links.notices },
    { label: 'Events', on: links.events },
    { label: 'Bookings', on: links.bookings },
    { label: 'Shop', on: () => links.shop() },
    { label: 'Suggestion box', on: links.suggestions },
    { label: 'Regular giving', on: () => links.give({ sub: 'regular' }) },
    { label: 'Credit', on: links.credit },
  ];
  return (
    <div className="stack home">
      <div className="greet">
        <h1>{greeting()}{first ? `, ${first}` : ''}</h1>
        {m ? <p>{m.branch_name} · {m.org_name}</p> : <p>You are not linked to a church yet. Ask your church to add you, or open your profile to request a move.</p>}
      </div>
      <div className="home-top"><LinkOffers onLinked={onLinked} />{banner}</div>

      <div className="home-main">
        <NextUp links={links} credit={credit} svc={svc} />
        <div className="quick" role="group" aria-label="Quick actions">
          {actions.map((a) => (
            <button type="button" key={a.label} className="tile" onClick={a.on}>
              <span className="tile-ico"><Icon name={a.ico} size={26} /></span>
              <span className="tile-label">{a.label}</span>
            </button>
          ))}
        </div>
        <HeadsUp links={links} credit={credit} families={families} />
        <AdvertSlider onShop={links.shop} />
        <nav className="more-row" aria-label="More">
          <span className="more-label">More</span>
          {more.map((x) => <button type="button" key={x.label} className="link-btn" onClick={x.on}>{x.label}</button>)}
        </nav>
      </div>

      <div className="home-side">
        {latest.length > 0 && (
          <section className="block hm-msgs">
            <div className="block-head"><h3>Latest messages{unread > 0 ? <span className="badge warn" style={{ marginLeft: 8 }}>{unread} new</span> : null}</h3><button type="button" className="link-btn" onClick={links.inbox}>See all</button></div>
            <ul className="plain-list">
              {latest.map((r) => (
                <li key={r.id}>
                  <button type="button" className={`mini-msg ${r.read ? '' : 'unread'}`} onClick={() => (parseLink(r.link) ? openMsg(r) : links.inbox())}>
                    <span className={`msg-ico ${isReceipt(r) ? 'good' : r.kind === 'announcement' ? 'announce' : ''}`}><Icon name={isReceipt(r) ? 'check' : r.kind === 'announcement' ? 'megaphone' : 'chat'} size={18} /></span>
                    <span className="mini-text"><strong>{r.title}</strong><span className="clamp2">{r.body}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="block hm-giving">
          <div className="block-head"><h3>Recent giving</h3><button type="button" className="link-btn" onClick={() => links.give({ sub: 'history' })}>History</button></div>
          {giving.loading ? <Skeleton lines={3} /> : giving.error ? <Empty>We could not load your giving. Open History to try again.</Empty> : (
            <>
              <div className="total-row"><span className="tiny">Total given</span><span className="total">{kes(giving.data?.total ?? 0)}</span></div>
              {!recent.length ? <Empty>Your first gift will show here.</Empty> : (
                <ul className="plain-list">
                  {recent.map((r) => (
                    <li key={r.id} className="gift-row">
                      <span className="msg-ico good"><Icon name="give" size={18} /></span>
                      <span className="gift-main"><strong>{purposeLabel(r.purpose)}</strong><span className="tiny">{shortDate(r.date)} · {r.church ?? 'Church'}</span></span>
                      <span className="amt">{kes(r.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {nextRegular && <button type="button" className="rg-line tiny" onClick={() => links.give({ sub: 'regular' })}><Icon name="refresh" size={16} /><span>Next regular gift: {kesCents(nextRegular.amount)} {nextRegular.purposeLabel}, {shortDate(nextRegular.nextRunAt)}</span></button>}
            </>
          )}
        </section>

        {(children.length > 0 || families.length > 0) && (
          <section className="block hm-family">
            <div className="block-head"><h3>For your family</h3>{families.length > 0 && <button type="button" className="link-btn" onClick={links.kids}>Children</button>}</div>
            <ul className="plain-list">
              {children.map((c) => {
                const inNow = here.find((h: any) => h.name === c.full_name)?.inNow;
                return (
                  <li key={c.id} className="gift-row">
                    <span className="msg-ico"><Icon name="family" size={18} /></span>
                    <span className="gift-main"><strong>{c.full_name}</strong><span className="tiny">{inNow ? `In ${inNow.className}, tag ${inNow.tag}` : `Child · ${c.member_number}`}</span></span>
                  </li>
                );
              })}
            </ul>
            <p className="tiny" style={{ margin: '10px 0 0' }}>Children do not sign in. Messages about them from your church arrive in your Messages, marked with their name.</p>
          </section>
        )}
      </div>
    </div>
  );
}

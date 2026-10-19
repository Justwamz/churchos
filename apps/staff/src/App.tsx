import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { summarize, VerificationBanner, VerificationDialog, type KycSummary } from './VerificationBanner';
import { Badge, Button, ErrorNote, HelpButton, LoginGate, Spinner } from '@churchos/ui';
import { api, SessionCtx, friendly, EMAIL_REQUIRED_EVENT, type Session } from './session';
import { EmailGate } from './EmailGate';
import { Adverts } from './Adverts';
import { Notices } from './Notices';
import { Events } from './Events';
import { Resources } from './Resources';
import { Bookings } from './Bookings';
import { CalendarPage } from './CalendarPage';
import { Dashboard } from './Dashboard';
import { Collections } from './Collections';
import { RegularGiving } from './RegularGiving';
import { Settlements } from './Settlements';
import { Cash } from './Cash';
import { GivingRecords } from './GivingRecord';
import { Members, Transfers } from './Members';
import { Projects } from './Projects';
import { Help } from './Help';
import { Verification } from './Verification';
import { Messages } from './Messages';
import { Wallets } from './Wallets';
import { Integrations } from './Integrations';
import { Groups } from './Groups';
import { Profile } from './Profile';
import { Payout } from './Payout';
import { WalletBanner } from './WalletBanner';
import { Notifications } from './Notifications';
import { Records } from './Records';
import { Template } from './Template';
import { AuditPage } from './Audit';
import { Team } from './Team';
import { Shop } from './Shop';
import { Checkin } from './Checkin';
import { Services } from './Services';
import { Expenses } from './Expenses';
import { Usher } from './Usher';
import { Attendance } from './Attendance';
import { Children } from './Children';
import { Prayer } from './Prayer';
import { Suggestions } from './Suggestions';
import { Lectionary } from './Lectionary';
import { Boundaries } from './Boundaries';
import { TodayPage } from './Today';
import { InstallButton, useOnline } from './Install';
import './phone.css';

const HELP_SCREEN: Record<string, string> = {
  dashboard: 'staff.dashboard', collections: 'staff.collections', settlements: 'staff.settlements', cash: 'staff.cash',
  members: 'staff.members', transfers: 'staff.transfers', projects: 'staff.projects', help: 'staff.help',
  verification: 'staff.verification', payout: 'staff.payout', messages: 'staff.messages', wallets: 'staff.wallets', integrations: 'staff.integrations', adverts: 'staff.adverts', notices: 'staff.notices', events: 'staff.events', resources: 'staff.resources', bookings: 'staff.bookings', calendar: 'staff.calendar', groups: 'staff.groups', profile: 'staff.profile', records: 'staff.records', template: 'staff.template', audit: 'staff.audit', team: 'staff.team', shop: 'staff.shop', checkin: 'staff.checkin', today: 'staff.dashboard', children: 'staff.dashboard', prayer: 'staff.dashboard', lectionary: 'staff.dashboard', boundaries: 'staff.dashboard', suggestions: 'staff.dashboard',
};

const PAGES: { id: string; label: string; any: string[]; el: () => JSX.Element }[] = [
  { id: 'today', label: 'Today', any: ['*'], el: TodayPage },
  { id: 'dashboard', label: 'Dashboard', any: ['collections.view'], el: Dashboard },
  { id: 'collections', label: 'Collections', any: ['collections.view'], el: Collections },
  { id: 'giving-records', label: 'Giving records', any: ['giving.ledger'], el: GivingRecords },
  { id: 'expenses', label: 'Expenses', any: ['expenses.view', 'expenses.record', 'expenses.approve'], el: Expenses },
  { id: 'regular-giving', label: 'Regular giving', any: ['collections.view'], el: RegularGiving },
  { id: 'settlements', label: 'Settlements', any: ['settlements.view'], el: Settlements },
  { id: 'cash', label: 'Cash', any: ['cash.count', 'cash.approve'], el: Cash },
  { id: 'members', label: 'Members', any: ['members.view', 'members.edit'], el: Members },
  { id: 'transfers', label: 'Transfers', any: ['transfers.approve'], el: Transfers },
  { id: 'groups', label: 'Groups', any: ['members.view', 'groups.manage'], el: Groups },
  { id: 'messages', label: 'Messages', any: ['messages.send', 'messages.view'], el: Messages },
  { id: 'wallets', label: 'Messaging wallets', any: ['wallets.view'], el: Wallets },
  { id: 'integrations', label: 'Messaging settings', any: ['integrations.manage', 'wallets.view'], el: Integrations },
  { id: 'notices', label: 'Notices', any: ['notices.view', 'notices.manage'], el: Notices },
  { id: 'events', label: 'Events', any: ['events.view', 'events.manage'], el: Events },
  { id: 'bookings', label: 'Bookings', any: ['bookings.view'], el: Bookings },
  { id: 'calendar', label: 'Calendar', any: ['bookings.view'], el: CalendarPage },
  { id: 'resources', label: 'Resources', any: ['bookings.view', 'resources.manage'], el: Resources },
  { id: 'shop', label: 'Shop', any: ['shop.view', 'shop.sell', 'shop.manage'], el: Shop },
  { id: 'checkin', label: 'Check-in', any: ['events.checkin'], el: Checkin },
  { id: 'attendance', label: 'Attendance', any: ['attendance.view'], el: Attendance },
  { id: 'services', label: 'Services', any: ['attendance.manage'], el: Services },
  { id: 'lectionary', label: 'Lectionary', any: ['attendance.manage', 'attendance.view'], el: Lectionary },
  { id: 'boundaries', label: 'Check-in boundary', any: ['attendance.manage', 'attendance.view'], el: Boundaries },
  { id: 'usher', label: 'Usher', any: ['attendance.checkin'], el: Usher },
  { id: 'children', label: 'Children', any: ['kids.checkin', 'kids.manage'], el: Children },
  { id: 'prayer', label: 'Prayer', any: ['prayer.respond'], el: Prayer },
  { id: 'suggestions', label: 'Suggestions', any: ['suggestions.view'], el: Suggestions },
  { id: 'adverts', label: 'Adverts', any: ['adverts.view', 'adverts.manage', 'adverts.approve'], el: Adverts },
  { id: 'projects', label: 'Projects', any: ['collections.view', 'projects.manage'], el: Projects },
  { id: 'help', label: 'Payment help', any: ['reversals.request'], el: Help },
  { id: 'records', label: 'Records', any: ['records.view'], el: Records },
  { id: 'template', label: 'Certificate design', any: ['records.view'], el: Template },
  { id: 'team', label: 'Team', any: ['team.view', 'team.manage'], el: Team },
  { id: 'audit', label: 'Audit log', any: ['audit.view'], el: AuditPage },
  { id: 'verification', label: 'Verification', any: ['kyc.manage'], el: Verification },
  { id: 'payout', label: 'Payout account', any: ['payouts.manage'], el: Payout },
  // Everyone signed in has a profile, so there is no permission to check ('*').
  { id: 'profile', label: 'My profile', any: ['*'], el: Profile },
];

const MORE_GROUPS: { title: string; ids: string[] }[] = [
  { title: 'On the day', ids: ['usher', 'children', 'checkin', 'attendance', 'prayer', 'suggestions'] },
  { title: 'Money', ids: ['dashboard', 'collections', 'giving-records', 'expenses', 'regular-giving', 'settlements', 'cash', 'transfers', 'projects', 'shop', 'help'] },
  { title: 'People and church life', ids: ['members', 'groups', 'messages', 'notices', 'events', 'bookings', 'calendar', 'resources', 'adverts'] },
  { title: 'Setup and records', ids: ['services', 'lectionary', 'boundaries', 'records', 'template', 'team', 'audit', 'verification', 'payout', 'wallets', 'integrations'] },
  { title: 'Account', ids: ['profile'] },
];
const APPROVAL_PAGES = ['expenses', 'cash', 'events'];
const APPROVAL_RIGHT: Record<string, string> = { expenses: 'expenses.approve', cash: 'cash.approve', events: 'events.manage' };

function usePhone() {
  const q = '(max-width: 760px)';
  const [phone, setPhone] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return phone;
}

const initials = (n: string) => (n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';

function Shell({ signOut }: { signOut: () => void }) {
  const [me, setMe] = useState<any>();
  const [error, setError] = useState<string>();
  const [orgIdx, setOrgIdx] = useState(0);
  const [scope, setScope] = useState('all');
  const [page, setPageState] = useState('');
  const pageRef = useRef('');
  const phone = usePhone();
  const [menu, setMenu] = useState(false);
  const online = useOnline();

  // Keep the browser Back button working: every page change is a history entry.
  const setPage = useCallback((p: string) => {
    if (pageRef.current !== p) { try { window.history.pushState({ churchosPage: p }, ''); } catch { /* ignore */ } }
    pageRef.current = p;
    setPageState(p);
    setMenu(false);
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    try { window.history.replaceState({ churchosPage: '' }, ''); } catch { /* ignore */ }
    const on = (e: PopStateEvent) => { const p = e.state?.churchosPage ?? ''; pageRef.current = p; setPageState(p); setMenu(false); };
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);

  const [gate, setGate] = useState(false);
  const [tick, setTick] = useState(0);
  const [kyc, setKyc] = useState<KycSummary | null>(null);
  const unverified = !!kyc && kyc.tone !== 'done';

  useEffect(() => {
    api.get('/staff/me').then(setMe).catch((e) => setError(friendly(e.message)));
  }, []);

  useEffect(() => {
    const on = () => setGate(true);
    window.addEventListener(EMAIL_REQUIRED_EVENT, on);
    return () => window.removeEventListener(EMAIL_REQUIRED_EVENT, on);
  }, []);
  const reloadMe = () => api.get('/staff/me').then((m: any) => { setMe(m); setGate(false); setTick((t) => t + 1); }).catch((e) => setError(friendly(e.message)));

  const grant = me?.orgs?.[orgIdx];
  const session = useMemo<Session | null>(() => {
    if (!me || !grant) return null;
    const perms = new Set<string>(grant.permissions);
    const multiOrg = me.orgs.length > 1;
    return {
      user: me.user, orgs: me.orgs, grant, branches: grant.branches, scope, setScope, go: setPage,
      can: (p) => perms.has(p),
      qs: (extra = {}) => {
        const p = new URLSearchParams();
        if (multiOrg) p.set('org', grant.org.id);
        if (scope !== 'all') p.set('branch', scope);
        for (const [k, v] of Object.entries(extra)) { if (v === undefined) p.delete(k); else p.set(k, v); }
        const s = p.toString();
        return s ? `?${s}` : '';
      },
    };
  }, [me, grant, scope]);

  useEffect(() => {
    if (!session || !session.can('kyc.manage')) { setKyc(null); return; }
    let live = true;
    // Always summarise the whole organisation, not just the selected branch, so the banner cannot be hidden by the scope selector.
    api.get('/kyc/status' + (session.orgs.length > 1 ? `?org=${session.grant.org.id}` : ''))
      .then((k: any) => { if (live) setKyc(summarize(k)); })
      .catch(() => {});
    return () => { live = false; };
  }, [session, page]);

  if (error) return <main className="login"><div className="login-card"><ErrorNote>{error}</ErrorNote><Button onClick={signOut}>Sign out</Button></div></main>;
  if (!me) return <Spinner />;
  if (me.orgs.length === 0 || !session) {
    return (
      <main className="login"><div className="login-card">
        <div className="brand">ChurchOS</div>
        <h1>No staff access</h1>
        <p className="muted">This number is not linked to any church as staff. Please ask your church administrator to give you a role, then sign in again.</p>
        <Button onClick={signOut}>Sign out</Button>
      </div></main>
    );
  }

  const visible = PAGES.filter((p) => p.any.includes('*') || p.any.some((a) => session.can(a)));
  const defaultId = phone ? 'today' : (visible.find((p) => p.id !== 'today') ?? visible[0])?.id;
  const onMore = phone && page === 'more';
  const current = visible.find((p) => p.id === page) ?? visible.find((p) => p.id === defaultId) ?? visible[0];
  const Page = current?.el;
  const has = (id: string) => visible.some((p) => p.id === id);
  const approvalsPage = APPROVAL_PAGES.find((id) => has(id) && session.can(APPROVAL_RIGHT[id]));
  const tabs: { id: string; label: string; icon: string }[] = [{ id: 'today', label: 'Today', icon: '⌂' }];
  if (session.can('attendance.checkin')) tabs.push({ id: 'usher', label: 'Check-in', icon: '✔' });
  if (session.can('kids.checkin')) tabs.push({ id: 'children', label: 'Children', icon: '☺' });
  if (approvalsPage) tabs.push({ id: approvalsPage, label: 'Approvals', icon: '✓' });
  const activeTab = onMore ? 'more' : (tabs.find((t) => t.id === current?.id)?.id ?? 'more');
  const grouped = new Set(MORE_GROUPS.flatMap((g) => g.ids));
  const groups = [...MORE_GROUPS, { title: 'Other', ids: visible.map((p) => p.id).filter((id) => !grouped.has(id) && id !== 'today') }]
    .map((g) => ({ title: g.title, items: g.ids.map((id) => visible.find((p) => p.id === id)).filter(Boolean) as typeof visible }))
    .filter((g) => g.items.length > 0);
  const picker = (
    <div className="row phone-pick" style={{ marginBottom: 16 }}>
      {me.orgs.length > 1 && (
        <select aria-label="Church" value={orgIdx} onChange={(e) => { setOrgIdx(Number(e.target.value)); setScope('all'); }}>
          {me.orgs.map((o: any, i: number) => <option key={o.org.id} value={i}>{o.org.name}</option>)}
        </select>
      )}
      <select aria-label="Branch scope" value={scope} onChange={(e) => setScope(e.target.value)}>
        {grant.branches.length > 1 && <option value="all">All branches</option>}
        {grant.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      <span className="tiny phone-hide">{grant.org.name}</span>
      {unverified && <Badge tone="warn">Not verified</Badge>}
      {!phone && <span style={{ marginLeft: 'auto' }}><Notifications /></span>}
    </div>
  );

  return (
    <SessionCtx.Provider value={session}>
      <div className={`shell ${phone ? 'phone' : ''}`}>
        {((me.emailRequired && !me.emailVerified) || gate) && <EmailGate initialEmail={me.user.email} onVerified={reloadMe} />}
        {phone && (
          <header className="topbar">
            <div className="topbar-title"><span className="brand">{grant.org.name || 'ChurchOS'}</span></div>
            <Notifications />
            <div className="avatar-wrap">
              <button type="button" className="avatar" aria-label="Account menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>{initials(me.user.name || me.user.phone)}</button>
              {menu && (
                <>
                  <div className="avatar-scrim" onClick={() => setMenu(false)} />
                  <div className="avatar-menu" role="menu">
                    <div className="avatar-who"><b>{me.user.name || me.user.phone}</b><div className="tiny">{grant.org.name}</div></div>
                    <button type="button" role="menuitem" onClick={() => setPage('profile')}>My profile</button>
                    <button type="button" role="menuitem" onClick={signOut}>Sign out</button>
                  </div>
                </>
              )}
            </div>
          </header>
        )}
        {!phone && (
          <aside className="sidebar">
            <div className="brand">ChurchOS</div>
            {visible.map((p) => (
              <button key={p.id} className={`nav-link ${current?.id === p.id ? 'active' : ''}`} onClick={() => setPage(p.id)}>{p.label}</button>
            ))}
            <div className="userbox">
              <div><b>{me.user.name || me.user.phone}</b></div>
              <div className="tiny">{grant.org.name} {unverified && <Badge tone="warn">Not verified</Badge>}</div>
              <button className="nav-link" style={{ padding: '6px 0' }} onClick={signOut}>Sign out</button>
            </div>
          </aside>
        )}
        <main className="content">
          {phone && !online && <div className="note warn" role="status" style={{ marginBottom: 12 }}>You are offline. Staff screens always need a connection.</div>}
          {onMore ? (
            <div className="more">
              <h1>More</h1>
              {picker}
              {groups.map((g) => (
                <section key={g.title} className="more-group">
                  <h2>{g.title}</h2>
                  <div className="more-list">
                    {g.items.map((p) => <button key={p.id} type="button" className="more-item" onClick={() => setPage(p.id)}>{p.label}<span aria-hidden="true">›</span></button>)}
                  </div>
                </section>
              ))}
              <section className="more-group">
                <h2>This app</h2>
                <InstallButton />
                <button type="button" className="more-item more-signout" onClick={signOut}>Sign out</button>
              </section>
            </div>
          ) : (
            <>
              {picker}
              {kyc && kyc.tone !== 'done' && current?.id !== 'verification' && <VerificationBanner s={kyc} onGo={() => setPage('verification')} />}
              <WalletBanner page={current?.id ?? ''} />
              {kyc && <VerificationDialog s={kyc} userKey={me.user.id} onGo={() => setPage('verification')} />}
              {Page ? <Page key={`${current.id}:${grant.org.id}:${scope}:${tick}`} /> : <ErrorNote>You do not have access to any pages yet.</ErrorNote>}
            </>
          )}
          <div style={{ height: 80 }} aria-hidden="true" />
        </main>
        {phone && (
          <nav className="tabs-bottom" aria-label="Main">
            {tabs.map((t) => (
              <button key={t.id} type="button" className={activeTab === t.id ? 'active' : ''} aria-current={activeTab === t.id ? 'page' : undefined} onClick={() => setPage(t.id)}><span aria-hidden="true" className="ti">{t.icon}</span>{t.label}</button>
            ))}
            <button type="button" className={activeTab === 'more' ? 'active' : ''} aria-current={activeTab === 'more' ? 'page' : undefined} onClick={() => setPage('more')}><span aria-hidden="true" className="ti">⋯</span>More</button>
          </nav>
        )}
        <HelpButton api={api} audience="staff" screen={HELP_SCREEN[current?.id ?? ''] ?? 'staff.dashboard'} />
      </div>
    </SessionCtx.Provider>
  );
}

export function App() {
  return (
    <LoginGate api={api} title="ChurchOS Staff" subtitle="Sign in to manage your church's giving." allow={() => true}>
      {({ signOut }) => <Shell signOut={signOut} />}
    </LoginGate>
  );
}

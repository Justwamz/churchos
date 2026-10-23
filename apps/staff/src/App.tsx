import { Suspense, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { summarize, VerificationBanner, VerificationDialog, type KycSummary } from './VerificationBanner';
import { Badge, BrandMark, Button, ConsentGate, ErrorNote, HelpButton, LegalApp, LoginGate, isLegalPath, useChurchBranding, useToast } from '@churchos/ui';
import { BrandCtx } from './Branding';
import { api, SessionCtx, friendly, EMAIL_REQUIRED_EVENT, type Session } from './session';
import { EmailGate } from './EmailGate';
import { WalletNotice, useWalletAlert } from './WalletBanner';
import { noteVisit, topPages } from './usage';
import { Notifications, openBell, useUnread } from './Notifications';
import { onNotify } from './links';
import { InstallButton, useInstall, useOnline } from './Install';
import { Icon } from './icons';
import { PAGES, pageLabel, type PageDef } from './nav';
import { AREAS, QUICK_ACTIONS, areaOfPage, type Area } from './navmap';
import { WordsProvider, useWords } from './words';
import { CommandBar } from './CommandBar';
import { KioskView } from './KioskView';
import { PageSkeleton } from './ui';
import './phone.css';
import './shell.css';

const HELP_SCREEN: Record<string, string> = {
  dashboard: 'staff.dashboard', collections: 'staff.collections', settlements: 'staff.settlements', cash: 'staff.cash',
  members: 'staff.members', transfers: 'staff.transfers', projects: 'staff.projects', help: 'staff.help',
  verification: 'staff.verification', payout: 'staff.payout', messages: 'staff.messages', wallets: 'staff.wallets', integrations: 'staff.integrations', adverts: 'staff.adverts', notices: 'staff.notices', events: 'staff.events', resources: 'staff.resources', bookings: 'staff.bookings', calendar: 'staff.calendar', groups: 'staff.groups', profile: 'staff.profile', records: 'staff.records', template: 'staff.template', audit: 'staff.audit', team: 'staff.team', shop: 'staff.shop', checkin: 'staff.checkin', today: 'staff.dashboard', children: 'staff.dashboard', prayer: 'staff.dashboard', lectionary: 'staff.dashboard', boundaries: 'staff.dashboard', suggestions: 'staff.dashboard', wording: 'staff.dashboard', branding: 'staff.dashboard',
};

const APPROVAL_PAGES = ['expenses', 'cash', 'events'];
const APPROVAL_RIGHT: Record<string, string> = { expenses: 'expenses.approve', cash: 'cash.approve', events: 'events.manage' };
const BRAND_APP = { label: 'Staff', description: 'Run your church from your phone: check people in, approve, count and follow up.', defaultTheme: '#123456' };
const COLLAPSE_KEY = 'churchos:staff-nav-collapsed';

/** phone <= 760px, tablet 761-1099px (rail only, flyout), desktop >= 1100px (rail + second panel). */
type Layout = 'phone' | 'tablet' | 'desktop';
function useLayout(): Layout {
  const get = (): Layout => (window.matchMedia('(max-width: 760px)').matches ? 'phone' : window.matchMedia('(min-width: 1100px)').matches ? 'desktop' : 'tablet');
  const [l, setL] = useState<Layout>(get);
  useEffect(() => {
    const qs = [window.matchMedia('(max-width: 760px)'), window.matchMedia('(min-width: 1100px)')];
    const on = () => setL(get());
    qs.forEach((m) => m.addEventListener('change', on));
    return () => qs.forEach((m) => m.removeEventListener('change', on));
  }, []);
  return l;
}

const initials = (n: string) => (n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

type NavPage = { p: PageDef; label: string };
type NavGroupV = { title?: string; items: NavPage[] };
type AreaV = Area & { groupsV: NavGroupV[]; first?: NavPage };

function Shell({ signOut }: { signOut: () => void }) {
  const [me, setMe] = useState<any>();
  const [error, setError] = useState<string>();
  const [orgIdx, setOrgIdx] = useState(0);
  const [scope, setScope] = useState('all');
  const [page, setPageState] = useState('');
  const pageRef = useRef('');

  // Keep the browser Back button working: every page change is a history entry.
  const setPage = useCallback((p: string) => {
    if (pageRef.current !== p) { try { window.history.pushState({ churchosPage: p }, ''); } catch { /* ignore */ } }
    pageRef.current = p;
    // A transition keeps the current page on screen until the next page's code has loaded: no flash of skeleton, no jump.
    startTransition(() => setPageState(p));
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    try { window.history.replaceState({ churchosPage: '' }, ''); } catch { /* ignore */ }
    const on = (e: PopStateEvent) => { const p = e.state?.churchosPage ?? ''; pageRef.current = p; startTransition(() => setPageState(p)); };
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);

  const { brand, reload: reloadBrand } = useChurchBranding(api, BRAND_APP);
  const brandCtx = useMemo(() => ({ brand, reload: reloadBrand }), [brand, reloadBrand]);
  const [gate, setGate] = useState(false);
  const [tick, setTick] = useState(0);
  const [kyc, setKyc] = useState<KycSummary | null>(null);

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
  }, [me, grant, scope, setPage]);

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
  if (!me) return <div className="boot"><PageSkeleton /></div>;
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

  return (
    <SessionCtx.Provider value={session}>
      <BrandCtx.Provider value={brandCtx}>
      <WordsProvider orgId={grant.org.id} multiOrg={me.orgs.length > 1}>
        <Frame me={me} orgIdx={orgIdx} setOrgIdx={setOrgIdx} page={page} setPage={setPage} kyc={kyc} gateOpen={gate} reloadMe={reloadMe} tick={tick} signOut={signOut} />
      </WordsProvider>
      </BrandCtx.Provider>
    </SessionCtx.Provider>
  );
}

type FrameProps = {
  me: any; orgIdx: number; setOrgIdx: (n: number) => void; page: string; setPage: (p: string) => void;
  kyc: KycSummary | null; gateOpen: boolean; reloadMe: () => void; tick: number; signOut: () => void;
};

function AccountMenu({ me, orgName, onProfile, signOut, onClose }: { me: any; orgName: string; onProfile: () => void; signOut: () => void; onClose: () => void }) {
  const inst = useInstall();
  return (
    <>
      <div className="avatar-scrim" onClick={onClose} />
      <div className="avatar-menu" role="menu">
        <div className="avatar-who"><b>{me.user.name || me.user.phone}</b><div className="tiny">{orgName}</div></div>
        <button type="button" role="menuitem" onClick={() => { onClose(); onProfile(); }}><Icon name="user" size={18} />My profile</button>
        {inst.available && !inst.ios && <button type="button" role="menuitem" onClick={() => { onClose(); inst.run(); }}><Icon name="download" size={18} />Install the app</button>}
        {inst.available && inst.ios && <div className="tiny" style={{ padding: '6px 12px' }}>To install: tap Share, then Add to Home Screen.</div>}
        <a role="menuitem" className="menu-link" href="/legal" target="_blank" rel="noopener">Terms, privacy and agreements</a>
        <button type="button" role="menuitem" className="danger" onClick={signOut}><Icon name="signout" size={18} />Sign out</button>
      </div>
    </>
  );
}

/** The signed-in frame: navigation (rail, second panel, flyout, phone tabs and menu), top bar, command bar, and the current page. */
function Frame({ me, orgIdx, setOrgIdx, page, setPage, kyc, gateOpen, reloadMe, tick, signOut }: FrameProps) {
  const w = useWords();
  const { brand } = useContext(BrandCtx);
  const layout = useLayout();
  const phone = layout === 'phone';
  const online = useOnline();
  const unreadCount = useUnread();
  const toast = useToast();
  useEffect(() => onNotify((t) => toast.show(t, 'bad')), [toast.show]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useContext(SessionCtx);
  const grant = s.grant;
  const [menu, setMenu] = useState(false);
  const [cmd, setCmd] = useState(false);
  const [flyout, setFlyout] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } });
  const unverified = !!kyc && kyc.tone !== 'done';
  const wallet = useWalletAlert(page);
  const main = useRef<HTMLElement>(null);
  const [visits, setVisits] = useState(0);
  useEffect(() => { const on = () => setVisits((n) => n + 1); window.addEventListener('churchos:visits', on); return () => window.removeEventListener('churchos:visits', on); }, []);

  const toggleCollapsed = () => setCollapsed((c) => { try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch { /* ignore */ } return !c; });

  // Ctrl+K / Cmd+K opens the command bar from anywhere.
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmd((v) => !v); } };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  // Any page change closes menus.
  useEffect(() => { setMenu(false); setFlyout(null); }, [page, layout]);
  useEffect(() => {
    if (!flyout) return;
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') setFlyout(null); };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [flyout]);

  const visible = PAGES.filter((p) => p.any.includes('*') || p.any.some((a) => s.can(a)));
  const byId = (id: string) => visible.find((p) => p.id === id);
  const areas = useMemo<AreaV[]>(() => AREAS.map((a) => {
    const groupsV = a.groups.map((g) => ({ title: g.title, items: g.ids.map(byId).filter(Boolean).map((p) => ({ p: p!, label: pageLabel(p!, w) })) })).filter((g) => g.items.length > 0);
    return { ...a, groupsV, first: groupsV[0]?.items[0] };
  }).filter((a) => a.id === 'today' || a.groupsV.length > 0),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [s, w.many]);

  const onMore = phone && page.startsWith('more');
  const moreArea = onMore && page.includes(':') ? areas.find((a) => a.id === page.split(':')[1]) : undefined;
  const current = byId(page) ?? byId('today') ?? visible[0];
  const Page = current?.el;
  const activeArea = areaOfPage(current?.id ?? 'today');
  const has = (id: string) => visible.some((p) => p.id === id);
  const approvalsPage = APPROVAL_PAGES.find((id) => has(id) && s.can(APPROVAL_RIGHT[id]));
  const tabs: { id: string; label: string; icon: any }[] = [{ id: 'today', label: 'Today', icon: 'today' }];
  if (s.can('attendance.checkin')) tabs.push({ id: 'usher', label: 'Check-in', icon: 'checkin' });
  if (s.can('kids.checkin')) tabs.push({ id: 'children', label: 'Children', icon: 'child' });
  if (approvalsPage && tabs.length < 4) tabs.push({ id: approvalsPage, label: 'Approvals', icon: 'check' });
  const activeTab = onMore ? 'more' : (tabs.find((t) => t.id === current?.id)?.id ?? 'more');
  const prevPage = useRef<string | undefined>(undefined);
  useEffect(() => {
    noteVisit(current?.id ?? '');
    // Move keyboard focus to the new page (not on first load) so Tab continues from the content, not from the menu you just used.
    const was = prevPage.current; prevPage.current = current?.id;
    if (was === undefined || was === current?.id) return;
    main.current?.focus({ preventScroll: true });
  }, [current?.id]);
  const shortcuts = useMemo(() => topPages(8).map((id) => byId(id)).filter((p): p is PageDef => !!p && p.id !== 'today').slice(0, 5).map((p) => ({ p, label: pageLabel(p, w) })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [visits, s, w.many, page]);

  const orgLabel = grant.org.name || 'ChurchOS';
  const picker = (
    <div className="picker">
      {me.orgs.length > 1 && (
        <select aria-label="Church" value={orgIdx} onChange={(e) => { setOrgIdx(Number(e.target.value)); s.setScope('all'); }}>
          {me.orgs.map((o: any, i: number) => <option key={o.org.id} value={i}>{o.org.name}</option>)}
        </select>
      )}
      <select aria-label="Branch scope" value={s.scope} onChange={(e) => s.setScope(e.target.value)}>
        {grant.branches.length > 1 && <option value="all">All branches</option>}
        {grant.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      {unverified && <Badge tone="warn">Not verified</Badge>}
    </div>
  );

  const account = (
    <div className="avatar-wrap">
      <button type="button" className="avatar" aria-label="Account menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>{initials(me.user.name || me.user.phone)}</button>
      {menu && <AccountMenu me={me} orgName={orgLabel} onProfile={() => setPage('profile')} signOut={signOut} onClose={() => setMenu(false)} />}
    </div>
  );

  const pageLink = (it: NavPage, onDone?: () => void) => (
    <button key={it.p.id} type="button" className={`sn-link ${current?.id === it.p.id ? 'active' : ''}`} aria-current={current?.id === it.p.id ? 'page' : undefined} onClick={() => { setPage(it.p.id); onDone?.(); }}>
      {it.label}
    </button>
  );
  const areaList = (a: AreaV, onDone?: () => void) => (
    <>
      {a.id === 'today' ? (
        <>
          {pageLink({ p: byId('today')!, label: 'Today' }, onDone)}
          <div className="sn-title">Your shortcuts</div>
          {shortcuts.length === 0
            ? <p className="sn-empty">The pages you open most will show up here.</p>
            : shortcuts.map((it) => pageLink(it, onDone))}
        </>
      ) : a.groupsV.map((g, i) => (
        <div key={i} className="sn-group">
          {g.title && <div className="sn-title">{g.title}</div>}
          {g.items.map((it) => pageLink(it, onDone))}
        </div>
      ))}
    </>
  );

  const banners = (
    <>
      {kyc && kyc.tone !== 'done' && current?.id !== 'verification' && <VerificationBanner s={kyc} onGo={() => setPage('verification')} />}
      <WalletNotice page={current?.id ?? ''} bad={wallet.bad} anyEmpty={wallet.anyEmpty} />
      {kyc && <VerificationDialog s={kyc} userKey={me.user.id} onGo={() => setPage('verification')} />}
    </>
  );
  const body = Page
    ? <Suspense fallback={<PageSkeleton />}><Page key={`${current.id}:${grant.org.id}:${s.scope}:${tick}`} /></Suspense>
    : <ErrorNote>You do not have access to any pages yet.</ErrorNote>;

  const searchBtn = phone
    ? <button type="button" className="icon-btn" aria-label="Search" onClick={() => setCmd(true)}><Icon name="search" size={22} /></button>
    : <button type="button" className="ns-search" aria-label="Search or jump to" onClick={() => setCmd(true)}><Icon name="search" size={18} /><span>Search or jump to</span><kbd>{isMac ? '⌘ K' : 'Ctrl K'}</kbd></button>;

  return (
    <div className={`shell ns ${layout} ${layout === 'desktop' && collapsed ? 'collapsed' : ''}`}>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>Skip to content</a>
      {((me.emailRequired && !me.emailVerified) || gateOpen) && <EmailGate initialEmail={me.user.email} onVerified={reloadMe} />}

      {phone ? (
        <header className="topbar">
          <div className="topbar-title brand-row"><BrandMark brand={brand} size={30} /><span className="brand-name">{orgLabel}</span></div>
          {searchBtn}
          <Notifications />
          {account}
        </header>
      ) : (
        <>
          <nav className="rail" aria-label="Areas">
            <button type="button" className="rail-logo" aria-label={`${orgLabel}: go to Today`} onClick={() => setPage('today')}><BrandMark brand={brand} size={44} fallback={<Icon name="worship" size={22} />} /></button>
            {areas.map((a) => {
              const on = activeArea?.id === a.id;
              return (
                <button key={a.id} type="button" className={`rail-item ${on ? 'active' : ''}`} aria-current={on ? 'page' : undefined} aria-haspopup={layout === 'tablet' && a.id !== 'today' ? 'menu' : undefined}
                  onClick={() => { if (layout === 'tablet' && a.id !== 'today') setFlyout((f) => (f === a.id ? null : a.id)); else if (a.first) setPage(a.first.p.id); }}>
                  <span className="rail-pill"><Icon name={a.icon} size={22} />{a.id === 'communicate' && wallet.bad.length > 0 && <span className={`rail-dot ${wallet.anyEmpty ? 'bad' : 'warn'}`} role="img" aria-label={wallet.anyEmpty ? 'Messaging credit has run out' : 'Messaging credit is running low'} />}</span>
                  <span className="rail-label">{a.label}</span>
                </button>
              );
            })}
          </nav>
          {layout === 'desktop' && !collapsed && (
            <nav className="subnav" aria-label={`${activeArea?.label ?? 'Pages'} pages`}>
              <div className="sn-head">
                <div className="sn-titles"><span className="tiny">{orgLabel}</span><h2>{activeArea?.label ?? 'Today'}</h2></div>
                <button type="button" className="icon-btn sm" aria-label="Hide the page list" onClick={toggleCollapsed}><Icon name="chevron" size={18} style={{ transform: 'rotate(180deg)' }} /></button>
              </div>
              {areas.filter((a) => a.id === (activeArea?.id ?? 'today')).map((a) => <div key={a.id}>{areaList(a)}</div>)}
            </nav>
          )}
          {layout === 'tablet' && flyout && (
            <>
              <div className="fly-scrim" onClick={() => setFlyout(null)} />
              <nav className="subnav flyout" aria-label="Pages">
                <div className="sn-head"><div className="sn-titles"><h2>{areas.find((a) => a.id === flyout)?.label}</h2></div><button type="button" className="icon-btn sm" aria-label="Close" onClick={() => setFlyout(null)}><Icon name="close" size={18} /></button></div>
                {areas.filter((a) => a.id === flyout).map((a) => <div key={a.id}>{areaList(a, () => setFlyout(null))}</div>)}
              </nav>
            </>
          )}
        </>
      )}

      <div className="ns-main">
        {!phone && (
          <header className="ns-top">
            {layout === 'desktop' && collapsed && <button type="button" className="icon-btn" aria-label="Show the page list" onClick={toggleCollapsed}><Icon name="menu" size={20} /></button>}
            {picker}
            <span className="spacer" />
            {searchBtn}
            <Notifications />
            {account}
          </header>
        )}
        <main className="content" id="main" tabIndex={-1} ref={main} aria-label={current ? pageLabel(current, w) : 'Content'}>
          {phone && !online && <div className="note warn" role="status" style={{ marginBottom: 12 }}>You are offline. Staff screens always need a connection.</div>}
          {onMore ? (
            <div className="more">
              {moreArea ? (
                <>
                  <button type="button" className="more-back" onClick={() => setPage('more')}><Icon name="chevron" size={18} style={{ transform: 'rotate(180deg)' }} />Menu</button>
                  <h1>{moreArea.label}</h1>
                  {moreArea.groupsV.map((g, i) => (
                    <section key={i} className="more-group">
                      {g.title && <h2>{g.title}</h2>}
                      <div className="more-list">
                        {g.items.map((it) => <button key={it.p.id} type="button" className="more-item" onClick={() => setPage(it.p.id)}>{it.label}<Icon name="chevron" size={18} /></button>)}
                      </div>
                    </section>
                  ))}
                </>
              ) : (
                <>
                  <h1>Menu</h1>
                  <button type="button" className="more-item" onClick={openBell}>Notifications{unreadCount > 0 ? ` (${unreadCount} unread)` : ''}<Icon name="bell" size={18} /></button>
                  {picker}
                  <div className="more-grid">
                    {areas.filter((a) => a.id !== 'today').map((a) => (
                      <button key={a.id} type="button" className="more-tile" onClick={() => (a.groupsV.length === 1 && a.groupsV[0].items.length === 1 ? setPage(a.first!.p.id) : setPage('more:' + a.id))}>
                        <span className="more-tile-ico"><Icon name={a.icon} size={28} /></span>
                        <b>{a.label}</b>
                        <span className="tiny">{a.groupsV.reduce((n, g) => n + g.items.length, 0)} pages</span>
                      </button>
                    ))}
                  </div>
                  <section className="more-group">
                    <h2>This app</h2>
                    <InstallButton />
                    <a className="more-item" href="/legal" target="_blank" rel="noopener">Terms, privacy and agreements<Icon name="chevron" size={18} /></a>
                    <button type="button" className="more-item more-signout" onClick={signOut}>Sign out</button>
                  </section>
                </>
              )}
            </div>
          ) : (
            <>
              {phone && picker}
              {banners}
              {body}
            </>
          )}
          <div style={{ height: 80 }} aria-hidden="true" />
        </main>
      </div>

      {phone && (
        <nav className="tabs-bottom" aria-label="Main">
          {tabs.map((t) => (
            <button key={t.id} type="button" className={activeTab === t.id ? 'active' : ''} aria-current={activeTab === t.id ? 'page' : undefined} onClick={() => setPage(t.id)}><Icon name={t.icon} size={22} />{t.label}</button>
          ))}
          <button type="button" className={activeTab === 'more' ? 'active' : ''} aria-current={activeTab === 'more' ? 'page' : undefined} onClick={() => setPage('more')}><span className="tab-ico"><Icon name="grid" size={22} />{unreadCount > 0 && <span className="tab-badge" aria-label={`${unreadCount} unread notifications`}>{unreadCount > 99 ? '99+' : unreadCount}</span>}</span>Menu</button>
        </nav>
      )}
      {toast.node}
      {cmd && <CommandBar onClose={() => setCmd(false)} />}
      <HelpButton api={api} audience="staff" screen={HELP_SCREEN[current?.id ?? ''] ?? 'staff.dashboard'} />
    </div>
  );
}

export function App() {
  // The kiosk screen is a paired device, not a signed-in person: it must never reach the staff sign-in or the staff shell.
  if (location.pathname.replace(/\/+$/, '') === '/kiosk') return <KioskView />;
  if (isLegalPath()) return <LegalApp app="staff" appName="Staff app" loadChurch={() => (api.getToken() ? api.get('/me/branding').then((b: any) => (b?.name ? { name: b.name } : null)) : Promise.resolve(null))} />;
  return (
    <LoginGate api={api} title="ChurchOS Staff" subtitle="Sign in to look after your people, your worship and your money." legal="staff" allow={() => true}>
      {({ signOut }) => <ConsentGate api={api} app="staff" signOut={signOut}><Shell signOut={signOut} /></ConsentGate>}
    </LoginGate>
  );
}

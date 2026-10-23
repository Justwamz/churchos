import { Suspense, lazy, startTransition, useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { ConsentGate, HelpButton, LegalApp, LoginGate, isLegalPath, PasskeyBanner, phonePretty, useToast } from '@churchos/ui';
import { api, type PageProps } from './common';
import { Icon } from './icons';
import { AREAS, areaOfPage, pageById, type Area, type PageId } from './navmap';
import { CommandBar } from './CommandBar';
import { PageSkeleton } from './ui';
import './shell.css';
import './admin-extra.css';
import './admin-ux.css';

/** Pages load on demand: each file is its own chunk, and a skeleton shows while it loads. */
const lazyPage = <K extends string>(load: () => Promise<Record<K, ComponentType<PageProps>>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const PAGE_EL: Record<PageId, ComponentType<PageProps>> = {
  overview: lazyPage(() => import('./pages/Overview'), 'Overview'),
  payments: lazyPage(() => import('./pages/Money'), 'Payments'),
  settlements: lazyPage(() => import('./pages/Money'), 'Settlements'),
  suspense: lazyPage(() => import('./pages/Money'), 'Suspense'),
  reversals: lazyPage(() => import('./pages/Money'), 'Reversals'),
  tenants: lazyPage(() => import('./pages/Tenants'), 'Tenants'),
  kyc: lazyPage(() => import('./pages/Churches'), 'Kyc'),
  'payout-requests': lazyPage(() => import('./pages/Churches'), 'PayoutRequests'),
  messaging: lazyPage(() => import('./pages/Messaging'), 'Messaging'),
  tariffs: lazyPage(() => import('./MessagingAdmin'), 'Tariffs'),
  providers: lazyPage(() => import('./MessagingAdmin'), 'Providers'),
  adverts: lazyPage(() => import('./MessagingAdmin'), 'Adverts'),
  smsbox: lazyPage(() => import('./pages/Outboxes'), 'SmsOutbox'),
  outbox: lazyPage(() => import('./pages/Outboxes'), 'Outbox'),
  tools: lazyPage(() => import('./pages/Platform'), 'Tools'),
  audit: lazyPage(() => import('./pages/Audit'), 'Audit'),
  'data-requests': lazyPage(() => import('./pages/DataRequests'), 'DataRequests'),
  security: lazyPage(() => import('./pages/Security'), 'Security'),
};

const COLLAPSE_KEY = 'churchos:admin-nav-collapsed';

/** phone <= 760px, tablet 761-1099px (rail only, flyout), desktop >= 1100px (rail + area panel). */
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

/**
 * Tables become cards on a phone. CSS needs each cell to know its column title, so label every cell from its table's header row.
 * Runs once after each change inside the page (also covers the audit log, which comes from the shared package).
 */
function useCellLabels(root: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let raf = 0;
    const label = () => {
      el.querySelectorAll<HTMLTableElement>('table.table').forEach((t) => {
        const heads = Array.from(t.querySelectorAll('thead th')).map((h) => (h.textContent ?? '').trim());
        if (heads.length === 0) return;
        const first = t.querySelector('tbody > tr');
        if (first) Array.from(first.children).forEach((td, i) => { if (td.classList.contains('num')) t.querySelectorAll('thead th')[i]?.classList.add('num'); });
        t.querySelectorAll('tbody > tr').forEach((tr) => {
          let col = 0;
          Array.from(tr.children).forEach((td) => {
            const span = Number((td as HTMLTableCellElement).colSpan || 1);
            if (span === 1) { const l = heads[col] ?? ''; if (td.getAttribute('data-label') !== l) td.setAttribute('data-label', l); }
            col += span;
          });
        });
      });
    };
    /** A region that scrolls must be reachable by keyboard and have a name. Only tables that really scroll (not the phone card layout) get it. */
    const regions = () => {
      el.querySelectorAll<HTMLElement>('.table-wrap').forEach((w) => {
        const cs = getComputedStyle(w);
        const scrolls = /(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflowX);
        if (scrolls) {
          if (!w.hasAttribute('tabindex')) w.setAttribute('tabindex', '0');
          if (!w.hasAttribute('role')) w.setAttribute('role', 'region');
          const heads = Array.from(w.querySelectorAll('thead th')).map((h) => (h.textContent ?? '').trim()).filter(Boolean);
          const name = heads.length ? 'Table: ' + heads.slice(0, 4).join(', ') : 'Table';
          if (w.getAttribute('aria-label') !== name) w.setAttribute('aria-label', name);
        } else if (w.getAttribute('role') === 'region') {
          w.removeAttribute('tabindex'); w.removeAttribute('role'); w.removeAttribute('aria-label');
        }
      });
    };
    const run = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { label(); regions(); }); };
    window.addEventListener('resize', run);
    const mo = new MutationObserver(run);
    mo.observe(el, { childList: true, subtree: true });
    run();
    return () => { mo.disconnect(); window.removeEventListener('resize', run); cancelAnimationFrame(raf); };
  }, [root]);
}

/** One tab stop for a list of buttons: Up/Down (or Left/Right), Home and End move between them. Keeps the Tab order short. */
function onRovingKey(e: React.KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-rove]'));
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
  items[next]?.focus();
}

export function App() {
  if (isLegalPath()) return <LegalApp app="admin" appName="Platform admin" />;
  return (
    <LoginGate api={api} title="Platform Admin" subtitle="For ChurchOS staff only. Sign in with your admin phone number." legal="admin" allow={(u) => !!u.isAdmin}>
      {({ user, signOut }) => <ConsentGate api={api} app="admin" signOut={signOut}><Shell user={user} signOut={signOut} /></ConsentGate>}
    </LoginGate>
  );
}

function Shell({ user, signOut }: { user: any; signOut: () => void }) {
  const toast = useToast();
  const layout = useLayout();
  const phone = layout === 'phone';
  const [page, setPageState] = useState<string>('overview');
  const pageRef = useRef('overview');
  const [menu, setMenu] = useState(false);
  const [cmd, setCmd] = useState(false);
  const [flyout, setFlyout] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } });
  const main = useRef<HTMLElement>(null);
  useCellLabels(main);
  // The test tools exist only where the API says so (never on the Render demo). Hidden until the API answers.
  const [devTools, setDevTools] = useState(false);
  useEffect(() => { api.get<{ enabled: boolean }>('/admin/dev-tools').then((r) => setDevTools(!!r?.enabled)).catch(() => setDevTools(false)); }, []);
  const areas: Area[] = AREAS.map((a) => (devTools ? a : { ...a, ids: a.ids.filter((id) => id !== 'tools') }));

  // Keep the browser Back button working: every page change is a history entry.
  const setPage = useCallback((p: string) => {
    if (pageRef.current !== p) { try { window.history.pushState({ adminPage: p }, ''); } catch { /* ignore */ } }
    pageRef.current = p;
    startTransition(() => setPageState(p));
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    try { window.history.replaceState({ adminPage: 'overview' }, ''); } catch { /* ignore */ }
    const on = (e: PopStateEvent) => { const p = e.state?.adminPage ?? 'overview'; pageRef.current = p; startTransition(() => setPageState(p)); };
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);

  const toggleCollapsed = () => setCollapsed((c) => { try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch { /* ignore */ } return !c; });

  useEffect(() => {
    const on = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmd((v) => !v); } };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  useEffect(() => { setMenu(false); setFlyout(null); }, [page, layout]);
  useEffect(() => {
    if (!flyout) return;
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') setFlyout(null); };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [flyout]);

  const onMore = phone && page.startsWith('more');
  const moreArea = onMore && page.includes(':') ? areas.find((a) => a.id === page.split(':')[1]) : undefined;
  const current = (page === 'tools' && !devTools ? pageById('audit') : pageById(page)) ?? pageById('overview')!;
  const Page = PAGE_EL[current.id];
  const activeArea = areas.find((a) => (a.ids as string[]).includes(current.id)) ?? areaOfPage(current.id) ?? areas[0];
  const solo = activeArea.ids.length === 1;
  const phoneTabs = areas.filter((a) => a.id !== 'platform');
  const activeTab = onMore ? 'menu' : activeArea.id === 'platform' ? 'menu' : activeArea.id;

  const prevPage = useRef<string | undefined>(undefined);
  useEffect(() => {
    const was = prevPage.current; prevPage.current = current.id;
    if (was === undefined || was === current.id) return;
    main.current?.focus({ preventScroll: true });
  }, [current.id]);

  const name = user.name ?? phonePretty(user.phone);
  const pageProps: PageProps = { toast: toast.show, user, go: setPage, devTools };

  const account = (
    <div className="avatar-wrap">
      <button type="button" className="avatar" aria-label="Account menu" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu((m) => !m)}>{initials(name)}</button>
      {menu && (
        <>
          <div className="avatar-scrim" onClick={() => setMenu(false)} />
          <div className="avatar-menu" role="menu">
            <div className="avatar-who"><b>{name}</b><div className="tiny">Platform admin</div></div>
            <a role="menuitem" className="menu-link" href="/legal" target="_blank" rel="noopener">Terms and privacy</a>
            <button type="button" role="menuitem" className="danger" onClick={signOut}><Icon name="signout" size={18} />Sign out</button>
          </div>
        </>
      )}
    </div>
  );

  const pageLink = (id: PageId, onDone?: () => void) => {
    const p = pageById(id)!;
    return (
      <button key={id} type="button" data-rove className={`sn-link ${current.id === id ? 'active' : ''}`} tabIndex={current.id === id ? 0 : -1} aria-current={current.id === id ? 'page' : undefined} onClick={() => { setPage(id); onDone?.(); }}>{p.label}</button>
    );
  };
  const areaList = (a: Area, onDone?: () => void) => {
    const tech = a.technical ?? [];
    const main = a.ids.filter((id) => !tech.includes(id));
    const techIds = a.ids.filter((id) => tech.includes(id));
    return (
      <div className="sn-group" onKeyDown={onRovingKey}>
        {main.map((id) => pageLink(id, onDone))}
        {techIds.length > 0 && <><h3 className="sn-title">Technical</h3>{techIds.map((id) => pageLink(id, onDone))}</>}
      </div>
    );
  };

  const searchBtn = phone
    ? <button type="button" className="icon-btn" aria-label="Search" onClick={() => setCmd(true)}><Icon name="search" size={22} /></button>
    : <button type="button" className="ns-search" aria-label="Search or jump to" onClick={() => setCmd(true)}><Icon name="search" size={18} /><span>Search or jump to</span><kbd>{isMac ? '⌘ K' : 'Ctrl K'}</kbd></button>;

  const body = <Suspense fallback={<PageSkeleton />}><Page key={current.id} {...pageProps} /></Suspense>;

  return (
    <div className={`shell ns ${layout} ${layout === 'desktop' && (collapsed || solo) ? 'collapsed' : ''} ${layout === 'desktop' && solo ? 'solo' : ''}`}>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>Skip to content</a>

      {phone ? (
        <header className="topbar">
          <div className="topbar-title"><span className="brand-name">ChurchOS</span><span className="pa-badge">Platform admin</span></div>
          {searchBtn}
          {account}
        </header>
      ) : (
        <>
          <nav className="rail" aria-label="Areas" onKeyDown={onRovingKey}>
            <button type="button" tabIndex={-1} className="rail-logo" aria-label="ChurchOS Platform admin: go to Overview" onClick={() => setPage('overview')}><Icon name="shield" size={22} /></button>
            <span className="rail-badge">Platform admin</span>
            {areas.map((a) => {
              const on = activeArea.id === a.id;
              const multi = a.ids.length > 1;
              return (
                <button key={a.id} type="button" data-rove tabIndex={on ? 0 : -1} className={`rail-item ${on ? 'active' : ''}`} aria-current={on ? 'page' : undefined} aria-haspopup={layout === 'tablet' && multi ? 'menu' : undefined} aria-expanded={layout === 'tablet' && multi ? flyout === a.id : undefined}
                  onClick={() => { if (layout === 'tablet' && multi) setFlyout((f) => (f === a.id ? null : a.id)); else setPage(a.ids[0]); }}>
                  <span className="rail-pill"><Icon name={a.icon} size={22} /></span>
                  <span className="rail-label">{a.label}</span>
                </button>
              );
            })}
          </nav>
          {layout === 'desktop' && !collapsed && !solo && (
            <nav className="subnav" aria-label={`${activeArea.label} pages`}>
              <div className="sn-head">
                <div className="sn-titles"><span className="tiny">Platform admin</span><h2>{activeArea.label}</h2></div>
                <button type="button" className="icon-btn sm" aria-label="Hide the page list" onClick={toggleCollapsed}><Icon name="chevron" size={18} style={{ transform: 'rotate(180deg)' }} /></button>
              </div>
              {areaList(activeArea)}
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
            {layout === 'desktop' && collapsed && !solo && <button type="button" className="icon-btn" aria-label="Show the page list" onClick={toggleCollapsed}><Icon name="menu" size={20} /></button>}
            <span className="spacer" />
            {searchBtn}
            {account}
          </header>
        )}
        <main className="content" id="main" tabIndex={-1} ref={main} aria-label={onMore ? 'Menu' : current.label}>
          {onMore ? (
            <div className="more">
              {moreArea ? (
                <>
                  <button type="button" className="more-back" onClick={() => setPage('more')}><Icon name="chevron" size={18} style={{ transform: 'rotate(180deg)' }} />Menu</button>
                  <h1>{moreArea.label}</h1>
                  <section className="more-group">
                    <div className="more-list">
                      {moreArea.ids.map((id) => <button key={id} type="button" className="more-item" onClick={() => setPage(id)}>{pageById(id)!.label}<Icon name="chevron" size={18} /></button>)}
                    </div>
                  </section>
                </>
              ) : (
                <>
                  <h1>Menu</h1>
                  <div className="more-grid">
                    {areas.map((a) => (
                      <button key={a.id} type="button" className="more-tile" onClick={() => setPage(a.ids.length === 1 ? a.ids[0] : 'more:' + a.id)}>
                        <span className="more-tile-ico"><Icon name={a.icon} size={28} /></span>
                        <b>{a.label}</b>
                        <span className="tiny">{a.ids.length} {a.ids.length === 1 ? 'page' : 'pages'}</span>
                      </button>
                    ))}
                    <button type="button" className="more-tile pinned" onClick={() => setPage('audit')}>
                      <span className="more-tile-ico"><Icon name="list" size={28} /></span>
                      <b>Audit log</b>
                      <span className="tiny">Every change</span>
                    </button>
                    <button type="button" className="more-tile pinned" onClick={() => setPage('security')}>
                      <span className="more-tile-ico"><Icon name="shield" size={28} /></span>
                      <b>Security</b>
                      <span className="tiny">Passkeys, devices</span>
                    </button>
                  </div>
                  <section className="more-group">
                    <h2>This account</h2>
                    <div className="tiny" style={{ margin: '0 4px 8px' }}>{name} · Platform admin</div>
                    <button type="button" className="more-item more-signout" onClick={signOut}>Sign out</button>
                  </section>
                </>
              )}
            </div>
          ) : (
            <>
              {layout !== 'desktop' && activeArea.ids.length > 1 && (
                <nav className="area-pills" aria-label={`${activeArea.label} pages`}>
                  {activeArea.ids.map((id) => <button key={id} type="button" className={`chip ${current.id === id ? 'on' : ''}`} aria-current={current.id === id ? 'page' : undefined} onClick={() => setPage(id)}>{pageById(id)!.label}</button>)}
                </nav>
              )}
              {current.id !== 'security' && <PasskeyBanner api={api} onOpen={() => setPage('security')} />}
              {body}
            </>
          )}
        </main>
      </div>

      {phone && (
        <nav className="tabs-bottom" aria-label="Main">
          {phoneTabs.map((a) => (
            <button key={a.id} type="button" className={activeTab === a.id ? 'active' : ''} aria-current={activeTab === a.id ? 'page' : undefined} onClick={() => setPage(a.ids[0])}><Icon name={a.icon} size={22} />{a.label}</button>
          ))}
          <button type="button" className={activeTab === 'menu' ? 'active' : ''} aria-current={activeTab === 'menu' ? 'page' : undefined} onClick={() => setPage('more')}><Icon name="grid" size={22} />Menu</button>
        </nav>
      )}
      {cmd && <CommandBar onClose={() => setCmd(false)} go={setPage} hide={devTools ? [] : ['tools']} />}
      <HelpButton api={api} audience="admin" screen={`admin.${current.id === 'messaging' ? 'sms' : current.id}`} />
      {toast.node}
    </div>
  );
}


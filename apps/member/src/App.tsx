import { networkMismatch, phoneHint } from '@churchos/shared';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { BrandMark, useChurchBranding, Badge, Button, Card, CertificateCard, Empty, ErrorNote, Field, HelpButton, LoginGate, ConsentGate, LegalApp, isLegalPath, Note, StatusBadge, Table, dateOnly, kes, phonePretty, printCertificate, shortDate, useAsync, useToast } from '@churchos/ui';
import type { BrandInfo, CertificatePayload } from '@churchos/ui';
import { api, errText, useOnline } from './api';
import { Inbox, LinkCtx } from './Inbox';
import { MessageChoices } from './Choices';
import { MyData, SecurityScreen } from './MyData';
import { Icon, Sheet, Skeleton } from './ui';
import { FamilyPage, useFamilies } from './Family';
import { RegularGiving } from './RegularGiving';
import { AnonSwitch, GivingRecord } from './GivingRecord';
import { WordsProvider, useWords } from './Words';
import { LinkHome, LinkOffers, Locked, VisitorGiveTab } from './LinkChurch';
import { TICKET_PENDING_KEY, UserCtx } from './Tickets';
import type { ShopIntent } from './Shop';
import { CommunityHub, ServicesHub } from './Hubs';
import type { CommunitySection, EventsSub, ServicesSection } from './Hubs';
import { Home } from './Home';
import type { HomeLinks } from './Home';
import { ProfileMenu } from './ProfileMenu';
import { useInstall } from './Install';
import { hashFor, placeForHash, placeForLink } from './links';
import type { GiveSub, Place, ProfileTarget, Tab } from './links';

type Nav = { tab: Tab; sub: GiveSub; purpose?: string; k: number; section?: string; esub: EventsSub; psub: ProfileTarget };
type Go = (t: Tab, o?: { sub?: GiveSub; purpose?: string }) => void;
/** Six tabs at most. Children only shows for a member who has children. Me is gone: the avatar opens the profile menu. */
const TABS: { key: Tab; label: string; ico: string }[] = [
  { key: 'home', label: 'Home', ico: 'home' },
  { key: 'give', label: 'Give', ico: 'give' },
  { key: 'services', label: 'Services', ico: 'calendar' },
  { key: 'community', label: 'Community', ico: 'groups' },
  { key: 'inbox', label: 'Messages', ico: 'chat' },
  { key: 'kids', label: 'Children', ico: 'family' },
];
const TITLES: Record<Tab, string> = { home: 'Home', give: 'Give', services: 'Services', community: 'Community', inbox: 'Messages', kids: 'Children', profile: 'My profile and church' };
const PROFILE_TITLES: Record<ProfileTarget, string> = { main: 'My profile and church', data: 'My data and privacy', security: 'Security' };

const METHODS = [
  { key: 'mpesa', label: 'M-Pesa' },
  { key: 'airtel', label: 'Airtel Money' },
  { key: 'tkash', label: 'T-Kash' },
  { key: 'card', label: 'Card' },
];
const QUICK = [100, 500, 1000, 2000, 5000];

/** Friendly words for payment statuses. 'pending' is the 48 hour hold, which the member sees simply as received. */
function friendlyStatus(s: string) {
  if (s === 'pending' || s === 'available' || s === 'paid_out') return <Badge tone="good">Received</Badge>;
  if (s === 'reversed' || s === 'refunded') return <Badge tone="bad">Refunded</Badge>;
  if (s === 'suspense') return <Badge tone="warn">Under review</Badge>;
  return <StatusBadge status={s} />;
}

function Loading() { return <div className="card"><Skeleton lines={3} /></div>; }
function Failed({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="stack">
      <ErrorNote>{error}</ErrorNote>
      <Button kind="ghost" onClick={retry}>Try again</Button>
    </div>
  );
}

const isReceipt = (r: any) => r.kind === 'receipt' || r.kind === 'giving' || r.kind === 'gift';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const initials = (n: string) => (n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('') || 'U').toUpperCase();

export function App() {
  if (isLegalPath()) return <LegalApp app="member" appName="Member app" loadChurch={() => (api.getToken() ? api.get('/me/branding').then((b: any) => (b?.name ? { name: b.name } : null)) : Promise.resolve(null))} />;
  return (
    <LoginGate api={api} title="ChurchOS Member" subtitle="Give, follow your giving and stay connected to your church. Sign in with your phone number." legal="member">
      {({ user, signOut }) => <ConsentGate api={api} app="member" signOut={signOut} withMessageChoices><UserCtx.Provider value={user}><WordsProvider><Shell user={user} signOut={signOut} /></WordsProvider></UserCtx.Provider></ConsentGate>}
    </LoginGate>
  );
}

const toNav = (p: Place, k: number): Nav => ({ tab: p.tab, sub: p.sub ?? 'give', purpose: p.purpose, k, section: p.section, esub: p.esub ?? 'events', psub: p.psub ?? 'main' });
function parseHash(): Nav { return toNav(placeForHash(location.hash), 0); }
/** A paid ticket or shop order that was left half way (card page) reopens where it can be finished. */
function initialNav(): Nav {
  const n = parseHash();
  try {
    if (n.tab === 'home' && localStorage.getItem(TICKET_PENDING_KEY)) return toNav({ tab: 'services', section: 'events', esub: 'tickets' }, 0);
    if (n.tab === 'home' && localStorage.getItem('churchos:shop-pending')) return toNav({ tab: 'services', section: 'shop' }, 0);
  } catch { /* storage blocked */ }
  return n;
}

const BRAND_APP = { label: 'Member', description: 'Give, read messages from your church, join groups and keep your records.', defaultTheme: '#0e5a52' };
const BrandCtx = createContext<BrandInfo | null>(null);
/** The church's logo on a small white tile so it reads on the green bar and on the light desktop bar; nothing when there is no logo. */
function ChurchLogo({ brand, size = 36 }: { brand: BrandInfo | null; size?: number }) {
  if (!brand?.hasLogo || !brand.orgId) return null;
  return <span className="church-logo" style={{ width: size, height: size }}><BrandMark brand={brand} size={size - 6} /></span>;
}

function Shell({ user, signOut }: { user: any; signOut: () => void }) {
  const { brand } = useChurchBranding(api, BRAND_APP);
  const words = useWords();
  const [nav, setNav] = useState<Nav>(initialNav);
  const tab = nav.tab;
  const [shopIntent, setShopIntent] = useState<ShopIntent | undefined>();
  const [shopK, setShopK] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const toTop = () => { if (mainRef.current) mainRef.current.scrollTop = 0; };

  /** Move to a place. Profile screens are pushed onto the browser history so Back works; everything else replaces the address, as before. */
  const open = (p: Place, how: 'replace' | 'push' = 'replace') => {
    setNav((prev) => toNav(p, prev.k + 1));
    try { if (how === 'push') history.pushState({ pf: true }, '', hashFor(p)); else history.replaceState(null, '', hashFor(p)); } catch { /* ignore */ }
    toTop();
  };
  const openShop = (i?: ShopIntent) => { setShopIntent(i); setShopK((k) => k + 1); open({ tab: 'services', section: 'shop' }); };
  const openProfile = (t: ProfileTarget = 'main') => open({ tab: 'profile', psub: t }, 'push');
  const events = useRef<Record<string, () => void>>({});
  events.current = {
    'churchos:open-tickets': () => open({ tab: 'services', section: 'events', esub: 'tickets' }),
    'churchos:open-prayer': () => open({ tab: 'community', section: 'prayer' }),
    'churchos:open-suggestions': () => open({ tab: 'community', section: 'suggestions' }),
    'churchos:open-credit': () => open({ tab: 'services', section: 'events', esub: 'credit' }),
    'churchos:open-events': () => open({ tab: 'services', section: 'events', esub: 'events' }),
  };
  useEffect(() => {
    const fns = Object.keys(events.current).map((name) => [name, () => events.current[name]()] as const);
    fns.forEach(([n, f]) => window.addEventListener(n, f));
    // Back and Forward (and a hash typed into the address bar) move between the places the history holds.
    const onPop = () => setNav((prev) => ({ ...parseHash(), k: prev.k + 1 }));
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    return () => { fns.forEach(([n, f]) => window.removeEventListener(n, f)); window.removeEventListener('popstate', onPop); window.removeEventListener('hashchange', onPop); };
  }, []);
  // an old hash (#me, #groups, #tickets) is rewritten to the address it now lives at
  useEffect(() => { try { if (location.hash && location.hash !== hashFor(nav)) history.replaceState(history.state, '', hashFor(nav)); } catch { /* ignore */ } }, []); // eslint-disable-line
  const me = useAsync<any>(() => api.get('/me'));
  const online = useOnline();
  const fams = useFamilies();
  const hasKids = fams.families.length > 0;
  const notif = useAsync<any>(() => api.get('/me/notifications'));
  const notifReload = useRef(notif.reload);
  notifReload.current = notif.reload;
  const notifData = useRef<any>(undefined);
  notifData.current = notif.data;
  const setNotifData = useRef(notif.setData);
  setNotifData.current = notif.setData;
  const unread = Number(notif.data?.unread ?? 0);

  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible' && navigator.onLine) notifReload.current(); };
    const timer = setInterval(tick, 20000);
    // after a gift the server writes the receipt a moment later: look up to 5 times, 1s apart
    let alive = true;
    const onGift = async () => {
      const known = new Set<string>((notifData.current?.rows ?? []).filter(isReceipt).map((r: any) => r.id));
      for (let i = 0; i < 5 && alive; i++) {
        await sleep(1000);
        try {
          const r = await api.get('/me/notifications');
          if ((r?.rows ?? []).some((x: any) => isReceipt(x) && !known.has(x.id))) { setNotifData.current(r); return; }
        } catch { /* try again */ }
      }
      if (alive) notifReload.current();
    };
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('online', tick);
    window.addEventListener('churchos:gift-done', onGift);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', tick); window.removeEventListener('online', tick); window.removeEventListener('churchos:gift-done', onGift); };
  }, []);

  /** Move to a tab (and the give section); the profile and the hub sections go through open(). */
  const go: Go = (t, o) => open({ tab: t, sub: o?.sub, purpose: o?.purpose });

  const m = me.data?.memberships?.[0];
  const unlinked = !!me.data && !me.data.memberships?.length;
  /** Message links: member:<page>?params -> the screen the app really has. Unknown pages go Home. */
  const openLink = (link: string) => {
    const p = placeForLink(link, { unlinked, hasKids });
    if (!p) return;
    if (p.tab === 'services' && p.section === 'shop') openShop();
    else open(p, p.tab === 'profile' ? 'push' : 'replace');
  };
  const links: HomeLinks = {
    give: (o) => go('give', o),
    inbox: () => go('inbox'),
    kids: () => go(hasKids ? 'kids' : 'home'),
    services: () => open({ tab: 'services', section: 'services' }),
    tickets: () => open({ tab: 'services', section: 'events', esub: 'tickets' }),
    events: () => open({ tab: 'services', section: 'events', esub: 'events' }),
    bookings: () => open({ tab: 'services', section: 'events', esub: 'bookings' }),
    credit: () => open({ tab: 'services', section: 'events', esub: 'credit' }),
    shop: openShop,
    prayer: () => open({ tab: 'community', section: 'prayer' }),
    suggestions: () => open({ tab: 'community', section: 'suggestions' }),
    notices: () => open({ tab: 'community', section: 'notices' }),
  };

  useEffect(() => { if (!api.getToken()) signOut(); }, [me.error]); // eslint-disable-line
  const onLinked = () => { me.reload(); fams.reload(); notif.reload(); toTop(); };
  const name = String(m?.full_name ?? user?.name ?? '');
  const helpScreen = tab === 'give' && nav.sub === 'history' ? 'member.history' : tab === 'community' || tab === 'profile' ? 'member.church' : tab === 'inbox' ? 'member.inbox' : tab === 'give' ? 'member.give' : 'member.home';
  const profileBack = () => { if (history.state?.pf) history.back(); else open(nav.psub === 'main' ? { tab: 'home' } : { tab: 'profile', psub: 'main' }); };
  const section = nav.section as string | undefined;
  return (
    <BrandCtx.Provider value={brand}><div className="app">
      <header className="appbar">
        {tab === 'profile' && <button type="button" className="icon-btn" aria-label={nav.psub === 'main' ? 'Back' : 'Back to my profile'} onClick={profileBack}><Icon name="back" size={24} /></button>}
        {tab === 'home' && <ChurchLogo brand={brand} />}
        <div className="appbar-title">
          {tab === 'home' ? (<><span className="appbar-sub">ChurchOS</span><strong>{m?.branch_name ?? 'Welcome'}</strong></>) : <strong>{tab === 'services' ? words.many : tab === 'profile' ? (unlinked && nav.psub === 'main' ? 'Church link status' : PROFILE_TITLES[nav.psub]) : TITLES[tab]}</strong>}
        </div>
        <button type="button" className="icon-btn bell" aria-label={unread > 0 ? `Messages, ${unread} unread` : 'Messages'} onClick={() => go('inbox')}>
          <Icon name="bell" size={24} />
          {unread > 0 && <span className="count" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
        </button>
        <ProfileMenu initials={initials(name)} name={name} church={m ? `${m.branch_name} · ${m.org_name}` : undefined} number={m?.member_number} linked={!unlinked} active={tab === 'profile'} onOpen={openProfile} onHelp={() => setHelpOpen(true)} signOut={signOut} />
      </header>

      <LinkCtx.Provider value={openLink}>
      <main className="app-main" ref={mainRef} id="main">
        <div className="page" key={tab}>
          {!online && <Note tone="warn">You are offline. Some things may not load until you are connected.</Note>}
          {me.loading && !me.data ? <Loading /> : me.error && !me.data ? <Failed error={me.error} retry={me.reload} /> : (
            <>
              {tab === 'home' && unlinked && <LinkHome user={user} first={String(user?.name ?? '').split(' ')[0]} onLinked={onLinked} />}
              {tab === 'home' && !unlinked && <Home onLinked={onLinked} me={me.data} user={user} families={fams.families} notif={notif} links={links} banner={<InstallBanner />} />}
              {tab === 'give' && <GiveTab me={me.data} user={user} online={online} nav={nav} go={go} unlinked={unlinked} />}
              {tab === 'services' && (unlinked ? <Locked onLink={() => go('home')} /> : <ServicesHub section={(section ?? 'services') as ServicesSection} esub={nav.esub} onSection={(s) => open({ tab: 'services', section: s, esub: nav.esub })} onEsub={(e) => open({ tab: 'services', section: 'events', esub: e })} hasMembership={!!me.data?.memberships?.length} user={user} shopIntent={shopIntent} shopK={shopK} />)}
              {tab === 'kids' && unlinked && <Locked onLink={() => go('home')} />}
              {tab === 'kids' && !unlinked && hasKids && <FamilyPage families={fams.families} reload={fams.reload} loading={fams.loading} />}
              {tab === 'kids' && !unlinked && !hasKids && <Card title="Children"><Empty>You have no children recorded at your church.</Empty></Card>}
              {tab === 'inbox' && <Inbox n={notif} online={online} />}
              {tab === 'community' && <CommunityHub section={(section ?? 'groups') as CommunitySection} onSection={(s) => open({ tab: 'community', section: s })} unlinked={unlinked} onLink={() => go('home')} />}
              {tab === 'profile' && <ProfileScreen psub={nav.psub} me={me.data} user={user} reload={() => { me.reload(); fams.reload(); notif.reload(); }} signOut={signOut} />}
            </>
          )}
        </div>
      </main>
      </LinkCtx.Provider>

      <HelpButton api={api} audience="member" screen={helpScreen} />
      <Sheet open={helpOpen} onClose={() => setHelpOpen(false)} title="Help">
        {helpOpen && <Help />}
      </Sheet>
      <nav className="tabbar" aria-label="Main">
        <div className="rail-brand">{brand?.hasLogo ? <ChurchLogo brand={brand} size={44} /> : <span className="rail-mark" aria-hidden="true">{'✚'}</span>}<span className="rail-name"><strong>ChurchOS</strong><span>{m?.branch_name ?? 'Welcome'}</span></span></div>
        {TABS.filter((t) => t.key !== 'kids' || (hasKids && !unlinked)).map((t) => (
          <button key={t.key} type="button" className={tab === t.key ? 'active' : ''} aria-current={tab === t.key ? 'page' : undefined} onClick={() => go(t.key)}>
            <span className="tab-ico"><Icon name={t.ico} filled={tab === t.key} />
              {t.key === 'inbox' && unread > 0 && <span className="tab-badge" aria-label={`${unread} unread`}>{unread > 9 ? '9+' : unread}</span>}
            </span>
            <span className="tab-label">{t.key === 'services' ? words.many : t.label}</span>
          </button>
        ))}
      </nav>
    </div></BrandCtx.Provider>
  );
}

// ---------------- Give ----------------

type Receipt = { status: string; church: string; purpose: string; amountPaid: number; receipt: string | null };

function GiveTab({ me, user, online, nav, go, unlinked }: { me: any; user: any; online: boolean; nav: Nav; go: Go; unlinked?: boolean }) {
  const m = me?.memberships?.[0];
  const code: string | undefined = m?.branch_code;
  const church = useAsync<any>(() => (code ? api.get(`/public/church/${encodeURIComponent(code)}`) : Promise.resolve(undefined)), [code]);
  const [sub, setSub] = useState<GiveSub>(nav.sub);
  useEffect(() => { setSub(nav.sub); }, [nav.k]); // eslint-disable-line
  const SUBS: { key: GiveSub; label: string }[] = [{ key: 'give', label: 'Give' }, { key: 'pledges', label: 'Pledges' }, { key: 'history', label: 'History' }, { key: 'regular', label: 'Regular' }];
  if (unlinked) return <VisitorGiveTab onLink={() => go('home')} renderGive={(vcode, vchurch, back) => <Give visitorCode={vcode} back={back} me={me} user={user} online={online} church={vchurch} nav={nav} go={go} />} />;
  return (
    <div className="stack">
      <div className="seg" role="tablist" aria-label="Giving">
        {SUBS.map((s) => <button key={s.key} type="button" role="tab" aria-selected={sub === s.key} className={sub === s.key ? 'on' : ''} onClick={() => setSub(s.key)}>{s.label}</button>)}
      </div>
      {sub === 'give' && <Give me={me} user={user} online={online} church={church} initPurpose={nav.purpose} nav={nav} go={go} />}
      {sub === 'pledges' && <Pledges me={me} church={church} />}
      {sub === 'history' && <History />}
      {sub === 'regular' && <RegularGiving me={me} user={user} online={online} />}
    </div>
  );
}

function Give({ me, user, online, church, initPurpose, nav, go, visitorCode, back }: { me: any; user: any; online: boolean; church: any; initPurpose?: string; nav: Nav; go: Go; visitorCode?: string; back?: () => void }) {
  const m = visitorCode ? undefined : me?.memberships?.[0];
  const code: string | undefined = visitorCode ?? m?.branch_code;
  const [purpose, setPurpose] = useState(initPurpose ?? 'TITHE');
  useEffect(() => { const ps: any[] = church.data?.purposes ?? []; if (visitorCode && ps.length && !ps.some((p) => p.key === purpose)) setPurpose(ps[0].key); }, [church.data]); // eslint-disable-line
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('mpesa');
  const [phone, setPhone] = useState(phonePretty(user?.phone));
  const [fee, setFee] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [intent, setIntent] = useState<{ id: string; message: string } | null>(null);
  const [result, setResult] = useState<Receipt | null>(null);
  const [slow, setSlow] = useState(false);
  const [anon, setAnon] = useState(false);
  const [doneAnon, setDoneAnon] = useState(false);

  const purposes: any[] = church.data?.purposes ?? [];
  useEffect(() => {
    if (initPurpose && purposes.some((p) => p.key === initPurpose)) setPurpose(initPurpose);
  }, [nav.k, purposes.length]); // eslint-disable-line

  const hint = phoneHint(method);
  const mismatch = networkMismatch(method, phone);
  const n = Number(amount);
  const valid = Number.isFinite(n) && n >= 10 && n <= 150000;
  const bearerMember = church.data?.feeBearer === 'member';

  useEffect(() => {
    setFee(0);
    if (!bearerMember || !valid || !code) return;
    let alive = true;
    api.get(`/public/fee?code=${encodeURIComponent(code)}&amount=${n}&method=${method}`).then((r) => alive && setFee(r.memberFee ?? 0)).catch(() => {});
    return () => { alive = false; };
  }, [bearerMember, valid, n, method, code]);

  // poll the gift until it settles; after 90s stop without claiming failure
  useEffect(() => {
    if (!intent) return;
    let alive = true;
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const r: Receipt = await api.get(`/public/give/${intent.id}`);
        if (!alive) return;
        if (r.status === 'completed' || r.status === 'failed') { clearInterval(timer); setResult(r); setIntent(null); if (r.status === 'completed') window.dispatchEvent(new Event('churchos:gift-done')); return; }
      } catch { /* keep trying until the time is up */ }
      if (alive && Date.now() - started > 90000) { clearInterval(timer); setSlow(true); setIntent(null); }
    }, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [intent]);

  const anonOk = !!user && !!m && String(m.category ?? '').toLowerCase() !== 'child';
  const anonPurposeOk = purpose === 'TITHE' || purpose === 'OFFERING' || purpose.startsWith('PROJ-');
  const anonNow = anon && anonOk && anonPurposeOk;
  const reset = () => { setAnon(false); setResult(null); setSlow(false); setAmount(''); setError(undefined); setIntent(null); };

  const give = async () => {
    setBusy(true); setError(undefined);
    try {
      const r = anonNow ? await api.post('/me/give', { code, phone, amount: n, method, purpose, anonymous: true }) : await api.post('/public/give', { code, phone, amount: n, method, purpose });
      setDoneAnon(anonNow);
      // A card is paid on the payment provider's own page, which sends the person back here with the receipt in Messages.
      if (r.checkoutUrl) { window.location.assign(`${r.checkoutUrl}&return=${encodeURIComponent(`${location.origin}/#inbox`)}`); return; }
      setIntent({ id: r.intentId, message: r.message });
    } catch (e) { setError(errText(e)); }
    setBusy(false);
  };

  if (!m && !visitorCode) return <Card title="Give"><Empty>You are not linked to a church yet, so we cannot show where to give. Open My profile from the avatar menu to request a move.</Empty></Card>;
  if (church.loading) return <Loading />;
  if (church.error || !church.data) return <Failed error={church.error ?? 'We could not load your church.'} retry={church.reload} />;

  if (result && result.status !== 'completed') {
    return (
      <Card className="receipt">
        <div className="big-amount">{kes(result.amountPaid)}</div>
        <Note tone="warn">The payment did not go through, so nothing was taken. You can try again when you are ready.</Note>
        <Button onClick={reset}>Try again</Button>
      </Card>
    );
  }
  if (slow) {
    return (
      <Card>
        <Note tone="info">We are still waiting for the confirmation from your phone company. If you entered your PIN, your gift will appear in History shortly. Please do not pay twice.</Note>
        <div style={{ height: 12 }} />
        <Button kind="ghost" onClick={reset}>Back</Button>
      </Card>
    );
  }
  if (intent) {
    return (
      <Card className="waiting">
        <div className="pulse" aria-hidden="true"><Icon name="give" size={32} /></div>
        <p style={{ textAlign: 'center', fontSize: 17 }}><strong>{intent.message}</strong></p>
        <p className="tiny" style={{ textAlign: 'center' }}>Waiting for confirmation…</p>
      </Card>
    );
  }

  return (
    <div className="stack">
      {!online && <Note tone="warn">You are offline. You can look around, but you need a connection to give.</Note>}
      <Card title={`Give to ${church.data.name}`} action={back ? <Button kind="ghost" small onClick={back}>Change church</Button> : undefined}>
        <div className="stack">
          <div>
            <div className="field-label" id="purpose-l">What is it for?</div>
            <div className="chips" role="group" aria-labelledby="purpose-l" style={{ marginTop: 8 }}>
              {church.data.purposes.map((p: any) => (
                <button key={p.key} type="button" className={`chip ${purpose === p.key ? 'on' : ''}`} aria-pressed={purpose === p.key} onClick={() => setPurpose(p.key)}>{p.label}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="field-label" id="amt-l">Amount (KES)</div>
            <div className="chips" role="group" aria-labelledby="amt-l" style={{ margin: '8px 0' }}>
              {QUICK.map((q) => (
                <button key={q} type="button" className={`chip ${n === q ? 'on' : ''}`} aria-pressed={n === q} onClick={() => setAmount(String(q))}>{q.toLocaleString('en-KE')}</button>
              ))}
            </div>
            <Field label="Other amount" hint="KES 10 to KES 150,000" error={amount && !valid ? 'Enter an amount between 10 and 150,000' : undefined}>
              <input className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="e.g. 750" />
            </Field>
          </div>
          <div>
            <div className="field-label" id="meth-l">Pay with</div>
            <div className="chips" role="group" aria-labelledby="meth-l" style={{ marginTop: 8 }}>
              {METHODS.map((x) => (
                <button key={x.key} type="button" className={`chip ${method === x.key ? 'on' : ''}`} aria-pressed={method === x.key} onClick={() => setMethod(x.key)}>{x.label}</button>
              ))}
            </div>
          </div>
          <Field label={hint.label} hint={hint.help} error={mismatch ?? undefined}><input type="tel" inputMode="tel" autoComplete="tel" placeholder={hint.placeholder} value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!!mismatch} /></Field>
          {anonOk && <AnonSwitch on={anon && anonPurposeOk} onChange={setAnon} disabled={!anonPurposeOk} note={anonPurposeOk ? undefined : 'Only tithe, offering and project gifts can be given anonymously.'} />}
          {bearerMember && valid && fee > 0 && <Note tone="info">A service fee of {kes(fee)} is added. You will pay {kes(Math.round(n * 100) + fee)} in total.</Note>}
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      </Card>
      {!visitorCode && <button type="button" className="rg-entry" onClick={() => go('give', { sub: 'regular' })}>
        <span className="rg-home-ico"><Icon name="refresh" size={22} /></span>
        <span className="rg-home-text"><strong>Give regularly</strong><span className="tiny">Set up a weekly or monthly tithe or offering</span></span>
        <Icon name="chev" size={20} />
      </button>}
      <div className="sticky-cta">
        <Button disabled={!online || busy || !valid || phone.trim().length < 9 || !!mismatch} onClick={give}>{busy ? (method === 'card' ? 'Opening card page…' : 'Sending…') : valid ? `${method === 'card' ? 'Pay by card' : anonNow ? 'Give anonymously' : 'Give'} ${kes(Math.round(n * 100))}` : 'Give'}</Button>
      </div>

      <GiftSuccess anonymous={doneAnon} r={result && result.status === 'completed' ? result : null} onClose={reset} onMessages={() => { reset(); go('inbox'); }} />
    </div>
  );
}

function GiftSuccess({ r, onClose, onMessages, anonymous }: { anonymous?: boolean; r: Receipt | null; onClose: () => void; onMessages: () => void }) {
  return (
    <Sheet open={!!r} onClose={onClose} full title="Thank you" label="Thank you, your gift was received">
      {r && (
        <div className="thanks">
          <svg className="bigcheck" viewBox="0 0 80 80" width="112" height="112" aria-hidden="true">
            <circle className="bc-ring" cx="40" cy="40" r="36" fill="none" strokeWidth="5" />
            <path className="bc-tick" d="M24 41.5 35 52.5 57 29" fill="none" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="thanks-amt">{kes(r.amountPaid)}</div>
          <p className="muted">Your gift to {r.church} was received.</p>
          <dl className="thanks-meta">
            <div><dt>Church</dt><dd>{r.church}</dd></div>
            <div><dt>Purpose</dt><dd>{purposeLabel(r.purpose)}</dd></div>
            {r.receipt && <div><dt>Receipt</dt><dd>{r.receipt}</dd></div>}
          </dl>
          {anonymous && <p className="tiny"><strong>Given anonymously.</strong> Your receipt is for you only. Your church cannot see who gave.</p>}
          <p className="tiny">We also sent a confirmation to your Messages.</p>
          <div className="thanks-actions">
            <Button onClick={onClose}>Done</Button>
            <Button kind="ghost" onClick={onMessages}>View my Messages</Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function Pledges({ me, church }: { me: any; church: any }) {
  const pledges = useAsync<any[]>(() => api.get('/me/pledges'));
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const projects: any[] = church.data?.projects ?? [];
  return (
    <div className="stack">
      <Card title="My pledges">
        {pledges.loading ? <Skeleton lines={3} /> : pledges.error ? <Failed error={pledges.error} retry={pledges.reload} /> : !pledges.data?.length ? (
          <Empty>No pledges yet. You can pledge to a church project below.</Empty>
        ) : (
          <ul className="list">
            {pledges.data.map((p) => {
              const pct = p.amount > 0 ? Math.min(100, Math.round((p.paid / p.amount) * 100)) : 0;
              return (
                <li key={p.id}>
                  <div className="row"><strong>{p.project}</strong><span className="tiny">{pct}%</span></div>
                  <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${p.project} pledge progress`}><i style={{ width: `${pct}%` }} /></div>
                  <div className="tiny">{kes(p.paid)} given of {kes(p.amount)} pledged</div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card title="Make a pledge">
        {!me?.memberships?.length ? <Empty>You are not linked to a church yet.</Empty> : church.loading ? <Skeleton lines={2} /> : !projects.length ? <Empty>There are no open projects to pledge to right now.</Empty> : (
          <div className="stack">
            <p className="muted" style={{ margin: 0 }}>Promise a gift to a church project and track your progress here.</p>
            <Button kind="ghost" onClick={() => setOpen(true)}>Pledge to a project</Button>
          </div>
        )}
      </Card>
      <Sheet open={open} onClose={() => setOpen(false)} title="Make a pledge">
        {open && church.data && projects.length > 0 && <PledgeForm church={church.data} projects={projects} onDone={() => { setOpen(false); pledges.reload(); toast.show('Pledge saved. Thank you.'); }} />}
      </Sheet>
      {toast.node}
    </div>
  );
}

// ---------------- History ----------------

function purposeLabel(p: string | null) {
  if (!p) return 'Gift';
  if (p.startsWith('PROJ-')) return `Project ${p.slice(5)}`;
  return p.charAt(0) + p.slice(1).toLowerCase();
}

function History() {
  const g = useAsync<any>(() => api.get('/me/giving'));
  const [statement, setStatement] = useState(false);
  const [record, setRecord] = useState(false);
  if (record) return <GivingRecord onBack={() => setRecord(false)} />;
  if (g.loading) return <Loading />;
  if (g.error) return <Failed error={g.error} retry={g.reload} />;
  const rows: any[] = g.data?.rows ?? [];

  if (statement) {
    return (
      <div className="stack">
        <div className="row no-print">
          <Button kind="ghost" small onClick={() => setStatement(false)}>Back</Button>
          <Button small onClick={() => window.print()}>Print</Button>
        </div>
        <h1>Giving statement</h1>
        <p className="muted">Prepared {dateOnly(new Date().toISOString())}</p>
        <Table head={['Date', 'Church', 'Purpose', 'Amount', 'Receipt']}>
          {rows.map((r) => (
            <tr key={r.id}><td>{dateOnly(r.date)}</td><td>{r.church}</td><td>{purposeLabel(r.purpose)}</td><td>{kes(r.amount)}</td><td>{r.receipt}</td></tr>
          ))}
        </Table>
        <p><strong>Total: {kes(g.data?.total ?? 0)}</strong></p>
        <p className="tiny">Refunded gifts are not counted in the total.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="hero-total">
        <span>Total given</span>
        <strong>{kes(g.data?.total ?? 0)}</strong>
        <small>{rows.length ? `${rows.length} gift${rows.length === 1 ? '' : 's'}` : 'Your first gift will show here'}</small>
      </div>
      <button type="button" className="rg-entry" onClick={() => setRecord(true)}>
        <span className="rg-home-ico"><Icon name="receipt" size={22} /></span>
        <span className="rg-home-text"><strong>My giving record</strong><span className="tiny">Your totals, and who has looked at your record</span></span>
        <Icon name="chev" size={20} />
      </button>
      <Button kind="ghost" onClick={() => setStatement(true)} disabled={!rows.length}>Giving statement</Button>
      <Card title="My giving">
        {!rows.length ? <Empty>No gifts yet. When you give, your receipts will appear here.</Empty> : (
          <ul className="list">
            {rows.map((r) => (
              <li key={r.id}>
                <div className="row"><strong>{purposeLabel(r.purpose)}</strong><span className="amt">{kes(r.amount)}</span></div>
                <div className="row"><span className="tiny">{shortDate(r.date)} · {r.church ?? 'Church'}</span><span className="gr-chips">{r.anonymous && <Badge tone="info">Anonymous</Badge>}{friendlyStatus(r.status)}</span></div>
                {r.anonymous && <div className="tiny">Given anonymously</div>}
                {r.receipt && <div className="tiny">Receipt {r.receipt}</div>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------- Profile (opened from the avatar menu) ----------------

const REL: Record<string, string> = { Adult: 'Adult', Child: 'Child' };

/** The three profile screens: #profile (membership, household, records, message choices, moving church), #profile/data and #profile/security. */
function ProfileScreen({ psub, me, user, reload, signOut }: { psub: ProfileTarget; me: any; user: any; reload: () => void; signOut: () => void }) {
  if (psub === 'data') return <div className="stack profile-narrow"><MyData signOut={signOut} /></div>;
  if (psub === 'security') return <div className="profile-narrow"><SecurityScreen /></div>;
  return <ProfileMain me={me} user={user} reload={reload} />;
}

function ProfileMain({ me, user, reload }: { me: any; user: any; reload: () => void }) {
  const ms: any[] = me?.memberships ?? [];
  const m = ms[0];
  const household: any[] = me?.household ?? [];
  const transfers: any[] = me?.transfers ?? [];
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [moveOpen, setMoveOpen] = useState(false);
  const toast = useToast();
  const name = String(m?.full_name ?? user?.name ?? '');
  const linked = ms.length > 0;

  const request = async () => {
    setBusy(true); setError(undefined);
    try {
      const r = await api.post('/me/transfer-request', { toChurchCode: code });
      toast.show(`Request sent to ${r.to}`);
      setCode('');
      setMoveOpen(false);
      reload();
    } catch (e) { setError(errText(e)); }
    setBusy(false);
  };

  return (
    <div className="stack profile-page">
      <div className="profile">
        <span className="avatar big" aria-hidden="true">{initials(name)}</span>
        <div className="profile-text">
          <strong>{name || 'Member'}</strong>
          <span>{phonePretty(user?.phone)}</span>
          {m && <span>{m.branch_name} · {m.member_number}</span>}
        </div>
      </div>

      {!linked && <Card title="My church"><Locked onLink={() => { window.location.hash = '#home'; }}>Your membership, records and certificates show here once your church has approved you.</Locked></Card>}
      <LinkOffers onLinked={reload} />
      {linked && <Card title="My membership">
        {!ms.length ? <Empty>You are not linked to a church yet.</Empty> : (
          <ul className="list">
            {ms.map((x) => (
              <li key={x.id}>
                <div className="row"><strong>{x.branch_name}</strong><Badge tone="good">Active</Badge></div>
                <div className="tiny">{x.org_name} · Member no. {x.member_number}{x.joined_at ? ` · Joined ${dateOnly(x.joined_at)}` : ''}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>}

      {linked && <MyRecords />}

      {linked && <MessageChoices />}

      {linked && <Card title="My household">
        {!household.length ? <Empty>No household recorded yet.</Empty> : (
          <ul className="list">
            {household.map((h) => (
              <li key={h.id}>
                <div className="row"><strong>{h.full_name}</strong><span className="tiny">{h.member_number}</span></div>
                <div className="tiny">{REL[h.relationship] ?? h.relationship ?? 'Member'}{h.is_primary_contact ? ' · primary contact' : ''}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>}

      {linked && transfers.length > 0 && (
        <Card title="My requests">
          <ul className="list">
            {transfers.map((t) => (
              <li key={t.id}>
                <div className="row"><strong>{t.from_name} to {t.to_name}</strong><StatusBadge status={t.status} /></div>
                <div className="tiny">{dateOnly(t.created_at)}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {linked && <div className="menu">
        <button type="button" onClick={() => setMoveOpen(true)}><Icon name="swap" /><span>Moving to a new church?</span><Icon name="chev" size={18} /></button>
      </div>}

      <Sheet open={moveOpen} onClose={() => setMoveOpen(false)} title="Moving to a new church?">
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>
            The new church must approve your request. You keep your own record: in the same church you keep your member number, in a different church you get a new one, and your old church keeps its own history.
          </p>
          <Field label="New church code" hint="For example GRC002 or HPC001">
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="GRC002" autoCapitalize="characters" />
          </Field>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button disabled={busy || code.trim().length < 3} onClick={request}>{busy ? 'Sending…' : 'Request to move'}</Button>
        </div>
      </Sheet>
      {toast.node}
    </div>
  );
}

const INSTALL_DISMISS_KEY = 'churchos:member-install-dismissed';
const INSTALL_SNOOZE_MS = 7 * 86_400_000;

/**
 * A visible "Install the app" card at the top of Home, for phones where the app is not installed yet. It can be put off for a week; the
 * Install app item in the profile menu stays for anyone who wants it later. Where the browser cannot install (iPhone) it shows the two taps instead.
 */
function InstallBanner() {
  const [gone, setGone] = useState(() => { try { return Date.now() - Number(localStorage.getItem(INSTALL_DISMISS_KEY) ?? 0) < INSTALL_SNOOZE_MS; } catch { return false; } });
  const brand = useContext(BrandCtx);
  const inst = useInstall();
  const phone = window.matchMedia?.('(max-width: 760px)').matches ?? true;
  if (inst.hidden || gone || !phone || (!inst.evt && !inst.ios)) return null;
  const later = () => { try { localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now())); } catch { /* ignore */ } setGone(true); };
  const name = brand?.hasLogo && brand.name ? brand.name : 'ChurchOS';
  return (
    <section className="install-banner" aria-label="Install the app">
      <span className="install-ico" aria-hidden="true"><Icon name="install" size={26} /></span>
      <div className="install-text">
        <strong>Install the {name} app</strong>
        <span>{inst.evt ? 'Open it from your home screen like any other app: faster, and full screen.' : 'Tap the Share button, then "Add to Home Screen".'}</span>
      </div>
      <div className="install-actions">
        {inst.evt && <button type="button" className="install-go" onClick={inst.install}>Install</button>}
        <button type="button" className="install-later" onClick={later}>Not now</button>
      </div>
    </section>
  );
}

function PledgeForm({ church, projects, onDone }: { church: any; projects: any[]; onDone: () => void }) {
  const [proj, setProj] = useState(projects[0].code);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const n = Number(amount);
  const submit = async () => {
    setBusy(true); setError(undefined);
    try { await api.post('/me/pledges', { churchCode: church.code, projectCode: proj, amount: n }); onDone(); }
    catch (e) { setError(errText(e)); }
    setBusy(false);
  };
  return (
    <div className="stack">
      <div className="chips" role="group" aria-label="Project">
        {projects.map((p) => <button key={p.code} type="button" className={`chip ${proj === p.code ? 'on' : ''}`} aria-pressed={proj === p.code} onClick={() => setProj(p.code)}>{p.name}</button>)}
      </div>
      <Field label="Pledge amount (KES)"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="e.g. 20000" /></Field>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button disabled={busy || !(n > 0)} onClick={submit}>{busy ? 'Saving…' : 'Save pledge'}</Button>
    </div>
  );
}
// ---------------- Records ----------------

const CARD_WIDTH = 1040;

/** Draws the certificate card at its fixed width, scaled down to fit the screen. */
function ScaledCard({ c }: { c: CertificatePayload }) {
  const ref = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(() => Math.min(1, (Math.min(window.innerWidth, 480) - 32) / CARD_WIDTH));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => { const w = el.clientWidth; if (w > 0) setZoom(Math.min(1, w / CARD_WIDTH)); };
    measure();
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ width: '100%', overflow: 'hidden' }}>
      <div style={{ zoom } as any}><CertificateCard c={c} /></div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { baptism: 'Baptism', marriage: 'Marriage' };
type CopyResult = { status: string; fee: number; purpose?: string; churchCode: string; render: CertificatePayload | null };

function MyRecords() {
  const recs = useAsync<any[]>(() => api.get('/me/records'));
  const [open, setOpen] = useState<any | null>(null);

  if (open) return <RecordView rec={open} onBack={() => setOpen(null)} />;
  const rows = recs.data ?? [];
  return (
    <Card title="My records">
      {recs.loading && !recs.data ? <Loading /> : recs.error && !recs.data ? <Failed error={recs.error} retry={recs.reload} /> : !rows.length ? (
        <Empty>Baptism and marriage records appear here once your church has approved them.</Empty>
      ) : (
        <ul className="list">
          {rows.map((r) => (
            <li key={r.id}>
              <div className="row"><strong>{KIND_LABEL[r.kind] ?? r.kind}</strong><span className="tiny">{dateOnly(r.event_date)}</span></div>
              <div>{r.subject_name}</div>
              <div className="tiny">{r.place}</div>
              <div className="tiny">Held by {r.church}</div>
              {r.held_elsewhere && <div className="tiny">This record stays with the church that holds it</div>}
              <div style={{ marginTop: 8 }}>
                <Button kind="ghost" small onClick={() => setOpen(r)}>{r.can_print ? 'View card' : 'View details'}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecordView({ rec, onBack }: { rec: any; onBack: () => void }) {
  const preview = useAsync<CertificatePayload | undefined>(() => (rec.can_print ? api.get(`/me/records/${encodeURIComponent(rec.id)}/render`) : Promise.resolve(undefined)), [rec.id]);
  const [copy, setCopy] = useState<CopyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [checked, setChecked] = useState(false);

  const ask = async () => {
    setBusy(true); setError(undefined);
    try { setCopy(await api.post(`/me/records/${encodeURIComponent(rec.id)}/copy`, {})); setChecked(true); }
    catch (e) { setError(errText(e)); }
    setBusy(false);
  };

  const issued = copy?.status === 'issued' && copy.render;
  const waiting = copy?.status === 'awaiting_payment';
  const serial = copy?.purpose ? copy.purpose.replace(/^CERT-/, '') : '';
  const payUrl = waiting && copy ? `${location.protocol}//${location.hostname}:3001/${encodeURIComponent(copy.churchCode)}?cert=${encodeURIComponent(serial)}` : '';

  return (
    <div className="stack">
      <div className="row no-print"><Button kind="ghost" small onClick={onBack}>Back</Button></div>
      <Card title={`${KIND_LABEL[rec.kind] ?? rec.kind} record`} className="no-print">
        <div className="stack">
          <div><strong>{rec.subject_name}</strong></div>
          <div className="tiny">{dateOnly(rec.event_date)} · {rec.place}</div>
          <div className="tiny">Held by {rec.church}</div>
          {rec.held_elsewhere && <div className="tiny">This record stays with the church that holds it</div>}
          {!rec.can_print && <Note tone="info">A marriage certificate is a legal document. Ask your church office or the registry for a copy.</Note>}
        </div>
      </Card>

      {rec.can_print && (
        <>
          {issued ? (
            <>
              <ScaledCard c={copy!.render!} />
              <div className="no-print"><Button onClick={() => printCertificate()}>Print / Save as PDF</Button></div>
            </>
          ) : preview.loading ? <Loading /> : preview.error ? <Failed error={preview.error} retry={preview.reload} /> : preview.data ? (
            <ScaledCard c={preview.data} />
          ) : null}

          {!issued && (
            <div className="stack no-print">
              {waiting && copy && (
                <Note tone="info">
                  A copy of this certificate costs {kes(copy.fee)}. Pay through your church's giving page and it will appear here.
                </Note>
              )}
              {checked && waiting && <p className="tiny" style={{ margin: 0 }}>We have not seen the payment yet. It can take a minute to arrive.</p>}
              {error && <ErrorNote>{error}</ErrorNote>}
              {waiting && copy ? (
                <>
                  <a className="btn" href={payUrl} target="_blank" rel="noopener noreferrer" style={{ textAlign: 'center', textDecoration: 'none' }}>Pay for my copy</a>
                  <Button kind="ghost" disabled={busy} onClick={ask}>{busy ? 'Checking…' : 'I have paid, check again'}</Button>
                </>
              ) : (
                <>
                  <Button disabled={busy} onClick={ask}>{busy ? 'One moment…' : 'Get my card'}</Button>
                  <p className="tiny" style={{ margin: 0 }}>Your first card is free. Later copies follow your church's price.</p>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
// ---------------- Help ----------------

function Help() {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [found, setFound] = useState<any>(null);

  const send = async () => {
    setBusy(true); setError(undefined);
    try { setFound(await api.post('/me/reversal-request', { message })); setMessage(''); }
    catch (e) { setError(errText(e)); }
    setBusy(false);
  };

  return (
    <div className="stack">
      <Card title="Help articles">
        <p className="muted" style={{ margin: 0 }}>Browse help articles: tap the Help button at the bottom right of any screen.</p>
      </Card>
      <Card title="Payment help">
        <div className="stack">
          <h3 style={{ fontSize: '1.05rem' }}>I paid the wrong church or the wrong amount</h3>
          {found ? (
            <>
              <Note tone="good">
                We found your payment <strong>{found.found?.transactionCode}</strong> of {kes(found.found?.amount)}. It is {found.found?.where}.
              </Note>
              <p className="muted" style={{ margin: 0 }}>A ChurchOS agent will review your request. A refund returns the church fee, but charges made by the mobile money company are not refunded.</p>
              <Button kind="ghost" onClick={() => setFound(null)}>Report another payment</Button>
            </>
          ) : (
            <>
              <p className="muted" style={{ margin: 0 }}>Paste the whole M-Pesa or Airtel confirmation message you received, including the transaction code.</p>
              <Field label="Confirmation message">
                <textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="QK12ABC34D Confirmed. Ksh500.00 sent to ..." />
              </Field>
              {error && <ErrorNote>{error}</ErrorNote>}
              <Button disabled={busy || message.trim().length < 10} onClick={send}>{busy ? 'Sending…' : 'Send'}</Button>
              <p className="tiny" style={{ margin: 0 }}>This is a rule-based helper, not a person. A real agent reviews every request.</p>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

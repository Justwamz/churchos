import { useEffect, useMemo, useState } from 'react';
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
import { Settlements } from './Settlements';
import { Cash } from './Cash';
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

const HELP_SCREEN: Record<string, string> = {
  dashboard: 'staff.dashboard', collections: 'staff.collections', settlements: 'staff.settlements', cash: 'staff.cash',
  members: 'staff.members', transfers: 'staff.transfers', projects: 'staff.projects', help: 'staff.help',
  verification: 'staff.verification', payout: 'staff.payout', messages: 'staff.messages', wallets: 'staff.wallets', integrations: 'staff.integrations', adverts: 'staff.adverts', notices: 'staff.notices', events: 'staff.events', resources: 'staff.resources', bookings: 'staff.bookings', calendar: 'staff.calendar', groups: 'staff.groups', profile: 'staff.profile', records: 'staff.records', template: 'staff.template', audit: 'staff.audit', team: 'staff.team', shop: 'staff.shop',
};

const PAGES: { id: string; label: string; any: string[]; el: () => JSX.Element }[] = [
  { id: 'dashboard', label: 'Dashboard', any: ['collections.view'], el: Dashboard },
  { id: 'collections', label: 'Collections', any: ['collections.view'], el: Collections },
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

function Shell({ signOut }: { signOut: () => void }) {
  const [me, setMe] = useState<any>();
  const [error, setError] = useState<string>();
  const [orgIdx, setOrgIdx] = useState(0);
  const [scope, setScope] = useState('all');
  const [page, setPage] = useState('');

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
  const current = visible.find((p) => p.id === page) ?? visible[0];
  const Page = current?.el;

  return (
    <SessionCtx.Provider value={session}>
      <div className="shell">
        {((me.emailRequired && !me.emailVerified) || gate) && <EmailGate initialEmail={me.user.email} onVerified={reloadMe} />}
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
        <main className="content">
          <div className="row" style={{ marginBottom: 16 }}>
            {me.orgs.length > 1 && (
              <select aria-label="Church" value={orgIdx} onChange={(e) => { setOrgIdx(Number(e.target.value)); setScope('all'); }}>
                {me.orgs.map((o: any, i: number) => <option key={o.org.id} value={i}>{o.org.name}</option>)}
              </select>
            )}
            <select aria-label="Branch scope" value={scope} onChange={(e) => setScope(e.target.value)}>
              {grant.branches.length > 1 && <option value="all">All branches</option>}
              {grant.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <span className="tiny">{grant.org.name}</span>
            {unverified && <Badge tone="warn">Not verified</Badge>}
            <span style={{ marginLeft: 'auto' }}><Notifications /></span>
          </div>
          {kyc && kyc.tone !== 'done' && current?.id !== 'verification' && <VerificationBanner s={kyc} onGo={() => setPage('verification')} />}
          <WalletBanner page={current?.id ?? ''} />
          {kyc && <VerificationDialog s={kyc} userKey={me.user.id} onGo={() => setPage('verification')} />}
          {Page ? <Page key={`${current.id}:${grant.org.id}:${scope}:${tick}`} /> : <ErrorNote>You do not have access to any pages yet.</ErrorNote>}
          <div style={{ height: 80 }} aria-hidden="true" />
        </main>
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

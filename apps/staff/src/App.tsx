import { useEffect, useMemo, useState } from 'react';
import { summarize, VerificationBanner, VerificationDialog, type KycSummary } from './VerificationBanner';
import { Badge, Button, ErrorNote, HelpButton, LoginGate, Spinner } from '@churchos/ui';
import { api, SessionCtx, friendly, type Session } from './session';
import { Dashboard } from './Dashboard';
import { Collections } from './Collections';
import { Settlements } from './Settlements';
import { Cash } from './Cash';
import { Members, Transfers } from './Members';
import { Projects } from './Projects';
import { Help } from './Help';
import { Verification } from './Verification';
import { Sms } from './Sms';
import { Payout } from './Payout';

const HELP_SCREEN: Record<string, string> = {
  dashboard: 'staff.dashboard', collections: 'staff.collections', settlements: 'staff.settlements', cash: 'staff.cash',
  members: 'staff.members', transfers: 'staff.transfers', projects: 'staff.projects', help: 'staff.help',
  verification: 'staff.verification', sms: 'staff.sms', payout: 'staff.payout',
};

const PAGES: { id: string; label: string; any: string[]; el: () => JSX.Element }[] = [
  { id: 'dashboard', label: 'Dashboard', any: ['collections.view'], el: Dashboard },
  { id: 'collections', label: 'Collections', any: ['collections.view'], el: Collections },
  { id: 'settlements', label: 'Settlements', any: ['settlements.view'], el: Settlements },
  { id: 'cash', label: 'Cash', any: ['cash.count', 'cash.approve'], el: Cash },
  { id: 'members', label: 'Members', any: ['members.view', 'members.edit'], el: Members },
  { id: 'transfers', label: 'Transfers', any: ['transfers.approve'], el: Transfers },
  { id: 'projects', label: 'Projects', any: ['collections.view', 'projects.manage'], el: Projects },
  { id: 'help', label: 'Payment help', any: ['reversals.request'], el: Help },
  { id: 'verification', label: 'Verification', any: ['kyc.manage'], el: Verification },
  { id: 'sms', label: 'SMS wallet', any: ['sms.manage'], el: Sms },
  { id: 'payout', label: 'Payout account', any: ['payouts.manage'], el: Payout },
];

function Shell({ signOut }: { signOut: () => void }) {
  const [me, setMe] = useState<any>();
  const [error, setError] = useState<string>();
  const [orgIdx, setOrgIdx] = useState(0);
  const [scope, setScope] = useState('all');
  const [page, setPage] = useState('');

  const [kyc, setKyc] = useState<KycSummary | null>(null);
  const unverified = !!kyc && kyc.tone !== 'done';

  useEffect(() => {
    api.get('/staff/me').then(setMe).catch((e) => setError(friendly(e.message)));
  }, []);

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

  const visible = PAGES.filter((p) => p.any.some((a) => session.can(a)));
  const current = visible.find((p) => p.id === page) ?? visible[0];
  const Page = current?.el;

  return (
    <SessionCtx.Provider value={session}>
      <div className="shell">
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
          </div>
          {kyc && kyc.tone !== 'done' && current?.id !== 'verification' && <VerificationBanner s={kyc} onGo={() => setPage('verification')} />}
          {kyc && <VerificationDialog s={kyc} userKey={me.user.id} onGo={() => setPage('verification')} />}
          {Page ? <Page key={`${current.id}:${grant.org.id}:${scope}`} /> : <ErrorNote>You do not have access to any pages yet.</ErrorNote>}
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

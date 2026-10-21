// AUTHZ MATRIX: signs in as every demo persona and hits every non-public route (taken from apps/api/src/routes at run time).
//   node docs/security/probes/authz-matrix.mjs            (API must be running on http://localhost:4000, fresh demo data)
// Expectation per request:
//   anonymous                                  -> 401 on every non-public route
//   persona vs an object of ANOTHER tenant     -> never 2xx (other church: org; other branch for a branch-scoped person)
//   person with no staff role on a staff route -> never 2xx
//   person on /me/* with another person's id   -> never 2xx
// A 400/409/422 on a mutation sent with an empty body is INCONCLUSIVE (the handler may validate before it checks access).
// Mutations are only sent by attackers against objects they must not reach, so a 2xx here IS the bug (and changes demo data).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginAll, req, BASE } from './_lib.mjs';
import { buildFixtures } from './_fixtures.mjs';
import { extract } from './_extract-routes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const G = 'org_grace', H = 'org_hope', NH = 'org_newhope', NBO = 'br_grc001', MBA = 'br_grc002';

// persona -> what they hold. staff: has at least one role. orgs/branches: where. 'all' = every branch of the org.
const P = {
  anon: { staff: false, orgs: [], branches: [] },
  pa1: { staff: false, admin: true, orgs: [], branches: [] },
  pa2: { staff: false, admin: true, orgs: [], branches: [] },
  owner: { staff: true, orgs: [G], branches: [NBO, MBA] },
  treas: { staff: true, orgs: [G], branches: [NBO] },
  admin: { staff: true, orgs: [G], branches: [NBO] },
  pastor: { staff: true, orgs: [G], branches: [NBO] },
  auditor: { staff: true, lowpriv: true, orgs: [G], branches: [NBO, MBA] },
  vera: { staff: true, lowpriv: true, orgs: [G], branches: [NBO] },
  lucy: { staff: true, lowpriv: true, orgs: [G], branches: [NBO] },
  fatuma: { staff: true, orgs: [G], branches: [MBA] },
  hope: { staff: true, orgs: [H], branches: ['br_hpc001'] },
  newhope: { staff: true, orgs: [NH], branches: ['br_nhf001'] },
  // Jane also belongs to Hope Chapel if authz-targeted.mjs (I01) has been run before: Hope staff can attach her by phone number (finding AZ-18).
  jane: { staff: false, member: true, orgs: [G, H], branches: [NBO] },
  peter: { staff: false, member: true, orgs: [G], branches: [NBO] },
  david: { staff: false, member: true, orgs: [G], branches: [NBO] },
  amina: { staff: false, member: true, orgs: [G], branches: [MBA] },
  newcomer: { staff: false, orgs: [], branches: [] },
};
const PERSONAS = Object.keys(P).filter((p) => p !== 'anon');

// ---- which kind of object a path parameter is ----
function kindOf(route, name, idx, segs) {
  const prev = segs[idx - 1] ?? '';
  const direct = { orderId: 'tkorder', bid: 'block', rid: 'resource', fid: 'expfile', pid: 'post', cid: 'comment', uid: 'user', mid: 'member', userId: 'user', orgId: 'org', branchId: 'branch', membershipId: 'member', date: 'date', version: 'version', entity: 'entity' };
  if (direct[name]) return direct[name];
  const p = route.path;
  const map = [
    [/^\/(admin\/)?adverts\//, 'advert'], [/^\/me\/adverts\//, 'advert'], [/\/schedules\//, 'schedule'], [/\/visitors\//, 'visitor'], [/\/services\//, 'service'],
    [/^\/(me\/)?resources\//, 'resource'], [/bookings\/|\/diary\//, 'booking'], [/^\/notices\//, 'notice'], [/^\/(me\/)?events\//, 'event'], [/\/credit\/refund-request\//, 'crefund'], [/^\/credit\/refunds\//, 'crefund'],
    [/\/tickets\/orders\//, 'tkorder'], [/^\/tickets\//, 'ticket'], [/^\/expenses\/categories/, 'expcat'], [/^\/expenses\//, 'expense'], [/^\/members\/join-requests/, 'joinreq'], [/^\/members\//, 'member'], [/^\/households\//, 'household'],
    [/^\/kids\/classes/, 'kclass'], [/^\/kids\/sessions/, 'ksession'], [/^\/kids\/checkins/, 'kcheckin'], [/^\/kids\/guardians/, 'guardian'], [/^\/kids\/branches/, 'branch'], [/pickup-people/, 'pickup'],
    [/^\/(me\/)?records\//, 'record'], [/^\/messages\//, 'message'], [/^\/(me\/)?groups\//, 'group'], [/^\/groups\//, 'group'], [/prayer\//, 'prayer'],
    [/^\/(me\/)?shop\/items/, 'item'], [/^\/shop\/sales/, 'sale'], [/\/shop\/orders/, 'sorder'], [/^\/projects\//, 'project'], [/^\/settlements\//, 'branch'], [/^\/cash\//, 'cash'], [/^\/transfers\//, 'transfer'],
    [/statements\//, 'statement'], [/^\/suggestions\//, 'suggestion'], [/^\/refund-requests\//, 'trefund'], [/^\/team\/assignments/, 'assignment'], [/^\/team\/roles/, 'role'], [/^\/me\/giving-plans/, 'plan'],
    [/^\/me\/link\/request/, 'joinreq'], [/^\/wallets\/topups/, 'topup'], [/^\/wallets\//, 'wallet'], [/^\/audit\/events/, 'auditevent'], [/^\/attendance\/branches/, 'branch'], [/^\/certificates\/branch-profile/, 'branch'],
    [/^\/admin\/payments/, 'payment'], [/^\/admin\/tariffs/, 'tariff'], [/^\/admin\/tenants/, 'org'], [/^\/admin\/branches/, 'branch'], [/^\/admin\//, 'adminobj'],
  ];
  for (const [re, k] of map) if (re.test(p)) return k;
  return prev || 'unknown';
}

const fixedValues = { date: '2026-10-25', version: '1', entity: 'record' };
// members use the church-wide member app (groups, services, adverts and the shop span branches), so for them only the church matters
const inScope = (persona, obj) => P[persona].orgs.includes(obj.org) && (P[persona].member || !obj.branch || P[persona].branches.includes(obj.branch) || obj.branch === obj.org);
const NEUTRAL = new Set(['/staff/me', '/staff/today', '/team/permissions', '/permissions']); // answer with the caller's own (possibly empty) data
const hasData = (j) => (Array.isArray(j) ? j.length > 0 : j && typeof j === 'object' ? Object.values(j).some((v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : v !== null && v !== false && v !== 0 && v !== '' && v !== true)) : !!j);
const crossTenant = (persona, obj) => !inScope(persona, obj);

// ---- concurrency helper ----
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// A superset body: passes the usual field validation so that the access check (not a 400) decides the answer.
const BODY = { reason: 'authz probe reason', note: 'authz probe note', message: 'authz probe message', approve: false, decision: 'reject', amount: 100, title: 'authz probe', body: 'authz probe body text', name: 'Authz Probe', reference: 'AUTHZPRB1', code: 'AUTHZPRB', status: 'approved', branchId: 'br_grc001', startsAt: new Date(Date.now() + 5 * 86400000).toISOString(), endsAt: new Date(Date.now() + 5 * 86400000 + 3600000).toISOString(), consent: true, role: 'admin', is_platform_admin: true, isAdmin: true, org_id: 'org_grace', orgId: 'org_grace', user_id: 'u_owner' };
async function callOnce(token, method, p, body) {
  if (p.startsWith('/stream/')) {
    const ac = new AbortController();
    try {
      const r = await fetch(BASE + p, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, signal: ac.signal });
      const s = r.status; ac.abort(); return { s, j: null, text: '' };
    } catch { return { s: 0, j: null, text: '' }; }
  }
  return req(token, method, p, method === 'GET' ? undefined : BODY);
}

const T = await loginAll();
for (const k of Object.keys(T)) if (!T[k]) { console.error('login failed for', k); process.exit(2); }
console.log('Building fixtures...');
const { bag, log } = await buildFixtures(T);
console.log(log.filter((l) => /FAILED/.test(l)).join('\n') || 'fixtures ok');

const routes = extract();
const publicRoutes = routes.filter((r) => r.auth === 'public' || r.auth.startsWith('config'));
const guarded = routes.filter((r) => r.auth === 'session' || r.auth === 'admin');

function expand(route) {
  const segs = route.path.split('/');
  const params = segs.map((s, i) => (s.startsWith(':') ? { name: s.slice(1), idx: i } : null)).filter(Boolean);
  return { params, segs };
}

// build the attack list
const jobs = [];
for (const r of guarded) {
  const { params, segs } = expand(r);
  const kinds = params.map((p) => ({ ...p, kind: kindOf(r, p.name, p.idx, segs) }));
  // anonymous, every route
  jobs.push({ r, persona: 'anon', kinds, mode: 'anon' });
  for (const persona of PERMISSIONS_FOR(r)) jobs.push({ r, persona, kinds, mode: 'victim' });
}
function PERMISSIONS_FOR(r) { return r.auth === 'admin' ? PERSONAS.filter((p) => !P[p].admin) : PERSONAS; }

// Foreign-identifier scan: any 2xx body that mentions another tenant's ids, codes or names is a leak candidate.
const TOKENS = {
  grace: ['org_grace', 'Grace Community Church', 'br_grc001', 'br_grc002', 'GRC001', 'GRC002', 'Grace Nairobi', 'Grace Mombasa'],
  hope: ['org_hope', 'br_hpc001', 'HPC001', 'Hope Chapel'],
  newhope: ['org_newhope', 'br_nhf001', 'NHF001', 'New Hope Fellowship', 'New Hope Nakuru'],
  nbo: ['br_grc001', 'GRC001', 'Grace Nairobi'], mba: ['br_grc002', 'GRC002', 'Grace Mombasa'],
};
const HOME = { owner: 'grace', treas: 'grace', admin: 'grace', pastor: 'grace', auditor: 'grace', vera: 'grace', lucy: 'grace', fatuma: 'grace', peter: 'grace', david: 'grace', amina: 'grace', hope: 'hope', newhope: 'newhope' };
const BRANCH_HOME = { treas: 'nbo', admin: 'nbo', pastor: 'nbo', vera: 'nbo', lucy: 'nbo', jane: 'nbo', peter: 'nbo', david: 'nbo', fatuma: 'mba', amina: 'mba' };
const foreignOrg = (p, text) => !HOME[p] ? [] : Object.entries(TOKENS).filter(([k]) => ['grace', 'hope', 'newhope'].includes(k) && k !== HOME[p]).flatMap(([, v]) => v).filter((t) => text.includes(t));
const foreignBranch = (p, text) => { const b = BRANCH_HOME[p]; if (!b) return []; return TOKENS[b === 'nbo' ? 'mba' : 'nbo'].filter((t) => text.includes(t)); };
const orgLeaks = []; const branchMentions = [];
const results = [];
function resolvePath(route, kinds, persona, mode) {
  const segs = route.path.split('/');
  let victim = null; const used = []; const forced = {};
  for (const k of kinds) {
    let val; let obj = null;
    if (fixedValues[k.kind]) val = fixedValues[k.kind];
    else {
      if (forced[k.kind]) { const f = (bag[k.kind] ?? []).find((o) => o.id === forced[k.kind]); if (f) { segs[k.idx] = encodeURIComponent(f.id); used.push({ kind: k.kind, id: f.id, obj: f }); continue; } }
      const cands = r_isAdmin(route) ? [{ id: 'x_probe_admin', org: 'none', branch: null, owner: null }] : (bag[k.kind] ?? []);
      if (mode === 'anon') obj = cands[0];
      else {
        obj = cands.find((o) => crossTenant(persona, o) && (!o.owner || o.owner !== persona))
          ?? cands.find((o) => o.owner && o.owner !== persona && !(o.allow ?? []).includes(persona) && (P[persona].member || !P[persona].staff || P[persona].lowpriv)); // private object of someone else
        // pair order with its event
        if (k.kind === 'tkorder' && obj) victim = victim ?? obj;
        if (obj?.parents) Object.assign(forced, obj.parents);
        if (k.kind === 'event' && victim?.eventId) obj = cands.find((o) => o.id === victim.eventId) ?? obj;
      }
      val = obj?.id ?? (mode === 'anon' ? 'x_anon' : null);
    }
    if (val == null) return null;
    segs[k.idx] = encodeURIComponent(val);
    used.push({ kind: k.kind, id: val, obj });
  }
  return { p: segs.join('/'), used };
}

// wait for paired ordering: process kinds so tkorder resolves before event
const LEAF = ['comment', 'post', 'block', 'expfile', 'tkorder', 'kcheckin'];
for (const j of jobs) j.kinds.sort((a, b) => (LEAF.indexOf(b.kind) - LEAF.indexOf(a.kind)));

const r_isAdmin = (route) => route.auth === 'admin';
let sent = 0;
const skippedNoFixture = new Map();
await pool(jobs, 6, async (j) => {
  const { r, persona, mode, kinds } = j;
  const hasParams = kinds.length > 0;
  let resolved;
  if (!hasParams) resolved = { p: r.path.replace(/\$\{[^}]+\}/g, 'x'), used: [] };
  else resolved = resolvePath(r, kinds, persona, mode);
  if (!resolved) { const key = `${r.method} ${r.path}`; skippedNoFixture.set(key, (skippedNoFixture.get(key) ?? 0) + 1); return; }
  const isMe = r.path.startsWith('/me/') || r.path === '/me';
  const cross = mode === 'victim' && resolved.used.some((u) => u.obj && crossTenant(persona, u.obj));
  const privateOther = mode === 'victim' && resolved.used.some((u) => u.obj?.owner && u.obj.owner !== persona && !(u.obj.allow ?? []).includes(persona) && !['hope'].includes(u.obj.owner));
  const mutating = r.method !== 'GET';
  if (mode === 'victim' && mutating && isMe && !hasParams) return; // own-data actions (clear notifications etc.), nothing to attack
  let expectDeny = false; let why = '';
  if (persona === 'anon') { expectDeny = true; why = 'anonymous'; }
  else if (r.auth === 'admin') { expectDeny = true; why = 'not a platform admin'; }
  else if (cross) { expectDeny = true; why = 'other tenant'; }
  else if (!P[persona].staff && !isMe && !NEUTRAL.has(r.path)) { expectDeny = true; why = 'no staff role'; }
  else if (isMe && privateOther) { expectDeny = true; why = "another person's object"; }
  // what to send: reads always; mutations only where a 2xx would be a clear bug or the person holds no/low privilege
  if (mode === 'victim' && mutating) {
    const weak = !P[persona].staff || P[persona].lowpriv;
    if (!(expectDeny || weak)) return;
  }
  const token = persona === 'anon' ? null : T[persona];
  const res = await callOnce(token, r.method, resolved.p, undefined);
  sent++;
  const status = res.s;
  const data = status >= 200 && status < 300 && hasData(res.j);
  const out = { data, method: r.method, route: r.path, path: resolved.p, persona, status, expectDeny, why, mode, inconclusive: expectDeny && [400, 409, 422, 428].includes(status) };
  if (persona === 'anon' && status !== 401) out.violation = true;
  else if (expectDeny && status >= 200 && status < 300) { if (r.method !== 'GET' || data) out.violation = true; else out.empty200 = true; }
  results.push(out);
  if (status >= 200 && status < 300 && persona !== 'anon' && HOME[persona]) {
    const fo = foreignOrg(persona, res.text ?? ''); if (fo.length) { out.foreignOrgTokens = fo; orgLeaks.push(`${persona} ${r.method} ${resolved.p} mentions ${fo.join(', ')}`); }
    const fb = foreignBranch(persona, res.text ?? ''); if (fb.length) { out.foreignBranchTokens = fb; branchMentions.push(`${persona} ${r.method} ${resolved.p} mentions ${fb.join(', ')}`); }
  }
  if (out.violation) console.log(`VIOLATION ${persona} ${r.method} ${resolved.p} -> ${status} (${why})`);
});

const viol = results.filter((x) => x.violation);
const incon = results.filter((x) => x.inconclusive);
const empty200 = results.filter((x) => x.empty200);
const coveredRoutes = new Set(results.map((x) => `${x.method} ${x.route}`));
const guardedKeys = guarded.map((r) => `${r.method} ${r.path}`);
const uncovered = guardedKeys.filter((k) => !coveredRoutes.has(k));
const attemptedBy = new Map();
for (const x of results) if (x.persona !== 'anon' && x.mode === 'victim') { const k = `${x.method} ${x.route}`; attemptedBy.set(k, (attemptedBy.get(k) ?? 0) + 1); }
const routesWithAttacker = guardedKeys.filter((k) => attemptedBy.has(k));
const routesWithoutAttacker = guardedKeys.filter((k) => !attemptedBy.has(k));
const summary = {
  base: BASE, routesTotal: routes.length, routesPublic: publicRoutes.length, routesGuarded: guarded.length, routesCoveredByMatrix: guardedKeys.length - uncovered.length,
  routesWithNonAnonAttack: routesWithAttacker.length, routesOnlyAnonTested: routesWithoutAttacker, requestsSent: sent, violations: viol.length, crossOrgIdentifierLeaks: orgLeaks.length, crossBranchMentions: branchMentions.length, inconclusive: incon.length, empty200: empty200.length,
  uncoveredRoutes: uncovered, noFixtureFor: [...skippedNoFixture.keys()],
};
console.log('\nSUMMARY', JSON.stringify({ ...summary, uncoveredRoutes: summary.uncoveredRoutes.length, noFixtureFor: summary.noFixtureFor.length, routesOnlyAnonTested: summary.routesOnlyAnonTested.length }, null, 1));
fs.writeFileSync(path.join(here, 'authz-matrix.results.json'), JSON.stringify({ summary, violations: viol, crossOrgIdentifierLeaks: orgLeaks, crossBranchMentions: branchMentions, empty200: empty200.map((x) => `${x.persona} ${x.method} ${x.path}`), inconclusive: incon.map((x) => `${x.persona} ${x.method} ${x.path} ${x.status}`), results }, null, 1));
console.log('Wrote authz-matrix.results.json');
process.exit(viol.length ? 1 : 0);

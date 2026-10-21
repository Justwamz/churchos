// AUTH probe 2: session token format, tampering, query-string token, default-secret forgery, privilege staleness.
// Local API + demo data only. Safe to rerun. Creates (once) a throw-away staff user "Probe Usher" 0722990001 in the DEMO data.
import { createHmac } from 'node:crypto';
const B = process.env.API ?? 'http://localhost:4000';
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(B)) throw new Error('Refusing to probe a non-local host');
const log = (k, v) => console.log(k.padEnd(60), v);
const call = async (m, p, tok, body, hdr = {}) => { const r = await fetch(B + p, { method: m, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...hdr }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const login = async (phone) => (await call('POST', '/auth/otp/verify', null, { phone, code: '123456' })).j.token;

const owner = await login('0700000001');
const [pl, sig] = owner.split('.');
const claims = JSON.parse(Buffer.from(pl, 'base64url').toString());
log('token format', 'base64url(JSON claims) "." base64url(HMAC-SHA256)  (no header, no alg, no kid, no jti, no iat, no type)');
log('claims', JSON.stringify(claims));
log('TTL (hours)', ((claims.exp - Date.now()) / 3600000).toFixed(2));

// tampering
const flip = (o) => Buffer.from(JSON.stringify({ ...claims, ...o })).toString('base64url');
log('tampered isAdmin=true, old signature ->', (await call('GET', '/admin/tenants', flip({ isAdmin: true }) + '.' + sig)).s);
log('alg-none style (no signature) ->', (await call('GET', '/me', pl + '.')).s);
log('extra segment accepted (token.sig.junk) ->', (await call('GET', '/me', owner + '.junk')).s + '  (200 = malleable token, harmless but sloppy)');
log('expired claim re-signed? (needs secret) skipped', '');

// token in the query string
const viaQuery = await fetch(B + '/me?token=' + encodeURIComponent(owner));
log('GET /me?token=<token> (no header) ->', viaQuery.status + '  (200 = query-string tokens accepted on EVERY route, not only downloads)');
const viaQueryPost = await fetch(B + '/team/roles?token=' + encodeURIComponent(owner), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
log('POST /team/roles?token=... (state-changing) ->', viaQueryPost.status + '  (400 = got past auth)');

// forging with the development default secret (shows what happens if CHURCHOS_AUTH_SECRET is unset)
const forge = (c, secret) => { const p = Buffer.from(JSON.stringify(c)).toString('base64url'); return p + '.' + createHmac('sha256', secret).update(p).digest('base64url'); };
const forged = forge({ uid: 'u_admin1', phone: '254700000099', name: 'x', isAdmin: true, exp: Date.now() + 3600000 }, 'dev-only-secret-change-me');
const fr = await call('GET', '/admin/tenants', forged);
log('forged admin token signed with the dev default secret ->', fr.s + (fr.s === 200 ? '  THIS API INSTANCE USES THE PUBLIC DEFAULT SECRET (only ok on a dev laptop)' : '  (rejected: a real secret is configured)'));
log('forged token with a wrong secret ->', (await call('GET', '/admin/tenants', forge({ uid: 'u_admin1', phone: '254700000099', name: 'x', isAdmin: true, exp: Date.now() + 3600000 }, 'guess'))).s);

// there is no server side sign-out / revocation
for (const p of ['/auth/logout', '/auth/signout', '/auth/revoke', '/auth/sessions']) log(`POST ${p}`, (await call('POST', p, owner, {})).s + '  (404 = no such route)');

// staff privilege is read from the database on every request: remove a role, access stops immediately
const team = await call('GET', '/team', owner);
const usherRole = team.j.roles?.find((r) => r.name === 'Usher');
let uid, asg;
const existing = team.j.people?.find((p) => p.name === 'Probe Usher');
if (!existing) {
  const r = await call('POST', '/team/members', owner, { phone: '0722990001', name: 'Probe Usher', roleId: usherRole.id, scope: { type: 'org' } });
  log('created Probe Usher', r.s + ' ' + JSON.stringify(r.j));
}
const team2 = await call('GET', '/team', owner);
const me = team2.j.people.find((p) => p.name === 'Probe Usher');
asg = me.assignments.find((a) => a.role === 'Usher');
const usher = await login('0722990001');
log('usher token works for /staff/me before removal ->', (await call('GET', '/staff/me', usher)).s);
const svc = await call('GET', '/attendance/services', usher);
log('usher can read attendance services before removal ->', svc.s);
if (asg) await call('POST', `/team/assignments/${asg.id}/remove`, owner, {});
log('same (still unexpired) token after the role was removed ->', (await call('GET', '/attendance/services', usher)).s + '  (403 = permissions re-read from DB each request: good)');
// restore for rerunnability
await call('POST', `/team/members/${me.userId}/assignments`, owner, { roleId: usherRole.id, scope: { type: 'org' } });

// isAdmin claim: never re-read from the database. (There is no API to demote an admin, so this part is code reading only: ctx.ts requireAdmin)
log('isAdmin re-checked against DB per request?', 'NO (ctx.ts requireAdmin trusts token claim; stale for up to 12h after demotion) [code reading]');

// Email confirmation: no rate limit when the address is CHANGED (each change sends a fresh code and resets the attempt counter).
const probeTok = await login('0722990001');
const codes = []; const statuses = [];
let blocked = 0;
for (let i = 0; i < 12; i++) {
  const r = await call('PUT', '/me/profile', probeTok, { email: `probe${i}.tester@mailinator.net` });
  if (r.s === 429) blocked++; statuses.push(r.s);
  codes.push(r.j.devCode ?? '-');
}
log("12 email changes in a row (each sends a code email), HTTP statuses " + statuses.join(",") + ", 429 count", blocked + '  (0 = no limit: mail-bombing a third party / unlimited code guesses; 5 guesses per fresh code)');
const v = await call('POST', '/me/profile/verify', probeTok, { code: '000000' });
log('wrong confirmation code', v.s + ' ' + JSON.stringify(v.j));
await call('PUT', '/me/profile', probeTok, { email: '' });

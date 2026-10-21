// Read-only probe of the LOCAL API (http://localhost:4000) for transport and header hygiene. Usage: node docs/security/probes/web-headers.mjs [apiBase]
import { createHmac } from 'node:crypto';
const API = process.argv[2] ?? 'http://localhost:4000';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(API)) { console.error('Refusing: local API only'); process.exit(1); }
const WANT = ['strict-transport-security', 'x-content-type-options', 'referrer-policy', 'content-security-policy', 'x-frame-options', 'permissions-policy', 'cross-origin-resource-policy', 'cache-control'];
const show = (label, r) => { console.log(`\n# ${label} -> ${r.status}`); for (const h of WANT) console.log(`  ${h.padEnd(30)} ${r.headers.get(h) ?? '(missing)'}`); };
const login = async (phone) => (await (await fetch(API + '/auth/otp/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, code: '123456' }) })).json()).token;

show('GET /health', await fetch(API + '/health'));
show('GET /public/churches/search?q=grace', await fetch(API + '/public/churches/search?q=grace'));
const staff = await login('0700000001');
show('GET /me (authenticated JSON)', await fetch(API + '/me', { headers: { authorization: 'Bearer ' + staff } }));

// CORS: does the API reflect any Origin, allow credentials, cache preflights?
const pre = await fetch(API + '/me', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
console.log('\n# CORS preflight from https://evil.example');
for (const h of ['access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-max-age']) console.log(`  ${h.padEnd(34)} ${pre.headers.get(h) ?? '(missing)'}`);

// Token accepted in the query string (ends up in logs, history, Referer)?
const viaQuery = await fetch(API + '/me?token=' + encodeURIComponent(staff));
console.log(`\n# GET /me?token=<jwt-like> without Authorization header -> ${viaQuery.status} (200 means tokens in URLs are accepted on every route)`);

// 404 / error shape
const nf = await fetch(API + '/does-not-exist'); console.log('\n# 404 body:', (await nf.text()).slice(0, 120));

// Mock PSP webhook signed with the hard-coded development secret (zero-amount body: nothing is posted, status "ignored" proves the signature was accepted)
const body = JSON.stringify({ providerTxId: 'PROBE0', method: 'mpesa', amount: 0, reference: '', phone: '254700000000' });
const sig = createHmac('sha256', 'dev-psp-secret').update(body).digest('hex');
const wh = await fetch(API + '/psp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-psp-signature': sig }, body });
console.log(`\n# POST /psp/webhook signed with 'dev-psp-secret' -> ${wh.status} ${await wh.text()}  (200 ignored = forged-signature accepted while PSP_MODE != live)`);
const bad = await fetch(API + '/psp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-psp-signature': 'deadbeef' }, body });
console.log(`# same with a wrong signature -> ${bad.status}`);

#!/usr/bin/env node
/**
 * Abuse-resistance / business-logic / privacy probes against the LOCAL stack only (default http://localhost:4000, demo data).
 * Plain node 18+ and fetch, no dependencies:    node docs/security/probes/logic-http.mjs [section ...]
 *
 * Sections: ratelimit give-spam amounts welcome-sms join anon-gift audit privacy lockout webhook-neg
 *
 * Notes before you run it:
 *  - It refuses to run against anything other than localhost / 127.0.0.1.
 *  - It adds a few demo rows (small gifts, visitors, join requests that it cancels again). Nothing is deleted.
 *  - `lockout` locks the demo phone 0733000001 (Neema Newcomer) out for 15 minutes (in-memory counter, cleared by an API restart).
 *    It is NOT part of the default run; ask for it: node logic-http.mjs lockout
 *  - `ratelimit` and `give-spam` use up the church-search bucket of your IP for a minute.
 */
const BASE = process.env.API ?? 'http://localhost:4000';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) { console.error('Refusing: this probe only runs against localhost.'); process.exit(2); }

const call = async (method, url, body, token, headers = {}) => {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};
const login = async (phone) => (await call('POST', '/auth/otp/verify', { phone, code: '123456' })).json?.token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const out = (id, v) => console.log(`[${id}] ` + (typeof v === 'string' ? v : JSON.stringify(v)));
const tally = (arr) => arr.reduce((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {});
const burst = async (n, fn) => tally(await Promise.all(Array.from({ length: n }, (_, i) => fn(i).then((r) => r.status))));

const OWNER = '0700000001', TREAS = '0700000002', AUDITOR = '0700000007', ADMIN1 = '0700000099', JANE = '0711000001', NEEMA = '0733000001';
const wanted = new Set(process.argv.slice(2));
const run = (name) => (wanted.size ? wanted.has(name) : name !== 'lockout');

// ------------------------------------------------------------------ 1. which routes have any limit?
if (run('ratelimit')) {
  console.log('\n== ratelimit: burst counts per endpoint (statuses seen). 429 anywhere means a limit exists. ==');
  out('RL-otp-request x40 (same phone)', await burst(40, () => call('POST', '/auth/otp/request', { phone: '0711000001' })));
  const rnd = () => hex(8);
  out('RL-public-credit x50 (random 16-hex codes)', await burst(50, () => call('GET', `/public/credit/${rnd()}`)));
  out('RL-public-statement x50', await burst(50, () => call('GET', `/public/statement/GS-2026-${hex(3)}`)));
  out('RL-public-ticket-order-secret x50', await burst(50, () => call('GET', `/public/tickets/orders/${hex(16).toLowerCase()}`)));
  out('RL-public-ticket-token x50', await burst(50, () => call('GET', `/public/tickets/${hex(12)}`)));
  out('RL-public-give-lookup x50', await burst(50, () => call('GET', `/public/give/int_${hex(6)}`)));
  out('RL-public-church x50', await burst(50, () => call('GET', '/public/church/GRC001')));
  out('RL-public-fee x50', await burst(50, () => call('GET', '/public/fee?code=GRC001&amount=100&method=mpesa')));
  out('RL-public-verify-cert x50', await burst(50, () => call('GET', `/public/verify/BAP-2026-000001?k=${hex(8)}`)));
  out('RL-door-token x30 (bad token)', await burst(30, () => call('POST', '/public/here/D1.bad.bad', { name: 'x', phone: '0722000000' })));
  out('RL-church-search x45 (limit is 40/min/IP)', await burst(45, () => call('GET', '/public/churches/search?q=grace')));
  out('RL-church-search with rotating X-Forwarded-For x10 (TRUST_PROXY is off here, so header ignored)', await burst(10, (i) => call('GET', '/public/churches/search?q=grace', undefined, undefined, { 'x-forwarded-for': `9.9.9.${i}` })));
  const t = await login(JANE);
  out('RL-authenticated-expensive: 30x GET /me/giving/ledger', await burst(30, () => call('GET', '/me/giving/ledger', undefined, t)));
  out('RL-authenticated: 30x POST /me/credit/transfer/lookup (limit is 10/hour/user)', await burst(30, () => call('POST', '/me/credit/transfer/lookup', { phone: '0711000002' }, t)));
}

// ------------------------------------------------------------------ 2. paying prompts to other people's phones
if (run('give-spam')) {
  console.log('\n== give-spam: /public/give has no per-phone / per-IP / per-church limit; each call sends a payment prompt to the number given ==');
  const victim = '0722000111';
  const r = await Promise.all(Array.from({ length: 12 }, () => call('POST', '/public/give', { code: 'GRC001', amount: 10, method: 'mpesa', purpose: 'OFFERING', phone: victim })));
  out('GIVE-12 prompts to ONE stranger number in one burst', tally(r.map((x) => x.status)));
  const cardR = await Promise.all(Array.from({ length: 5 }, () => call('POST', '/public/give', { code: 'GRC001', amount: 10, method: 'card', purpose: 'OFFERING', phone: victim })));
  out('GIVE-5 card checkouts created (each is a pending provider record)', tally(cardR.map((x) => x.status)));
  const tk = await call('GET', '/public/event/__none__');
  out('GIVE-note', 'The same pattern exists on POST /public/tickets/orders (STK sent BEFORE the order row exists) and POST /wallets/:id/topup (staff).');
}

// ------------------------------------------------------------------ 3. amounts the server accepts
if (run('amounts')) {
  console.log('\n== amounts: odd values on the public gift endpoint and a few other money inputs ==');
  const tryGive = async (label, amount) => { const r = await call('POST', '/public/give', { code: 'GRC001', amount, method: 'cash', purpose: 'OFFERING', phone: '0722000222' }); return [label, r.status, r.json?.code ?? r.json?.error ?? r.text.slice(0, 80)]; };
  // method 'cash' is refused AFTER the amount checks, so this shows amount validation without sending a prompt
  for (const [l, v] of [['-1', -1], ['0', 0], ['0.001', 0.001], ['9.99', 9.99], ["'10abc'", '10abc'], ["'1e3'", '1e3'], ["'NaN'", 'NaN'], ['1e308', 1e308], ["'1e308'", '1e308'], ['150000.01', 150000.01], ['null', null], ['[]', []], ["'0x10'", '0x10']]) out('AMT-give ' + l, await tryGive(l, v));
  const owner = await login(OWNER);
  const proj = await call('POST', '/projects', { branchId: 'br_grc001', code: 'ZZBIG', name: 'Overflow probe', target: '1e17' }, owner);
  out('AMT-project target 1e17 (above bigint max when x100)', [proj.status, proj.json?.code ?? proj.json?.error ?? proj.text.slice(0, 100)]);
  const jane = await login(JANE);
  const pl = await call('POST', '/me/pledges', { churchCode: 'GRC001', projectCode: 'ROOF', amount: '1e17' }, jane);
  out('AMT-pledge 1e17', [pl.status, pl.json?.code ?? pl.json?.error ?? pl.text.slice(0, 100)]);
}

// ------------------------------------------------------------------ 4. SMS sent to arbitrary numbers by anonymous visitors
if (run('welcome-sms')) {
  console.log('\n== welcome-sms: a door/invite link lets an anonymous caller trigger a (church-paid) SMS to any number, with their own text in it ==');
  const owner = await login(OWNER);
  const svcs = (await call('GET', '/attendance/services', undefined, owner)).json?.services ?? [];
  const open = svcs.find((s) => s.state === 'open');
  if (!open) out('WSMS', 'no open service right now; run this when a service is open (demo "Wednesday Prayer" opens around its start time)');
  else {
    const door = await call('GET', `/attendance/services/${open.id}/door`, undefined, owner);
    const token = door.json?.token ?? door.json?.code ?? door.json?.url?.split('/').pop();
    out('WSMS door token obtained by staff (anyone who photographs the door QR has the same)', !!token);
    const res = [];
    for (let i = 0; i < 4; i++) res.push((await call('POST', `/public/here/${token}`, { name: `http://example.test/p${i}`, phone: `07220004${10 + i}` })).status);
    out('WSMS 4 different numbers, attacker-chosen one-word "name", one token', tally(res));
    await sleep(500);
    const adm = await login(ADMIN1);
    const sms = (await call('GET', '/admin/sms-outbox', undefined, adm)).json ?? [];
    out('WSMS resulting SMS bodies (newest first)', sms.filter((s) => String(s.body).startsWith('Hello http://example.test')).slice(0, 4).map((s) => s.body));
  }
}

// ------------------------------------------------------------------ 5. join requests: spam loop, text reaching staff
if (run('join')) {
  console.log('\n== join: create / cancel loop by one user; what staff receive ==');
  const t = await login(NEEMA);
  if (!t) out('JOIN', 'Neema could not sign in (locked?). Restart not allowed here; try again after 15 minutes.');
  else {
    const status = await call('GET', '/me/link/status', undefined, t);
    if (status.json?.linked) out('JOIN', 'Neema is already linked to a church; skipping');
    else {
      const codes = [];
      for (let i = 0; i < 6; i++) {
        const r = await call('POST', '/me/link/request', { code: 'HPC001', consent: true, name: 'URGENT call 0700 000 000 or visit http://example.test', message: 'x'.repeat(190) }, t);
        codes.push(r.status);
        if (r.json?.id) await call('POST', `/me/link/request/${r.json.id}/cancel`, {}, t);
      }
      out('JOIN-6 request/cancel cycles (each notifies every staff member with members.edit and writes an audit event)', tally(codes));
      const owner = await login('0700000005');
      const n = (await call('GET', '/me/notifications', undefined, owner)).json;
      const rows = (n?.rows ?? n ?? []).filter?.((x) => /join the church/i.test(x.title ?? '')) ?? [];
      out('JOIN-staff notifications that carry the requester-chosen name', { count: rows.length, sample: rows[0]?.body, link: rows[0]?.link });
    }
  }
}

// ------------------------------------------------------------------ 6. anonymous gift traces
if (run('anon-gift')) {
  console.log('\n== anon-gift: who can still tie an anonymous gift to a person? ==');
  const jane = await login(JANE);
  const g = await call('POST', '/me/give', { code: 'GRC001', amount: 10, method: 'mpesa', purpose: 'OFFERING', anonymous: true }, jane);
  out('ANON-gift started', g.status);
  await sleep(5000);
  const adm = await login(ADMIN1);
  const pays = (await call('GET', '/admin/payments?stage=pending', undefined, adm)).json ?? [];
  const anon = pays.find((p) => p.anonymous);
  const sms = (await call('GET', '/admin/sms-outbox', undefined, adm)).json ?? [];
  const hit = sms.find((s) => anon && String(s.body).includes(anon.provider_tx_id));
  out('ANON-admin payments list marks it anonymous and hides the phone', anon ? { payer_phone: anon.payer_phone, anonymous: anon.anonymous, tx: anon.provider_tx_id } : 'not found');
  out('ANON-admin SMS outbox row for the SAME transaction id (no reason asked, no audit written)', hit ? { to_phone: hit.to_phone, body: hit.body } : 'not found');
  const events = (await call('GET', '/admin/audit/events?action=access', undefined, adm)).json?.events ?? [];
  out('ANON-audit events of kind access.* after that look-up', events.slice(0, 3).map((e) => e.action));
  const t = await login(TREAS);
  const tr = await call('GET', '/collections', undefined, t);
  out('ANON-treasurer collections response mentions the giver phone?', /711000001|0711 ?000 ?001/.test(tr.text));
  const pi = await call('GET', `/public/give/${g.json?.intentId}`);
  out('ANON-public give status (intent id is the only key; 48 random bits)', { status: pi.status, keys: Object.keys(pi.json ?? {}) });
}

// ------------------------------------------------------------------ 7. audit log and giving-ledger access
if (run('audit')) {
  console.log('\n== audit: integrity, who can read, staff reading member giving ==');
  const adm = await login(ADMIN1);
  const v = (await call('GET', '/admin/audit/verify', undefined, adm)).json;
  out('AUD-platform chain verification (on request only, not on read)', { ok: v?.ok, chains: v?.chains?.map((c) => `${c.chain}:${c.events}:${c.ok}`) });
  const jane = await login(JANE);
  out('AUD-member reads church audit log', (await call('GET', '/audit/events', undefined, jane)).status);
  const aud = await login(AUDITOR);
  const ev = await call('GET', '/audit/events?limit=5', undefined, aud);
  out('AUD-auditor reads church audit log (fields incl. ip, user_agent, meta)', { status: ev.status, fields: Object.keys(ev.json?.events?.[0] ?? {}), sampleIp: ev.json?.events?.[0]?.ip });
  const tr = await login(TREAS);
  const before = (await call('GET', '/me/giving/access-log', undefined, jane)).json;
  const gl = await call('GET', '/members/m_jane/giving-ledger', undefined, tr);
  const after = (await call('GET', '/me/giving/access-log', undefined, jane)).json;
  out('AUD-treasurer opens a member giving ledger WITHOUT giving a reason', { status: gl.status, error: gl.json?.error ?? gl.json?.code, accessLogBefore: JSON.stringify(before).length, accessLogAfter: JSON.stringify(after).length });
  const gl2 = await call('GET', '/members/m_jane/giving-ledger?reason=audit', undefined, tr);
  out('AUD-with ?reason=audit', { status: gl2.status });
  const own = await login(OWNER);
  out('AUD-owner (no giving.ledger permission?) opens it', (await call('GET', '/members/m_jane/giving-ledger', undefined, own)).status);
}

// ------------------------------------------------------------------ 8. personal data in responses
if (run('privacy')) {
  console.log('\n== privacy: unmasked phone numbers in list responses, per role ==');
  const re = /(?<![\d])(?:254|0)[17]\d{8}(?![\d])/g;
  const scan = async (who, phone, urls) => {
    const t = await login(phone);
    for (const u of urls) {
      const r = await call('GET', u, undefined, t);
      const found = (r.text.match(re) ?? []);
      out(`PRIV ${who} GET ${u}`, { status: r.status, fullPhonesInResponse: new Set(found).size, example: found[0] ? found[0].slice(0, 6) + '*****' : null });
    }
  };
  await scan('owner', OWNER, ['/members', '/members/grouped', '/members/join-requests', '/credit/refunds', '/attendance/visitors', '/collections', '/kids/classes', '/members/lookup?q=jane']);
  await scan('treasurer', TREAS, ['/members', '/collections', '/credit/refunds']);
  await scan('platform admin', ADMIN1, ['/admin/payments', '/admin/suspense', '/admin/reversal-requests', '/admin/sms-outbox', '/admin/outbox', '/admin/tenants']);
  await scan('member Jane', JANE, ['/me/profile', '/me/family', '/me/groups/discover']);
  const pub = await call('GET', '/public/church/GRC001');
  out('PRIV public church page keys', Object.keys(pub.json ?? {}));
  const st = await call('GET', '/public/statement/GS-2026-AAAAAA');
  out('PRIV public statement lookup of a non-existent number', st.json);
}

// ------------------------------------------------------------------ 9. login lock (opt-in)
if (run('lockout')) {
  console.log('\n== lockout: anyone can lock a known phone out of sign-in (attempt counter is per phone, not per caller) ==');
  const bad = [];
  for (let i = 0; i < 6; i++) bad.push((await call('POST', '/auth/otp/verify', { phone: NEEMA, code: '000000' })).status);
  const good = await call('POST', '/auth/otp/verify', { phone: NEEMA, code: '123456' });
  out('LOCK-6 wrong codes from an anonymous caller, then the REAL code', { wrongCodeStatuses: bad, correctCodeStatus: good.status, message: good.json?.error });
  const req = await call('POST', '/auth/otp/request', { phone: NEEMA });
  out('LOCK-otp/request response in this (non-production) mode', req.json);
}

// ------------------------------------------------------------------ 10. webhook negatives
if (run('webhook-neg')) {
  console.log('\n== webhook-neg: unauthenticated callbacks must be refused ==');
  const post = (u, h = {}, b = { providerTxId: 'X1', method: 'mpesa', amount: 100, reference: 'GRC001#OFFERING', phone: '254700000000' }) => call('POST', u, b, undefined, h);
  for (const u of ['/psp/webhook', '/webhooks/daraja/guess/stk', '/webhooks/daraja/guess/c2b', '/webhooks/daraja/guess/c2b-validate', '/webhooks/daraja/guess/result', '/webhooks/airtel/guess', '/webhooks/paystack'])
    out('WH ' + u, (await post(u)).status);
  out('WH bad signature', (await post('/psp/webhook', { 'x-psp-signature': 'deadbeef' })).status);
  out('WH caller-supplied x-psp / x-psp-token / x-psp-ip headers on /psp/webhook', (await post('/psp/webhook', { 'x-psp': 'mpesa', 'x-psp-token': 'a', 'x-psp-ip': '196.201.214.200' })).status);
  out('WH-note', 'Forging a payment with the published dev secret is shown in logic-races.scratch.test.ts (in-process, so it cannot disturb this stack reconcile).');
}
console.log('\ndone');

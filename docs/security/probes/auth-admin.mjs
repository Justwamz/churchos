// AUTH probe 3: platform admin separation, dev-only tools, maker-checker on reversals above KES 50,000.
// Local API + demo data only. Creates one simulated KES 60,000 payment and one reversal request per run (demo data).
const B = process.env.API ?? 'http://localhost:4000';
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(B)) throw new Error('Refusing to probe a non-local host');
const log = (k, v) => console.log(k.padEnd(66), v);
const call = async (m, p, tok, body) => { const r = await fetch(B + p, { method: m, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const login = async (phone) => (await call('POST', '/auth/otp/verify', null, { phone, code: '123456' })).j.token;
const a1 = await login('0700000099'), a2 = await login('0700000098'), owner = await login('0700000001'), treas = await login('0700000002'), member = await login('0711000001');

// separation: church users cannot use admin routes, admins have no church access
for (const [who, t] of [['church owner', owner], ['treasurer', treas], ['member', member], ['no token', null]]) log(`GET /admin/tenants as ${who}`, (await call('GET', '/admin/tenants', t)).s);
for (const [who, t] of [['church owner', owner], ['member', member]]) log(`POST /admin/clock/advance as ${who}`, (await call('POST', '/admin/clock/advance', t, { hours: 1 })).s);
log('admin one on a staff route (/team)', (await call('GET', '/team', a1)).s + ' (403 expected: admin has no church role)');

// dev-only tools: reachable by an admin when NODE_ENV != production (the demo MUST run with NODE_ENV=production)
const sim = await call('POST', '/admin/simulate/paybill', a1, { amount: 60000, reference: 'GRC001#OFFERING', phone: '254711000001' });
log('POST /admin/simulate/paybill as admin (dev tool)', sim.s + (sim.s === 200 ? '  REACHABLE => this instance is NOT in production mode' : '  (404 = gated: production mode)'));
const wr = await call('POST', '/admin/webhook-replay', a1, {});
log('POST /admin/webhook-replay as admin (dev tool, signs with mock key)', wr.s);
if (sim.s !== 200) { console.log('dev tools gated; skipping maker-checker part (needs a >50k payment)'); process.exit(0); }

// maker-checker
const pays = (await call('GET', '/admin/payments', a1)).j;
const big = pays.find((p) => Number(p.amount_paid) > 5000000 && p.stage !== 'reversed' && p.stage !== 'suspense');
if (!big) { console.log('no big payment found', JSON.stringify(sim.j)); process.exit(0); }
log('payment found', `${big.provider_tx_id} KES ${Number(big.amount_paid) / 100} stage=${big.stage} branch=${big.branch_code}`);
const rq = await call('POST', '/reversal-requests', treas, { paymentId: big.id, reason: 'probe: wrong amount entered' });
log('treasurer requests reversal', rq.s + ' ' + JSON.stringify(rq.j));
const id = rq.j.id; if (!id) process.exit(0);
const d = (t, approve = true) => call('POST', `/admin/reversal-requests/${id}/decide`, t, { approve, reason: 'probe' });
log('admin ONE first approval', JSON.stringify((await d(a1)).j));
log('admin ONE tries to approve again (second approval)', JSON.stringify((await d(a1)).j) + '   <- must be same_person');
// race: admin TWO approves twice concurrently (double reversal?)
const race = await Promise.all([d(a2), d(a2), d(a2)]);
log('admin TWO x3 concurrent second approvals', race.map((r) => r.s + ':' + (r.j.status ?? r.j.code)).join(' | '));
const final = (await call('GET', '/admin/reversal-requests?status=approved,failed', a1)).j.find((r) => r.id === id);
log('final state', final && `${final.status} first=${final.first_approver} second=${final.second_approver} failure=${final.failure ?? ''}`);
console.log('NOTE: no check that the approver differs from the REQUESTER (code: reversals.ts decideReversal compares only first_approver). Requesters are church users, admins are separate accounts, so it only matters if one phone is both (see findings).');

// requester == approver: a platform admin pays from their own phone (simulated here), asks for the reversal as a "member", then approves it alone (< KES 50,000).
const s2 = await call('POST', '/admin/simulate/paybill', a1, { amount: 1000, reference: 'GRC001#OFFERING', phone: '254700000099' });
const code2 = s2.j.providerTxId ?? s2.j.txId ?? (await call('GET', '/admin/payments', a1)).j.find((p) => Number(p.amount_paid) === 100000 && p.stage !== 'reversed')?.provider_tx_id;
const rq2 = await call('POST', '/me/reversal-request', a1, { message: 'Confirmed. ' + code2 + ' sent', reason: 'probe: self request' });
log('admin asks for reversal of its own payment (member route)', rq2.s + ' ' + JSON.stringify(rq2.j).slice(0, 120));
if (rq2.j.id) log('SAME admin approves its own request', JSON.stringify((await call('POST', `/admin/reversal-requests/${rq2.j.id}/decide`, a1, { approve: true, reason: 'probe' })).j) + '  <- no requester != approver check');

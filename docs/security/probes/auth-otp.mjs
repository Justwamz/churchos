// AUTH probe 1: sign-in behaviour. Local API + demo data only. Safe to rerun (uses a random UNKNOWN number for lockout tests).
// Run: node docs/security/probes/auth-otp.mjs
const B = process.env.API ?? 'http://localhost:4000';
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(B)) throw new Error('Refusing to probe a non-local host');
const post = async (p, body) => { const t0 = performance.now(); const r = await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); return { s: r.status, j, ms: performance.now() - t0 }; };
const log = (k, v) => console.log(k.padEnd(52), v);

// 1. /auth/otp/request: does it reveal whether a number is registered, or the code?
const known = await post('/auth/otp/request', { phone: '0700000001' });
const unknown = await post('/auth/otp/request', { phone: '0799999999' });
log('otp/request known   ->', JSON.stringify(known.j));
log('otp/request unknown ->', JSON.stringify(unknown.j));
log('enumeration via request (non-production)?', known.j.known !== unknown.j.known ? 'YES (known flag + devCode returned)' : 'no');

// 2. /auth/otp/verify: same message for unknown number and wrong code?
const rnd = '07' + String(Math.floor(10000000 + Math.random() * 89999999)).slice(0, 8); // random, almost surely unregistered
const wrongKnown = await post('/auth/otp/verify', { phone: '0711000002', code: '000000' });
const wrongUnknown = await post('/auth/otp/verify', { phone: rnd, code: '123456' }); // right code, unknown number
log('verify wrong code, known number', `${wrongKnown.s} ${JSON.stringify(wrongKnown.j)}`);
log('verify right code, unknown number', `${wrongUnknown.s} ${JSON.stringify(wrongUnknown.j)}`);
log('verify message identical?', JSON.stringify(wrongKnown.j) === JSON.stringify(wrongUnknown.j) ? 'yes (good)' : 'NO');

// 3. timing (rough): 15 samples each of known/unknown with wrong code, on throw-away numbers to avoid locking real demo users
const sample = async (phoneFn) => { const t = []; for (let i = 0; i < 4; i++) t.push((await post('/auth/otp/verify', { phone: phoneFn(i), code: '000000' })).ms); return t.sort((a, b) => a - b)[1]; };
log('median ms, wrong code, unknown numbers (not locked)', (await sample((i) => '0799' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0'))).toFixed(1));
log('(known-number timing not sampled to avoid locking demo users)', '');

// 4. phone normalisation edge cases (right code; shows which spellings map to a real account)
for (const raw of ['0700000002', '+254 700 000 002', '254-700-000-002', '700000002', 'abc07 00-000 002xyz', ['0700000002', 'junk'], '0700000002\n', '٠٧٠٠٠٠٠٠٠٢' /* arabic-indic digits */, '07000000020' /* 11 digits */, '0100000002']) {
  const r = await post('/auth/otp/verify', { phone: raw, code: '123456' });
  log(`normalise ${JSON.stringify(raw)}`, `${r.s} ${r.j.user ? 'signed in as ' + r.j.user.phone : r.j.code}`);
}

// 5. lockout is per phone, in memory: lock a random unknown number with 5 wrong codes, then check the 6th and whether a RIGHT code still fails
const lockMe = '0798' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const codes = [];
for (let i = 0; i < 7; i++) codes.push((await post('/auth/otp/verify', { phone: lockMe, code: '111111' })).s);
log('lockout sequence (HTTP statuses), 7 wrong tries', codes.join(','));
log('lock applies to NON-EXISTENT numbers too (memory growth)', codes.includes(429) ? 'yes: map entry created per unknown phone, never pruned' : 'no');

// 6. no per-IP limit: 60 requests/verifies from one client with different numbers
let limited = 0;
for (let i = 0; i < 60; i++) { const r = await post('/auth/otp/request', { phone: '0797' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0') }); if (r.s === 429) limited++; }
log('60 otp/request calls from one IP, 429 count', limited);
let lim2 = 0;
for (let i = 0; i < 60; i++) { const r = await post('/auth/otp/verify', { phone: '0796' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0'), code: '000000' }); if (r.s === 429) lim2++; }
log('60 otp/verify guesses over 60 DIFFERENT numbers, 429 count', lim2 + '  (0 => no per-IP limit; each also writes an audit row)');

// 7. targeting an admin: same flow as everyone (no extra factor)
const adm = await post('/auth/otp/verify', { phone: '0700000099', code: '123456' });
log('platform admin sign-in with fixed code', adm.s + ' isAdmin=' + adm.j.user?.isAdmin + '  (no second factor, no different treatment)');

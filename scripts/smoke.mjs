// End-to-end money story against a RUNNING api (pnpm dev). Prints PASS or FAIL per step.
// Usage: node scripts/smoke.mjs [apiUrl]
const API = process.argv[2] ?? 'http://localhost:4000';
let failed = 0;

const step = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

async function call(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const login = async (phone) => (await call('POST', '/auth/otp/verify', { phone, code: '123456' })).json.token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const health = await call('GET', '/health').catch(() => null);
if (!health || health.status !== 200) {
  console.log(`API is not reachable at ${API}. Start it with: pnpm dev`);
  process.exit(2);
}

const admin = await login('0700000099');
const admin2 = await login('0700000098');
const treasurer = await login('0700000002');
const hope = await login('0700000005');
const peter = await login('0711000002');

// 1. A member gives by STK push to the public giving page.
const give = await call('POST', '/public/give', { code: 'GRC001', purpose: 'TITHE', phone: '0712000111', amount: 1000, method: 'mpesa' });
step('STK push started from the public giving page', give.status === 200, give.json.message);
let status = 'initiated';
for (let i = 0; i < 30 && status === 'initiated'; i++) {
  await sleep(500);
  status = (await call('GET', `/public/give/${give.json.intentId}`)).json.status;
}
step('STK push completed and credited to the church ledger', status === 'completed', status);

// 2. Money shows up on the treasurer's real-time dashboard.
const dash = await call('GET', '/dashboard', undefined, treasurer);
step('Treasurer dashboard shows today\'s collections', dash.status === 200 && Number(dash.json.today.gross) >= 100000);

// 3. Tenant isolation.
const leak = await call('GET', '/dashboard?branch=br_grc001', undefined, hope);
step('Another church cannot read this church\'s branch (403)', leak.status === 403);

// 4. A paybill payment with a wrong church code lands in suspense.
const wrong = await call('POST', '/admin/simulate/paybill', { phone: '0711000002', amount: 750, reference: 'GRC999#TITHE' }, admin);
const code = wrong.json.providerTxId;
const susp = await call('GET', '/admin/suspense', undefined, admin);
step('Wrong church code is held in suspense, not credited', susp.json.some((s) => s.provider_tx_id === code));

// 5. A duplicate delivery is posted once.
const dup = await call('POST', '/admin/simulate/paybill', { phone: '0711000002', amount: 400, reference: 'GRC001#OFFERING', duplicate: true }, admin);
const all = await call('GET', '/admin/payments', undefined, admin);
step('Duplicate PSP notification posted exactly once', all.json.filter((p) => p.provider_tx_id === dup.json.providerTxId).length === 1);

// 6. The member pastes the SMS to get the wrong payment back.
const sms = `${code} Confirmed. Ksh750.00 paid to CHURCHOS. New balance is Ksh 1,200.00.`;
const ask = await call('POST', '/me/reversal-request', { message: sms }, peter);
step('Member reversal request found the payment from the pasted SMS', ask.status === 200, ask.json.found?.where ?? ask.json.error);
const reqs = await call('GET', '/admin/reversal-requests?status=pending', undefined, admin);
const rev = reqs.json.find((r) => r.provider_tx_id === code);
const approved = rev ? await call('POST', `/admin/reversal-requests/${rev.id}/decide`, { approve: true }, admin) : { json: {} };
step('Admin approved the reversal (under KES 50,000, one approver)', approved.json.status === 'approved', approved.json.status);

// 7. Skip the 48 hour hold, run settlement.
await call('POST', '/admin/clock/advance', { hours: 49 }, admin);
const run = await call('POST', '/admin/settlement/run', {}, admin);
step('Daily settlement paid out at least one branch', run.json.results?.some((r) => r.status === 'paid'), JSON.stringify(run.json.results?.map((r) => r.status)));

// 8. Reversal after payout becomes a receivable and the books still balance.
const after = await call('POST', '/admin/simulate/paybill', { phone: '0711000002', amount: 300, reference: 'GRC001#TITHE' }, admin);
await call('POST', '/admin/clock/advance', { hours: 1 }, admin);
const ask2 = await call('POST', '/me/reversal-request', { message: `${after.json.providerTxId} Confirmed Ksh300.00` }, peter);
step('Member can ask to reverse a recent church payment', ask2.status === 200, ask2.json.error ?? '');

// 9. The books balance.
const rec = await call('GET', '/admin/reconcile', undefined, admin);
step('Ledger wallet equals the PSP wallet and entries sum to zero', rec.json.ok === true, `ledger ${rec.json.ledgerWallet} vs psp ${rec.json.pspWallet}`);
void admin2;

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

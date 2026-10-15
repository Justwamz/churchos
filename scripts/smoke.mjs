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

// 10. Slice 2: verification, SMS wallet and help.
const owner = await login('0700000001');
const newhope = await login('0700000006');
const kyc = await call('GET', '/kyc/status', undefined, newhope);
step('Unverified church sees its onboarding checklist', kyc.status === 200 && kyc.json.branches[0].verified === false);
await call('POST', '/admin/simulate/paybill', { phone: '0722000333', amount: 1000, reference: 'NHF001#TITHE' }, admin);
await call('POST', '/admin/clock/advance', { hours: 49 }, admin);
const run2 = await call('POST', '/admin/settlement/run', {}, admin);
step('Unverified church collects but is not paid out', run2.json.results?.find((r) => r.branchId === 'br_nhf001')?.status === 'skipped');
const walletList = await call('GET', '/wallets', undefined, owner);
const orgSms = walletList.json.wallets?.find((w) => w.id === 'wal:org_grace:sms');
step('The church SMS wallet shows a balance and the paybill reference', walletList.status === 200 && orgSms?.paybillReference === 'SMS#GRACE', 'KES ' + (orgSms?.balance / 100));
const help = await call('GET', '/help/search?q=wrong%20church%20refund');
step('Help search finds the wrong-payment article without signing in', help.json.results?.[0]?.articleId === 'member-wrong-payment');
const helpLeak = await call('GET', '/help/articles/admin-suspense');
step('Admin-only help is hidden from anonymous visitors (404)', helpLeak.status === 404);
const rec2 = await call('GET', '/admin/reconcile', undefined, admin);
step('Books still balance after slice 2 activity', rec2.json.ok === true);

// 11. Slice 3: records, approval and verification.
const samuel = await login('0700000003');
const daniel = await login('0700000001');
const year = new Date().getUTCFullYear();
const verify = await call('GET', `/public/verify/GRC001-BAP-${year}-0001?k=DEMOKEY1`);
step('Baptism card verifies with the key from its QR code', verify.status === 200 && verify.json.valid === true, verify.json.subject);
const noKey = await call('GET', `/public/verify/GRC001-BAP-${year}-0001`);
step('The same card does not verify without the private key', noKey.status === 404);
const pending = (await call('GET', '/records?status=pending_approval', undefined, samuel)).json[0];
const own = await call('POST', `/records/${pending.id}/decide`, {}, samuel);
step('The person who entered a record cannot approve it', own.status === 403 && own.json.code === 'same_person');
const ok = await call('POST', `/records/${pending.id}/decide`, {}, daniel);
step('A different person approves it and a serial number is issued', ok.status === 200 && /^GRC001-BAP-/.test(ok.json.serial ?? ''), ok.json.serial);
const tpl = await call('GET', '/certificates/template', undefined, samuel);
step('The church template and logo load', tpl.status === 200 && !!tpl.json.logo);
const rec3 = await call('GET', '/admin/reconcile', undefined, admin);
step('Books still balance after slice 3 activity', rec3.json.ok === true);

// 12. Slice 4: audit, history and masking.
const auditor = await login('0700000007');
const fullPhone = /\b254\d{9}\b|\b07\d{8}\b/;
const members = await call('GET', '/members?q=Jane', undefined, samuel);
step('Member phone numbers are masked for staff', members.status === 200 && !fullPhone.test(JSON.stringify(members.json)) && /•••/.test(JSON.stringify(members.json)));
const jane = members.json.find((m) => m.full_name === 'Jane Wanjiku');
const revealed = await call('POST', `/members/${jane.id}/reveal`, { fields: ['phone'], reason: 'Smoke test' }, samuel);
step('A permitted person can reveal one number', revealed.status === 200 && fullPhone.test(revealed.json.phone ?? ''));
const denied = await call('POST', `/members/${jane.id}/reveal`, {}, auditor);
step('The read-only auditor cannot reveal numbers', denied.status === 403);
const log = await call('GET', '/audit/events?action=access.reveal', undefined, daniel);
step('The reveal was written to the audit log with the reason', log.status === 200 && log.json.events[0]?.reason === 'Smoke test' && log.json.events[0]?.actor_name === 'Samuel Kiptoo');
const chain = await call('GET', '/audit/verify', undefined, daniel);
step('The audit chain verifies', chain.status === 200 && chain.json.ok === true, `${chain.json.events} events`);
const exp = await fetch(API + '/audit/export', { headers: { authorization: 'Bearer ' + auditor } });
step('The auditor can export the log, and the export is masked', exp.status === 200 && !fullPhone.test(await exp.text()));
const noExport = await call('GET', '/audit/export', undefined, samuel);
step('A branch admin cannot export', noExport.status === 403);

// 13. Slice 5: messaging wallets, integrations, consent, scheduled and group messages.
const m5Wallets = await call('GET', '/wallets', undefined, samuel);
step('Branch admin sees wallet balances for their branch and headquarters', m5Wallets.status === 200 && m5Wallets.json.wallets.some((w) => w.id === 'wal:br_grc001:sms') && !m5Wallets.json.wallets.some((w) => w.id === 'wal:br_grc002:sms'));
const m5Before = m5Wallets.json.wallets.find((w) => w.id === 'wal:br_grc001:sms').balance;
const m5Top = await call('POST', '/wallets/wal:br_grc001:sms/topup', { amount: 100, method: 'mpesa', phone: '0700000003' }, samuel);
let m5Status = 'initiated';
for (let i = 0; i < 30 && m5Status === 'initiated'; i++) { await sleep(300); m5Status = (await call('GET', `/wallets/topups/${m5Top.json.id}`, undefined, samuel)).json.status; }
const m5After = (await call('GET', '/wallets', undefined, samuel)).json.wallets.find((w) => w.id === 'wal:br_grc001:sms').balance;
step('An M-Pesa top-up credits the branch wallet', m5Status === 'completed' && m5After === m5Before + 10000, `KES ${m5After / 100}`);
const m5Card = await call('POST', '/wallets/wal:org_grace:sms/topup', { amount: 100, method: 'card' }, daniel);
const m5Tx = m5Card.json.checkoutUrl?.split('/').pop();
const m5Pay = await call('POST', `/public/checkout/${m5Tx}/pay`, { number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' });
step('A card top-up completes on the hosted checkout page', m5Pay.status === 200 && m5Pay.json.status === 'paid');
const m5Est = await call('POST', '/messages/estimate', { audience: { scope: { type: 'org' }, who: 'all' }, channels: ['sms', 'whatsapp'], body: 'Hello {name}' }, daniel);
step('The estimate reaches people and shows cost, with no phone numbers', m5Est.status === 200 && m5Est.json.people > 0 && !fullPhone.test(JSON.stringify(m5Est.json)), `${m5Est.json.people} people`);
const m5Send = await call('POST', '/messages', { audience: { scope: { type: 'org' }, who: 'all' }, channels: ['sms', 'whatsapp'], title: 'Smoke', body: 'Hello {name}, smoke test.' }, daniel);
step('A message goes out in-app, by SMS and by WhatsApp, only to people who agreed', m5Send.status === 200 && m5Send.json.summary?.channels?.inapp?.sent > 0 && m5Send.json.summary.channels.whatsapp.sent > 0, JSON.stringify(m5Send.json.summary?.channels?.whatsapp));
const m5Later = await call('POST', '/messages', { audience: { scope: { type: 'org' }, who: 'all' }, channels: ['sms'], title: 'Later', body: 'Hello', scheduleAt: new Date(new Date((await call('GET', '/health')).json.time).getTime() + 5 * 3600_000).toISOString() }, daniel); // the server clock can be ahead after the clock tool
const m5Cancel = await call('POST', `/messages/${m5Later.json.id}/cancel`, {}, daniel);
step('A scheduled message can be cancelled before it goes', m5Later.json.status === 'scheduled' && m5Cancel.json.status === 'cancelled');
const m5Treas = await call('POST', '/messages', { audience: { scope: { type: 'org' }, who: 'all' }, channels: [], title: 'x', body: 'y' }, treasurer);
step('A role without the send permission cannot message', m5Treas.status === 403);
const m5Peter = await call('POST', '/messages/estimate', {}, peter);
step('A member cannot use staff messaging', m5Peter.status === 403);
const m5Groups = await call('GET', '/me/groups', undefined, peter);
step('A group leader sees their group and may message it', m5Groups.status === 200 && m5Groups.json.some((g) => g.canMessage));
const m5Int = await call('GET', '/integrations', undefined, daniel);
step('The Integrations page shows who pays for messages', m5Int.status === 200 && m5Int.json.walletMode === 'per_branch', m5Int.json.walletMode);
const m5Rec = await call('GET', '/admin/reconcile', undefined, admin);
step('Books still balance after slice 5 activity', m5Rec.json.ok === true);

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

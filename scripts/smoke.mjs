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

// 14. Slice 6: tariffs, verified email, sender approvals, children, adverts.
const janeTok = await login('0711000001');
const s6Tar = await call('GET', '/admin/tariffs', undefined, admin);
step('Platform admin sees the tariffs, with a default and a volume example', s6Tar.status === 200 && s6Tar.json.some((t) => t.isDefault) && s6Tar.json.some((t) => t.name === 'Volume bands'));
const s6Quote = await call('POST', '/admin/tariffs/quote', { bands: [{ upTo: 3500, price: 95 }, { upTo: 15000, price: 85 }, { upTo: null, price: 70 }], used: 3400, count: 200 }, admin);
step('The calculator prices across a band boundary (100 at 0.95 then 100 at 0.85)', s6Quote.json.total === 18000, 'KES ' + s6Quote.json.total / 100);
const s6NoTar = await call('GET', '/admin/tariffs', undefined, daniel);
step('A church cannot see or change tariffs', s6NoTar.status === 403);
const s6Prof = await call('GET', '/me/profile', undefined, daniel);
step('An owner who receives alerts has a confirmed email', s6Prof.json.emailRequired === true && s6Prof.json.emailVerified === true);
const s6Int = await call('PUT', '/integrations', { walletMode: 'per_branch', smsSenderId: 'GRACESMOKE' }, daniel);
const s6Req = await call('GET', '/admin/sender-requests?status=pending', undefined, admin);
const s6One = s6Req.json.find((r) => r.value === 'GRACESMOKE');
step('A new sender name becomes a request for the platform to approve', s6Int.status === 200 && !!s6One);
const s6Dec = await call('POST', `/admin/sender-requests/${s6One?.id}/decide`, { approve: true }, admin);
step('A platform admin approves it and it becomes active', s6Dec.json.status === 'approved' && (await call('GET', '/integrations', undefined, daniel)).json.smsSenderId === 'GRACESMOKE');
const s6Ads = await call('GET', '/me/adverts', undefined, janeTok);
step('A member sees the church adverts on the home slider', s6Ads.status === 200 && s6Ads.json.some((a) => a.title === 'Christmas Carols Night'), s6Ads.json.map((a) => a.title).join(', '));
const s6Img = await fetch(API + s6Ads.json[0].imageUrl + '?token=' + janeTok);
step('The advert artwork loads as an image', s6Img.status === 200 && (s6Img.headers.get('content-type') || '').startsWith('image/'));
const s6Pend = await call('GET', '/adverts', undefined, daniel);
const s6Bake = s6Pend.json.find((a) => a.title === 'Mothers Union Bake Sale');
step('An advert waiting for approval is hidden from members and approvable by someone else', s6Bake?.status === 'pending' && s6Bake.canApprove === true && !s6Ads.json.some((a) => a.title === s6Bake.title));
const s6Appr = await call('POST', `/adverts/${s6Bake.id}/decide`, { approve: true }, daniel);
step('Approving it puts it on the slider', s6Appr.json.status === 'approved' && (await call('GET', '/me/adverts', undefined, janeTok)).json.some((a) => a.title === s6Bake.title));
const s6Pay = await call('GET', '/public/ad/WED001');
step('A paid advert shows the advertiser what they owe', s6Pay.json.price === 500000 && s6Pay.json.purpose === 'AD-WED001');
const s6Down = await call('POST', `/admin/adverts/${s6Bake.id}/takedown`, { reason: 'Smoke test takedown' }, admin);
step('A platform admin can take an advert down at once', s6Down.json.status === 'taken_down' && !(await call('GET', '/me/adverts', undefined, janeTok)).json.some((a) => a.title === s6Bake.title));
const s6Rec = await call('GET', '/admin/reconcile', undefined, admin);
step('Books still balance after slice 6 activity', s6Rec.json.ok === true);

// 15. Slice 7: notice board, events and RSVP, group walls, joining groups.
const s7Notices = await call('GET', '/me/notices', undefined, janeTok);
step('A member sees the notice board, pinned first', s7Notices.status === 200 && s7Notices.json[0]?.pinned === true && s7Notices.json.some((n) => n.title === 'Harvest Sunday is coming'), s7Notices.json.map((n) => n.title).join(', '));
const s7Pub = await call('POST', '/notices', { title: 'Smoke notice', body: 'Published by the smoke test.', audience: { type: 'org' } }, daniel);
step('Staff publish a notice and members see it at once', s7Pub.status === 200 && (await call('GET', '/me/notices', undefined, janeTok)).json.some((n) => n.title === 'Smoke notice'));
const s7NoPub = await call('POST', '/notices', { title: 'Nope', body: 'x', audience: { type: 'org' } }, samuel);
step('A branch admin cannot publish to the whole church', s7NoPub.status === 403);
const s7Ev = (await call('GET', '/me/events', undefined, janeTok)).json.find((e) => e.title === 'Christmas Carols Night');
const s7Rsvp = await call('POST', `/me/events/${s7Ev?.id}/rsvp`, { response: 'going', guests: 2 }, janeTok);
step('A member replies Going with guests and the count follows', s7Rsvp.status === 200 && s7Rsvp.json.peopleComing === s7Ev.peopleComing + 3, `${s7Rsvp.json.peopleComing} coming`);
const s7Who = await call('GET', `/events/${s7Ev?.id}/rsvps`, undefined, daniel);
step('Staff see who is coming, without phone numbers', s7Who.status === 200 && s7Who.json.going.length >= 2 && !fullPhone.test(JSON.stringify(s7Who.json)));
const s7Wall = await call('GET', '/me/groups/grp_youth/wall', undefined, peter);
step('A group member reads the wall', s7Wall.status === 200 && s7Wall.json.posts.length > 0 && s7Wall.json.group.role === 'leader');
const s7Out = await call('GET', '/me/groups/grp_youth/wall', undefined, janeTok);
step('Someone outside the group cannot see the wall', s7Out.status === 404);
const s7Find = await call('GET', '/me/groups/discover', undefined, peter);
step('An open group can be found and a request sent', s7Find.status === 200 && s7Find.json.some((g) => g.id === 'grp_prayer') && (await call('POST', '/me/groups/grp_prayer/join-request', {}, peter)).json.status === 'pending');
const s7Req = await call('GET', '/me/groups/grp_prayer/requests', undefined, janeTok);
step('The group leader sees the request', s7Req.status === 200 && s7Req.json.some((r) => r.name === 'Peter Otieno'));
const s7Rec = await call('GET', '/admin/reconcile', undefined, admin);
step('Books still balance after slice 7 activity', s7Rec.json.ok === true);

// 16. Slice 8: resources, availability, bookings, approval and payment.
const s8Day = (() => { const d = new Date(Date.now() + 3 * 3600_000 + 9 * 86400_000); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const s8Res = await call('GET', '/me/resources', undefined, janeTok);
step('A member sees what the church lets them book', s8Res.status === 200 && ['Pastor Daniel', 'Main hall, Nairobi', 'Sound system'].every((n) => s8Res.json.some((r) => r.name === n)), s8Res.json.map((r) => r.name).join(', '));
const s8Av = await call('GET', `/me/resources/res_pastor/availability?date=${s8Day}`, undefined, janeTok);
step('Free times are listed inside the working hours', s8Av.status === 200 && s8Av.json.slots.length === 12, `${s8Av.json.slots?.length} slots`);
const s8Slot = s8Av.json.slots[3];
const s8Bk = await call('POST', '/me/bookings', { resourceIds: ['res_pastor'], startsAt: s8Slot.startsAt, endsAt: s8Slot.endsAt, title: 'Smoke visit', note: 'private note' }, janeTok);
step('A booking request goes to the pastor', s8Bk.status === 200 && s8Bk.json.status === 'requested');
const s8Dup = await call('POST', '/me/bookings', { resourceIds: ['res_pastor'], startsAt: s8Slot.startsAt, endsAt: s8Slot.endsAt, title: 'Same time' }, peter);
step('The same time cannot be booked twice once it is confirmed', (await call('POST', `/me/diary/${s8Bk.json.id}/decide`, { approve: true }, daniel)).json.status === 'confirmed' && (await call('POST', '/me/bookings', { resourceIds: ['res_pastor'], startsAt: s8Slot.startsAt, endsAt: s8Slot.endsAt, title: 'Same time' }, peter)).status === 409);
const s8Cal = await call('GET', '/calendar', undefined, daniel);
step('Confirmed bookings and events share one staff calendar', s8Cal.status === 200 && s8Cal.json.some((c) => c.type === 'booking' && c.title === 'Smoke visit') && s8Cal.json.some((c) => c.type === 'event'));
const s8Hall = await call('GET', `/me/resources/res_hall/availability?date=${s8Day}&minutes=120`, undefined, peter);
const s8H = s8Hall.json.slots[4];
const s8HB = await call('POST', '/me/bookings', { resourceIds: ['res_hall'], startsAt: s8H.startsAt, endsAt: s8H.endsAt, title: 'Smoke hall', attendees: 40 }, peter);
const s8HA = await call('POST', `/bookings/${s8HB.json.id}/items/res_hall/decide`, { approve: true }, samuel);
step('A priced booking is approved and then waits for payment', s8HB.json.price === 300000 && s8HA.json.status === 'awaiting_payment');
const s8Code = (await call('GET', '/me/bookings', undefined, peter)).json.find((b) => b.id === s8HB.json.id).code;
const s8Pay = await call('POST', '/public/give', { code: 'GRC001', phone: '0712000333', amount: 3000, purpose: 'BK-' + s8Code, method: 'mpesa' });
let s8St = '';
for (let i = 0; i < 30 && s8St !== 'confirmed'; i++) { await sleep(300); s8St = (await call('GET', '/me/bookings', undefined, peter)).json.find((b) => b.id === s8HB.json.id).status; }
step('Paying through the giving flow confirms the booking', s8Pay.status === 200 && s8St === 'confirmed');
const s8Rec = await call('GET', '/admin/reconcile', undefined, admin);
step('Books still balance after slice 8 activity', s8Rec.json.ok === true);

// 17. Slice 10: the church shop, stock and the till.
const esther = await login('0700000002');
const s10Items = await call('GET', '/shop/items', undefined, esther);
const s10Candles = s10Items.json.find((i) => i.name === 'Candles, pack of 12');
step('A cashier sees the shop items and stock, without cost prices', s10Items.status === 200 && s10Items.json.length >= 7 && s10Candles.cost === null, s10Items.json.length + ' items');
const s10Sale = await call('POST', '/shop/sales', { branchId: 'br_grc001', method: 'cash', lines: [{ itemId: s10Candles.id, qty: 2 }], buyerName: 'Smoke buyer' }, esther);
const s10After = (await call('GET', '/shop/items', undefined, esther)).json.find((i) => i.id === s10Candles.id);
step('A cash sale completes at once and takes the stock', s10Sale.status === 200 && s10Sale.json.status === 'completed' && s10After.stock === s10Candles.stock - 2, s10Sale.json.receiptNo);
const s10Tshirt = s10Items.json.find((i) => i.name === 'Church T-shirt');
step('An item that is out of stock cannot be sold', (await call('POST', '/shop/sales', { branchId: 'br_grc001', method: 'cash', lines: [{ itemId: s10Tshirt.id, qty: 1 }] }, esther)).status === 409);
step('A cashier cannot void a sale, a manager can and the stock returns', (await call('POST', `/shop/sales/${s10Sale.json.id}/void`, { reason: 'Smoke test' }, esther)).status === 404 && (await call('POST', `/shop/sales/${s10Sale.json.id}/void`, { reason: 'Smoke test' }, samuel)).json.status === 'voided' && (await call('GET', '/shop/items', undefined, esther)).json.find((i) => i.id === s10Candles.id).stock === s10Candles.stock);
const s10Till = await call('GET', '/shop/till?branch=br_grc001', undefined, esther);
const s10Close = await call('POST', '/shop/till', { branchId: 'br_grc001', counted: s10Till.json.expected / 100 }, esther);
step('Closing the till sends the count for a second person to sign off', s10Close.status === 200 && s10Close.json.variance === 0);
const s10Rep = await call('GET', '/shop/reports', undefined, daniel);
step('The shop report shows takings, low stock and margin to a manager', s10Rep.status === 200 && s10Rep.json.totals.revenue > 0 && s10Rep.json.lowStock.length >= 2 && typeof s10Rep.json.totals.margin === 'number');
const s10Rec = await call('GET', '/admin/reconcile', undefined, admin);
step('Books still balance after slice 10 activity', s10Rec.json.ok === true);

// 18. Slice 11: buying from the shop in the member app, and adverts that lead to it.
const s11Cat = await call('GET', '/me/shop', undefined, janeTok);
const s11Rosary = s11Cat.json.items?.find((i) => i.name === 'Rosary, wooden');
step('A member sees the church shop with pictures and prices', s11Cat.status === 200 && s11Cat.json.items.length >= 6 && !!s11Rosary.imageUrl, s11Cat.json.items.length + ' items');
const s11Ads = await call('GET', '/me/adverts', undefined, janeTok);
const s11Buy = s11Ads.json.find((a) => a.title === 'Get your own Bible');
const s11Go = s11Ads.json.find((a) => a.title === 'Rosary week');
step('Adverts can lead to an item or straight to checkout', s11Buy?.action?.kind === 'item' && s11Go?.action?.kind === 'checkout' && s11Go.action.item.available === true);
const s11Order = await call('POST', '/me/shop/orders', { branchId: 'br_grc001', method: 'mpesa', lines: [{ itemId: s11Rosary.id, qty: 1 }], advertId: s11Go.id }, janeTok);
let s11State = '';
for (let i = 0; i < 30 && s11State !== 'to_prepare'; i++) { await sleep(300); s11State = (await call('GET', '/me/shop/orders', undefined, janeTok)).json.find((o) => o.id === s11Order.json.id)?.state; }
const s11Mine = (await call('GET', '/me/shop/orders', undefined, janeTok)).json.find((o) => o.id === s11Order.json.id);
step('An app order is paid by mobile money and the member gets a collection code', s11Order.status === 200 && s11State === 'to_prepare' && /^[A-F0-9]{6}$/.test(s11Mine.collectionCode), s11Mine?.collectionCode);
const s11Staff = await call('GET', '/shop/orders', undefined, esther);
step('The branch sees the order to prepare, and marks it ready and collected', s11Staff.json.some((o) => o.id === s11Order.json.id) && (await call('POST', `/shop/orders/${s11Order.json.id}/ready`, {}, esther)).json.state === 'ready' && (await call('POST', `/shop/orders/${s11Order.json.id}/collected`, { code: s11Mine.collectionCode }, esther)).json.state === 'collected');
const s11AdStats = (await call('GET', '/adverts', undefined, daniel)).json.find((a) => a.id === s11Go.id);
step('The advert shows the order it brought', s11AdStats.stats.orders === 1 && s11AdStats.stats.orderTotal === 25000);
const s11Rec = await call('GET', '/admin/reconcile', undefined, admin);
step('Books still balance after slice 11 activity', s11Rec.json.ok === true);

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

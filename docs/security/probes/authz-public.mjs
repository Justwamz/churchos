// PUBLIC ENDPOINT PROBES: what each unauthenticated route returns, whether it leaks personal data or internal ids, whether valid and invalid
// identifiers can be told apart, and how guessable the identifiers are.
//   node docs/security/probes/authz-public.mjs        (local stack, demo data)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginAll, req, recorder, rid, iso, DAY, BASE } from './_lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { rows, check, info } = recorder();
const T = await loginAll(['owner', 'jane', 'hope', 'pastor', 'treas']);
const tag = rid();
const PII = /(\b2547\d{8}\b|\b07\d{8}\b|@[a-z0-9-]+\.[a-z]{2,}|\bu_[a-z0-9]+\b|\bm_[a-z0-9]+\b)/i;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dump = (j) => JSON.stringify(j);

// --- fixtures: a paid guest order, a credit code, a statement number, a booking, a service, a record ---
const ev = await req(T.owner, 'POST', '/events', { title: `Public probe ${tag}`, audience: { type: 'org' }, startsAt: iso(20 * DAY) });
const tk = await req(T.owner, 'PUT', `/events/${ev.j.id}/ticketing`, { ticketed: true, refundDaysBefore: 3, types: [{ name: 'Seat', price: 200, quantity: 10 }] });
const pubEv = (await req(null, 'GET', `/public/event/${tk.j.code}`)).j;
const order = await req(null, 'POST', '/public/tickets/orders', { code: tk.j.code, name: `Public Probe ${tag}`, email: `public.probe.${tag}@acme.co.ke`, phone: '0711000096', method: 'mpesa', lines: [{ typeId: pubEv.types[0].id, qty: 1 }] });
for (let i = 0; i < 12; i++) { await wait(1000); const s = await req(null, 'GET', `/public/tickets/orders/${order.j.secret}`); if (s.j.status === 'paid') break; }
const paidOrder = (await req(null, 'GET', `/public/tickets/orders/${order.j.secret}`)).j;
const ticketToken = paidOrder.tickets?.[0]?.token;
const stm = (await req(T.jane, 'GET', '/me/statements')).j.issued?.[0];
const svc = (await req(T.owner, 'GET', '/attendance/services')).j.services?.[0];

// ============ P1. the ticket page hands out the order secret ============
{
  const page = await req(null, 'GET', `/public/tickets/${ticketToken}`);
  const secret = page.j?.order?.secret;
  info('P01', 'GET /public/tickets/:token (the QR link) returns the whole order secret', `secret returned=${!!secret}`);
  const viaSecret = await req(null, 'GET', `/public/tickets/orders/${secret}`);
  info('P01b', 'The order page behind the secret lists every ticket of the order with its own token, and offers refund and credit', `ticket link -> order secret -> /public/tickets/orders/:secret = ${viaSecret.s}; lists ${viaSecret.j?.tickets?.length} ticket(s)`);
  // a friend with the ticket link can turn the order into credit and read the credit code
  const cr = await req(null, 'POST', `/public/tickets/orders/${secret}/credit`);
  if (cr.s === 200 && cr.j?.code) check('P01c', 'A ticket-link holder cannot convert the buyer\'s order into credit and read the credit code', false, `ticket link -> secret -> POST credit = 200, credit code ${cr.j.code.replace(/.(?=.{4})/g, '*')} returned to the link holder`);
  else check('P01c', 'A ticket-link holder cannot convert the buyer\'s order into credit', true, `${cr.s}`);
  global.creditCode = cr.j?.code;
}

// ============ P2. credit code ============
{
  const code = global.creditCode;
  if (code) {
    const ok = await req(null, 'GET', `/public/credit/${code}`);
    const bad = await req(null, 'GET', `/public/credit/${code.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))}`);
    info('P02', 'Credit code lookup: valid vs invalid is distinguishable (200 with balance + church name vs 404). 16 hex = 64 bits', `valid=${ok.s} ${dump(ok.j)}, invalid=${bad.s}`);
  }
}

// ============ P3. statement number ============
{
  const n = stm?.number;
  const ok = await req(null, 'GET', `/public/statement/${n}`);
  const bad = await req(null, 'GET', `/public/statement/GS-2026-FFFFFF`);
  info('P03', 'Statement verify: valid vs invalid is distinguishable and a valid number discloses church, year, TOTAL GIVEN and member initials', `valid=${dump(ok.j).slice(0, 220)} invalid=${dump(bad.j)}`);
  const t0 = Date.now(); let hits = 0; const N = 300;
  const res = await Promise.all(Array.from({ length: N }, (_, i) => req(null, 'GET', `/public/statement/GS-2026-${(0xA00000 + i).toString(16).toUpperCase()}`)));
  const ms = Date.now() - t0; const limited = res.filter((r) => r.s === 429).length; hits = res.filter((r) => r.j?.valid).length;
  const rate = Math.round((N / ms) * 1000);
  const issued = 2; // statements outstanding is small in the demo; a real church issues hundreds to thousands each January
  info('P03b', 'Brute force: statement numbers are GS-<year>-<6 hex> = 24 bits (16.7M per year), no rate limit', `${N} requests in ${ms} ms (${rate}/s), ${limited} rate-limited, ${hits} hits. With 1,000 statements issued one valid number is expected every ~${Math.round(16_777_216 / 1000).toLocaleString()} guesses (~${Math.round(16_777_216 / 1000 / rate)} s at this rate); the full space is ~${Math.round(16_777_216 / rate / 3600)} h`);
  check('P03c', 'The public statement check is rate limited (429 after a burst)', limited > 0, `${limited} of ${N} limited`);
}

// ============ P4. church code enumeration ============
{
  const seen = [];
  const codes = [];
  for (const p of ['GRC', 'HPC', 'NHF', 'ABC', 'CCC', 'DLC', 'RCC', 'KAG']) for (let i = 1; i <= 3; i++) codes.push(`${p}${String(i).padStart(3, '0')}`);
  const res = await Promise.all(codes.map((c) => req(null, 'GET', `/public/church/${c}`)));
  res.forEach((r, i) => { if (r.s === 200) seen.push(`${codes[i]}:${r.j.organisation}/${r.j.name}${(r.j.projects ?? []).length ? ` (+${r.j.projects.length} projects with raised totals)` : ''}`); });
  info('P04', 'Branch codes are short and sequential: /public/church/:code answers 200 with names, branding and open projects with their raised totals; unknown codes 404', `${codes.length} guesses found ${seen.length}: ${seen.join(' | ')}`);
  // hiding from the name search does not hide the code
  const before = (await req(null, 'GET', '/public/churches/search?q=Hope%20Chapel')).j.churches.length;
  await req(T.hope, 'PUT', '/church/directory', { listed: false });
  const hidden = (await req(null, 'GET', '/public/churches/search?q=Hope%20Chapel')).j.churches.length;
  const byCode = (await req(null, 'GET', '/public/churches/search?q=HPC001')).j.churches.length;
  const direct = await req(null, 'GET', '/public/church/HPC001');
  await req(T.hope, 'PUT', '/church/directory', { listed: true });
  info('P04b', 'A church hidden from the name search is still found by its (guessable) code', `name search before=${before} after hiding=${hidden}; search by exact code=${byCode}; /public/church/HPC001=${direct.s}`);
  const many = await Promise.all(Array.from({ length: 60 }, () => req(null, 'GET', '/public/churches/search?q=Grace')));
  info('P04c', 'Church search is rate limited per IP', `${many.filter((r) => r.s === 429).length} of 60 got 429 (limit is keyed on req.ip; behind a reverse proxy without TRUST_PROXY=1 every visitor shares one bucket)`);
}

// ============ P5. event, order, ticket ============
{
  const pg = await req(null, 'GET', `/public/event/${tk.j.code}`);
  info('P05', 'Event page fields', Object.keys(pg.j).join(','));
  check('P05b', 'Event page carries no personal data or internal ids', !PII.test(dump(pg.j)), (dump(pg.j).match(PII) ?? [''])[0]);
  const od = await req(null, 'GET', `/public/tickets/orders/${order.j.secret}`);
  const odKeys = Object.keys(od.j);
  check('P05c', 'Order page (secret) does not return buyer email or phone', !PII.test(dump(od.j).replace(/"id":"(tko|tk|tkt)_[a-z0-9-]+"/g, '')), odKeys.join(','));
  const notFound = await req(null, 'GET', '/public/tickets/orders/' + 'a'.repeat(32));
  check('P05d', 'Unknown order secret and unknown ticket token answer the same 404', notFound.s === 404 && (await req(null, 'GET', '/public/tickets/' + 'b'.repeat(32))).s === 404);
  info('P05e', 'Ticketed event codes are 6 hex (24 bits) and the order short code is shown to buyers; the order SECRET is 32 hex (128 bits)', `event code=${tk.j.code} secret length=${order.j.secret.length} ticket token length=${ticketToken?.length}`);
}

// ============ P6. record verification ============
{
  const rec = (await req(T.owner, 'GET', '/records')).j.find((r) => r.serial);
  const noKey = await req(null, 'GET', `/public/verify/${rec?.serial}`);
  const wrong = await req(null, 'GET', `/public/verify/${rec?.serial}?k=AAAAAAAAAAA`);
  check('P06', 'Certificate verification needs the key printed on the card (serial alone returns nothing)', noKey.s === 404 && wrong.s === 404, `serial=${rec?.serial} no key=${noKey.s} wrong key=${wrong.s}`);
  const cert = await req(null, 'GET', `/public/cert/${rec?.serial}`);
  info('P06b', 'GET /public/cert/:serial answers only while a copy awaits payment (sequential serials such as GRC001-BAP-2026-0001)', `${cert.s}`);
}

// ============ P7. live link, door code, invite ============
{
  const live = await req(null, 'GET', `/public/live/${svc.code}`);
  info('P07', 'GET /public/live/:code needs only the 6-char service code (or b-<BRANCHCODE>) and returns church, service name, times', `${live.s} ${Object.keys(live.j ?? {}).join(',')}`);
  const withBranch = await req(null, 'GET', '/public/live/b-GRC001');
  info('P07b', 'GET /public/live/b-GRC001 resolves from the guessable branch code', `${withBranch.s} ${withBranch.j?.error ?? ''}`);
  const post = await req(null, 'POST', `/public/live/${svc.code}`, { name: 'Probe Visitor', phone: '0711000095' });
  info('P07c', 'POST /public/live/:code returns the stream URL to anyone who types any name and a phone number (and files a visitor record)', `${post.s} ${post.j?.error ?? (post.j?.url ? 'url returned' : '')}`);
  const door = await req(T.owner, 'GET', `/attendance/services/${svc.id}/door`);
  const token = door.j?.url?.split('/here/')[1];
  const tampered = await req(null, 'GET', `/public/here/${token?.slice(0, -2)}xx`);
  const okDoor = await req(null, 'GET', `/public/here/${token}`);
  check('P07d', 'Door code is signed: a tampered code is rejected', tampered.s === 404, `valid=${okDoor.s} tampered=${tampered.s}`);
  check('P07e', 'Door-code page returns no personal data', !PII.test(dump(okDoor.j)));
}

// ============ P8. advert / booking payment pages, branding, help ============
{
  const ad = await req(null, 'GET', '/public/ad/ZZZZZZ');
  const bk = await req(null, 'GET', '/public/booking/ZZZZZZ');
  info('P08', 'Advert and booking payment pages are keyed by 6 hex (24 bits) codes and show title, price, times, advertiser name for items awaiting payment', `ad=${ad.s} booking=${bk.s}`);
  const b = await req(null, 'GET', '/public/branding/org_grace');
  check('P08b', 'Branding is public by design and exposes only colours and a logo flag', !PII.test(dump(b.j)), dump(b.j).slice(0, 120));
  const guessable = await req(null, 'GET', '/public/branding/org_hope');
  info('P08c', 'Organisation ids are readable (org_grace, org_hope, org_newhope), so /public/branding/:orgId confirms which churches exist', `${guessable.s}`);
  const help = await req(null, 'GET', '/help/articles?audience=admin,staff');
  check('P08d', 'Anonymous visitors cannot read staff/admin help articles', Array.isArray(help.j) && help.j.length === 0, `${Array.isArray(help.j) ? help.j.length : help.s} articles`);
  const h = await req(null, 'GET', '/health');
  info('P08e', 'Health endpoint discloses server time and the development clock offset', dump(h.j));
}

// ============ P9. giving ============
{
  const fee = await req(null, 'GET', '/public/fee?code=GRC001&amount=1000&method=mpesa');
  info('P09', '/public/fee', dump(fee.j));
  const gv = await req(null, 'POST', '/public/give', { code: 'GRC001', amount: 20, method: 'mpesa', phone: '0711000094', purpose: 'OFFERING' });
  const st = await req(null, 'GET', `/public/give/${gv.j?.intentId}`);
  info('P09b', 'Anyone can start a gift (and an STK prompt) to ANY phone number with no proof of ownership; the receipt page shows status, church, purpose and amount to whoever has the intent id (int_ + 12 hex)', `${gv.s} ${dump(st.j)}`);
  const noRate = await Promise.all(Array.from({ length: 25 }, () => req(null, 'POST', '/public/give', { code: 'GRC001', amount: 20, method: 'mpesa', phone: '0711000094', purpose: 'OFFERING' })));
  check('P09c', 'Starting gifts to one phone number is rate limited (prompt spam)', noRate.some((r) => r.s === 429), `${noRate.filter((r) => r.s === 200).length} of 25 prompts accepted for the same number`);
}

// ============ P10. rate limiting overall ============
{
  const burst = await Promise.all(Array.from({ length: 200 }, () => req(null, 'GET', '/public/church/GRC001')));
  check('P10', 'Public endpoints answer a 200-request burst without any throttling', burst.some((r) => r.s === 429), `${burst.filter((r) => r.s === 429).length} x 429 of 200`);
}

const summary = { base: BASE, run: new Date().toISOString(), pass: rows.filter((r) => r.pass === true).length, fail: rows.filter((r) => r.pass === false).length, info: rows.filter((r) => r.pass === null).length };
console.log('\nSUMMARY', JSON.stringify(summary));
fs.writeFileSync(path.join(here, 'authz-public.results.json'), JSON.stringify({ summary, rows }, null, 1));

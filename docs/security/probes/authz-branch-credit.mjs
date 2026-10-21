// BRANCH SCOPE on event-credit refunds: does a staff member who manages events at ONE branch see and decide refund requests of ANOTHER branch's members?
//   node docs/security/probes/authz-branch-credit.mjs   (changes demo data: Amina (Mombasa member) buys a KES 300 ticket, turns it into credit and asks KES 150 back)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginAll, req, recorder, rid, iso, DAY } from './_lib.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const { rows, check, info } = recorder();
const T = await loginAll(['owner', 'amina', 'pastor', 'admin', 'fatuma']);
const tag = rid();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = await req(T.owner, 'POST', '/events', { title: `Branch credit probe ${tag}`, audience: { type: 'org' }, startsAt: iso(20 * DAY) });
const tk = await req(T.owner, 'PUT', `/events/${ev.j.id}/ticketing`, { ticketed: true, refundDaysBefore: 3, types: [{ name: 'Seat', price: 300, quantity: 5 }] });
const pub = (await req(null, 'GET', `/public/event/${tk.j.code}`)).j;
const o = await req(T.amina, 'POST', '/me/tickets/orders', { eventId: ev.j.id, method: 'mpesa', phone: '0711000003', useCredit: false, lines: [{ typeId: pub.types[0].id, qty: 1 }] });
for (let i = 0; i < 12; i++) { await wait(1000); if ((await req(null, 'GET', `/public/tickets/orders/${o.j.secret}`)).j.status === 'paid') break; }
await req(T.amina, 'POST', `/me/tickets/orders/${o.j.id}/credit`);
const old = await req(T.amina, 'GET', '/me/credit/history');
for (const r of old.j.refunds ?? []) if (['pending'].includes(r.status)) await req(T.amina, 'POST', `/me/credit/refund-request/${r.id}/cancel`);
const rq = await req(T.amina, 'POST', '/me/credit/refund-request', { amount: 150, reason: 'probe ' + tag, phone: '0711000003' });
info('BC00', 'Amina (Grace MOMBASA member) asked for KES 150 of event credit back', `${rq.s} ${rq.j?.status ?? rq.j?.code}`);
const list = await req(T.pastor, 'GET', '/credit/refunds');
let refundId = rq.j?.id;
if (!refundId) refundId = (list.j.refunds ?? []).find((r) => r.member === 'Amina Hassan' && r.status === 'pending')?.id; // an earlier run's open request
if (!refundId) { info('BC00b', 'no pending Amina refund request to test with (an earlier one may be approved); rerun after it is paid or declined'); process.exit(0); }
const seen = (list.j.refunds ?? []).find((r) => r.id === refundId);
check('BC01', "Staff who manage events at Nairobi only must not see a Mombasa member's credit refund request (name, phone)", !seen, seen ? `Pastor Mary (events.manage at Grace Nairobi only) sees: ${seen.member}, phone ${seen.phone}` : 'not visible');
const sum = await req(T.pastor, 'GET', '/credit/summary');
info('BC02', 'Credit summary for a Nairobi-only manager covers the whole church', JSON.stringify(sum.j).slice(0, 160));
const dec = await req(T.admin, 'POST', `/credit/refunds/${refundId}/decide`, { approve: false, note: 'probe: wrong branch' });
check('BC03', "A Nairobi branch admin must not be able to decide a Mombasa member's credit refund", dec.s === 403 || dec.s === 404, `decide as Nairobi branch admin -> ${dec.s} ${dec.j?.status ?? dec.j?.code}`);
const summary = { run: new Date().toISOString(), pass: rows.filter((r) => r.pass === true).length, fail: rows.filter((r) => r.pass === false).length };
console.log('\nSUMMARY', JSON.stringify(summary));
fs.writeFileSync(path.join(here, 'authz-branch-credit.results.json'), JSON.stringify({ summary, rows }, null, 1));

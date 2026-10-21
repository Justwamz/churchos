// SEPARATION OF DUTIES on money that leaves the church: can a staff member who is ALSO a member request a refund and approve/pay it herself?
//   node docs/security/probes/authz-selfdecide.mjs   (changes demo data: Pastor Mary becomes a member of GRC001, buys a KES 300 ticket, turns it into credit, asks for it back)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginAll, req, recorder, rid, iso, DAY } from './_lib.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const { rows, check, info } = recorder();
const T = await loginAll(['owner', 'pastor']);
const tag = rid();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const paid = async (secret) => { for (let i = 0; i < 12; i++) { await wait(1000); const s = await req(null, 'GET', `/public/tickets/orders/${secret}`); if (s.j.status === 'paid') return true; } return false; };

const link = await req(T.pastor, 'POST', '/me/link/instant', { code: 'GRC001' });
info('S00', 'Pastor Mary (staff, events.manage) links herself to the church as a member', `${link.s} ${link.j?.code ?? 'ok'}`);

async function paidOrder(refundDays, who = T.pastor, phone = '0700000009') {
  const ev = await req(T.owner, 'POST', '/events', { title: `Probe self ${tag}`, audience: { type: 'org' }, startsAt: iso(20 * DAY) });
  const tk = await req(T.owner, 'PUT', `/events/${ev.j.id}/ticketing`, { ticketed: true, refundDaysBefore: refundDays, types: [{ name: 'Seat', price: 300, quantity: 5 }] });
  const pub = (await req(null, 'GET', `/public/event/${tk.j.code}`)).j;
  const o = await req(who, 'POST', '/me/tickets/orders', { eventId: ev.j.id, method: 'mpesa', phone, useCredit: false, lines: [{ typeId: pub.types[0].id, qty: 1 }] });
  await paid(o.j.secret);
  return { ev: ev.j.id, order: o.j };
}

// 1. event credit refund
{
  const { order } = await paidOrder(30);
  const cr = await req(T.pastor, 'POST', `/me/tickets/orders/${order.id}/credit`);
  const rq = await req(T.pastor, 'POST', '/me/credit/refund-request', { amount: 150, reason: 'probe self refund ' + tag, phone: '0700000009' });
  info('S01', 'Pastor turned her ticket into credit and asked for KES 150 back', `credit ${cr.s}, request ${rq.s} ${rq.j?.code ?? rq.j?.status}`);
  if (rq.j?.id) {
    const d = await req(T.pastor, 'POST', `/credit/refunds/${rq.j.id}/decide`, { approve: true, note: 'self' });
    check('S02', 'The person who asked for a credit refund cannot approve it herself', d.s === 403, `decide as the requester -> ${d.s} ${d.j?.code ?? d.j?.status}`);
    const p = await req(T.pastor, 'POST', `/credit/refunds/${rq.j.id}/paid`, { reference: 'SELFPAID' + tag });
    check('S03', 'The person who asked for a credit refund cannot record it as paid herself', p.s === 403 || p.s === 409, `paid as the requester -> ${p.s} ${p.j?.code ?? p.j?.status}`);
    if (d.s !== 200) await req(T.owner, 'POST', `/credit/refunds/${rq.j.id}/decide`, { approve: false, note: 'probe cleanup' });
  }
}
// 2. ticket refund request
{
  await req(T.owner, 'POST', '/me/link/instant', { code: 'GRC001' });
  const { ev, order } = await paidOrder(7, T.owner, '0700000001');
  const rr = await req(T.owner, 'POST', `/me/tickets/orders/${order.id}/refund-request`, { reason: 'probe self refund ' + tag });
  info('S04', 'Owner Daniel (whole-church events.manage, also a member) asked for a refund of his own ticket order', `${rr.s} ${JSON.stringify(rr.j).slice(0, 80)}`);
  if (rr.j?.id) {
    const d = await req(T.owner, 'POST', `/refund-requests/${rr.j.id}/decide`, { approve: true, note: 'self' });
    check('S05', 'The buyer cannot approve her own ticket refund request', d.s === 403, `decide as the buyer -> ${d.s} ${d.j?.code ?? d.j?.status}`);
    if (d.s !== 200) await req(T.owner, 'POST', `/refund-requests/${rr.j.id}/decide`, { approve: false, note: 'probe cleanup' });
  }
}
const summary = { run: new Date().toISOString(), pass: rows.filter((r) => r.pass === true).length, fail: rows.filter((r) => r.pass === false).length };
console.log('\nSUMMARY', JSON.stringify(summary));
fs.writeFileSync(path.join(here, 'authz-selfdecide.results.json'), JSON.stringify({ summary, rows }, null, 1));

// Creates (or harvests) objects in each demo tenant so the matrix has real ids to attack.
// bag[kind] = [{ id, org, branch, owner, note }]. Every create is best-effort and recorded in `log`.
import { req, rid, iso, DAY } from './_lib.mjs';

export async function buildFixtures(T) {
  const bag = {};
  const log = [];
  const BN = { 'Grace Nairobi': 'br_grc001', 'Grace Mombasa': 'br_grc002', GRC001: 'br_grc001', GRC002: 'br_grc002' };
  const add = (kind, id, org, branch, owner, extra = {}) => { if (!id) return; branch = BN[branch] ?? branch; (bag[kind] ??= []).push({ ...extra, id: String(id), org, branch: branch ?? null, owner: owner ?? null }); };
  const step = async (name, fn) => { try { const r = await fn(); log.push(`${name}: ok`); return r; } catch (e) { log.push(`${name}: FAILED ${e?.message ?? e}`); } };
  const arr = (j, key) => (Array.isArray(j) ? j : j?.[key] ?? []);
  const G = 'org_grace', NBO = 'br_grc001', MBA = 'br_grc002', H = 'org_hope', HB = 'br_hpc001', NH = 'org_newhope', NHB = 'br_nhf001';
  const tag = rid();

  // ---- harvest seeded Grace data (owner sees both branches) ----
  await step('harvest grace lists', async () => {
    const o = T.owner;
    const take = async (kind, path, key, f = (x) => x) => { const r = await req(o, 'GET', path); for (const x of arr(r.j, key)) { const v = f(x); if (v) add(kind, v.id, G, v.branchId ?? v.branch_id ?? null, v.owner ?? null, v); } };
    await take('advert', '/adverts', 'adverts');
    await take('schedule', '/attendance/schedules', 'schedules');
    await take('service', '/attendance/services', 'services');
    await take('visitor', '/attendance/visitors', 'visitors', (x) => ({ ...x, branchId: NBO }));
    await take('resource', '/resources', 'x');
    await take('notice', '/notices', 'x');
    await take('event', '/events', 'x');
    await take('expcat', '/expenses/setup', 'categories', (x) => x);
    await take('expense', '/expenses', 'expenses');
    await take('member', '/members', 'x');
    await take('household', '/members/grouped', 'households', (x) => ({ ...x, branchId: NBO }));
    await take('kclass', '/kids/classes', 'classes');
    await take('message', '/messages', 'x', (x) => ({ ...x, branchId: null }));
    await take('group', '/groups', 'x');
    await take('prayer', '/prayer', 'requests');
    await take('record', '/records', 'x');
    await take('item', '/shop/items', 'x');
    await take('sale', '/shop/sales', 'x');
    await take('project', '/projects', 'x');
    await take('suggestion', '/suggestions', 'suggestions');
    await take('wallet', '/wallets', 'wallets');
    await take('auditevent', '/audit/events', 'events', (x) => ({ ...x, branchId: x.branch_id }));
    await take('collection', '/collections', 'rows');
    const st = await req(o, 'GET', '/settlements');
    for (const b of st.j.balances ?? []) add('branch', b.id, G, b.id, null);
    const col = await req(o, 'GET', '/collections');
    for (const p of col.j.rows ?? []) add('payment', p.id, G, p.branch === 'GRC002' ? MBA : NBO, null);
  });

  // ---- expense categories, then an expense in each branch ----
  const cat = bag.expcat?.[0]?.id;
  await step('treasurer expense nairobi', async () => {
    const r = await req(T.treas, 'POST', '/expenses', { branchId: NBO, date: iso(0).slice(0, 10), amount: 500, categoryId: cat, payee: `Probe Stores ${tag}`, method: 'mpesa', reference: 'PRB' + tag });
    add('expense', r.j.id, G, NBO, 'treas', { fixture: true });
  });
  await step('fatuma expense mombasa', async () => {
    const r = await req(T.fatuma, 'POST', '/expenses', { branchId: MBA, date: iso(0).slice(0, 10), amount: 700, categoryId: cat, payee: `Probe Mombasa ${tag}`, method: 'mpesa', reference: 'PRM' + tag });
    add('expense', r.j.id, G, MBA, 'fatuma', { fixture: true });
  });
  await step('vera claim', async () => {
    const r = await req(T.vera, 'POST', '/me/claims', { branchId: NBO, date: iso(0).slice(0, 10), amount: 800, categoryId: cat, payee: 'Probe bus fare', note: 'probe' });
    add('expense', r.j.id, G, NBO, 'vera', { fixture: true, claim: true });
  });

  // ---- events, ticketing, orders (Grace Nairobi org-wide, Grace Mombasa branch, Hope) ----
  async function eventWithOrder(owner, orgId, branchId, audience, ownerKey, free = true) {
    const ev = await req(owner, 'POST', '/events', { title: `Probe ${tag} ${orgId}`, audience, startsAt: iso(20 * DAY), rsvp: false });
    if (!ev.j.id) throw new Error('event ' + JSON.stringify(ev.j));
    add('event', ev.j.id, orgId, branchId, ownerKey, { fixture: true });
    const tk = await req(owner, 'PUT', `/events/${ev.j.id}/ticketing`, { ticketed: true, types: [{ name: 'Probe', price: free ? 0 : 1000, quantity: 50 }] });
    const code = tk.j.code;
    const pub = await req(null, 'GET', `/public/event/${code}`);
    const typeId = pub.j.types?.[0]?.id ?? pub.j.ticketTypes?.[0]?.id;
    const order = await req(null, 'POST', '/public/tickets/orders', { code, name: `Probe Guest ${tag}`, email: `probe.${tag}@acme.co.ke`, phone: '0711000099', method: 'mpesa', lines: [{ typeId, qty: 1 }] });
    add('tkorder', order.j.id, orgId, branchId, 'guest', { secret: order.j.secret, eventId: ev.j.id, eventCode: code, ticketToken: order.j.tickets?.[0]?.token, ticketId: order.j.tickets?.[0]?.id });
    if (order.j.tickets?.[0]) add('ticket', order.j.tickets[0].id, orgId, branchId, 'guest', { token: order.j.tickets[0].token });
    return { eventId: ev.j.id, code, typeId, order: order.j };
  }
  const fx = {};
  fx.nbo = await step('event nairobi', () => eventWithOrder(T.owner, G, null, { type: 'org' }, 'owner'));
  fx.mba = await step('event mombasa', () => eventWithOrder(T.owner, G, MBA, { type: 'branch', id: MBA }, 'owner'));
  fx.hope = await step('event hope', () => eventWithOrder(T.hope, H, null, { type: 'org' }, 'hope'));

  // Jane's own seeded order and a paid one with credit possibility
  await step('jane tickets', async () => {
    const r = await req(T.jane, 'GET', '/me/tickets');
    for (const t of r.j.tickets ?? []) { add('tkorder', t.order.id, G, null, 'jane', { secret: t.order.secret }); add('ticket', t.id, G, null, 'jane', { token: t.token }); }
  });
  // Jane buys a paid ticket (the simulator pays at once) so she has an order that can become credit, then turns it into credit
  await step('jane paid order + credit', async () => {
    const e = fx.nbo;
    if (!e) return;
    const t = await req(null, 'GET', `/public/event/${e.code}`);
    // use a second ticketed event with a price
    const ev = await req(T.owner, 'POST', '/events', { title: `Probe paid ${tag}`, audience: { type: 'org' }, startsAt: iso(25 * DAY), rsvp: false });
    const tk = await req(T.owner, 'PUT', `/events/${ev.j.id}/ticketing`, { ticketed: true, refundDaysBefore: 3, types: [{ name: 'Paid', price: 20000, quantity: 20 }] });
    const pub = await req(null, 'GET', `/public/event/${tk.j.code}`);
    const typeId = pub.j.types?.[0]?.id;
    add('event', ev.j.id, G, null, 'owner', { fixture: true });
    const o = await req(T.jane, 'POST', '/me/tickets/orders', { eventId: ev.j.id, method: 'mpesa', phone: '0711000001', lines: [{ typeId, qty: 1 }] });
    add('tkorder', o.j.id, G, null, 'jane', { secret: o.j.secret, paid: true, eventId: ev.j.id });
    const o2 = await req(T.jane, 'POST', '/me/tickets/orders', { eventId: ev.j.id, method: 'mpesa', phone: '0711000001', lines: [{ typeId, qty: 1 }] });
    add('tkorder', o2.j.id, G, null, 'jane', { secret: o2.j.secret, credited: true, eventId: ev.j.id });
    for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 1000)); const st = await req(null, 'GET', `/public/tickets/orders/${o2.j.secret}`); if (st.j.status === 'paid') break; }
    const c = await req(T.jane, 'POST', `/me/tickets/orders/${o2.j.id}/credit`);
    log.push('jane credit: ' + c.s + ' ' + JSON.stringify(c.j).slice(0, 80));
  });
  await step('jane credit refund', async () => {
    const r = await req(T.jane, 'POST', '/me/credit/refund-request', { orgId: G, amount: 150, phone: '0711000001', reason: 'probe' });
    log.push('credit refund-request: ' + r.s + ' ' + JSON.stringify(r.j).slice(0, 100));
    const l = await req(T.owner, 'GET', '/credit/refunds');
    for (const x of l.j.refunds ?? []) add('crefund', x.id, G, null, 'jane', { status: x.status });
  });

  // ---- members ----
  await step('members', async () => {
    const m1 = await req(T.owner, 'POST', '/members', { branchId: NBO, consent: true, fullName: `Probe Nairobi ${tag}`, category: 'adult', phone: '07120' + String(Math.floor(10000 + Math.random() * 89999)), dob: '1990-05-05', sex: 'female' });
    add('member', m1.j.id, G, NBO, 'owner', { fixture: true });
    const m2 = await req(T.owner, 'POST', '/members', { branchId: MBA, consent: true, fullName: `Probe Mombasa ${tag}`, category: 'adult', phone: '07121' + String(Math.floor(10000 + Math.random() * 89999)), dob: '1991-06-06', sex: 'male' });
    add('member', m2.j.id, G, MBA, 'owner', { fixture: true });
    const h = await req(T.hope, 'POST', '/members', { branchId: HB, consent: true, fullName: `Probe Hope ${tag}`, category: 'adult', phone: '07122' + String(Math.floor(10000 + Math.random() * 89999)), dob: '1992-07-07', sex: 'female' });
    add('member', h.j.id, H, HB, 'hope', { fixture: true });
    const list = await req(T.hope, 'GET', '/members');
    for (const x of list.j ?? []) add('member', x.id, H, HB, 'hope');
  });

  // ---- other Hope objects ----
  await step('hope notice/group/project', async () => {
    const n = await req(T.hope, 'POST', '/notices', { title: 'Hope probe', body: 'Hope probe notice', audience: { type: 'org' } });
    add('notice', n.j.id, H, null, 'hope');
    const g = await req(T.hope, 'POST', '/groups', { name: `Hope group ${tag}`, branchId: HB });
    add('group', g.j.id, H, HB, 'hope');
    const p = await req(T.hope, 'POST', '/projects', { branchId: HB, code: 'HP' + tag.toUpperCase().slice(0, 4), name: 'Hope probe project', target: 1000 });
    add('project', p.j.id, H, HB, 'hope');
    const w = await req(T.hope, 'GET', '/wallets');
    for (const x of w.j.wallets ?? []) add('wallet', x.id, H, x.branchId, 'hope');
    const cat2 = await req(T.hope, 'GET', '/expenses/setup');
    const hc = cat2.j.categories?.[0]?.id;
    const ex = await req(T.hope, 'POST', '/expenses', { branchId: HB, date: iso(0).slice(0, 10), amount: 500, categoryId: hc, payee: 'Hope probe', method: 'mpesa', reference: 'HP' + tag });
    add('expense', ex.j.id, H, HB, 'hope', { fixture: true });
    const rs = await req(T.hope, 'GET', '/resources');
    for (const x of rs.j ?? []) add('resource', x.id, H, x.branchId, 'hope');
    const pr = await req(T.hope, 'GET', '/team');
    for (const p2 of pr.j.people ?? []) { add('user', p2.userId, H, null, null); for (const a of p2.assignments) add('assignment', a.id, H, null, null); }
    for (const rl of pr.j.roles ?? []) add('role', rl.id, H, null, null, { name: rl.name });
  });

  // ---- Grace team ----
  await step('grace team', async () => {
    const t = await req(T.owner, 'GET', '/team');
    for (const p of t.j.people ?? []) { add('user', p.userId, G, null, null); for (const a of p.assignments) add('assignment', a.id, G, a.scopeType === 'branch' ? a.scopeId : null, null, { user: p.userId, role: a.role }); }
    for (const rl of t.j.roles ?? []) add('role', rl.id, G, null, null, { name: rl.name, builtIn: rl.builtIn });
  });

  // ---- member private objects ----
  await step('jane private', async () => {
    const pr = await req(T.jane, 'POST', '/me/prayer', { body: `Private probe prayer ${tag}`, audience: 'team' });
    add('prayer', pr.j.id, G, NBO, 'jane', { fixture: true, private: true });
    const sg = await req(T.jane, 'POST', '/me/suggestions', { category: 'worship', body: `Anonymous probe suggestion ${tag} please read`, anonymous: true });
    add('suggestion', sg.j.id, G, NBO, 'jane', { fixture: true, anonymous: true });
    const st = await req(T.jane, 'POST', '/me/statements', { year: new Date().getUTCFullYear() });
    log.push('statement: ' + st.s + ' ' + JSON.stringify(st.j).slice(0, 100));
    const sl = await req(T.jane, 'GET', '/me/statements');
    for (const s of sl.j.issued ?? []) add('statement', s.id, G, NBO, 'jane', { number: s.number });
    const fam = await req(T.jane, 'GET', '/me/family');
    for (const f of fam.j.families ?? []) { add('guardian', f.membershipId, G, NBO, 'jane'); }
    const nt = await req(T.jane, 'GET', '/me/notifications');
    for (const n of nt.j.rows ?? []) add('notification', n.id, G, null, 'jane');
    const mine = await req(T.jane, 'GET', '/me/prayer');
    for (const p of mine.j.requests ?? []) add('prayer', p.id, G, NBO, 'jane');
    const sug = await req(T.jane, 'GET', '/me/suggestions');
    for (const s of sug.j.suggestions ?? []) add('suggestion', s.id, G, NBO, 'jane');
  });
  await step('amina+peter private', async () => {
    const pr = await req(T.amina, 'POST', '/me/prayer', { body: `Amina private probe prayer ${tag}`, audience: 'team' });
    add('prayer', pr.j.id, G, MBA, 'amina', { fixture: true, private: true });
    const st = await req(T.amina, 'POST', '/me/statements', { year: new Date().getUTCFullYear() });
    const sl = await req(T.amina, 'GET', '/me/statements');
    for (const s of sl.j.issued ?? []) add('statement', s.id, G, MBA, 'amina', { number: s.number });
    const m = await req(T.amina, 'GET', '/me/prayer');
    for (const p of m.j.requests ?? []) add('prayer', p.id, G, MBA, 'amina');
    const nt = await req(T.amina, 'GET', '/me/notifications');
    for (const n of nt.j.rows ?? []) add('notification', n.id, G, MBA, 'amina');
    const pp = await req(T.peter, 'POST', '/me/giving-plans', { membershipId: 'm_peter', amount: 1000, purpose: 'TITHE', frequency: 'weekly', weekday: 3, time: '10:00' });
    log.push('peter plan: ' + pp.s + ' ' + JSON.stringify(pp.j).slice(0, 100));
    const pl = await req(T.peter, 'GET', '/me/giving-plans');
    for (const p of pl.j.plans ?? []) add('plan', p.id, G, NBO, 'peter');
  });
  await step('jane booking', async () => {
    const mk = async (start) => req(T.jane, 'POST', '/me/bookings', { resourceIds: ['res_pastor'], startsAt: start, endsAt: new Date(Date.parse(start) + 30 * 60_000).toISOString(), title: 'Probe booking' });
    for (let d = 2; d < 12; d++) {
      const day = new Date(Date.now() + d * DAY); day.setUTCHours(7, 0, 0, 0);
      const b = await mk(day.toISOString());
      if (b.j?.id) { add('booking', b.j.id, G, null, 'jane', { fixture: true }); break; }
    }
    const l = await req(T.jane, 'GET', '/me/bookings');
    for (const b of l.j ?? []) add('booking', b.id, G, null, 'jane');
  });
  await step('claims', async () => {
    const l = await req(T.vera, 'GET', '/me/claims');
    for (const c of l.j.claims ?? []) add('expense', c.id, G, NBO, 'vera', { claim: true });
  });
  await step('newcomer join request', async () => {
    const r = await req(T.newcomer, 'POST', '/me/link/request', { code: 'GRC001', consent: true, message: 'probe' });
    log.push('join request: ' + r.s + ' ' + JSON.stringify(r.j).slice(0, 80));
    const s = await req(T.newcomer, 'GET', '/me/link/status');
    for (const q of s.j.requests ?? []) add('joinreq', q.id, G, NBO, 'newcomer');
  });
  await step('kids session + check-in', async () => {
    const cl = await req(T.lucy, 'GET', '/kids/classes');
    const ses = cl.j.classes?.[0]?.session?.id;
    add('ksession', ses, G, NBO, 'lucy', { fixture: true });
    const q = await req(T.jane, 'POST', '/me/family/qr', { membershipId: 'm_jane', device: 'probe-phone' });
    const sc = await req(T.lucy, 'POST', `/kids/sessions/${ses}/scan`, { token: q.j.token, device: 'probe-tablet' });
    const kid = sc.j.dropOff?.find((k) => !k.inClass);
    if (kid) {
      const ci = await req(T.lucy, 'POST', `/kids/sessions/${ses}/checkin`, { proof: sc.j.proof, childIds: [kid.id], device: 'probe-tablet' });
      log.push('kids checkin: ' + ci.s + ' ' + JSON.stringify(ci.j).slice(0, 80));
      for (const c of ci.j.children ?? []) add('kcheckin', c.id, G, NBO, 'jane', { parents: { ksession: ses } });
    } else log.push('kids checkin: no free child');
    const fam = await req(T.jane, 'GET', '/me/family');
    for (const f of fam.j.families ?? []) for (const p of f.pickupPeople ?? []) add('pickup', p.id, G, NBO, 'jane');
  });
  await step('group wall', async () => {
    const p = await req(T.jane, 'POST', '/me/groups/grp_mothers/wall', { body: 'Probe post ' + tag });
    add('post', p.j.id, G, NBO, 'jane', { parents: { group: 'grp_mothers' }, allow: ['jane', 'amina'] });
    const c = await req(T.jane, 'POST', `/me/groups/grp_mothers/wall/${p.j.id}/comments`, { body: 'Probe comment ' + tag });
    add('comment', c.j.id, G, NBO, 'jane', { parents: { group: 'grp_mothers', post: p.j.id }, allow: ['jane', 'amina'] });
    log.push('wall: ' + p.s + ' ' + c.s);
  });
  await step('resource blocks', async () => {
    const mk = async (tok, rid, org, br, owner) => { const b = await req(tok, 'POST', `/resources/${rid}/blocks`, { startsAt: iso(40 * DAY), endsAt: iso(40 * DAY + 3600_000), reason: 'probe ' + tag }); add('block', b.j.id, org, br, owner, { parents: { resource: rid } }); log.push('block ' + rid + ' ' + b.s); };
    await mk(T.owner, 'res_hall', G, NBO, 'owner');
    await mk(T.owner, 'res_grounds', G, MBA, 'owner');
  });
  await step('expense file', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const ex = (bag.expense ?? []).find((x) => x.fixture && x.owner === 'treas');
    if (!ex) return;
    const up = await req(T.treas, 'POST', `/expenses/${ex.id}/files`, { name: 'receipt.png', mime: 'image/png', data: png });
    const d = await req(T.treas, 'GET', `/expenses/${ex.id}`);
    for (const f of d.j.fileList ?? []) add('expfile', f.id, G, NBO, 'treas', { parents: { expense: ex.id } });
    log.push('expense file: ' + up.s);
  });
  await step('cash entry', async () => {
    const c = await req(T.treas, 'POST', '/cash', { branchId: NBO, amount: 200, purpose: 'OFFERING' });
    add('cash', c.j.id, G, NBO, 'treas');
    const m = await req(T.fatuma, 'POST', '/cash', { branchId: MBA, amount: 300, purpose: 'OFFERING' });
    add('cash', m.j.id, G, MBA, 'fatuma');
  });
  await step('transfer request', async () => {
    const t = await req(T.david, 'POST', '/me/transfer-request', { toChurchCode: 'GRC002' });
    log.push('transfer: ' + t.s + ' ' + JSON.stringify(t.j).slice(0, 80));
    add('transfer', t.j.id, G, MBA, 'david');
  });
  await step('shop order', async () => {
    const o = await req(T.jane, 'POST', '/me/shop/orders', { branchId: NBO, method: 'mpesa', phone: '0711000001', lines: [{ itemId: 'itm_bible_kjv', qty: 1 }] });
    log.push('shop order: ' + o.s + ' ' + JSON.stringify(o.j).slice(0, 80));
    add('sorder', o.j.id, G, NBO, 'jane');
  });
  await step('hope wallet topup', async () => {
    const w = (bag.wallet ?? []).find((x) => x.org === H && /sms/.test(x.id));
    const t = await req(T.hope, 'POST', `/wallets/${encodeURIComponent(w.id)}/topup`, { amount: 100, method: 'mpesa', phone: '0711000077' });
    log.push('topup: ' + t.s + ' ' + JSON.stringify(t.j).slice(0, 80));
    add('topup', t.j.id, H, null, 'hope');
  });
  await step('ticket refund request', async () => {
    const o = (bag.tkorder ?? []).find((x) => x.paid && x.owner === 'jane');
    if (!o) return;
    const r = await req(T.jane, 'POST', `/me/tickets/orders/${o.id}/refund-request`, { reason: 'probe' });
    log.push('ticket refund request: ' + r.s + ' ' + JSON.stringify(r.j).slice(0, 80));
    const l = await req(T.owner, 'GET', `/events/${o.eventId}/refund-requests`);
    for (const x of (Array.isArray(l.j) ? l.j : l.j.requests ?? [])) add('trefund', x.id, G, null, 'jane');
  });

  for (const k of Object.keys(bag)) {
    const seen = new Set();
    bag[k] = bag[k].filter((x) => (seen.has(x.id) ? false : seen.add(x.id)));
  }
  return { bag, log, tag, fx };
}

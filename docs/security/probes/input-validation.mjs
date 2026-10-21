// Input probe 2: money-field and type-confusion validation. LOCAL STACK ONLY. Creates a few demo rows when a value is (wrongly) accepted.
// Usage: node docs/security/probes/input-validation.mjs [apiUrl]
const API = process.argv[2] ?? 'http://localhost:4000';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API)) { console.log('refusing: local stack only'); process.exit(2); }
const call = async (method, path, body, token) => {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: res.status, json: j };
};
const login = async (phone) => (await call('POST', '/auth/otp/verify', { phone, code: '123456' })).json.token;
const owner = await login('0700000001'), treas = await login('0700000002'), peter = await login('0711000002');
// Nonsense values for an amount in shillings. [label, value]
const NONSENSE = [['negative', -5], ['zero', 0], ['sub-cent 0.001', 0.001], ['1e21 number', 1e21], ['1e21 string', '1e21'], ['1e17', 1e17], ['2^53+1', 9007199254740993], ['array [100]', [100]], ['object', { a: 1 }], ['null', null], ['empty', ''], ['true', true], ['"Infinity"', 'Infinity'], ['"NaN"', 'NaN'],
  ['hex "0x10"', '0x10'], ['"12abc" (trailing junk)', '12abc'], ['"1e3" exponent string', '1e3'], ['"  50  "', '  50  '], ['3 decimals 10.005', 10.005], ['"1,000"', '1,000'], ['-0', -0]];
const out = []; let flagged = 0;
async function amountTable(name, mk, legit) {
  const base = await mk(legit);
  const lines = [`## ${name}  (legit value ${JSON.stringify(legit)} -> HTTP ${base.status} ${base.status < 300 ? '' : JSON.stringify(base.json).slice(0, 80)})`];
  for (const [label, v] of NONSENSE) {
    const r = await mk(v);
    const accepted = r.status < 300; const err500 = r.status >= 500;
    // "1e3", "  50  ", "10.005" are lenient-but-sane; still reported so the owner can decide.
    if (accepted || err500) { flagged++; lines.push(`  FLAG ${label.padEnd(26)} -> HTTP ${r.status} ${accepted ? 'ACCEPTED' : 'unhandled 500'} ${JSON.stringify(r.json).slice(0, 90)}`); }
  }
  if (lines.length === 1) lines.push('  all nonsense values rejected with 4xx');
  out.push(lines.join('\n'));
}
await amountTable('POST /public/give amount', (a) => call('POST', '/public/give', { code: 'GRC001', purpose: 'OFFERING', phone: '0712000111', amount: a, method: 'mpesa' }), 20);
await amountTable('POST /me/pledges amount (no upper bound?)', (a) => call('POST', '/me/pledges', { churchCode: 'GRC001', projectCode: 'ROOF', amount: a }, peter), 100);
await amountTable('POST /me/giving-plans amount', (a) => call('POST', '/me/giving-plans', { amount: a, method: 'mpesa', frequency: 'monthly', purpose: 'TITHE' }, peter), 50);
await amountTable('POST /cash amount', (a) => call('POST', '/cash', { branchId: 'br_grc001', amount: a, purpose: 'OFFERING' }, treas), 100);
const setup = (await call('GET', '/expenses/setup', undefined, treas)).json; const cat = setup?.categories?.[0]?.id;
const today = new Date().toISOString().slice(0, 10);
await amountTable('POST /expenses amount', (a) => call('POST', '/expenses', { branchId: 'br_grc001', date: today, amount: a, categoryId: cat, payee: 'probe', method: 'cash', noReceiptReason: 'probe' }, treas), 10);
const wal = (await call('GET', '/wallets', undefined, owner)).json?.wallets?.[0]?.id;
await amountTable('POST /wallets/:id/topup amount', (a) => call('POST', `/wallets/${encodeURIComponent(wal)}/topup`, { amount: a, method: 'card' }, owner), 200);
await amountTable('POST /projects target', (a) => call('POST', '/projects', { branchId: 'br_grc001', code: 'PRB' + Math.random().toString(36).slice(2, 6).toUpperCase(), name: 'probe', target: a }, owner), 1000);
await amountTable('POST /shop/till counted', (a) => call('POST', '/shop/till', { branchId: 'br_grc001', counted: a, day: '2026-01-02' }, owner), 0);
// tickets: quantity and creditAmount
const ev = (await call('GET', '/public/event/PRAISE')).json; const tt = ev?.types?.[0]?.id ?? ev?.ticketTypes?.[0]?.id;
out.push(`## tickets (type id ${tt})`);
for (const [label, qty] of [['qty -1', -1], ['qty 0', 0], ['qty 1e9', 1e9], ['qty 1.5', 1.5], ['qty "2abc"', '2abc'], ['qty [2]', [2]], ['qty "1e1"', '1e1'], ['qty null', null], ['qty 1e300', 1e300]]) {
  const r = await call('POST', '/public/tickets/quote', { code: 'PRAISE', lines: [{ typeId: tt, qty }] });
  const o = await call('POST', '/public/tickets/orders', { code: 'PRAISE', name: 'Probe', email: 'probe.user@gmail.com', lines: [{ typeId: tt, qty }], method: 'mpesa', phone: '0712000111' });
  out.push(`  ${label.padEnd(14)} quote HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 90)} | order HTTP ${o.status} ${o.status < 300 ? 'ORDER CREATED' : ''}`);
}
for (const [label, ca] of [['creditAmount -100', -100], ['creditAmount 1e21', 1e21], ['creditAmount "abc"', 'abc'], ['creditAmount {}', {}], ['creditAmount [5]', [5]]]) {
  const r = await call('POST', '/public/tickets/quote', { code: 'PRAISE', lines: [{ typeId: tt, qty: 1 }], creditCode: 'NOPE', creditAmount: ca });
  if (r.status >= 500) { flagged++; out.push(`  FLAG ${label} quote -> HTTP ${r.status}`); } else out.push(`  ok   ${label} quote -> HTTP ${r.status}`);
}
// credit refund and transfer (peter has no credit in fresh demo data: must be rejected, never 500)
for (const [label, v] of [['1e21', 1e21], ['-5', -5], ['[100]', [100]], ['"0x10"', '0x10'], ['0.004', 0.004], ['1e308', 1e308]]) {
  const r = await call('POST', '/me/credit/refund-request', { amount: v }, peter); const t = await call('POST', '/me/credit/transfer', { amount: v, to: '0711000001' }, peter);
  if (r.status >= 500 || t.status >= 500 || r.status < 300 || t.status < 300) { flagged++; out.push(`  FLAG credit ${label}: refund HTTP ${r.status}, transfer HTTP ${t.status}`); } else out.push(`  ok   credit ${label}: refund ${r.status}, transfer ${t.status}`);
}
// type confusion in JSON bodies of non-amount fields
const conf = [['POST', '/public/give', { code: ['GRC001'], purpose: {}, phone: 7, amount: 20, method: 'mpesa' }], ['POST', '/public/give', { code: 'GRC001', purpose: 'OFFERING', phone: '0712000111', amount: 20, method: ['mpesa'] }],
  ['POST', '/auth/otp/verify', { phone: { $ne: 1 }, code: [123456] }], ['POST', '/auth/otp/verify', { phone: '0711000002', code: ['123456'] }],
  ['POST', '/me/prayer', { body: { x: 1 }, audience: [] }], ['POST', '/me/suggestions', { body: ['a'], category: {} }], ['POST', '/cash', { branchId: ['br_grc001'], amount: 5 }],
  ['POST', '/members', { fullName: { a: 1 }, phone: [] }], ['POST', '/shop/sales', { branchId: 'br_grc001', method: 'cash', lines: 'x' }], ['POST', '/shop/sales', { branchId: 'br_grc001', method: 'cash', lines: [null, 5, 'a'] }],
  ['POST', '/messages', { title: [], body: {}, audience: 5 }], ['POST', '/events', { title: 5, startsAt: [] }]];
for (const [m, p, b] of conf) {
  const tok = p === '/auth/otp/verify' || p === '/public/give' ? undefined : (p.startsWith('/me') ? peter : owner);
  const r = await call(m, p, b, tok);
  out.push(`${r.status >= 500 ? 'FLAG' : r.status < 300 ? 'NOTE' : 'ok  '} ${m} ${p} ${JSON.stringify(b).slice(0, 60)} -> HTTP ${r.status}`); if (r.status >= 500) flagged++;
}
// malformed JSON bodies
for (const raw of ['{', '[]', 'null', '"str"', '123', '{"a":1e999}', '{"__proto__":{"isAdmin":true}}', '{"constructor":{"prototype":{"x":1}}}']) {
  const r = await call('POST', '/cash', raw, treas); out.push(`${r.status >= 500 ? 'FLAG' : 'ok  '} raw JSON body ${raw.slice(0, 40)} -> HTTP ${r.status}`); if (r.status >= 500) flagged++;
}
const chk = await call('GET', '/health'); out.push(`prototype pollution check: ({}).isAdmin is ${({}).isAdmin} locally; /health still HTTP ${chk.status}`);
console.log(out.join('\n')); console.log(`\n${flagged} flagged`);

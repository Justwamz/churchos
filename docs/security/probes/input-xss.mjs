// Input probe 3a: store XSS / HTML-injection payloads in every free-text field reachable by the demo roles, then check the
// server-built HTML (ticket e-mail in the outbox) for raw markup. Rendering in the React apps is checked by input-xss-render.mjs.
// LOCAL STACK ONLY, demo data only (adds a few rows prefixed XSSMARK). Usage: node docs/security/probes/input-xss.mjs [apiUrl]
const API = process.argv[2] ?? 'http://localhost:4000';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API)) { console.log('refusing: local stack only'); process.exit(2); }
const call = async (method, path, body, token) => {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: res.status, json: j, text: t };
};
const login = async (phone) => (await call('POST', '/auth/otp/verify', { phone, code: '123456' })).json.token;
const owner = await login('0700000001'), treas = await login('0700000002'), peter = await login('0711000002'), admin = await login('0700000099');
export const P = 'XSSMARK"><img src=x onerror=window.__xss=1>';          // 44 chars: fits the shortest limits
const P2 = 'XSSMARK<script>window.__xss=1</script><svg/onload=window.__xss=1>';
const tomorrow = new Date(Date.now() + 3 * 86400_000).toISOString();
const today = new Date().toISOString().slice(0, 10);
const rows = [];
const add = async (label, p) => { const r = await p; rows.push(`${String(r.status).padEnd(4)} ${label} ${r.status >= 300 ? JSON.stringify(r.json).slice(0, 100) : ''}`); return r; };

await add('prayer request body', call('POST', '/me/prayer', { body: P2, audience: 'church' }, peter));
await add('suggestion body', call('POST', '/me/suggestions', { body: P2, category: 'other' }, peter));
await add('event title/location/description', call('POST', '/events', { title: P, location: P, description: P2, startsAt: tomorrow, audience: { type: 'org' } }, owner));
await add('notice title/body', call('POST', '/notices', { title: P, body: P2, audience: { type: 'org' } }, owner));
await add('member full name', call('POST', '/members', { branchId: 'br_grc001', fullName: P, phone: '0733' + String(Math.floor(Math.random()*900000+100000)), category: 'adult', sex: 'male', consent: true }, owner));
const setup = (await call('GET', '/expenses/setup', undefined, treas)).json;
await add('expense payee/note', call('POST', '/expenses', { branchId: 'br_grc001', date: today, amount: 10, categoryId: setup?.categories?.[0]?.id, payee: P, note: P2, method: 'cash', noReceiptReason: P }, treas));
await add('group name/description', call('POST', '/groups', { branchId: 'br_grc001', name: P, description: P2, joinPolicy: 'open', posting: 'everyone' }, owner));
await add('shop item name/code', call('POST', '/shop/items', { branchId: 'br_grc001', name: P, code: 'XSS' + Math.random().toString(36).slice(2, 6), price: 10, cost: 5, openingStock: 1 }, owner));
await add('project name/description', call('POST', '/projects', { branchId: 'br_grc001', code: 'XS' + Math.random().toString(36).slice(2, 6).toUpperCase(), name: P, description: P2, target: 1000 }, owner));
await add('advert title/body (javascript: link must be refused)', call('POST', '/adverts', { title: P, body: P2, link: 'javascript:window.__xss=1', audience: { type: 'org' } }, owner));
await add('church words (server-written text)', call('PUT', '/church/words', { gathering: P }, owner));
await add('profile e-mail with markup (must be refused)', call('PUT', '/me/profile', { email: '"><img src=x onerror=1>@gmail.com' }, peter));
// Public, unauthenticated: ticket order buyer name goes into staff screens and the confirmation e-mail.
const ev = (await call('GET', '/public/event/PRAISE')).json; const tt = ev?.types?.[0]?.id ?? 'tkt_entry';
const ord = await add('PUBLIC ticket order, buyer name', call('POST', '/public/tickets/orders', { code: 'PRAISE', name: P, email: 'xss.probe.user@gmail.com', lines: [{ typeId: tt, qty: 1 }], method: 'mpesa', phone: '0712000111' }));
// e-mail HTML check: look at the newest outbox rows for raw markup coming from the buyer name
await new Promise((r) => setTimeout(r, 1500)); // the confirmation is sent just after the response
const box = await call('GET', '/admin/outbox', undefined, admin);
const list = Array.isArray(box.json) ? box.json : box.json?.emails ?? box.json?.rows ?? [];
const mine = list.filter((m) => /XSSMARK/.test(String(m.html ?? '') + String(m.body ?? ''))).slice(0, 3);
rows.push(`outbox rows containing XSSMARK: ${mine.length} (HTTP ${box.status})`);
for (const m of mine) {
  const h = String(m.html ?? '');
  const raw = /<img src=x|<script|<svg/i.test(h.replace(/<img alt="QR[^>]*>/g, ''));
  rows.push(`${raw ? 'FLAG' : 'OK  '} ticket e-mail html: raw markup from buyer name present = ${raw}; escaped form present = ${/&lt;img src=x/.test(h)}`);
  rows.push(`     plain-text part contains literal payload (expected, text/plain) = ${/<img src=x/.test(String(m.body ?? ''))}`);
}
console.log(rows.join('\n'));

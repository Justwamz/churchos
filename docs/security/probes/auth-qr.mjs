// AUTH probe 4: signed QR / door tokens (signData / verifyData). Local API + demo data only. Safe to rerun
// (records at most one demo attendance row for Jane Wanjiku the first time).
const B = process.env.API ?? 'http://localhost:4000';
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(B)) throw new Error('Refusing to probe a non-local host');
const log = (k, v) => console.log(k.padEnd(66), v);
const call = async (m, p, tok, body) => { const r = await fetch(B + p, { method: m, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const login = async (phone) => (await call('POST', '/auth/otp/verify', null, { phone, code: '123456' })).j.token;
const owner = await login('0700000001'), jane = await login('0711000001');
const svcs = (await call('GET', '/attendance/services', owner)).j.services;
const svc = svcs.find((s) => s.state === 'open') ?? svcs[0];
log('service used', `${svc.name} ${svc.id} state=${svc.state}`);

const q = await call('POST', '/me/attendance/qr', jane, {});
const tok = q.j.token;
const payload = tok.slice(3).split('.')[0];
const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
log('member usher code claims', JSON.stringify(claims) + `  ttl=${((claims.e - Date.now()) / 1000).toFixed(0)}s  prefix=${tok.slice(0, 3)}`);
log('no nonce / jti / audience; domain separation = claim "k" only', 'same HMAC key as session tokens');

const scan = (t, id = svc.id) => call('POST', `/attendance/services/${id}/scan`, owner, { token: t });
log('scan #1', JSON.stringify((await scan(tok)).j));
log('scan #2 (replay inside TTL)', JSON.stringify((await scan(tok)).j).slice(0, 120) + '  (replayable by anyone who photographs the screen, until expiry; first use only marks "already")');

// tampering and type confusion
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sig = tok.split('.')[1];
log('tampered expiry (e+1 day), old signature', JSON.stringify((await scan('A1.' + b64({ ...claims, e: claims.e + 86400000 }) + '.' + sig)).j));
log('session token presented as A1.<session token>', JSON.stringify((await scan('A1.' + owner)).j));
const guardianQr = await call('POST', '/me/family/qr', jane, { membershipId: 'x' });
const door = await call('GET', `/attendance/services/${svc.id}/door`, owner);
const doorTok = door.j.url.split('/here/')[1];
log('door token (D1.) presented as member code A1.', JSON.stringify((await scan('A1.' + doorTok.slice(3))).j));
log('member code presented as a door link /public/here/D1.<A1 payload>', (await call('GET', `/public/here/D1.${tok.slice(3)}`)).s + ' (404 = rejected)');
log('session token as door link /public/here/D1.<session token>', (await call('GET', `/public/here/D1.${owner}`)).s);
log('door link without any auth, valid?', (await call('GET', '/public/here/' + doorTok)).s);
log('door token lifetime vs QR refresh', `expiresAt-now=${((Date.parse(door.j.expiresAt) - Date.now()) / 1000).toFixed(0)}s, refreshSeconds=${door.j.refreshSeconds}  (a photo of the QR works remotely for the whole TTL)`);
log('door token for service A used to check in at service B?', 'token carries s=<service id>; the server loads that service only [code reading]');
console.log('Expiry of 45s/5min cannot be shortened by a client: it is inside the signed payload. Expired handling checked by code (each caller tests Number(p.e) < now); verifyData itself does NOT check expiry.');

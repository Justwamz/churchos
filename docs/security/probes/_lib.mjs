// Shared helpers for the authorization probes. Plain node 18+ and fetch, no dependencies.
// Local demo stack only. Refuses to run against anything but localhost.
export const BASE = process.env.CHURCHOS_API ?? 'http://localhost:4000';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('These probes only run against the local stack');

export const PHONES = {
  pa1: '0700000099', pa2: '0700000098',
  owner: '0700000001', treas: '0700000002', admin: '0700000003', pastor: '0700000009', auditor: '0700000007', vera: '0700000010', lucy: '0700000008',
  jane: '0711000001', peter: '0711000002', david: '0711000004',
  fatuma: '0700000004', hope: '0700000005', newhope: '0700000006', amina: '0711000003', newcomer: '0733000001',
};

export async function req(token, method, path, body, headers = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  try {
    const r = await fetch(BASE + path, { method, headers: h, body: payload });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { s: r.status, j: json, text, headers: r.headers };
  } catch (e) {
    return { s: 0, j: String(e), text: String(e), headers: new Headers() };
  }
}

export async function login(phone) {
  const r = await req(null, 'POST', '/auth/otp/verify', { phone, code: '123456' });
  return r.j?.token ?? null;
}

export async function loginAll(names = Object.keys(PHONES)) {
  const out = {};
  for (const n of names) out[n] = await login(PHONES[n]);
  return out;
}

export const ok2 = (s) => s >= 200 && s < 300;
export const denied = (s) => s === 401 || s === 403 || s === 404;

/** Tiny assertion recorder. Each check is {id, title, pass, detail}. */
export function recorder() {
  const rows = [];
  const check = (id, title, pass, detail = '') => { rows.push({ id, title, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${title}${detail ? '  -> ' + detail : ''}`); return !!pass; };
  const info = (id, title, detail = '') => { rows.push({ id, title, pass: null, detail }); console.log(`INFO  ${id}  ${title}${detail ? '  -> ' + detail : ''}`); };
  return { rows, check, info };
}

export const rid = () => Math.random().toString(36).slice(2, 8);
export const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
export const DAY = 86_400_000;

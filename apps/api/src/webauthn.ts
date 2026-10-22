import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { corsOrigins, isProduction } from './cors';

/**
 * WebAuthn (passkeys) checks done with node:crypto only: no library, so no extra supply-chain surface on the server.
 * Supported: registration with attestation "none" (we ask for none and refuse anything else), ES256 and RS256 keys, assertion
 * signature, rpId hash, origin, challenge, user-presence and signature counter. The browser side uses @simplewebauthn/browser.
 */

export class WebAuthnError extends Error {}
const bad = (m: string): never => { throw new WebAuthnError(m); };

// ---------- settings ----------

/** The relying-party id: the registrable domain the passkeys belong to. Passkeys cannot move to another id. */
export function rpId(env: NodeJS.ProcessEnv = process.env): string {
  return (env.WEBAUTHN_RP_ID ?? '').trim().toLowerCase() || 'localhost';
}
export const rpName = () => 'ChurchOS';

/** Origins a browser may use for a passkey ceremony: the CORS_ORIGINS list; the four local development ports when it is empty outside production. */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = corsOrigins(env);
  if (list.length) return list;
  return isProduction(env) ? [] : [3001, 3002, 3003, 3004].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]);
}

const hostOf = (origin: string) => { try { return new URL(origin).hostname.toLowerCase(); } catch { return ''; } };
/** The origin must be on the allowed list AND belong to the rp id (same host or a subdomain of it). */
export function originOk(origin: unknown, id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof origin !== 'string' || !allowedOrigins(env).includes(origin)) return false;
  const h = hostOf(origin);
  return h === id || h.endsWith(`.${id}`);
}

// ---------- minimal CBOR (enough for attestation objects and COSE keys) ----------

type Cbor = number | bigint | string | boolean | null | Buffer | Cbor[] | Map<Cbor, Cbor>;

export function cborDecode(buf: Buffer, start = 0, depth = 0): { value: Cbor; end: number } {
  if (depth > 8 || start >= buf.length) bad('Bad CBOR');
  const ib = buf[start];
  const major = ib >> 5;
  const info = ib & 31;
  let off = start + 1;
  let arg = 0;
  if (info < 24) arg = info;
  else if (info === 24) { arg = buf.readUInt8(off); off += 1; }
  else if (info === 25) { arg = buf.readUInt16BE(off); off += 2; }
  else if (info === 26) { arg = buf.readUInt32BE(off); off += 4; }
  else if (major === 7 && (info === 20 || info === 21 || info === 22)) return { value: info === 22 ? null : info === 21, end: off };
  else bad('Unsupported CBOR');
  if (major === 0) return { value: arg, end: off };
  if (major === 1) return { value: -1 - arg, end: off };
  if (major === 2 || major === 3) {
    if (off + arg > buf.length) bad('Bad CBOR');
    const b = buf.subarray(off, off + arg);
    return { value: major === 2 ? Buffer.from(b) : b.toString('utf8'), end: off + arg };
  }
  if (major === 4) {
    if (arg > 256) bad('Bad CBOR');
    const out: Cbor[] = [];
    for (let i = 0; i < arg; i++) { const r = cborDecode(buf, off, depth + 1); out.push(r.value); off = r.end; }
    return { value: out, end: off };
  }
  if (major === 5) {
    if (arg > 256) bad('Bad CBOR');
    const m = new Map<Cbor, Cbor>();
    for (let i = 0; i < arg; i++) {
      const k = cborDecode(buf, off, depth + 1); const v = cborDecode(buf, k.end, depth + 1);
      m.set(k.value, v.value); off = v.end;
    }
    return { value: m, end: off };
  }
  return bad('Unsupported CBOR');
}

// ---------- helpers ----------

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const eq = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
const b64u = (b: Buffer) => b.toString('base64url');

function clientData(raw: unknown, type: string, expectedChallenge: string, id: string, env: NodeJS.ProcessEnv) {
  if (typeof raw !== 'string' || raw.length > 4096) bad('Bad client data');
  let cd: any;
  try { cd = JSON.parse(Buffer.from(raw as string, 'base64url').toString('utf8')); } catch { bad('Bad client data'); }
  if (!cd || cd.type !== type) bad('Wrong ceremony type');
  if (typeof cd.challenge !== 'string' || !eq(Buffer.from(cd.challenge), Buffer.from(expectedChallenge))) bad('The challenge does not match');
  if (!originOk(cd.origin, id, env)) bad('This address may not use passkeys');
  if (cd.crossOrigin === true) bad('Cross-origin passkey use is not allowed');
  return Buffer.from(raw as string, 'base64url');
}

export interface AuthData { rpIdHash: Buffer; flags: number; up: boolean; uv: boolean; counter: number; credId?: Buffer; coseKey?: Map<Cbor, Cbor> }

export function parseAuthData(ad: Buffer): AuthData {
  if (ad.length < 37) bad('Bad authenticator data');
  const flags = ad[32];
  const out: AuthData = { rpIdHash: ad.subarray(0, 32), flags, up: !!(flags & 1), uv: !!(flags & 4), counter: ad.readUInt32BE(33) };
  if (flags & 0x40) {
    if (ad.length < 55) bad('Bad authenticator data');
    const len = ad.readUInt16BE(53);
    if (len < 1 || len > 1023 || ad.length < 55 + len) bad('Bad authenticator data');
    out.credId = Buffer.from(ad.subarray(55, 55 + len));
    const k = cborDecode(ad, 55 + len);
    if (!(k.value instanceof Map)) bad('Bad public key');
    out.coseKey = k.value as Map<Cbor, Cbor>;
  }
  return out;
}

/** A COSE key (ES256 or RS256) as a public key object. */
function coseToKey(k: Map<Cbor, Cbor>): KeyObject {
  const kty = k.get(1), alg = k.get(3);
  try {
    if (kty === 2 && alg === -7 && k.get(-1) === 1) {
      const x = k.get(-2), y = k.get(-3);
      if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) bad('Bad public key');
      return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(x as Buffer), y: b64u(y as Buffer) }, format: 'jwk' });
    }
    if (kty === 3 && alg === -257) {
      const n = k.get(-1), e = k.get(-2);
      if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length < 256) bad('Bad public key');
      return createPublicKey({ key: { kty: 'RSA', n: b64u(n as Buffer), e: b64u(e as Buffer) }, format: 'jwk' });
    }
  } catch (e) {
    if (e instanceof WebAuthnError) throw e;
  }
  return bad('Only ES256 and RS256 passkeys are supported');
}

// ---------- ceremonies ----------

export interface Registered { credentialId: string; publicKey: string; counter: number; transports: string[] }

export function verifyRegistration(a: { credential: any; expectedChallenge: string; rpId: string; env?: NodeJS.ProcessEnv }): Registered {
  const env = a.env ?? process.env;
  const r = a.credential?.response;
  if (!r || typeof r !== 'object') bad('Missing passkey response');
  clientData(r.clientDataJSON, 'webauthn.create', a.expectedChallenge, a.rpId, env);
  if (typeof r.attestationObject !== 'string' || r.attestationObject.length > 20_000) bad('Missing attestation');
  const att = cborDecode(Buffer.from(r.attestationObject, 'base64url')).value;
  if (!(att instanceof Map)) bad('Bad attestation');
  const m = att as Map<Cbor, Cbor>;
  if (m.get('fmt') !== 'none') bad('Only attestation "none" is accepted');
  const authData = m.get('authData');
  if (!Buffer.isBuffer(authData)) bad('Bad attestation');
  const ad = parseAuthData(authData as Buffer);
  if (!eq(ad.rpIdHash, sha256(a.rpId))) bad('The passkey was made for another site');
  if (!ad.up) bad('The passkey did not confirm presence');
  if (!ad.credId || !ad.coseKey) bad('No passkey in the response');
  const key = coseToKey(ad.coseKey!);
  const id = b64u(ad.credId!);
  if (typeof a.credential.id === 'string' && a.credential.id !== id) bad('The passkey id does not match');
  const transports = Array.isArray(r.transports) ? r.transports.filter((t: unknown) => typeof t === 'string' && /^[a-z-]{2,20}$/.test(t)).slice(0, 6) : [];
  return { credentialId: id, publicKey: b64u(key.export({ type: 'spki', format: 'der' }) as Buffer), counter: ad.counter, transports };
}

export interface Asserted { counter: number; uv: boolean }

/** Checks a sign-in assertion against a stored key and counter. Throws WebAuthnError on anything wrong, including a counter that went backwards (cloned key). */
export function verifyAssertion(a: { credential: any; expectedChallenge: string; rpId: string; publicKey: string; counter: number; requireUv?: boolean; env?: NodeJS.ProcessEnv }): Asserted {
  const env = a.env ?? process.env;
  const r = a.credential?.response;
  if (!r || typeof r !== 'object') bad('Missing passkey response');
  const cd = clientData(r.clientDataJSON, 'webauthn.get', a.expectedChallenge, a.rpId, env);
  if (typeof r.authenticatorData !== 'string' || typeof r.signature !== 'string' || r.authenticatorData.length > 4096 || r.signature.length > 2048) bad('Bad passkey response');
  const adRaw = Buffer.from(r.authenticatorData, 'base64url');
  const ad = parseAuthData(adRaw);
  if (!eq(ad.rpIdHash, sha256(a.rpId))) bad('The passkey was made for another site');
  if (!ad.up) bad('The passkey did not confirm presence');
  if (a.requireUv && !ad.uv) bad('The passkey did not verify the person');
  const key = createPublicKey({ key: Buffer.from(a.publicKey, 'base64url'), format: 'der', type: 'spki' });
  const signed = Buffer.concat([adRaw, sha256(cd)]);
  const sig = Buffer.from(r.signature, 'base64url');
  let ok = false;
  try { ok = cryptoVerify('sha256', signed, key, sig); } catch { ok = false; }
  if (!ok) bad('The passkey signature is not valid');
  // Counters: two zeros means the device does not count (synced passkeys). Otherwise it must go up, or the key may have been copied.
  if ((ad.counter !== 0 || a.counter !== 0) && ad.counter <= a.counter) bad('This passkey looks copied. It was refused.');
  return { counter: ad.counter, uv: ad.uv };
}

// Test-only helper: makes a throwaway RSA key pair and a self-signed X.509 certificate in memory at test time,
// so no private key is committed to the repository. Pure node:crypto, no openssl needed.
import { createSign, generateKeyPairSync, X509Certificate } from 'node:crypto';

const len = (n: number) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);
const oid = (hex: string) => tlv(0x06, Buffer.from(hex, 'hex'));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s));
const utc = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));

export function makeTestCert(): { certPem: string; keyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sigAlg = seq(oid('2a864886f70d01010b'), tlv(0x05)); // sha256WithRSAEncryption
  const name = seq(set(seq(oid('550403'), utf8('churchos-test')))); // CN=churchos-test
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
    tlv(0x02, Buffer.from([1])), // serial
    sigAlg,
    name,
    seq(utc(new Date(Date.now() - 86400_000)), utc(new Date(Date.now() + 86400_000 * 30))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
  );
  const sig = createSign('sha256').update(tbs).sign(privateKey);
  const der = seq(tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
  new X509Certificate(certPem); // throws if the DER is malformed
  return { certPem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}

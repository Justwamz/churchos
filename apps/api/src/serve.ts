import type { FastifyReply } from "fastify";

/** Types a browser may show inline; everything else is a download as an opaque binary. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);

/** Content-Disposition with a plain ASCII fallback and the real name in RFC 5987 form. Never throws on em dashes, CR/LF or quotes. */
export function contentDisposition(type: 'inline' | 'attachment', name: unknown): string {
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\/]/g, '_').trim().slice(0, 120) || 'file';
  const ascii = clean.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["%;\\]/g, '_').trim() || 'file';
  const star = encodeURIComponent(clean).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

/** Sends a stored private file (receipt, KYC document, scan) with safe headers. */
export function sendPrivateFile(reply: FastifyReply, file: { mime: unknown; name: unknown; data: Buffer }) {
  const mime = String(file.mime ?? '').toLowerCase();
  const inline = INLINE.has(mime);
  return reply
    .header('content-type', inline ? mime : 'application/octet-stream')
    .header('content-disposition', contentDisposition(inline ? 'inline' : 'attachment', file.name))
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "sandbox; default-src 'none'; img-src 'self' data:")
    .header('cache-control', 'private, no-store')
    .send(file.data);
}

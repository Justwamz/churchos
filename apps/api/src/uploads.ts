import { HttpError } from './ctx';

/**
 * One check for every picture or document that comes in as base64 (IN-05 to IN-08): receipts, KYC documents, certificate logos
 * and scans, event posters, shop pictures, adverts and church icons. The file's own first bytes decide what it is; the
 * type the browser claimed must agree, and the type that gets stored is the sniffed one. Pictures are measured from their
 * real headers and refused above 12,000 x 12,000 pixels or 40 megapixels. Nothing is changed or stripped.
 */

export type UploadKind = 'image' | 'pdf';
export interface UploadCheck {
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf';
  kind: UploadKind;
  width?: number;
  height?: number;
  bytes: number;
}

export const MAX_DIMENSION = 12_000;
export const MAX_PIXELS = 40_000_000;

type Sniffed = UploadCheck['mime'] | null;

/** What the bytes are, from their magic numbers. */
export function sniffType(b: Buffer): Sniffed {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 5 && b.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** Width and height read from the file's header, and for PNG a check that the chunks are well formed and the data is enough for the size claimed. */
export function decodeSize(b: Buffer, mime: Sniffed): { width: number; height: number } | null {
  try {
    if (mime === 'image/png') return pngInfo(b);
    if (mime === 'image/jpeg') return jpegSize(b);
    if (mime === 'image/webp') return webpSize(b);
  } catch { /* a short or damaged file */ }
  return null;
}

function pngInfo(b: Buffer): { width: number; height: number } | null {
  if (b.length < 33 || b.readUInt32BE(8) !== 13 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) return null;
  // Walk the chunks: each declared length must fit in the file, and the picture data (IDAT) must exist and be large enough for the size claimed.
  let pos = 8;
  let idat = 0;
  let sawEnd = false;
  while (pos + 12 <= b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('ascii', pos + 4, pos + 8);
    if (len > b.length - pos - 12) return null;
    if (type === 'IDAT') idat += len;
    pos += 12 + len;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  if (!sawEnd || idat === 0) return null;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[b[25]];
  if (!channels) return null;
  const rawBytes = height * (Math.ceil((width * channels * b[24]) / 8) + 1);
  // Deflate cannot shrink data by more than about 1032 times. A tiny file that claims a large picture is not real.
  if (rawBytes > 4_000_000 && idat * 1100 < rawBytes) return null;
  return { width, height };
}

function jpegSize(b: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') {
    const v = b.readUInt32LE(21);
    return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') return { width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1 };
  return null;
}

/**
 * Checks a file. `declaredMime` is what the client said. Throws HttpError 400 (code `opts.code`, default 'bad_file') when the file is
 * not one of the allowed kinds, when it is not what it claims to be, or when a picture is too large in pixels or too big in bytes (413).
 */
export function checkUpload(
  buf: Buffer,
  declaredMime: unknown,
  opts: { kinds?: UploadKind[]; maxBytes?: number; maxPixels?: number; code?: string; label?: string } = {},
): UploadCheck {
  const kinds = opts.kinds ?? ['image', 'pdf'];
  const code = opts.code ?? 'bad_file';
  const label = opts.label ?? 'file';
  const allowedText = kinds.includes('pdf') && kinds.includes('image') ? 'a PDF, PNG, JPEG or WebP' : kinds.includes('pdf') ? 'a PDF' : 'a PNG, JPEG or WebP picture';
  if (buf.length === 0) throw new HttpError(400, `That ${label} is empty`, code);
  if (opts.maxBytes !== undefined && buf.length > opts.maxBytes) throw new HttpError(413, `That ${label} is too big`, code === 'bad_file' ? 'too_large' : code);
  const sniffed = sniffType(buf);
  if (!sniffed) throw new HttpError(400, `That ${label} is not ${allowedText}`, code);
  const kind: UploadKind = sniffed === 'application/pdf' ? 'pdf' : 'image';
  if (!kinds.includes(kind)) throw new HttpError(400, `That ${label} must be ${allowedText}`, code);
  if (String(declaredMime ?? '').toLowerCase() !== sniffed) throw new HttpError(400, `That ${label} is not the type it says it is. Use ${allowedText}.`, code);
  if (kind === 'pdf') return { mime: sniffed, kind, bytes: buf.length };
  const size = decodeSize(buf, sniffed);
  if (!size || !size.width || !size.height) throw new HttpError(400, `That ${label} is not a valid picture`, code);
  const maxPixels = opts.maxPixels ?? MAX_PIXELS;
  if (size.width > MAX_DIMENSION || size.height > MAX_DIMENSION || size.width * size.height > maxPixels) {
    throw new HttpError(400, `That picture is too large (${size.width} x ${size.height} pixels). The most is 12,000 x 12,000 and 40 megapixels.`, code);
  }
  return { mime: sniffed as UploadCheck['mime'], kind, width: size.width, height: size.height, bytes: buf.length };
}

/** A file name safe to store and to put in a header: no path parts, no control characters, at most 100 characters. Letters of any language stay. */
export function cleanFileName(name: unknown, fallback = 'file'): string {
  let s = String(name ?? '');
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  s = s.split(/[\\/]/).pop() ?? '';
  s = s.replace(/^\.+/, '').replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, 100).join('').trim();
  return s || fallback;
}

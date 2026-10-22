import { deflateSync } from 'node:zlib';
import { HttpError } from './ctx';
import { checkUpload } from './uploads';

export const ART_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_ART_BYTES = 1024 * 1024;
export const MIN_ART_WIDTH = 800;

/** Reads the pixel size from the file itself, so a wrong label or a disguised file cannot get through. */
export function imageSize(buf: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === 'image/png') {
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (mime === 'image/jpeg') {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  if (mime === 'image/webp') {
    if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1, height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1 };
    return null;
  }
  return null;
}

/** Artwork rules (L131): PNG, JPEG or WebP, up to 1 MB, 16:9 within 3 percent, at least 800 px wide. */
export function validateArtwork(img: any): { mime: string; data: string; width: number; height: number } {
  if (!img || !(ART_MIMES as readonly string[]).includes(img.mime)) throw new HttpError(400, 'Use a PNG, JPEG or WebP image', 'bad_artwork');
  const bytes = Buffer.from(String(img.data ?? ''), 'base64');
  if (bytes.length === 0) throw new HttpError(400, 'That image is empty', 'bad_artwork');
  if (bytes.length > MAX_ART_BYTES) throw new HttpError(413, 'The image is larger than 1 MB. Export it at a lower quality or size.', 'artwork_too_large');
  const checked = checkUpload(bytes, img.mime, { kinds: ['image'], code: 'bad_artwork', label: 'image' });
  const size = { width: checked.width!, height: checked.height! };
  if (size.width < MIN_ART_WIDTH) throw new HttpError(400, `The image is ${size.width} pixels wide. It must be at least ${MIN_ART_WIDTH}.`, 'artwork_too_small');
  const ratio = size.width / size.height;
  if (Math.abs(ratio - 16 / 9) / (16 / 9) > 0.03) throw new HttpError(400, `The image must be widescreen (16:9), for example 1280 x 720. This one is ${size.width} x ${size.height}.`, 'artwork_ratio');
  return { mime: checked.mime, data: String(img.data), width: size.width, height: size.height };
}

// ---------- demo artwork for the seed ----------

const CRC = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

/** A vertical colour wash with a lighter band, as a valid PNG. Used for the sample adverts so the slider has something to show. */
export function gradientPng(width: number, height: number, top: [number, number, number], bottom: [number, number, number]): string {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    const f = y / (height - 1);
    const band = y > height * 0.62 && y < height * 0.7;
    const px = [0, 1, 2].map((i) => Math.round(top[i] + (bottom[i] - top[i]) * f + (band ? 40 : 0)));
    const o = y * row;
    raw[o] = 0;
    for (let x = 0; x < width; x++) {
      raw[o + 1 + x * 3] = Math.min(255, px[0]);
      raw[o + 2 + x * 3] = Math.min(255, px[1]);
      raw[o + 3 + x * 3] = Math.min(255, px[2]);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  return png.toString('base64');
}

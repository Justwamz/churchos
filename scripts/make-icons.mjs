// Generates the PWA icons for the member app as PNG files, with no image library.
// Usage: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../apps/member/public/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const TEAL = [14, 90, 82], CREAM = [248, 239, 220], GOLD = [185, 131, 42];

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const png = (w, h, rgba) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
};

/** Distance inside a rounded rectangle (negative inside). */
const sdRound = (x, y, cx, cy, hw, hh, r) => {
  const dx = Math.abs(x - cx) - (hw - r), dy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
};

/**
 * A teal tile with a cream cross and a small gold dot. A maskable icon fills the whole square and keeps the cross inside the
 * centre 60%, the area Android never crops. The standard icon has rounded corners.
 */
function icon(size, { maskable }) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4; // supersampling for smooth edges
  const s = maskable ? 0.62 : 0.82; // the cross scales down in a maskable icon
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size, y = (py + (sy + 0.5) / SS) / size; // 0..1
          const inTile = maskable ? true : sdRound(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) <= 0;
          if (!inTile) continue;
          let c = TEAL;
          const v = sdRound(x, y, 0.5, 0.5 - 0.02 * s, 0.07 * s, 0.34 * s, 0.015);
          const hz = sdRound(x, y, 0.5, 0.5 - 0.1 * s, 0.24 * s, 0.07 * s, 0.015);
          if (v <= 0 || hz <= 0) c = CREAM;
          if (Math.hypot(x - 0.5, y - (0.5 + 0.3 * s)) <= 0.035 * s) c = GOLD;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const o = (py * size + px) * 4;
      const n = Math.max(a, 1);
      buf[o] = Math.round(r / n); buf[o + 1] = Math.round(g / n); buf[o + 2] = Math.round(b / n); buf[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return png(size, size, buf);
}

const files = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
  ['favicon-32.png', 32, false],
];
for (const [name, size, maskable] of files) {
  writeFileSync(new URL(name, OUT), icon(size, { maskable }));
  console.log('wrote', name);
}

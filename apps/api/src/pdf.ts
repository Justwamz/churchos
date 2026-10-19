/**
 * A very small PDF writer for plain statements: A4 pages, Helvetica text, thin rules. No dependencies.
 * Text outside Latin-1 is replaced with "?", so names with other scripts should be shown in the app as well.
 */

export interface PdfItem {
  kind: 'text' | 'rule' | 'gap';
  text?: string;
  bold?: boolean;
  size?: number;
  /** Columns for a table row: each has x offset (points from the left margin), text and optional right alignment. */
  cols?: { x: number; text: string; right?: boolean }[];
  grey?: boolean;
  h?: number;
}

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 50;

const latin = (s: string) => Array.from(s).map((c) => (c.charCodeAt(0) <= 255 ? c : '?')).join('');
const esc = (s: string) => latin(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[\r\n]+/g, ' ');

/** Approximate width of Helvetica text, good enough to right-align numbers and to wrap long lines. */
export function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) {
    if ('il.,;:\'|!'.includes(ch)) w += 0.26;
    else if ('fjrt()[]-/ '.includes(ch)) w += 0.33;
    else if ('mwMW@%'.includes(ch)) w += 0.85;
    else if (ch >= 'A' && ch <= 'Z') w += 0.68;
    else if (ch >= '0' && ch <= '9') w += 0.556;
    else w += 0.52;
  }
  return w * size * (bold ? 1.05 : 1);
}

export function wrap(text: string, size: number, width: number, bold = false): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size, bold) > width && line) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

export function buildPdf(items: PdfItem[], opts: { title: string; footer: string }): Buffer {
  const pages: string[][] = [[]];
  let y = PAGE_H - MARGIN;
  const bottom = MARGIN + 28;
  const cur = () => pages[pages.length - 1];
  const newPage = () => { pages.push([]); y = PAGE_H - MARGIN; };
  for (const it of items) {
    const size = it.size ?? 10;
    const lead = it.kind === 'gap' ? it.h ?? 8 : it.kind === 'rule' ? 6 : size + 5;
    if (y - lead < bottom) newPage();
    if (it.kind === 'gap') { y -= lead; continue; }
    if (it.kind === 'rule') {
      y -= 3;
      cur().push(`0.75 G 0.5 w ${MARGIN} ${y.toFixed(1)} m ${PAGE_W - MARGIN} ${y.toFixed(1)} l S`);
      y -= 3;
      continue;
    }
    y -= size;
    const font = it.bold ? '/F2' : '/F1';
    const grey = it.grey ? '0.4 g' : '0 g';
    const cols = it.cols ?? [{ x: 0, text: it.text ?? '' }];
    for (const c of cols) {
      const w = textWidth(c.text, size, it.bold);
      const x = MARGIN + (c.right ? c.x - w : c.x);
      cur().push(`BT ${grey} ${font} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${esc(c.text)}) Tj ET`);
    }
    y -= 5;
  }
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // pages, filled below
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  pages.forEach((ops, i) => {
    const foot = `BT 0.4 g /F1 8 Tf ${MARGIN} ${MARGIN - 8} Td (${esc(opts.footer)}) Tj ET BT 0.4 g /F1 8 Tf ${PAGE_W - MARGIN - 50} ${MARGIN - 8} Td (Page ${i + 1} of ${pages.length}) Tj ET`;
    const content = `${ops.join('\n')}\n${foot}`;
    const c = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${esc(opts.title)}) /Producer (ChurchOS) >>`);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

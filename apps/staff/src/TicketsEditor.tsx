import { useRef, useState, type ReactNode } from 'react';
import { Button, ErrorNote, Field, Note } from '@churchos/ui';
import { toIso, toLocal } from './communityBits';
import './tickets.css';

export type TypeRow = { key: string; id?: string; name: string; description: string; price: string; quantity: string; perOrderMax: string; salesStart: string; salesEnd: string; active: boolean };
export type Poster = { mime: string; data: string; preview: string };

let counter = 0;
export const blankType = (): TypeRow => ({ key: `n${++counter}`, name: '', description: '', price: '', quantity: '', perOrderMax: '10', salesStart: '', salesEnd: '', active: true });
export const rowFromType = (t: any): TypeRow => ({
  key: t.id, id: t.id, name: t.name, description: t.description ?? '', price: String((t.price ?? 0) / 100), quantity: String(t.quantity ?? ''), perOrderMax: String(t.perOrderMax ?? 10),
  salesStart: toLocal(t.salesStart), salesEnd: toLocal(t.salesEnd), active: t.active !== false,
});

/** Returns a message if a row is not fine, otherwise the payload for the API. */
export function typesPayload(rows: TypeRow[]): { error?: string; types?: any[] } {
  if (rows.length === 0) return { error: 'Add at least one ticket type.' };
  const names = new Set<string>();
  const types: any[] = [];
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) return { error: 'Give every ticket type a name.' };
    if (names.has(name.toLowerCase())) return { error: `There are two ticket types called "${name}".` };
    names.add(name.toLowerCase());
    const price = r.price.trim() === '' ? 0 : Number(r.price);
    if (!(price >= 0) || (price > 0 && price < 10) || price > 150000) return { error: `The price of "${name}" must be 0 or between KES 10 and KES 150,000.` };
    const quantity = Number(r.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) return { error: `Enter how many "${name}" tickets are available.` };
    const per = Number(r.perOrderMax || 10);
    if (!Number.isInteger(per) || per < 1 || per > 20) return { error: 'Most per order must be from 1 to 20.' };
    if (r.salesStart && r.salesEnd && Date.parse(`${r.salesEnd}:00+03:00`) <= Date.parse(`${r.salesStart}:00+03:00`)) return { error: `Sales for "${name}" must close after they open.` };
    types.push({ ...(r.id ? { id: r.id } : {}), name, description: r.description.trim(), price, quantity, perOrderMax: per, salesStart: r.salesStart ? toIso(r.salesStart) : null, salesEnd: r.salesEnd ? toIso(r.salesEnd) : null, active: r.active });
  }
  return { types };
}

const ERR: Record<string, string> = {
  bad_types: 'Check the ticket types. You need at least one, and no more than 10.',
  duplicate: 'Two ticket types have the same name.',
  bad_amount: 'Check the ticket prices. Use 0 for free, or from KES 10 to KES 150,000.',
  bad_number: 'Check the numbers on the ticket types.',
  has_sales: 'A ticket type with sales cannot be removed. Switch it off instead.',
  artwork_ratio: 'The poster must be widescreen 16:9, for example 1280 x 720.',
  artwork_too_small: 'The poster is too small. It needs to be at least 1280 x 720.',
  artwork_too_large: 'The poster is larger than 1 MB. Make the file smaller.',
  bad_artwork: 'We could not use that poster. Use a PNG, JPG or WebP picture.',
};
export function explainTickets(e: any): string | null {
  if (e?.code === 'quantity_too_low') {
    const m = /(\d+)/.exec(e.message ?? '');
    return `${m ? `${m[1]} tickets are` : 'Some tickets are'} already sold or held, so the number cannot go below that.`;
  }
  return (e?.code && ERR[e.code]) || null;
}

function readPoster(file: File): Promise<Poster> {
  return new Promise((resolve, reject) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return reject(new Error('Use a PNG, JPG or WebP picture.'));
    if (file.size > 1024 * 1024) return reject(new Error('This picture is larger than 1 MB. Make the file smaller and try again.'));
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('We could not read that file.'));
    fr.onload = () => {
      const url = String(fr.result);
      const img = new Image();
      img.onerror = () => reject(new Error('We could not open that picture.'));
      img.onload = () => {
        if (img.naturalWidth < 1280 || img.naturalHeight < 720) return reject(new Error(`This picture is ${img.naturalWidth} x ${img.naturalHeight}. It needs to be at least 1280 x 720.`));
        if (Math.abs(img.naturalWidth / img.naturalHeight / (16 / 9) - 1) > 0.03) return reject(new Error(`This picture is ${img.naturalWidth} x ${img.naturalHeight}. It must be widescreen 16:9, for example 1280 x 720.`));
        resolve({ mime: file.type, data: url.slice(url.indexOf(',') + 1), preview: url });
      };
      img.src = url;
    };
    fr.readAsDataURL(file);
  });
}

export function TicketsEditor({ rows, setRows, poster, setPoster, existingPoster }: { rows: TypeRow[]; setRows: (r: TypeRow[]) => void; poster: Poster | null; setPoster: (p: Poster | null) => void; existingPoster?: string }) {
  const file = useRef<HTMLInputElement>(null);
  const [perr, setPerr] = useState('');
  const set = (i: number, p: Partial<TypeRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const pick = async (f?: File | null) => {
    if (!f) return;
    setPerr('');
    try { setPoster(await readPoster(f)); } catch (e: any) { setPerr(e.message); }
  };
  const src = poster?.preview ?? existingPoster;
  return (
    <div className="stack">
      <div className="stack" style={{ gap: 10 }}>
        {rows.map((r, i) => (
          <div className="tk-row" key={r.key}>
            <div className="row between"><b>Ticket type {i + 1}</b>
              <span className="row">
                {r.id && <label className="row" style={{ gap: 6, flexWrap: 'nowrap' }}><input type="checkbox" checked={r.active} onChange={(e) => set(i, { active: e.target.checked })} /> On sale</label>}
                {rows.length > 1 && <Button small kind="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>}
              </span>
            </div>
            <div className="tk-grid">
              <Field label="Name" hint={`${r.name.length} of 40`}><input maxLength={40} value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Adult" /></Field>
              <Field label="Price in KES" hint="0 for free"><input inputMode="decimal" value={r.price} onChange={(e) => set(i, { price: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
              <Field label="Number available"><input inputMode="numeric" value={r.quantity} onChange={(e) => set(i, { quantity: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="Most per order"><input inputMode="numeric" value={r.perOrderMax} onChange={(e) => set(i, { perOrderMax: e.target.value.replace(/\D/g, '') })} /></Field>
            </div>
            <Field label="Short description" hint={`Optional. ${r.description.length} of 120`}><input maxLength={120} value={r.description} onChange={(e) => set(i, { description: e.target.value })} /></Field>
            <div className="tk-grid">
              <Field label="Sales open" hint="Optional. East Africa Time"><input type="datetime-local" value={r.salesStart} onChange={(e) => set(i, { salesStart: e.target.value })} /></Field>
              <Field label="Sales close" hint="Optional. East Africa Time"><input type="datetime-local" value={r.salesEnd} onChange={(e) => set(i, { salesEnd: e.target.value })} /></Field>
            </div>
          </div>
        ))}
        <div className="row"><Button kind="ghost" disabled={rows.length >= 10} onClick={() => setRows([...rows, blankType()])}>Add a ticket type</Button><span className="tiny">Up to 10 types. A free ticket still gets a QR code for the door.</span></div>
      </div>
      <Field label="Poster" hint="Widescreen 16:9, at least 1280 x 720, PNG, JPG or WebP, up to 1 MB">
        <div className="stack" style={{ gap: 8 }}>
          <div className="tk-poster" style={src ? { backgroundImage: `url("${src}")` } : undefined}>{!src && 'Your poster will show here'}</div>
          <div className="row"><Button kind="ghost" small onClick={() => file.current?.click()}>{src ? 'Change poster' : 'Choose a poster'}</Button>{poster && <Button kind="ghost" small onClick={() => setPoster(null)}>Undo</Button>}</div>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          {perr && <ErrorNote>{perr}</ErrorNote>}
        </div>
      </Field>
      <Note>The buyer pays a small service fee on top, shown before they pay. You receive the full ticket price. Tickets are held for 15 minutes while someone pays.</Note>
    </div>
  );
}

export type { ReactNode };

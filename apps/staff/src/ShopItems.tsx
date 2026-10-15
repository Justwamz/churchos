import { useRef, useState, type ReactNode } from 'react';
import { Badge, Button, Empty, ErrorNote, Field, Table, kes, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load } from './bits';
import { Modal } from './MemberForm';
import './shop.css';

export const stockError = (e: any) => {
  const c = e?.code;
  if (c === 'below_zero') return friendly(e.message);
  if (c === 'duplicate') return friendly(e.message) || 'That name or code is already used.';
  if (c === 'picture_too_large') return 'The picture is larger than 500 KB. Use a smaller one.';
  if (c === 'bad_picture') return friendly(e.message) || 'Use a PNG, JPEG or WebP picture, at least 200 pixels wide and tall.';
  if (c === 'bad_code') return 'A code can use letters, numbers, dots, dashes and underscores only.';
  if (c === 'bad_amount' || c === 'bad_number') return 'Check the numbers. Prices need to be a positive amount and stock a whole number.';
  return friendly(e?.message);
};

export function useItems(branch: string) {
  const s = useSession();
  return useAsync<any[]>(() => api.get('/shop/items' + s.qs({ branch })), [branch, s.grant.org.id]);
}

const MOVE: Record<string, string> = { received: 'Received', adjusted: 'Adjusted', written_off: 'Written off', sold: 'Sold', voided: 'Put back (sale voided)', restocked: 'Put back' };
export function ItemThumb({ item, size = 40 }: { item: any; size?: number }) {
  const st = { width: size, height: size, fontSize: Math.round(size * 0.45) };
  return item.hasImage && item.imageUrl
    ? <img className="sp-thumb" style={st} src={api.url(item.imageUrl)} alt="" loading="lazy" />
    : <span className="sp-thumb tile" style={st} aria-hidden="true">{(item.name?.trim()?.[0] ?? '?').toUpperCase()}</span>;
}

type Pic = { mime: string; data: string; preview: string };
const PIC_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
function readPicture(file: File): Promise<Pic> {
  return new Promise((resolve, reject) => {
    if (!PIC_TYPES.includes(file.type)) return reject(new Error('Use a PNG, JPEG or WebP picture.'));
    if (file.size > 500 * 1024) return reject(new Error('This picture is larger than 500 KB. Use a smaller one.'));
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('We could not read that file.'));
    fr.onload = () => {
      const url = String(fr.result);
      const img = new Image();
      img.onerror = () => reject(new Error('We could not open that picture.'));
      img.onload = () => {
        if (img.naturalWidth < 200 || img.naturalHeight < 200) return reject(new Error(`This picture is ${img.naturalWidth} x ${img.naturalHeight} pixels. It must be at least 200 pixels wide and tall.`));
        resolve({ mime: file.type, data: url.slice(url.indexOf(',') + 1), preview: url });
      };
      img.src = url;
    };
    fr.readAsDataURL(file);
  });
}
const shillings = (v: string) => v.replace(/[^\d.]/g, '');

function ItemForm({ branch, item, categories, onClose, onSaved }: { branch: string; item?: any; categories: string[]; onClose: () => void; onSaved: (m: string) => void }) {
  const s = useSession();
  const [name, setName] = useState(item?.name ?? '');
  const [code, setCode] = useState(item?.code ?? '');
  const [category, setCategory] = useState(item?.category ?? '');
  const [price, setPrice] = useState(item ? String(item.price / 100) : '');
  const [cost, setCost] = useState(item?.cost != null ? String(item.cost / 100) : '');
  const [low, setLow] = useState(String(item?.lowStock ?? 5));
  const [open, setOpen] = useState('0');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pic, setPic] = useState<Pic | null>(null);
  const [removePic, setRemovePic] = useState(false);
  const [picErr, setPicErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const pickPic = async (f?: File | null) => {
    if (!f) return;
    setPicErr('');
    try { setPic(await readPicture(f)); setRemovePic(false); } catch (e: any) { setPicErr(e.message); }
  };
  const shownPic = pic?.preview ?? (item?.hasImage && !removePic ? api.url(item.imageUrl) : undefined);
  const save = async () => {
    setErr('');
    if (!name.trim()) return setErr('Write a name.');
    if (!(Number(price) > 0)) return setErr('Enter the selling price in shillings.');
    const body: any = { name: name.trim(), code: code.trim() || undefined, category: category.trim() || undefined, price: Number(price), cost: cost.trim() ? Number(cost) : undefined, lowStock: Number(low) || 0 };
    setBusy(true);
    let saved: any = item;
    try {
      if (item) await api.put(`/shop/items/${item.id}` + s.qs({ branch: undefined }), { ...body, code: code.trim() || null, category: category.trim() || null });
      else saved = await api.post('/shop/items' + s.qs({ branch: undefined }), { ...body, branchId: branch, openingStock: Number(open) || 0 });
    } catch (e: any) { setErr(stockError(e)); setBusy(false); return; }
    try {
      if (pic && saved?.id) await api.post(`/shop/items/${saved.id}/image` + s.qs({ branch: undefined }), { image: { mime: pic.mime, data: pic.data } });
      else if (removePic && item?.hasImage) await api.post(`/shop/items/${item.id}/image/remove` + s.qs({ branch: undefined }), {});
    } catch (e: any) { setErr(`The item was saved, but the picture was not. ${stockError(e)} Try again with Edit.`); setBusy(false); return; }
    onSaved(item ? 'Changes saved' : 'Item added');
  };
  return (
    <Modal title={item ? `Edit ${item.name}` : 'Add an item'} onClose={onClose}>
      <div className="stack">
        <Field label="Name" hint="For example Large print Bible"><input maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid cols-2">
          <Field label="Code" hint="Optional. A short code or barcode number."><input maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Field label="Category" hint="For example Bibles, Books, Rosaries">
            <input list="sp-cats" maxLength={30} value={category} onChange={(e) => setCategory(e.target.value)} />
            <datalist id="sp-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="Selling price (KES)"><input inputMode="decimal" value={price} onChange={(e) => setPrice(shillings(e.target.value))} /></Field>
          <Field label="Cost price (KES)" hint="Optional. Only managers see this."><input inputMode="decimal" value={cost} onChange={(e) => setCost(shillings(e.target.value))} /></Field>
          <Field label="Low stock level" hint="You are warned when stock falls to this number."><input inputMode="numeric" value={low} onChange={(e) => setLow(e.target.value.replace(/\D/g, ''))} /></Field>
          {!item && <Field label="Opening stock" hint="How many you have now."><input inputMode="numeric" value={open} onChange={(e) => setOpen(e.target.value.replace(/\D/g, ''))} /></Field>}
        </div>
        <Field label="Picture" hint="Optional. PNG, JPEG or WebP, at least 200 x 200 pixels, up to 500 KB. Members see it in the shop.">
          <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'center' }}>
            {shownPic ? <img className="sp-thumb" style={{ width: 88, height: 88 }} src={shownPic} alt="Picture preview" /> : <span className="sp-thumb tile" style={{ width: 88, height: 88, fontSize: 38 }} aria-hidden="true">{(name.trim()[0] ?? '?').toUpperCase()}</span>}
            <div className="stack" style={{ gap: 6 }}>
              <div className="row">
                <Button small kind="ghost" onClick={() => fileRef.current?.click()}>{shownPic ? 'Change picture' : 'Choose a picture'}</Button>
                {shownPic && <Button small kind="ghost" onClick={() => { setPic(null); setRemovePic(true); setPicErr(''); }}>Remove picture</Button>}
              </div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { pickPic(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
          </div>
        </Field>
        {picErr && <ErrorNote>{picErr}</ErrorNote>}
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button disabled={busy} onClick={save}>{busy ? 'Saving...' : item ? 'Save changes' : 'Add item'}</Button><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  );
}

const InfoNote = ({ children }: { children: ReactNode }) => <div className="note info">{children}</div>;

export function StockDialog({ item, kind, onClose, onSaved }: { item: any; kind: 'received' | 'adjusted' | 'written_off'; onClose: () => void; onSaved: (m: string) => void }) {
  const s = useSession();
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const n = Number(qty);
  const delta = kind === 'written_off' ? -n : n;
  const valid = qty !== '' && Number.isInteger(n) && n !== 0 && (kind === 'adjusted' || n > 0);
  const title = kind === 'received' ? 'Receive stock' : kind === 'adjusted' ? 'Adjust stock' : 'Write off stock';
  const save = async () => {
    setErr('');
    if (!valid) return setErr(kind === 'adjusted' ? 'Enter a whole number, like 3 or -2.' : 'Enter how many, as a whole number above zero.');
    if (kind !== 'received' && !reason.trim()) return setErr('Please say why.');
    setBusy(true);
    try {
      await api.post(`/shop/items/${item.id}/stock` + s.qs({ branch: undefined }), { kind, qty: n, unitCost: kind === 'received' && cost.trim() ? Number(cost) : undefined, reason: reason.trim() || undefined });
      onSaved('Stock updated');
    } catch (e: any) { setErr(stockError(e)); setBusy(false); }
  };
  return (
    <Modal title={`${title}: ${item.name}`} onClose={onClose}>
      <div className="stack">
        <div className="muted">In stock now: <b>{item.stock}</b></div>
        <Field label={kind === 'adjusted' ? 'Change (use - to take away)' : 'How many'} hint={kind === 'adjusted' ? 'For example 3 to add three, -2 to take away two.' : undefined}>
          <input inputMode={kind === 'adjusted' ? 'text' : 'numeric'} value={qty} onChange={(e) => setQty(kind === 'adjusted' ? e.target.value.replace(/[^\d-]/g, '') : e.target.value.replace(/\D/g, ''))} autoFocus />
        </Field>
        {kind === 'received' && item.cost !== null && <Field label="Cost of each (KES)" hint="Optional. Updates the cost price."><input inputMode="decimal" value={cost} onChange={(e) => setCost(shillings(e.target.value))} /></Field>}
        <Field label={kind === 'received' ? 'Note' : 'Reason'} hint={kind === 'received' ? 'Optional, for example "From the supplier, invoice 123"' : kind === 'written_off' ? 'For example damaged or lost' : 'For example "Counted the shelf"'}><input maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {valid && <InfoNote>{item.stock} now becomes <b>{item.stock + delta}</b></InfoNote>}
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button disabled={busy} onClick={save}>{busy ? 'Saving...' : title}</Button><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  );
}

function History({ item, onClose }: { item: any; onClose: () => void }) {
  const s = useSession();
  const d = useAsync<any[]>(() => api.get(`/shop/items/${item.id}/movements` + s.qs({ branch: undefined })), [item.id]);
  return (
    <Modal title={`History: ${item.name}`} onClose={onClose}>
      <Load loading={d.loading} error={d.error} hasData={!!d.data}>
        {d.data && (d.data.length === 0 ? <Empty>Nothing has happened yet.</Empty> : (
          <Table head={['What', 'Change', 'Reason', 'Who', 'When', 'Receipt']}>
            {d.data.map((m, i) => (
              <tr key={i}>
                <td>{MOVE[m.kind] ?? m.kind}</td>
                <td className="sp-num"><b>{m.qty > 0 ? '+' : ''}{m.qty}</b></td>
                <td>{m.reason || '-'}</td>
                <td>{m.by || '-'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{shortDate(m.at)}</td>
                <td>{m.receipt || '-'}</td>
              </tr>
            ))}
          </Table>
        ))}
      </Load>
    </Modal>
  );
}

export function ItemsAndStock({ branch }: { branch: string }) {
  const s = useSession();
  const toast = useToast();
  const list = useItems(branch);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [dlg, setDlg] = useState<{ type: 'form' | 'history' | 'received' | 'adjusted' | 'written_off'; item?: any } | null>(null);
  const items = list.data ?? [];
  const categories = Array.from(new Set(items.map((i) => i.category).filter(Boolean))).sort() as string[];
  const showCost = items.some((i) => i.cost !== null);
  const showValue = items.some((i) => i.value !== null);
  const term = q.trim().toLowerCase();
  const rows = items.filter((i) => (!term || i.name.toLowerCase().includes(term) || (i.code ?? '').toLowerCase().includes(term)) && (!cat || i.category === cat) && (!lowOnly || ((i.low || i.out) && i.active)));
  const manage = s.can('shop.manage');
  const done = (m: string) => { setDlg(null); toast.show(m); list.reload(); };
  const toggle = async (i: any) => {
    try { await api.put(`/shop/items/${i.id}` + s.qs({ branch: undefined }), { active: !i.active }); toast.show(i.active ? 'Switched off. It will not show in the till.' : 'Switched on'); list.reload(); } catch (e: any) { toast.show(stockError(e), 'bad'); }
  };
  return (
    <div className="stack">
      <section className="card">
        <div className="row between">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ margin: 0 }}><span className="field-label">Search</span><input type="search" placeholder="Name or code" value={q} onChange={(e) => setQ(e.target.value)} /></label>
            <label className="field" style={{ margin: 0 }}><span className="field-label">Category</span>
              <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}</select>
            </label>
            <label className="row" style={{ gap: 6, flexWrap: 'nowrap', paddingBottom: 8 }}><input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Low and out of stock only</label>
          </div>
          {manage && <Button onClick={() => setDlg({ type: 'form' })}>Add item</Button>}
        </div>
      </section>
      <Load loading={list.loading} error={list.error} hasData={!!list.data}>
        {list.data && (rows.length === 0 ? <Empty>{items.length === 0 ? 'No items yet.' : 'No items match these choices.'}</Empty> : (
          <Table head={['Name', 'Category', 'Price', ...(showCost ? ['Cost'] : []), 'In stock', ...(showValue ? ['Stock value'] : []), 'Status', '']}>
            {rows.map((i) => (
              <tr key={i.id} className={i.active ? '' : 'sp-off'}>
                <td style={{ minWidth: 140 }}><div className="row" style={{ flexWrap: 'nowrap', gap: 10, alignItems: 'center' }}><ItemThumb item={i} /><div><b>{i.name}</b>{i.code && <div className="tiny">{i.code}</div>}</div></div></td>
                <td>{i.category || '-'}</td>
                <td className="sp-num">{kes(i.price)}</td>
                {showCost && <td className="sp-num">{i.cost !== null ? kes(i.cost) : '-'}</td>}
                <td><b>{i.stock}</b> {i.out ? <Badge tone="bad">Out</Badge> : i.low ? <Badge tone="warn">Low</Badge> : null}</td>
                {showValue && <td className="sp-num">{i.value !== null ? kes(i.value) : '-'}</td>}
                <td><Badge tone={i.active ? 'good' : 'muted'}>{i.active ? 'On sale' : 'Switched off'}</Badge></td>
                <td><div className="row">
                  {i.canManage && <Button small onClick={() => setDlg({ type: 'received', item: i })}>Receive stock</Button>}
                  {i.canManage && <Button small kind="ghost" onClick={() => setDlg({ type: 'adjusted', item: i })}>Adjust</Button>}
                  {i.canManage && <Button small kind="ghost" onClick={() => setDlg({ type: 'written_off', item: i })}>Write off</Button>}
                  <Button small kind="ghost" onClick={() => setDlg({ type: 'history', item: i })}>History</Button>
                  {i.canManage && <Button small kind="ghost" onClick={() => setDlg({ type: 'form', item: i })}>Edit</Button>}
                  {i.canManage && <Button small kind="ghost" onClick={() => toggle(i)}>{i.active ? 'Switch off' : 'Switch on'}</Button>}
                </div></td>
              </tr>
            ))}
          </Table>
        ))}
      </Load>
      {dlg?.type === 'form' && <ItemForm branch={branch} item={dlg.item} categories={categories} onClose={() => setDlg(null)} onSaved={done} />}
      {dlg?.type === 'history' && <History item={dlg.item} onClose={() => setDlg(null)} />}
      {(dlg?.type === 'received' || dlg?.type === 'adjusted' || dlg?.type === 'written_off') && <StockDialog item={dlg.item} kind={dlg.type} onClose={() => setDlg(null)} onSaved={done} />}
      {toast.node}
    </div>
  );
}

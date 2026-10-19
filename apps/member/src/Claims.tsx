import { useEffect, useRef, useState } from 'react';
import { Button, ErrorNote, Field, Note, dateOnly, kes, useAsync } from '@churchos/ui';
import { api, errText } from './api';
import { Icon, Sheet, Skeleton } from './ui';

const MAX_FILES = 3;
const MAX_BYTES = 1.2 * 1024 * 1024;
const TARGET_BYTES = 1.1 * 1024 * 1024;

type Pic = { id: string; name: string; mime: string; data: string; preview: string };

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });

const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(new Error('We could not read that file.'));
  r.readAsDataURL(blob);
});

/** Shrinks a photo: longest side 1600px, JPEG, quality lowered until it is under about 1.1 MB. */
async function shrink(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That picture could not be opened. Try another photo.'));
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const g = c.getContext('2d');
    if (!g) throw new Error('That picture could not be prepared.');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    let q = 0.8;
    for (;;) {
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', q));
      if (!blob) throw new Error('That picture could not be prepared.');
      if (blob.size <= TARGET_BYTES || q <= 0.3) {
        if (blob.size > MAX_BYTES) throw new Error('That picture is too large even after shrinking. Try a clearer, closer photo.');
        return blob;
      }
      q = Math.round((q - 0.1) * 10) / 10;
    }
  } finally { URL.revokeObjectURL(url); }
}

function statusOf(c: any): { tone: string; label: string; line?: string } {
  if (c.status === 'voided') return { tone: 'muted', label: 'Cancelled' };
  if (c.status === 'rejected') return { tone: 'bad', label: 'Not approved' };
  if (c.status === 'approved') {
    return c.paid
      ? { tone: 'good', label: 'Paid', line: `Paid on ${dateOnly(c.paidAt)}${c.paidReference ? `, reference ${c.paidReference}` : ''}` }
      : { tone: 'good', label: 'Approved', line: 'Waiting to be paid' };
  }
  return { tone: 'warn', label: 'Waiting for approval' };
}

/** Asks once whether this member may claim expenses. The feature stays hidden until the answer is yes. */
export function useClaimSetup() {
  const s = useAsync<any>(() => api.get('/me/claims/setup'));
  return { allowed: s.data?.allowed === true, setup: s.data };
}

export function ClaimsPage({ setup }: { setup: any }) {
  const list = useAsync<any>(() => api.get('/me/claims'));
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const rows: any[] = list.data?.claims ?? [];
  return (
    <div className="stack">
      <div className="block cl-intro">
        <p style={{ margin: 0 }}>Spent your own money for the church? Claim it back here with a photo of the receipt. Someone else approves it, and you are told when it is paid.</p>
        <Button onClick={() => { setSent(null); setOpen(true); }}>New claim</Button>
      </div>
      {sent && <Note tone="good">{sent}</Note>}
      <h3 style={{ margin: '4px 2px 0' }}>My claims</h3>
      {list.loading && !list.data ? <div className="card"><Skeleton lines={3} /></div> : list.error && !list.data ? (
        <div className="stack"><ErrorNote>{list.error}</ErrorNote><Button kind="ghost" onClick={list.reload}>Try again</Button></div>
      ) : !rows.length ? (
        <div className="empty-state"><Icon name="receipt" size={40} /><strong>You have not made any claims yet.</strong></div>
      ) : (
        <ul className="notice-list pr-list">
          {rows.map((c) => {
            const st = statusOf(c);
            return (
              <li key={c.id} className="block pr-card cl-card">
                <div className="pr-top-row"><strong className="ell">{c.payee}</strong><span className={`badge ${st.tone}`}>{st.label}</span></div>
                <div className="cl-amt">{kes(c.amount)}</div>
                <div className="tiny">{c.code} · {dateOnly(c.date)} · {c.category}{c.project ? ` · ${c.project}` : ''}</div>
                <div className="tiny">Paid by {String(c.methodLabel ?? c.method).toLowerCase()}{c.reference ? ` (${c.reference})` : ''} · {c.files} receipt{c.files === 1 ? '' : 's'}</div>
                {st.line && <div className={`cl-line ${st.tone}`}>{st.line}</div>}
                {c.status === 'rejected' && c.decisionNote && <blockquote className="pr-quote">{c.decisionNote}</blockquote>}
                {c.status === 'voided' && c.voidReason && <blockquote className="pr-quote cl-grey">{c.voidReason}</blockquote>}
              </li>
            );
          })}
        </ul>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="New claim">
        {open && <ClaimForm setup={setup} onDone={(code) => { setOpen(false); setSent(`Claim sent. ${code}. Someone will approve it and you will be told.`); list.reload(); }} />}
      </Sheet>
    </div>
  );
}

function ClaimForm({ setup, onDone }: { setup: any; onDone: (code: string) => void }) {
  const branches: any[] = setup.branches ?? [];
  const cats: any[] = setup.categories ?? [];
  const projects: any[] = setup.projects ?? [];
  const methods: any[] = setup.methods ?? [];
  const limit = Number(setup.receiptRequiredAbove ?? 100000) / 100;
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [payee, setPayee] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [method, setMethod] = useState(methods[0]?.key ?? 'cash');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [why, setWhy] = useState('');
  const [pics, setPics] = useState<Pic[]>([]);
  const [prep, setPrep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [fileError, setFileError] = useState<string | undefined>();
  const cam = useRef<HTMLInputElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const picsRef = useRef<Pic[]>([]);
  picsRef.current = pics;
  useEffect(() => () => picsRef.current.forEach((p) => p.preview && URL.revokeObjectURL(p.preview)), []);

  const n = Number(amount);
  const validAmt = Number.isFinite(n) && n > 0;
  const needReceipt = validAmt && n > limit;
  const projs = projects.filter((p) => !p.branchId || p.branchId === branchId);
  const ok = validAmt && payee.trim().length >= 3 && !!categoryId && !!method && !!date && !!branchId && !prep && (!needReceipt || pics.length > 0 || why.trim().length >= 3);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    setFileError(undefined); setPrep(true);
    const next = [...picsRef.current];
    try {
      for (const f of list) {
        if (next.length >= MAX_FILES) { setFileError(`You can add up to ${MAX_FILES} receipts.`); break; }
        if (f.type === 'application/pdf') {
          if (f.size > MAX_BYTES) { setFileError('That PDF is bigger than 1.2 MB. Please take a photo of the receipt instead.'); continue; }
          next.push({ id: `${Date.now()}${next.length}`, name: f.name, mime: 'application/pdf', data: await toBase64(f), preview: '' });
        } else if (f.type.startsWith('image/')) {
          const b = await shrink(f);
          next.push({ id: `${Date.now()}${next.length}`, name: f.name.replace(/\.[^.]+$/, '') + '.jpg', mime: 'image/jpeg', data: await toBase64(b), preview: URL.createObjectURL(b) });
        } else setFileError('Please add a photo or a PDF.');
      }
    } catch (e) { setFileError(errText(e)); }
    setPics(next); setPrep(false);
    if (cam.current) cam.current.value = '';
    if (pick.current) pick.current.value = '';
  };
  const remove = (id: string) => setPics((p) => { const g = p.find((x) => x.id === id); if (g?.preview) URL.revokeObjectURL(g.preview); return p.filter((x) => x.id !== id); });

  const send = async () => {
    setBusy(true); setError(undefined);
    try {
      const r = await api.post('/me/claims', {
        branchId, date, amount: n, categoryId, projectId: projectId || undefined, payee: payee.trim(), method,
        reference: reference.trim() || undefined, note: note.trim() || undefined,
        noReceiptReason: !pics.length && why.trim() ? why.trim() : undefined,
        files: pics.length ? pics.map((p) => ({ name: p.name, mime: p.mime, data: p.data })) : undefined,
      });
      onDone(r.code);
      return;
    } catch (e) { setError(errText(e)); }
    setBusy(false);
  };

  return (
    <div className="stack">
      {branches.length > 1 && (
        <Field label="Which church branch?"><select value={branchId} onChange={(e) => { setBranchId(e.target.value); setProjectId(''); }}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
      )}
      <Field label="Date you spent it"><input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="Amount (KES)"><input className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="e.g. 450" /></Field>
      <Field label="What was it spent on?"><input value={payee} maxLength={120} onChange={(e) => setPayee(e.target.value)} placeholder="e.g. Bus fare to the printers" /></Field>
      <Field label="Category"><select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">Choose a category</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      {projs.length > 0 && (
        <Field label="Church project (optional)"><select value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">Not for a project</option>{projs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      )}
      <Field label="How did you pay?"><select value={method} onChange={(e) => setMethod(e.target.value)}>{methods.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></Field>
      <Field label="Reference (optional)" hint="For example the M-Pesa code"><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. SGH7K2L9" /></Field>
      <Field label="Note (optional)"><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>

      <div className="cl-receipts">
        <div className="field-label">Receipts</div>
        {needReceipt && <Note tone="info">{pics.length ? 'Receipt added. Thank you.' : `Above ${kes(Math.round(limit * 100))} a receipt is needed. Add a receipt, or say why there is none.`}</Note>}
        <input ref={cam} type="file" accept="image/*,application/pdf" capture="environment" hidden aria-label="Take a photo of the receipt" onChange={(e) => add(e.target.files)} />
        <input ref={pick} type="file" accept="image/*,application/pdf" multiple hidden aria-label="Add receipt from your files" onChange={(e) => add(e.target.files)} />
        {pics.length < MAX_FILES && (
          <>
            <button type="button" className="cl-photo" disabled={prep} onClick={() => cam.current?.click()}><Icon name="receipt" size={28} /><span>{prep ? 'Getting the photo ready…' : 'Take a photo of the receipt'}</span></button>
            <Button kind="ghost" disabled={prep} onClick={() => pick.current?.click()}>Add from your files</Button>
          </>
        )}
        {fileError && <ErrorNote>{fileError}</ErrorNote>}
        {pics.length > 0 && (
          <ul className="cl-thumbs">
            {pics.map((p) => (
              <li key={p.id}>
                {p.preview ? <img src={p.preview} alt={`Receipt ${p.name}`} /> : <span className="cl-pdf">PDF<small>{p.name}</small></span>}
                <button type="button" className="cl-x" aria-label={`Remove ${p.name}`} onClick={() => remove(p.id)}><Icon name="close" size={16} /></button>
              </li>
            ))}
          </ul>
        )}
        <p className="tiny" style={{ margin: 0 }}>Up to {MAX_FILES} photos or PDFs.</p>
        {!pics.length && (
          <Field label="No receipt because" hint={needReceipt ? 'Needed when there is no receipt' : 'Only if you have no receipt'}>
            <textarea rows={2} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. The matatu gave no receipt" />
          </Field>
        )}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button disabled={!ok || busy} onClick={send}>{busy ? 'Sending…' : 'Send claim'}</Button>
    </div>
  );
}

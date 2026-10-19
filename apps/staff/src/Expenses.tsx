import { useEffect, useState } from 'react';
import { API_URL, Button, ErrorNote, Field, Note, kes, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Modal } from './MemberForm';
import { Card, EmptyState, PageHeader, Section, SidePanel, Stat, StatTiles, StatusChip, Toolbar } from './ui';
import { Loaded } from './money-bits';
import { ExpenseBudgets, ExpenseReports, ExpenseRules } from './ExpenseTabs';
import './expenses.css';

const day = (d?: string | null) => {
  if (!d) return '-';
  const x = new Date(String(d).slice(0, 10) + 'T00:00:00Z');
  return isNaN(+x) ? String(d) : x.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
};
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
const kesWhole = (cents: number) => kes(cents).replace(/\.00$/, '');
const MAX_FILES = 3;
const STATUS_TABS: [string, string][] = [['', 'All'], ['submitted,awaiting_second', 'Waiting for approval'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['voided', 'Voided']];

function StatusChips({ e }: { e: any }) {
  return (
    <span className="ex-chips">
      {e.status === 'approved' && <StatusChip tone="done">{e.autoApproved ? 'Approved (automatic)' : 'Approved'}</StatusChip>}
      {e.status === 'submitted' && <StatusChip tone="wait">Waiting</StatusChip>}
      {e.status === 'awaiting_second' && <StatusChip tone="info">Needs a second approver</StatusChip>}
      {e.status === 'rejected' && <StatusChip tone="bad">Rejected</StatusChip>}
      {e.status === 'voided' && <StatusChip tone="off">Voided</StatusChip>}
      {e.kind === 'claim' && <StatusChip tone="info">Claim</StatusChip>}
      {e.kind === 'claim' && e.status === 'approved' && (e.paid ? <StatusChip tone="done">Paid</StatusChip> : <StatusChip tone="wait">To pay</StatusChip>)}
    </span>
  );
}

function Receipts({ e }: { e: any }) {
  if (e.files > 0) return <span className="ex-clip" title={`${e.files} receipt${e.files === 1 ? '' : 's'}`}>&#128206; {e.files}</span>;
  if (e.status === 'rejected' || e.status === 'voided') return <span className="tiny">-</span>;
  return <span className="ex-noreceipt" title={e.noReceiptReason || 'No receipt and no reason given'} tabIndex={0}><StatusChip tone="bad">No receipt</StatusChip></span>;
}

const orgParam = (s: ReturnType<typeof useSession>) => (s.orgs.length > 1 ? `org=${encodeURIComponent(s.grant.org.id)}` : '');
const withOrg = (s: ReturnType<typeof useSession>, p: string) => { const o = orgParam(s); return o ? p + (p.includes('?') ? '&' : '?') + o : p; };

/* ---------- receipts: shrink photos, read files ---------- */
type Pick = { name: string; mime: string; data: string; preview?: string };
const b64 = (blob: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(new Error('read')); r.readAsDataURL(blob); });
const rawBytes = (b: string) => Math.floor(b.length * 0.75) - (b.endsWith('==') ? 2 : b.endsWith('=') ? 1 : 0);

async function shrink(file: File): Promise<Pick> {
  const url = URL.createObjectURL(file);
  try {
    const img: HTMLImageElement = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('img')); i.src = url; });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    let q = 0.8, data = '';
    for (let i = 0; i < 8; i++) {
      const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('blob'))), 'image/jpeg', q));
      data = await b64(blob);
      if (rawBytes(data) < 1.1 * 1024 * 1024) break;
      q -= 0.1;
      if (q < 0.2) { c.width = Math.round(c.width * 0.8); c.height = Math.round(c.height * 0.8); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height); q = 0.6; }
    }
    return { name: file.name.replace(/\.[^.]+$/, '') + '.jpg', mime: 'image/jpeg', data, preview: `data:image/jpeg;base64,${data}` };
  } finally { URL.revokeObjectURL(url); }
}
async function toPick(file: File): Promise<Pick> {
  if (file.type === 'application/pdf') {
    if (file.size > 1.2 * 1024 * 1024) throw new Error(`${file.name} is a PDF over 1.2 MB. Use a smaller PDF or take a photo instead.`);
    return { name: file.name, mime: 'application/pdf', data: await b64(file) };
  }
  if (file.type.startsWith('image/')) return shrink(file);
  throw new Error(`${file.name} is not a photo or PDF.`);
}

function FilePicker({ files, setFiles, max = MAX_FILES, onError }: { files: Pick[]; setFiles: (f: Pick[]) => void; max?: number; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const add = async (list: FileList | null) => {
    if (!list) return;
    onError(''); setBusy(true);
    let cur = [...files];
    for (const f of Array.from(list)) {
      if (cur.length >= max) { onError(`You can attach up to ${max} receipts.`); break; }
      try { cur = [...cur, await toPick(f)]; } catch (e: any) { onError(e?.message === 'img' ? `${f.name} could not be read as a photo.` : e?.message ?? 'Could not read that file.'); }
    }
    setFiles(cur); setBusy(false);
  };
  return (
    <div className="stack">
      {files.length > 0 && (
        <div className="ex-thumbs">
          {files.map((f, i) => (
            <div className="ex-thumb" key={i} style={{ cursor: 'default' }}>
              {f.preview ? <img src={f.preview} alt={f.name} /> : <span className="ex-pdf">PDF<br /><span className="tiny ex-wrap">{f.name}</span></span>}
              <button type="button" className="x" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>&times;</button>
            </div>
          ))}
        </div>
      )}
      {files.length < max && (
        <label className="btn ghost small" style={{ width: 'fit-content', cursor: 'pointer' }}>
          {busy ? 'Preparing...' : files.length ? 'Add another' : 'Take a photo or choose a file'}
          <input type="file" accept="image/*,application/pdf" capture="environment" multiple style={{ display: 'none' }} disabled={busy} data-testid="receipt-input" onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
        </label>
      )}
    </div>
  );
}

/* ---------- authenticated receipt thumbnails ---------- */
function Receipt({ e, f }: { e: any; f: any }) {
  const [url, setUrl] = useState('');
  const [big, setBig] = useState(false);
  const [fail, setFail] = useState(false);
  const pdf = f.mime === 'application/pdf';
  useEffect(() => {
    let live = true; let u = '';
    const token = api.getToken();
    fetch(`${API_URL}/expenses/${e.id}/files/${f.id}`, { headers: { 'x-churchos-app': 'staff', ...(token ? { authorization: `Bearer ${token}` } : {}) } })
      .then((r) => { if (!r.ok) throw new Error('x'); return r.blob(); })
      .then((b) => { u = URL.createObjectURL(b); if (live) setUrl(u); })
      .catch(() => live && setFail(true));
    return () => { live = false; if (u) URL.revokeObjectURL(u); };
  }, [e.id, f.id]);
  return (
    <>
      <button type="button" className="ex-thumb" onClick={() => url && setBig(true)} aria-label={`Open receipt ${f.name}`}>
        {fail ? <span className="tiny">Could not load</span> : !url ? <span className="tiny">Loading...</span> : pdf ? <span className="ex-pdf">PDF</span> : <img src={url} alt={f.name} />}
      </button>
      {big && (
        <Modal title={f.name} onClose={() => setBig(false)}>
          {pdf ? <iframe className="ex-preview-frame" src={url} title={f.name} /> : <img className="ex-preview" src={url} alt={f.name} />}
          <div style={{ marginTop: 8 }}><a className="btn ghost small" href={url} target="_blank" rel="noreferrer">Open in a new tab</a></div>
        </Modal>
      )}
    </>
  );
}

/* ---------- record ---------- */
function Record({ setup, onClose, onDone }: { setup: any; onClose: () => void; onDone: (m: string) => void }) {
  const s = useSession();
  const st = setup.settings;
  const branches: any[] = setup.branches.filter((b: any) => b.canRecord);
  const [branchId, setBranchId] = useState(s.scope !== 'all' && branches.some((b) => b.id === s.scope) ? s.scope : branches[0]?.id ?? '');
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [payee, setPayee] = useState('');
  const [method, setMethod] = useState(setup.methods[0]?.key ?? '');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [noRcpt, setNoRcpt] = useState('');
  const [files, setFiles] = useState<Pick[]>([]);
  const [override, setOverride] = useState('');
  const [needOverride, setNeedOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [fileErr, setFileErr] = useState('');
  const amt = Number(amount.replace(/,/g, ''));
  const cents = Math.round((isFinite(amt) ? amt : 0) * 100);
  const projects: any[] = setup.projects.filter((p: any) => p.open && p.branchId === branchId);
  const project = projects.find((p) => p.id === projectId);
  const needsReceipt = cents > st.receiptRequiredAbove;
  const auto = st.approvalMode === 'above_limit' && cents > 0 && cents <= st.approvalLimit;
  const two = st.twoApproverLimit != null && cents > st.twoApproverLimit;
  const short = project?.restricted && cents > Number(project.available ?? 0);
  useEffect(() => { if (projectId && !projects.some((p) => p.id === projectId)) setProjectId(''); }, [branchId]); // eslint-disable-line

  const submit = async () => {
    setErr('');
    if (!(amt > 0)) return setErr('Enter the amount in KES.');
    if (!categoryId) return setErr('Choose a category.');
    if (!payee.trim()) return setErr('Say who was paid.');
    setBusy(true);
    try {
      const r: any = await api.post(withOrg(s, '/expenses'), {
        branchId, date, amount: amt, categoryId, ...(projectId ? { projectId } : {}), payee: payee.trim(), method,
        ...(reference.trim() ? { reference: reference.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}),
        ...(files.length === 0 && noRcpt.trim() ? { noReceiptReason: noRcpt.trim() } : {}),
        ...(files.length ? { files: files.map((f) => ({ name: f.name, mime: f.mime, data: f.data })) } : {}),
        ...(needOverride && override.trim() ? { overrideReason: override.trim() } : {}),
      });
      onDone(r.autoApproved ? `Recorded and approved straight away (${r.code}).` : `Recorded (${r.code}) and sent for approval.`);
    } catch (e: any) {
      if (e.code === 'fund_short' && setup.can.settings) setNeedOverride(true);
      setErr(friendly(e.message)); setBusy(false);
    }
  };

  return (
    <Modal title="Record an expense" onClose={onClose}>
      <div className="stack">
        <Note>ChurchOS only records what the church spent. It does not send any money.</Note>
        {branches.length > 1 && <Field label="Branch"><select value={branchId} onChange={(e) => setBranchId(e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
        <div className="ex-grid">
          <Field label="Date"><input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Amount (KES)"><input inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        </div>
        {cents > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            {needsReceipt && <div className="tiny">Above {kesWhole(st.receiptRequiredAbove)}: attach a receipt or say why there is none.</div>}
            {auto && <div className="tiny">This will be approved straight away ({kesWhole(st.approvalLimit)} or less).</div>}
            {!auto && <div className="tiny">This needs approval by someone else{two ? `, and two different people must approve it because it is above ${kesWhole(st.twoApproverLimit)}` : ''}.</div>}
          </div>
        )}
        <Field label="Category"><select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">Choose...</option>{setup.categories.filter((c: any) => c.active).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        {projects.length > 0 && (
          <Field label="Project" hint="Optional">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">No project</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.restricted ? ' (restricted fund)' : ''}</option>)}
            </select>
          </Field>
        )}
        {project?.restricted && (
          <Note tone={short ? 'warn' : undefined}>Restricted fund: {kesWhole(project.available)} available.{short ? ' This is more than the fund has, so it will be refused unless the owner overrides.' : ''}</Note>
        )}
        <Field label="Paid to"><input value={payee} maxLength={120} onChange={(e) => setPayee(e.target.value)} /></Field>
        <div className="ex-grid">
          <Field label="How it was paid"><select value={method} onChange={(e) => setMethod(e.target.value)}>{setup.methods.map((m: any) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></Field>
          <Field label="Reference" hint="e.g. M-Pesa code"><input value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} /></Field>
        </div>
        <Field label="Note" hint="Optional"><textarea rows={2} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Field label="Receipts" hint={`Up to ${MAX_FILES} photos or PDFs`}><FilePicker files={files} setFiles={setFiles} onError={setFileErr} /></Field>
        {fileErr && <ErrorNote>{fileErr}</ErrorNote>}
        {files.length === 0 && needsReceipt && <Field label="Why is there no receipt?"><textarea rows={2} maxLength={300} value={noRcpt} onChange={(e) => setNoRcpt(e.target.value)} /></Field>}
        {needOverride && (
          <div className="ex-amber stack">
            <b>Owner override</b>
            <div className="tiny">Only the owner can spend more than a restricted fund holds. Say why (at least 10 characters). This is recorded.</div>
            <textarea rows={2} maxLength={300} value={override} onChange={(e) => setOverride(e.target.value)} aria-label="Override reason" />
          </div>
        )}
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="mn-btns end"><Button kind="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={submit}>{busy ? 'Saving...' : needOverride ? 'Record with override' : 'Record expense'}</Button></div>
      </div>
    </Modal>
  );
}

/* ---------- detail ---------- */
function Detail({ id, setup, onClose, onChanged, toast }: { id: string; setup: any; onClose: () => void; onChanged: () => void; toast: (m: string, tone?: 'good' | 'bad') => void }) {
  const s = useSession();
  const d = useAsync<any>(() => api.get(withOrg(s, `/expenses/${id}`)), [id]);
  const e = d.data;
  const [mode, setMode] = useState<'' | 'reject' | 'void' | 'paid' | 'approve'>('');
  const [text, setText] = useState('');
  const [override, setOverride] = useState('');
  const [needOverride, setNeedOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [add, setAdd] = useState<Pick[]>([]);
  const [fileErr, setFileErr] = useState('');
  const can = setup.can;
  const done = (m: string) => { toast(m); onChanged(); onClose(); };
  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setErr('');
    try { done(await fn()); }
    catch (x: any) { if (x.code === 'fund_short' && can.settings) setNeedOverride(true); setErr(friendly(x.message)); setBusy(false); }
  };
  const decide = (approve: boolean) => {
    if (!approve && !text.trim()) return setErr('Write why you are rejecting this.');
    if (needOverride && override.trim().length < 10) return setErr('The override reason needs at least 10 characters.');
    run(async () => {
      const r: any = await api.post(withOrg(s, `/expenses/${id}/decide`), { approve, ...(!approve ? { note: text.trim() } : text.trim() ? { note: text.trim() } : {}), ...(needOverride && override.trim() ? { overrideReason: override.trim() } : {}) });
      return r.status === 'awaiting_second' ? 'Approved. It now needs a second approver.' : r.status === 'approved' ? 'Approved.' : 'Rejected.';
    });
  };
  const voidIt = () => {
    if (text.trim().length < 5) return setErr('Write a reason of at least 5 characters.');
    run(async () => { await api.post(withOrg(s, `/expenses/${id}/void`), { reason: text.trim() }); return 'Voided. The record is kept but no longer counts.'; });
  };
  const paid = () => {
    if (!text.trim()) return setErr('Enter the payment reference.');
    run(async () => { await api.post(withOrg(s, `/expenses/${id}/paid`), { reference: text.trim() }); return 'Marked as paid.'; });
  };
  const upload = () => run(async () => { for (const f of add) await api.post(withOrg(s, `/expenses/${id}/files`), { name: f.name, mime: f.mime, data: f.data }); return 'Receipt added.'; });
  const reset = (m: typeof mode) => { setMode(m); setText(''); setErr(''); };
  const waiting = e && (e.status === 'submitted' || e.status === 'awaiting_second');
  const mine = !!e && (e.recordedById ? e.recordedById === s.user.id : e.recordedBy === s.user.name);

  return (
    <SidePanel title={e ? `${e.code}: ${e.payee}` : 'Expense'} subtitle={e ? `${e.branch} · ${day(e.date)}` : undefined} onClose={onClose} width={520}>
      <Loaded loading={d.loading} error={d.error} hasData={!!e} rows={3} height={64}>
        {e && (
          <div className="stack">
            <div className="row between" style={{ alignItems: 'flex-start' }}><StatusChips e={e} /><b style={{ fontSize: 20 }}>{kes(e.amount)}</b></div>
            <div className="ex-grid">
              <div><span className="k">Date</span>{day(e.date)}</div>
              <div><span className="k">Paid to</span>{e.payee}</div>
              <div><span className="k">Category</span>{e.category}</div>
              <div><span className="k">Branch</span>{e.branch}</div>
              {e.project && <div><span className="k">Project</span>{e.project}</div>}
              <div><span className="k">How paid</span>{e.methodLabel || e.method}{e.reference ? `, ${e.reference}` : ''}</div>
              {e.note && <div style={{ gridColumn: '1 / -1' }}><span className="k">Note</span>{e.note}</div>}
              {e.noReceiptReason && <div style={{ gridColumn: '1 / -1' }}><span className="k">No receipt because</span>{e.noReceiptReason}</div>}
            </div>
            {e.restrictedFund && <div className="tiny">Paid from a restricted fund.</div>}
            <div>
              <b>Receipts</b>
              {(e.fileList ?? []).length === 0 ? <div className="tiny">No receipts attached.</div> : <div className="ex-thumbs" style={{ marginTop: 6 }}>{e.fileList.map((f: any) => <Receipt key={f.id} e={e} f={f} />)}</div>}
            </div>
            <div>
              <b>What happened</b>
              <ul className="ex-trail">
                <li>{e.kind === 'claim' ? 'Claim made' : 'Recorded'} by {e.recordedBy} on {when(e.recordedAt)}</li>
                {e.firstApprover && <li>First approved by {e.firstApprover}</li>}
                {e.status === 'approved' && (e.autoApproved ? <li>Approved automatically</li> : <li>Approved by {e.approver} on {when(e.approvedAt)}</li>)}
                {e.status === 'rejected' && <li>Rejected by {e.approver} on {when(e.approvedAt)}{e.decisionNote ? `: "${e.decisionNote}"` : ''}</li>}
                {e.status === 'approved' && e.decisionNote && <li>Note: {e.decisionNote}</li>}
                {e.status === 'voided' && <li>Voided by {e.voidedBy} on {when(e.voidedAt)}: &ldquo;{e.voidReason}&rdquo;</li>}
                {e.paid && <li>Paid on {when(e.paidAt)} by {e.paidBy}, reference {e.paidReference}</li>}
              </ul>
            </div>
            {e.overridden && <div className="ex-amber"><b>Owner override.</b> Spent more than the restricted fund held. Reason: {e.overrideReason}</div>}

            {waiting && e.needsTwo && e.status === 'submitted' && e.mayApprove && <Note tone="info">This needs two approvers: you are the first.</Note>}
            {waiting && e.status === 'awaiting_second' && <Note tone="info">One person has approved. A different person must give the second approval.</Note>}
            {waiting && !e.mayApprove && <div className="tiny">You cannot approve this{e.recordedBy === s.user.name ? ', because you recorded it. Someone else must approve it' : ''}.</div>}

            {mode === '' && (
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {waiting && e.mayApprove && <><Button disabled={busy} onClick={() => decide(true)}>{e.needsTwo && e.status === 'submitted' ? 'Approve (first)' : 'Approve'}</Button><Button kind="danger" onClick={() => reset('reject')}>Reject</Button></>}
                {e.status === 'approved' && can.approve && <Button kind="danger" onClick={() => reset('void')}>Void</Button>}
                {waiting && !can.approve && <Button kind="danger" onClick={() => reset('void')}>Void</Button>}
                {e.kind === 'claim' && e.status === 'approved' && !e.paid && can.record && <Button onClick={() => reset('paid')}>Mark as paid</Button>}
              </div>
            )}
            {mode === 'reject' && (
              <div className="stack"><Field label="Why are you rejecting this?" hint="The person who recorded it will see this."><textarea rows={3} maxLength={300} value={text} onChange={(x) => setText(x.target.value)} /></Field>
                <div className="mn-btns end"><Button kind="ghost" onClick={() => reset('')}>Back</Button><Button kind="danger" disabled={busy} onClick={() => decide(false)}>{busy ? 'Saving...' : 'Reject'}</Button></div></div>
            )}
            {mode === 'void' && (
              <div className="stack"><Note tone="warn">Voiding keeps the record and removes it from the totals. An approved expense cannot be edited.</Note>
                <Field label="Why is it being voided?"><textarea rows={3} maxLength={300} value={text} onChange={(x) => setText(x.target.value)} /></Field>
                <div className="mn-btns end"><Button kind="ghost" onClick={() => reset('')}>Back</Button><Button kind="danger" disabled={busy} onClick={voidIt}>{busy ? 'Saving...' : 'Void this expense'}</Button></div></div>
            )}
            {mode === 'paid' && (
              <div className="stack"><Note>This only records that the church paid this person back elsewhere. ChurchOS sends no money.</Note>
                <Field label="Payment reference" hint="e.g. the M-Pesa code"><input value={text} maxLength={80} onChange={(x) => setText(x.target.value)} /></Field>
                <div className="mn-btns end"><Button kind="ghost" onClick={() => reset('')}>Back</Button><Button disabled={busy} onClick={paid}>{busy ? 'Saving...' : 'Mark as paid'}</Button></div></div>
            )}
            {needOverride && (
              <div className="ex-amber stack"><b>Owner override</b><div className="tiny">The restricted fund has less than this. Say why you are going on (at least 10 characters).</div>
                <textarea rows={2} maxLength={300} value={override} onChange={(x) => setOverride(x.target.value)} aria-label="Override reason" />
                <div><Button disabled={busy} onClick={() => decide(true)}>Approve with override</Button></div></div>
            )}
            {waiting && mine && (e.fileList ?? []).length < MAX_FILES && mode === '' && (
              <div className="stack"><b>Add a receipt</b><FilePicker files={add} setFiles={setAdd} max={MAX_FILES - (e.fileList ?? []).length} onError={setFileErr} />
                {fileErr && <ErrorNote>{fileErr}</ErrorNote>}
                {add.length > 0 && <div><Button small disabled={busy} onClick={upload}>{busy ? 'Saving...' : 'Save receipt'}</Button></div>}</div>
            )}
            {err && <ErrorNote>{err}</ErrorNote>}
          </div>
        )}
      </Loaded>
    </SidePanel>
  );
}

/* ---------- list ---------- */
function ExpenseList({ setup, rec, setRec }: { setup: any; rec: boolean; setRec: (v: boolean) => void }) {
  const s = useSession();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [category, setCategory] = useState('');
  const [project, setProject] = useState('');
  const [branch, setBranch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [unpaid, setUnpaid] = useState(false);
  const [open, setOpen] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const query = (csv = false) => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (kind) p.set('kind', kind);
    if (category) p.set('category', category);
    if (project) p.set('project', project);
    const b = branch || (s.scope !== 'all' ? s.scope : '');
    if (b) p.set('branchId', b);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (q.trim()) p.set('q', q.trim());
    if (unpaid) p.set('unpaid', '1');
    if (csv) p.set('csv', '1');
    const o = orgParam(s); if (o) p.set('org', s.grant.org.id);
    const str = p.toString();
    return str ? '?' + str : '';
  };
  const key = query();
  const d = useAsync<any>(() => api.get('/expenses' + key), [key]);
  const list: any[] = d.data?.expenses ?? [];
  const x = d.data?.summary;

  const csv = async () => {
    setBusy(true); setErr('');
    try {
      const token = api.getToken();
      const res = await fetch(`${API_URL}/expenses${query(true)}`, { headers: { 'x-churchos-app': 'staff', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      if (!res.ok) throw new Error('Could not download the file. Try again.');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = 'expenses.csv'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) { setErr(friendly(e?.message)); }
    setBusy(false);
  };
  const clear = () => { setUnpaid(false); setKind(''); };
  const waitingKey = 'submitted,awaiting_second';
  const projectsAll: any[] = setup.projects;

  const [more, setMore] = useState(false);
  const filtered = !!(status || kind || category || project || q || from || to || unpaid);
  return (
    <>
      {toast.node}
      <StatTiles>
        <Stat label="To approve" value={x ? x.toApprove : '-'} tone={x?.toApprove > 0 ? 'wait' : undefined} onClick={() => { clear(); setStatus(waitingKey); }} />
        <Stat label="Approved so far" value={x ? kesWhole(x.approvedTotal) : '-'} tone="good" onClick={() => { clear(); setStatus('approved'); }} />
        <Stat label="Claims to pay" value={x ? x.claimsToPay : '-'} onClick={() => { setKind('claim'); setStatus('approved'); setUnpaid(true); }} />
      </StatTiles>
      <Section>
        <Toolbar end={<Button kind="ghost" small onClick={csv} disabled={busy}>{busy ? 'Preparing...' : 'Download CSV'}</Button>}>
          <input type="search" aria-label="Search expenses" placeholder="Search payee, code or note" value={q} onChange={(e) => setQ(e.target.value)} />
        </Toolbar>
        <div className="chips">
          {STATUS_TABS.map(([k, t]) => <button key={k || 'all'} type="button" className={'chip' + (status === k && !unpaid ? ' on' : '')} onClick={() => { setUnpaid(false); setStatus(k); }}>{t}</button>)}
          {unpaid && <button type="button" className="chip on" onClick={() => setUnpaid(false)}>Claims to pay &times;</button>}
          <button type="button" className={'chip' + (more ? ' on' : '')} aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'Fewer filters' : 'More filters'}</button>
        </div>
        {more && (
          <Card>
            <div className="mn-fields tight">
              <Field label="Type"><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Expenses and claims</option><option value="expense">Expenses</option><option value="claim">Claims</option></select></Field>
              <Field label="Category"><select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All categories</option>{setup.categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              <Field label="Project"><select value={project} onChange={(e) => setProject(e.target.value)}><option value="">All projects</option>{projectsAll.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
              {setup.branches.length > 1 && <Field label="Branch"><select value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">{s.scope === 'all' ? 'All branches' : 'Selected branch'}</option>{setup.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
              <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            </div>
          </Card>
        )}
        {err && <Note tone="bad">{err}</Note>}
        <Loaded loading={d.loading} error={d.error} hasData={!!d.data} rows={5}>
          {list.length === 0 ? (
            <Card><EmptyState icon="receipt" title={filtered ? 'Nothing matches these filters' : 'No expenses yet'} text={filtered ? 'Try clearing a filter.' : 'Record the first one with the button at the top.'} /></Card>
          ) : (
            <Card pad={false} className="mn-wrap">
              <div className="mn-scroll">
                <table className="mn-table">
                  <thead><tr><th>Date</th><th>Paid to</th><th>Category</th><th className="num">Amount</th><th>Status</th><th>Recorded by</th><th>Receipts</th><th /></tr></thead>
                  <tbody>
                    {list.map((e) => (
                      <tr key={e.id} className="tap" onClick={() => setOpen(e.id)}>
                        <td className="mn-first" data-l="Date">{day(e.date)}</td>
                        <td data-l="Paid to"><span><b>{e.payee}</b><span className="mn-sub mono">{e.code}</span></span></td>
                        <td data-l="Category"><span>{e.category}{e.project && <span className="mn-sub">{e.project}</span>}</span></td>
                        <td className="num" data-l="Amount"><b>{kes(e.amount)}</b></td>
                        <td data-l="Status"><StatusChips e={e} /></td>
                        <td data-l="Recorded by">{e.recordedBy}</td>
                        <td data-l="Receipts" onClick={(ev) => ev.stopPropagation()}><Receipts e={e} /></td>
                        <td className="mn-act">{e.mayApprove && <Button small onClick={() => setOpen(e.id)}>Approve</Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Loaded>
      </Section>
      {open && <Detail id={open} setup={setup} onClose={() => setOpen('')} onChanged={d.reload} toast={toast.show} />}
      {rec && <Record setup={setup} onClose={() => setRec(false)} onDone={(m) => { setRec(false); toast.show(m); d.reload(); }} />}
    </>
  );
}

export function Expenses() {
  const s = useSession();
  const setupQ = useAsync<any>(() => api.get(withOrg(s, '/expenses/setup')), [s.grant.org.id]);
  const [tab, setTab] = useState('expenses');
  const [rec, setRec] = useState(false);
  const setup = setupQ.data;
  const can = setup?.can ?? {};
  const tabs: { id: string; label: string }[] = [{ id: 'expenses', label: 'Expenses' }];
  if (can.view || can.approve || can.manage || can.settings) tabs.push({ id: 'budgets', label: 'Budgets' }, { id: 'reports', label: 'Reports' });
  if (can.settings || can.manage) tabs.push({ id: 'rules', label: 'Rules' });
  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle="What the church has spent. ChurchOS records it and does not send any money."
        actions={can.record ? <Button onClick={() => { setTab('expenses'); setRec(true); }}>Record an expense</Button> : undefined}
        tabs={tabs.length > 1 ? tabs : undefined}
        tab={tab}
        onTab={setTab}
      />
      <Loaded loading={setupQ.loading} error={setupQ.error} hasData={!!setup} rows={4}>
        {setup && (
          <>
            {tab === 'expenses' && <ExpenseList setup={setup} rec={rec} setRec={setRec} />}
            {tab === 'budgets' && <ExpenseBudgets />}
            {tab === 'reports' && <ExpenseReports />}
            {tab === 'rules' && <ExpenseRules />}
          </>
        )}
      </Loaded>
    </>
  );
}

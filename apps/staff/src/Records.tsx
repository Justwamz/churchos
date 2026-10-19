import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, CertificateCard, ErrorNote, Field, Note, dateOnly, kes, printCertificate, shortDate, useAsync, useToast, type CertificatePayload } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Hist } from './bits';
import { Gate, Modal, useDebounced } from './MemberForm';
import { Icon } from './icons';
import { Card, EmptyState, PageHeader, SidePanel, Skeleton, StatusChip, Toolbar } from './ui';
import './people.css';

const MAX_BYTES = 3 * 1024 * 1024;
const KIND: Record<string, string> = { baptism: 'Baptism', marriage: 'Marriage' };
const STATUS_TEXT: Record<string, string> = { draft: 'Draft', pending_approval: 'Waiting for approval', approved: 'Approved', rejected: 'Rejected' };

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('We could not read that file. Please try again.'));
    r.readAsDataURL(file);
  });
}

const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

/** Shows the card at its fixed 1040px width, shrunk to fit the space available. */
export function ScaledCard({ c }: { c: CertificatePayload }) {
  const ref = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setZoom(Math.min(1, Math.max(0.2, el.clientWidth / 1040)));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return <div ref={ref} style={{ width: '100%', overflow: 'hidden' }}><div style={{ zoom } as any}><CertificateCard c={c} /></div></div>;
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <Modal title={title} onClose={onClose}>{children}</Modal>;
}

const STATUS_TONE: Record<string, 'wait' | 'done' | 'bad' | 'off'> = { draft: 'off', pending_approval: 'wait', approved: 'done', rejected: 'bad' };
const StatusPill = ({ status }: { status: string }) => <StatusChip tone={STATUS_TONE[status] ?? 'off'}>{STATUS_TEXT[status] ?? status}</StatusChip>;

const joinList = (v: any) => (Array.isArray(v) ? v.join(', ') : '');

/** Label and value pairs for the details of a record, used for the detail view and for comparing changes. */
function factRows(r: any): [string, string][] {
  const d = r.details ?? {};
  const rows: [string, string][] = [];
  if (r.kind === 'marriage') {
    for (let i = 0; i < 2; i++) { const p = (d.parties ?? [])[i]; rows.push([`Party ${i + 1}`, p ? p.name + (p.membershipId ? ' (member)' : '') : '']); }
    rows.push(['Date of marriage', r.event_date ? dateOnly(r.event_date) : '']);
    rows.push(['Place', r.place ?? '']);
    rows.push(['Officiant', r.officiant ?? '']);
    rows.push(['Certificate number', d.certificateNumber ?? '']);
    rows.push(['Issuing authority', d.issuingAuthority ?? '']);
    rows.push(['Witnesses', joinList(d.witnesses)]);
  } else {
    rows.push(['Person baptised', r.subject_name ?? '']);
    rows.push(['Date of baptism', r.event_date ? dateOnly(r.event_date) : '']);
    rows.push(['Place', r.place ?? '']);
    rows.push(['Officiant', r.officiant ?? '']);
    rows.push(['Date of birth', d.dob ? dateOnly(d.dob) : '']);
    rows.push(['Birthplace', d.birthplace ?? '']);
    rows.push(['Father', d.father ?? '']);
    rows.push(['Mother', d.mother ?? '']);
    rows.push(['Sponsors', joinList(d.sponsors)]);
  }
  rows.push(['Register number', r.register_number ?? '']);
  return rows;
}

function statusLine(r: any): string {
  const by = r.created_by_name || 'someone';
  const last = r.last_edited_by_name || by;
  if (r.status === 'draft') return `Saved as a draft by ${last}. It has not been sent for approval yet.`;
  if (r.status === 'pending_approval') return `Entered by ${by}, waiting for a second person to approve it.`;
  if (r.status === 'rejected') return `Sent back by the approver${r.rejection_reason ? `: ${r.rejection_reason}` : '.'} ${last} can correct it and send it again.`;
  const base = `Entered by ${by}${r.approved_at ? `, approved on ${dateOnly(r.approved_at)}` : ', approved'}.`;
  return r.has_pending_changes ? `${base} Changes by ${last} are waiting for a second person to approve them.` : base;
}

// ---------- person picker ----------

type Person = { name: string; membershipId: string | null };

function PersonPicker({ label, value, onChange }: { label: string; value: Person; onChange: (p: Person) => void }) {
  const s = useSession();
  const [open, setOpen] = useState(false);
  const dq = useDebounced(value.name.trim());
  const [res, setRes] = useState<any[] | null>(null);
  useEffect(() => {
    if (!open || value.membershipId || dq.length < 2) { setRes(null); return; }
    let alive = true;
    api.get<any[]>('/members' + s.qs({ q: dq, branch: undefined })).then((r) => alive && setRes(r)).catch(() => alive && setRes([]));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq, open, value.membershipId]);
  return (
    <Field label={label} hint={value.membershipId ? 'Linked to a member of your church.' : 'Search for a member, or type the name of someone outside the church.'}>
      <div className="stack" style={{ gap: 6 }}>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input style={{ flex: 1, minWidth: 0 }} value={value.name} onFocus={() => setOpen(true)} onChange={(e) => onChange({ name: e.target.value, membershipId: null })} placeholder="Full name" />
          {value.membershipId && <Button small kind="ghost" onClick={() => onChange({ name: value.name, membershipId: null })}>Unlink</Button>}
        </div>
        {open && !value.membershipId && res && res.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            {res.slice(0, 6).map((m) => (
              <button type="button" key={m.id} className="pp-pick"
                onClick={() => { onChange({ name: m.full_name, membershipId: m.id }); setOpen(false); }}>
                {m.full_name} <span className="tiny">&nbsp;{m.member_number}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Field>
  );
}

// ---------- form ----------

function RecordForm({ existing, onClose, onDone }: { existing?: any; onClose: () => void; onDone: (msg: string) => void }) {
  const s = useSession();
  const d = existing?.details ?? {};
  const [kind, setKind] = useState<'baptism' | 'marriage' | ''>(existing?.kind ?? '');
  const [branchId, setBranchId] = useState<string>(existing?.branch_id ?? (s.scope !== 'all' ? s.scope : s.branches[0]?.id ?? ''));
  const [subject, setSubject] = useState<Person>({ name: existing?.kind === 'baptism' ? existing.subject_name : '', membershipId: existing?.kind === 'baptism' ? existing.membership_id ?? null : null });
  const [parties, setParties] = useState<Person[]>(existing?.kind === 'marriage' && d.parties?.length === 2
    ? d.parties.map((p: any) => ({ name: p.name, membershipId: p.membershipId ?? null })) : [{ name: '', membershipId: null }, { name: '', membershipId: null }]);
  const [date, setDate] = useState<string>(existing?.event_date ? String(existing.event_date).slice(0, 10) : '');
  const [place, setPlace] = useState<string>(existing?.place ?? '');
  const [officiant, setOfficiant] = useState<string>(existing?.officiant ?? '');
  const [reg, setReg] = useState<string>(existing?.register_number ?? '');
  const [dob, setDob] = useState<string>(d.dob ?? '');
  const [birthplace, setBirthplace] = useState<string>(d.birthplace ?? '');
  const [father, setFather] = useState<string>(d.father ?? '');
  const [mother, setMother] = useState<string>(d.mother ?? '');
  const [sponsors, setSponsors] = useState<string>(joinList(d.sponsors));
  const [certNo, setCertNo] = useState<string>(d.certificateNumber ?? '');
  const [authority, setAuthority] = useState<string>(d.issuingAuthority ?? '');
  const [witnesses, setWitnesses] = useState<string>(joinList(d.witnesses));
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editing = !!existing;
  const approvedEdit = editing && existing.status === 'approved';
  const hasScan = !!file || !!existing?.has_file;

  const pickFile = (f?: File) => {
    setError('');
    if (!f) return;
    if (f.size > MAX_BYTES) { setError('That file is larger than 3 MB. Please choose a smaller file or a lower-resolution photo.'); if (fileInput.current) fileInput.current.value = ''; return; }
    if (f.size === 0) { setError('That file is empty. Please choose another one.'); return; }
    setFile(f);
  };

  const save = async (submit: boolean) => {
    setError('');
    if (kind === 'marriage' && submit && !hasScan) { setError('Please attach the scan or photo of the marriage certificate before sending it for approval.'); return; }
    setBusy(true);
    try {
      const body: any = { kind, eventDate: date, place, officiant, registerNumber: reg, submit };
      if (kind === 'baptism') Object.assign(body, { subjectName: subject.name, membershipId: subject.membershipId, dob: dob || undefined, birthplace, father, mother, sponsors });
      else Object.assign(body, { parties, certificateNumber: certNo, issuingAuthority: authority, witnesses });
      if (file) body.file = { filename: file.name, mime: file.type, data: await readAsBase64(file) };
      if (editing) {
        await api.put(`/records/${existing.id}`, body);
        if (!approvedEdit && submit) await api.post(`/records/${existing.id}/submit`);
        onDone(approvedEdit ? 'Your changes are saved. They wait for a second person to approve them.' : submit ? 'Sent for approval.' : 'Saved.');
      } else {
        await api.post('/records', { ...body, branchId });
        onDone(submit ? 'Sent for approval. A second person will check it.' : 'Saved as a draft.');
      }
    } catch (e: any) { setError(friendly(e.message)); }
    setBusy(false);
  };

  if (!kind) {
    return (
      <Dialog title="New record" onClose={onClose}>
        <ol className="pp-steps"><li className="on"><b>1</b>Kind</li><li><b>2</b>Details</li><li><b>3</b>Send for approval</li></ol>
        <p className="pp-note" style={{ margin: '8px 0 14px' }}>What would you like to record?</p>
        <div className="pp-kind">
          <button type="button" onClick={() => setKind('baptism')}><b>Baptism</b><span>Add the person, the date and the minister. A baptism card can be printed.</span></button>
          <button type="button" onClick={() => setKind('marriage')}><b>Marriage</b><span>Keep the details and a scan of the certificate. Not printed here.</span></button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={`${editing ? 'Edit' : 'New'} ${kind} record`} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save(true); }}>
        <ol className="pp-steps"><li className="done"><b>1</b>Kind</li><li className="on"><b>2</b>Details</li><li><b>3</b>Send for approval</li></ol>
        {approvedEdit && <Note tone="warn">This record is approved. Your changes will not show until a second person approves them.</Note>}
        {kind === 'marriage' && <Note tone="info">A marriage certificate is a legal document issued elsewhere. Upload the scan or photo and type the details exactly as they appear on it. ChurchOS does not print marriage certificates.</Note>}
        {!editing && s.branches.length > 1 && (
          <Field label="Branch"><select value={branchId} onChange={(e) => setBranchId(e.target.value)}>{s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        )}
        {kind === 'baptism'
          ? <PersonPicker label="Person baptised" value={subject} onChange={setSubject} />
          : <><PersonPicker label="First party" value={parties[0]} onChange={(p) => setParties([p, parties[1]])} /><PersonPicker label="Second party" value={parties[1]} onChange={(p) => setParties([parties[0], p])} /></>}
        <div className="grid cols-2">
          <Field label={kind === 'baptism' ? 'Date of baptism' : 'Date of marriage'}><input type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Place"><input value={place} onChange={(e) => setPlace(e.target.value)} /></Field>
          <Field label="Officiating minister"><input value={officiant} onChange={(e) => setOfficiant(e.target.value)} /></Field>
          <Field label="Register number (optional)"><input value={reg} onChange={(e) => setReg(e.target.value)} /></Field>
        </div>
        {kind === 'baptism' ? (
          <div className="grid cols-2">
            <Field label="Date of birth (optional)"><input type="date" max={today()} value={dob} onChange={(e) => setDob(e.target.value)} /></Field>
            <Field label="Birthplace (optional)"><input value={birthplace} onChange={(e) => setBirthplace(e.target.value)} /></Field>
            <Field label="Father (optional)"><input value={father} onChange={(e) => setFather(e.target.value)} /></Field>
            <Field label="Mother (optional)"><input value={mother} onChange={(e) => setMother(e.target.value)} /></Field>
            <Field label="Sponsors (optional)" hint="Separate names with commas."><input value={sponsors} onChange={(e) => setSponsors(e.target.value)} /></Field>
          </div>
        ) : (
          <>
            <div className="grid cols-2">
              <Field label="Number printed on the marriage certificate"><input value={certNo} onChange={(e) => setCertNo(e.target.value)} /></Field>
              <Field label="Issuing authority (optional)"><input value={authority} onChange={(e) => setAuthority(e.target.value)} /></Field>
              <Field label="Witnesses (optional)" hint="Separate names with commas."><input value={witnesses} onChange={(e) => setWitnesses(e.target.value)} /></Field>
            </div>
            <Field label="Scan or photo of the certificate" hint="PDF, JPG or PNG, up to 3 MB.">
              <div className="row">
                <input ref={fileInput} type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display: 'none' }} onChange={(e) => pickFile(e.target.files?.[0])} />
                <Button kind="ghost" onClick={() => fileInput.current?.click()}>{hasScan ? 'Choose a different file' : 'Choose a file'}</Button>
                <span className="tiny">{file ? file.name : existing?.has_file ? 'A scan is already attached.' : 'Nothing chosen yet.'}</span>
              </div>
            </Field>
          </>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="pp-form-foot">
          {approvedEdit
            ? <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes for approval'}</Button>
            : <><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Send for approval'}</Button><Button kind="ghost" disabled={busy} onClick={() => save(false)}>Save as draft</Button></>}
          <Button kind="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------- detail ----------

function Facts({ rows, compare }: { rows: [string, string][]; compare?: [string, string][] }) {
  return (
    <dl className="pp-facts">
      {rows.map(([k, v], i) => {
        const was = compare?.[i]?.[1];
        const changed = compare && was !== v;
        return (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{changed ? <><s className="pp-tiny">{was || 'empty'}</s> <b>{v || 'empty'}</b></> : (v || '-')}</dd>
          </div>
        );
      })}
    </dl>
  );
}

async function viewScan(id: string): Promise<void> {
  const res = await fetch(`${api.API_URL}/records/${id}/file`, { headers: { authorization: `Bearer ${api.getToken()}` } });
  if (!res.ok) throw new Error('We could not open the scan. Please try again.');
  window.open(URL.createObjectURL(await res.blob()));
}

function RecordDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const s = useSession();
  const toast = useToast();
  const d = useAsync<any>(() => api.get(`/records/${id}`), [id]);
  const issues = useAsync<any[]>(() => api.get(`/records/${id}/issues`), [id]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [card, setCard] = useState<CertificatePayload | null>(null);
  const [cardIsFinal, setCardIsFinal] = useState(false);
  const [pay, setPay] = useState<any>(null);
  const [confirmWaive, setConfirmWaive] = useState(false);
  const [copied, setCopied] = useState(false);
  const r = d.data;
  const canEdit = s.can('records.edit');
  const canApprove = s.can('records.approve');
  const changed = () => { d.reload(); issues.reload(); onChanged(); };

  useEffect(() => {
    if (r && r.kind === 'baptism' && r.status === 'approved' && !card) api.get(`/records/${id}/render`).then((x: any) => { setCard(x); setCardIsFinal(false); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r?.id, r?.status]);

  const run = async (fn: () => Promise<any>, ok?: string | ((x: any) => string)) => {
    setBusy(true);
    try { const x = await fn(); if (ok) toast.show(typeof ok === 'function' ? ok(x) : ok); changed(); }
    catch (e: any) { toast.show(friendly(e.message), 'bad'); }
    setBusy(false);
  };

  const preview = () => run(async () => { setCard(await api.get(`/records/${id}/render`)); setCardIsFinal(false); setPay(null); });
  const issue = (waive?: boolean) => run(async () => {
    const x = await api.post(`/records/${id}/issue`, waive ? { waive: true } : {});
    setConfirmWaive(false);
    if (x.status === 'issued') { setCard(x.render); setCardIsFinal(true); setPay(null); }
    else setPay(x);
    return x;
  }, (x) => (x.status === 'issued' ? 'The card is ready to print.' : 'This copy is waiting for payment.'));
  const decide = (approve: boolean) => run(async () => {
    await api.post(`/records/${id}/decide`, { approve, reason: approve ? undefined : reason.trim() });
    setRejecting(false); setReason('');
  }, approve ? 'Approved.' : 'Sent back. The person who entered it can see your reason.');

  if (editing && r) return <RecordForm existing={r} onClose={() => setEditing(false)} onDone={(m) => { setEditing(false); toast.show(m); changed(); }} />;

  const me = s.user.id;
  const mine = r && (r.created_by === me || r.last_edited_by === me);
  const awaiting = r && (r.status === 'pending_approval' || r.has_pending_changes);
  const link = r?.serial && pay ? `${location.protocol}//${location.hostname}:3001/${s.branches.find((b) => b.id === r.branch_id)?.code ?? ''}?cert=${r.serial}` : '';

  const footer = r && canEdit && r.status !== 'pending_approval' ? (
    <>
      <Button kind="ghost" onClick={() => setEditing(true)}>{r.status === 'approved' ? 'Suggest changes' : 'Edit'}</Button>
      {(r.status === 'draft' || r.status === 'rejected') && <Button disabled={busy} onClick={() => run(() => api.post(`/records/${id}/submit`), 'Sent for approval.')}>Submit for approval</Button>}
    </>
  ) : undefined;

  return (
    <SidePanel title={r ? `${KIND[r.kind]} record` : 'Record'} subtitle={r ? [r.subject_name, r.branch_name].filter(Boolean).join(' · ') : undefined} onClose={onClose} width={card ? 760 : 520} footer={footer}>
      <Gate loading={d.loading} error={d.error} hasData={!!r}>
        {r && (
          <div className="pp-stack">
            <div className="pp-row-flex">
              <StatusChip tone={r.kind === 'baptism' ? 'info' : 'off'}>{KIND[r.kind]}</StatusChip>
              <StatusPill status={r.status} />
              {r.has_pending_changes && <StatusChip tone="wait">Changes waiting for approval</StatusChip>}
              {r.serial && <span className="pp-mono pp-tiny">{r.serial}</span>}
              <Hist entity="record" entityId={r.id} title={r.subject_name ?? (KIND[r.kind] + ' record')} />
            </div>
            <Note tone={r.status === 'rejected' ? 'bad' : 'info'}>{statusLine(r)}</Note>
            {r.has_pending_changes && r.pending_changes && (
              <div className="pp-psec">
                <h3>Changes waiting for approval</h3>
                <Facts rows={factRows({ ...r, ...r.pending_changes, kind: r.kind })} compare={factRows(r)} />
                {r.pending_changes.file && <div className="pp-tiny">A new scan is attached: {r.pending_changes.file.name}</div>}
              </div>
            )}
            <div className="pp-psec"><h3>Details</h3><Facts rows={factRows(r)} />
              {r.has_file && <div><Button kind="ghost" small onClick={() => viewScan(id).catch((e) => toast.show(friendly(e.message), 'bad'))}>View scan</Button></div>}
            </div>

            {awaiting && canApprove && (
              <div className="pp-psec">
                <h3>Approval</h3>
                {mine ? <Note tone="warn">A different person must approve this. You entered or changed it.</Note> : rejecting ? (
                  <div className="pp-stack">
                    <Field label="Why is it being sent back?"><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Tell them what to correct" /></Field>
                    <div className="pp-row-flex"><Button kind="danger" disabled={busy || !reason.trim()} onClick={() => decide(false)}>Send back</Button><Button kind="ghost" onClick={() => setRejecting(false)}>Cancel</Button></div>
                  </div>
                ) : (
                  <div className="pp-row-flex"><Button disabled={busy} onClick={() => decide(true)}>{r.has_pending_changes ? 'Approve the changes' : 'Approve'}</Button><Button kind="ghost" disabled={busy} onClick={() => setRejecting(true)}>Reject</Button></div>
                )}
              </div>
            )}
            {canEdit && r.status === 'pending_approval' && <p className="pp-note">This record is waiting for approval, so it cannot be edited. An approver can send it back if it needs changes.</p>}
            {canEdit && r.status === 'approved' && <p className="pp-note">Changes to an approved record wait for a second person to approve them. The approved version stays in use until then.</p>}

            {r.kind === 'baptism' && r.status === 'approved' && (
              <div className="pp-psec">
                <h3>Baptism card</h3>
                <ol className="pp-steps"><li className={card ? 'done' : 'on'}><b>1</b>Preview</li><li className={cardIsFinal ? 'done' : card ? 'on' : ''}><b>2</b>Issue and print</li></ol>
                {card ? (
                  <div className="pp-preview"><ScaledCard c={card} /></div>
                ) : <Skeleton height={140} />}
                <div className="pp-row-flex">
                  {cardIsFinal ? <Button onClick={printCertificate}>Print</Button> : <Button disabled={busy} onClick={() => issue()}>Issue and print</Button>}
                  {!cardIsFinal && <Button kind="ghost" disabled={busy} onClick={preview}>Refresh preview</Button>}
                </div>
                <p className="pp-note">{cardIsFinal ? 'This is the real card. Print it now.' : 'This is a preview. Choose "Issue and print" to get the real card. The first card is free. Later copies follow the church\'s price.'}</p>
                {pay && (
                  <Note tone="warn">
                    This copy costs {kes(pay.fee)}. Ask the person to pay through the church giving page using the link below. The copy becomes available once it is paid.
                    <div className="pp-mono" style={{ wordBreak: 'break-all', marginTop: 6 }}>{link}</div>
                    <div className="pp-row-flex" style={{ marginTop: 8 }}>
                      <Button small kind="ghost" onClick={() => { navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => toast.show('Please copy the link by hand.', 'bad')); }}>{copied ? 'Copied' : 'Copy link'}</Button>
                      {canApprove && !confirmWaive && <Button small kind="ghost" onClick={() => setConfirmWaive(true)}>Waive the fee</Button>}
                    </div>
                    {confirmWaive && <div className="pp-row-flex" style={{ marginTop: 8 }}><span>Give this copy free of charge?</span><Button small disabled={busy} onClick={() => issue(true)}>Yes, waive the fee</Button><Button small kind="ghost" onClick={() => setConfirmWaive(false)}>No</Button></div>}
                  </Note>
                )}
              </div>
            )}
            {r.kind === 'marriage' && <Note tone="info">Marriage certificates are legal documents issued elsewhere. ChurchOS keeps the scan and details, and does not print them.</Note>}

            <div className="pp-psec">
              <h3>Copies issued</h3>
              <Gate loading={issues.loading} error={issues.error} hasData={!!issues.data} rows={1}>
                {!issues.data || issues.data.length === 0 ? <p className="pp-note">No copies have been issued yet.</p> : (
                  <div className="pp-stack tight">
                    {issues.data.map((i) => (
                      <div key={i.id} className="pp-logrow">
                        <div className="head"><b>{i.kind === 'original' ? 'First card' : 'Copy'}</b>{i.status === 'issued' ? <StatusChip tone="done">Issued</StatusChip> : <StatusChip tone="wait">Waiting for payment</StatusChip>}</div>
                        <div className="pp-tiny">{shortDate(i.created_at)} · {i.fee > 0 ? kes(i.fee) : 'Free'} · {i.requested_by_name || '-'}{i.waived && <> · <StatusChip tone="info">{'Waived' + (i.waived_by_name ? ' by ' + i.waived_by_name : '')}</StatusChip></>}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Gate>
            </div>
          </div>
        )}
      </Gate>
      {toast.node}
    </SidePanel>
  );
}

// ---------- page ----------

export function Records() {
  const s = useSession();
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const needs = tab === 'needs';
  const dq = useDebounced(q.trim());
  const d = useAsync<any[]>(() => api.get('/records' + s.qs({ kind: kind || undefined, status: status || undefined, q: dq || undefined })), [s.qs(), kind, status, dq]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const canApprove = s.can('records.approve');
  const me = s.user.id;
  const awaiting = (r: any) => r.status === 'pending_approval' || r.has_pending_changes;
  const mineWaiting = (r: any) => awaiting(r) && r.created_by !== me && r.last_edited_by !== me;
  const rows = (d.data ?? []).filter((r) => !needs || mineWaiting(r));
  const needCount = (d.data ?? []).filter(mineWaiting).length;

  return (
    <>
      <PageHeader title="Records" subtitle="Baptism and marriage records for your church." actions={s.can('records.edit') && <Button onClick={() => setCreating(true)}>New record</Button>}
        tabs={canApprove ? [{ id: 'all', label: 'All records' }, { id: 'needs', label: 'Needs your approval', badge: needCount }] : undefined} tab={tab} onTab={setTab} />
      <Toolbar>
        <input aria-label="Search records" placeholder="Search by name, serial or register number" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All kinds</option><option value="baptism">Baptism</option><option value="marriage">Marriage</option></select>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>{Object.entries(STATUS_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Toolbar>
      <Gate loading={d.loading} error={d.error} hasData={!!d.data} rows={5}>
        {rows.length === 0 ? <EmptyState icon="book" title={needs ? 'Nothing is waiting for you' : 'No records found'} text={needs ? 'Records that need a second person to approve them show up here.' : 'Add a baptism or marriage record to start your register.'} action={!needs && s.can('records.edit') ? <Button onClick={() => setCreating(true)}>New record</Button> : undefined} /> : (
          <div className="pp-list">
            {rows.map((r) => (
              <button type="button" key={r.id} className="pp-item" onClick={() => setOpenId(r.id)}>
                <span className="pp-avatar home" aria-hidden="true"><Icon name="book" size={20} /></span>
                <div>
                  <div className="pp-name">{r.subject_name} <StatusChip tone={r.kind === 'baptism' ? 'info' : 'off'}>{KIND[r.kind] ?? r.kind}</StatusChip></div>
                  <div className="pp-sub">{[dateOnly(r.event_date), r.place, r.serial].filter(Boolean).join(' · ')}</div>
                  {r.status === 'rejected' && r.rejection_reason && <div className="pp-sub">{r.rejection_reason}</div>}
                </div>
                <span className="pp-side"><StatusPill status={r.status} />{r.has_pending_changes && <StatusChip tone="wait">Changes waiting</StatusChip>}</span>
                <Icon name="chevron" size={18} className="pp-chev" />
              </button>
            ))}
          </div>
        )}
      </Gate>
      {creating && <RecordForm onClose={() => setCreating(false)} onDone={(m) => { setCreating(false); toast.show(m); d.reload(); }} />}
      {openId && <RecordDetail id={openId} onClose={() => setOpenId(null)} onChanged={d.reload} />}
      {toast.node}
    </>
  );
}

/** A small list of the records tied to one member, for the Members page. */
export function MemberRecords({ member, onClose }: { member: any; onClose: () => void }) {
  const d = useAsync<any[]>(() => api.get(`/records/by-member/${member.id}`), [member.id]);
  return (
    <Dialog title={`Records for ${member.full_name}`} onClose={onClose}>
      {d.loading && !d.data ? <Skeleton lines={3} /> : d.error ? <ErrorNote>{friendly(d.error)}</ErrorNote> : !d.data || d.data.length === 0 ? <EmptyState icon="book" title="No records for this member" text="Baptism and marriage records linked to this member show up here." /> : (
        <div className="pp-stack tight">
          {d.data.map((r) => (
            <div key={r.id} className="pp-logrow">
              <div className="head"><b>{KIND[r.kind] ?? r.kind}</b><span className="pp-tiny">{dateOnly(r.event_date)}</span></div>
              <div className="pp-tiny"><span className="pp-mono">{r.serial || '-'}</span> · {r.read_only ? <>Held by {r.held_by} <StatusChip tone="info">Read-only copy</StatusChip></> : r.branch_name}</div>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

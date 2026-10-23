import { useRef, useState } from 'react';
import { Button, DpaCard, Note, dateOnly, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load } from './bits';
import { Card, PageHeader, Section, Skeleton, StatusChip } from './ui';
import './setup.css';

const MAX_BYTES = 3 * 1024 * 1024;

function DocStatus({ doc }: { doc: any }) {
  if (!doc) return <StatusChip tone="off">Not uploaded</StatusChip>;
  if (doc.status === 'approved') return <StatusChip tone="done">Approved</StatusChip>;
  if (doc.status === 'rejected') return <StatusChip tone="bad">Needs a new upload</StatusChip>;
  return <StatusChip tone="info">Waiting for review</StatusChip>;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('We could not read that file. Please try again.'));
    r.readAsDataURL(file);
  });
}

function DocRow({ n, title, type, branchId, doc, onDone }: { n: number; title: string; type: string; branchId?: string; doc: any; onDone: () => void }) {
  const toast = useToast();
  const s = useSession();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file?: File) => {
    if (!file) return;
    const reset = () => { if (input.current) input.current.value = ''; };
    if (file.size > MAX_BYTES) { toast.show('That file is larger than 3 MB. Please choose a smaller file or a lower-resolution photo.', 'bad'); reset(); return; }
    if (file.size === 0) { toast.show('That file is empty. Please choose another one.', 'bad'); reset(); return; }
    setBusy(true);
    try {
      const data = await readAsBase64(file);
      await api.post('/kyc/documents' + s.qs(), { type, branchId, filename: file.name, mime: file.type, data });
      toast.show('Uploaded. We will review it soon.');
      onDone();
    } catch (e: any) { toast.show(friendly(e.message), 'bad'); }
    setBusy(false);
    reset();
  };

  const tone = doc?.status === 'approved' ? 'done' : doc?.status === 'rejected' ? 'bad' : '';
  return (
    <div className={`setup-step ${tone}`}>
      <span className="setup-num">{doc?.status === 'approved' ? '✓' : n}</span>
      <div className="setup-step-main">
        <b>{title}</b>
        {doc ? <span className="tiny">{doc.filename} · {dateOnly(doc.created_at)}</span> : <span className="tiny">Nothing uploaded yet</span>}
        {doc?.status === 'rejected' && <span className="tiny" style={{ color: 'var(--bad)' }}>Reason: {doc.reason || 'Please upload a clearer copy.'}</span>}
      </div>
      <div className="setup-step-side">
        <DocStatus doc={doc} />
        <input ref={input} type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display: 'none' }} aria-label={`Choose a file for ${title}`} onChange={(e) => pick(e.target.files?.[0])} />
        <Button small kind={doc ? 'ghost' : 'primary'} disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : doc ? 'Replace' : 'Upload'}</Button>
        {toast.node}
      </div>
    </div>
  );
}

export function Verification() {
  const s = useSession();
  const d = useAsync<any>(() => api.get('/kyc/status' + s.qs()), [s.qs()]);
  const data = d.data;
  const allOk = !!data && data.branches.length > 0 && data.branches.every((b: any) => b.verified);

  return (
    <>
      <PageHeader title="Verification" subtitle="Confirm your church so payouts can be released." />
      <DpaCard api={api} />
      {!data && !d.error && <Skeleton rows={4} height={72} />}
      <Load loading={false} error={d.error} hasData={!!data}>
        {data && (
          <>
            <Note tone={allOk ? 'good' : 'warn'}>
              {allOk ? 'Your church is verified and can be paid out.' : 'Not verified yet. You can keep collecting, and the money is held safely until you are approved.'}
            </Note>
            <Section title="Step 1: Church documents" hint="PDF, JPG or PNG, up to 3 MB. If you upload again, we review the newest file of that type.">
              <Card pad={false}>
                <div className="setup-steps">
                  {data.required.map((r: any, i: number) => <DocRow key={r.type} n={i + 1} title={r.label} type={r.type} doc={r.latest} onDone={d.reload} />)}
                </div>
              </Card>
            </Section>
            <Section title="Step 2: Proof of payout account, one per branch" hint="A bank statement, cheque leaf or mobile money statement showing the account that will be paid.">
              <Card pad={false}>
                <div className="setup-steps">
                  {data.branches.map((b: any, i: number) => (
                    <DocRow key={b.id} n={i + 1} title={`${b.name}${b.verified ? ' (verified)' : ''}`} type="payout_proof" branchId={b.id} doc={b.payoutProof.latest} onDone={d.reload} />
                  ))}
                </div>
              </Card>
            </Section>
            <Section title="What each document is for">
              <Card>
                <p className="muted" style={{ margin: 0 }}>The registration certificate shows your church is a registered body. The KRA PIN certificate is your tax registration. The signatory ID belongs to a person who may receive money for the church.</p>
              </Card>
            </Section>
          </>
        )}
      </Load>
    </>
  );
}

import { useRef, useState } from 'react';
import { Badge, Button, Card, Note, Table, dateOnly, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load, PageHead } from './bits';

const MAX_BYTES = 3 * 1024 * 1024;

function DocStatus({ doc }: { doc: any }) {
  if (!doc) return <Badge tone="muted">Not uploaded</Badge>;
  if (doc.status === 'approved') return <Badge tone="good">Approved</Badge>;
  if (doc.status === 'rejected') return <Badge tone="bad">Needs a new upload</Badge>;
  return <Badge tone="info">Waiting for review</Badge>;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('We could not read that file. Please try again.'));
    r.readAsDataURL(file);
  });
}

function DocRow({ title, type, branchId, doc, onDone }: { title: string; type: string; branchId?: string; doc: any; onDone: () => void }) {
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

  return (
    <tr>
      <td><b>{title}</b></td>
      <td>
        <DocStatus doc={doc} />
        {doc?.status === 'rejected' && <div className="tiny" style={{ marginTop: 4 }}>Reason: {doc.reason || 'Please upload a clearer copy.'}</div>}
      </td>
      <td>{doc ? <>{doc.filename}<div className="tiny">{dateOnly(doc.created_at)}</div></> : <span className="tiny">Nothing yet</span>}</td>
      <td>
        <input ref={input} type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display: 'none' }} onChange={(e) => pick(e.target.files?.[0])} />
        <Button small kind={doc ? 'ghost' : 'primary'} disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : doc ? 'Replace' : 'Upload'}</Button>
        {toast.node}
      </td>
    </tr>
  );
}

export function Verification() {
  const s = useSession();
  const d = useAsync<any>(() => api.get('/kyc/status' + s.qs()), [s.qs()]);
  const data = d.data;
  const allOk = !!data && data.branches.length > 0 && data.branches.every((b: any) => b.verified);

  return (
    <>
      <PageHead title="Verification" sub="Confirm your church so payouts can be released." />
      <Load loading={d.loading} error={d.error} hasData={!!data}>
        {data && (
          <div className="stack">
            <Note tone={allOk ? 'good' : 'warn'}>
              {allOk ? 'Your church can be paid out.' : 'Not verified yet: you can collect, and money is held safely until you are approved.'}
            </Note>
            <Card title="What we need">
              <p className="muted" style={{ marginTop: 0 }}>
                The registration certificate proves your church is a registered body. The KRA PIN certificate is your tax registration. The signatory ID is the ID of a person authorised to receive money for the church. The payout proof, one per branch, is a bank statement, cheque leaf or mobile money statement showing the account that will be paid. Files may be PDF, JPG or PNG up to 3 MB. If you upload a document again, the newest upload of that type is the one we review.
              </p>
            </Card>
            <Card title="Church documents">
              <Table head={['Document', 'Status', 'File', '']}>
                {data.required.map((r: any) => <DocRow key={r.type} title={r.label} type={r.type} doc={r.latest} onDone={d.reload} />)}
              </Table>
            </Card>
            <Card title="Payout account proof, per branch">
              <Table head={['Branch', 'Status', 'File', '']}>
                {data.branches.map((b: any) => (
                  <DocRow key={b.id} title={`${b.name}${b.verified ? ' (verified)' : ''}`} type="payout_proof" branchId={b.id} doc={b.payoutProof.latest} onDone={d.reload} />
                ))}
              </Table>
            </Card>
          </div>
        )}
      </Load>
    </>
  );
}

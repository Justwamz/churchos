import { useState } from 'react';
import { Button, Card, ErrorNote, Field, Note, useToast } from '@churchos/ui';
import { api, errText } from './api';
import { Sheet } from './ui';

/** Profile: download a copy of my data, and close my account (with a preview of what is kept, what is removed and what is lost). */
export function MyData({ signOut }: { signOut: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [sure, setSure] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [sent, setSent] = useState<string | undefined>();

  const download = async () => {
    setBusy(true);
    try {
      // The file is fetched with the sign-in header (never a token in the address) and saved from memory.
      const url = await api.blobUrl('/me/export');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'my-churchos-data.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.show('Your data has been downloaded');
    } catch (e: any) {
      toast.show(e?.status === 429 ? 'You can download your data 3 times a day. Please try again tomorrow.' : errText(e));
    }
    setBusy(false);
  };

  const openDelete = async () => {
    setOpen(true); setPreview(null); setError(undefined); setSent(undefined); setSure(false); setReason('');
    try { setPreview(await api.get('/me/erasure-preview')); } catch (e) { setError(errText(e)); }
  };

  const confirm = async () => {
    setBusy(true); setError(undefined);
    try {
      const r = await api.post('/me/erasure-request', { confirm: true, reason });
      if (r.status === 'completed') { toast.show('Your account is closed'); signOut(); return; }
      setSent(r.message);
    } catch (e) { setError(errText(e)); }
    setBusy(false);
  };

  return (
    <>
      <Card title="My data">
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>You can download a copy of the information we hold about you, or ask to close your account and have your details erased.</p>
          <Button kind="ghost" disabled={busy} onClick={download}>{busy ? 'Preparing…' : 'Download my data'}</Button>
          <Button kind="danger" onClick={openDelete}>Delete my account</Button>
        </div>
      </Card>
      <Sheet open={open} onClose={() => setOpen(false)} title="Delete my account">
        <div className="stack">
          {!preview && !error && <p className="muted" style={{ margin: 0 }}>Checking your account…</p>}
          {error && <ErrorNote>{error}</ErrorNote>}
          {sent && <Note>{sent} Your request has been sent. Nothing has been deleted yet.</Note>}
          {preview && !sent && (
            <>
              {preview.open && <Note>You already asked to close your account. It is waiting for a decision.</Note>}
              {preview.blockers.map((b: string) => <ErrorNote key={b}>{b}</ErrorNote>)}
              <div>
                <strong>What happens</strong>
                <ul className="tiny" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {preview.removed.map((x: string) => <li key={x}>{x}</li>)}
                </ul>
              </div>
              {(preview.forfeitedCredit.length > 0 || preview.activeGivingPlans > 0) && (
                <Note>
                  {preview.forfeitedCredit.map((c: any) => <div key={c.church}>You will lose {`KES ${(c.balance / 100).toLocaleString('en-KE')}`} of event credit at {c.church}.</div>)}
                  {preview.activeGivingPlans > 0 && <div>{preview.activeGivingPlans} regular giving plan{preview.activeGivingPlans === 1 ? '' : 's'} will be cancelled.</div>}
                </Note>
              )}
              <div>
                <strong>What we must keep, and why</strong>
                <ul className="tiny" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {preview.kept.map((k: any) => <li key={k.what}>{k.what}. <em>{k.why}</em></li>)}
                </ul>
              </div>
              <p className="muted" style={{ margin: 0 }}>{preview.approvalText}</p>
              {preview.canRequest && (
                <>
                  <Field label="Why are you leaving? (optional)">
                    <textarea value={reason} maxLength={500} rows={2} onChange={(e) => setReason(e.target.value)} />
                  </Field>
                  <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                    <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
                    <span>I understand this cannot be undone once approved.</span>
                  </label>
                  <Button kind="danger" disabled={busy || !sure} onClick={confirm}>{busy ? 'Sending…' : preview.approval === 'none' ? 'Close my account now' : 'Ask to close my account'}</Button>
                </>
              )}
            </>
          )}
        </div>
      </Sheet>
      {toast.node}
    </>
  );
}

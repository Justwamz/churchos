import { useState } from 'react';
import { Button, Card, ErrorNote, Field, Note, kes } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { PageHead } from './bits';

export function Help() {
  const s = useSession();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | undefined>();

  const send = async () => {
    setBusy(true); setError(undefined); setResult(null);
    try { setResult(await api.post('/reversal-requests' + s.qs(), { message })); }
    catch (e: any) { setError(friendly(e.message)); }
    setBusy(false);
  };

  return (
    <>
      <PageHead title="Payment help" sub="Someone paid by mistake? Paste their confirmation message." />
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); send(); }}>
          <Field label="Confirmation SMS" hint="Include the full text, especially the transaction code.">
            <textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Paste the M-Pesa confirmation message here" />
          </Field>
          <Button type="submit" disabled={busy || message.trim().length < 8}>{busy ? 'Looking…' : 'Find the payment and request a reversal'}</Button>
        </form>
        {error && <ErrorNote>{error}</ErrorNote>}
        {result && (
          <Note tone="good">
            We found the payment and opened a reversal request.
            <div style={{ marginTop: 6 }}>
              Code <b>{result.found?.transactionCode}</b> for <b>{kes(result.found?.amount)}</b>, {result.found?.where}.
            </div>
          </Note>
        )}
      </Card>
    </>
  );
}

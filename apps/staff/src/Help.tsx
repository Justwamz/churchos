import { useState } from 'react';
import { Button, ErrorNote, Field, Note, kes } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Card, PageHeader, Section } from './ui';
import './money.css';

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
      <PageHeader title="Payment help" subtitle="Someone paid by mistake? Paste their confirmation message and we will find the payment." />
      <Section>
        <div style={{ maxWidth: 720 }}>
          <Card>
            <form onSubmit={(e) => { e.preventDefault(); send(); }}>
              <Field label="Confirmation SMS" hint="Include the full text, especially the transaction code.">
                <textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Paste the M-Pesa confirmation message here" />
              </Field>
              {error && <div style={{ marginBottom: 16 }}><ErrorNote>{error}</ErrorNote></div>}
              {result && (
                <div style={{ marginBottom: 16 }}>
                  <Note tone="good">
                    We found the payment and opened a reversal request.
                    <div style={{ marginTop: 6 }}>
                      Code <b>{result.found?.transactionCode}</b> for <b>{kes(result.found?.amount)}</b>, {result.found?.where}.
                    </div>
                  </Note>
                </div>
              )}
              <div className="mn-btns end">
                <Button type="submit" disabled={busy || message.trim().length < 8}>{busy ? 'Looking…' : 'Find the payment and request a reversal'}</Button>
              </div>
            </form>
          </Card>
        </div>
      </Section>
    </>
  );
}

import { useEffect, useState } from 'react';
import { Button, Card, ErrorNote, Field, Note, phonePretty, useAsync, useToast } from '@churchos/ui';
import { api, friendly } from './session';
import { Load, PageHead } from './bits';

function Toggle({ on, onChange, title, text, disabled }: { on: boolean; onChange: (v: boolean) => void; title: string; text: string; disabled?: boolean }) {
  return (
    <label style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 0', borderTop: '1px solid var(--line)', cursor: 'pointer' }}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3, flex: 'none' }} />
      <span><b>{title}</b><br /><span className="muted" style={{ fontSize: 14 }}>{text}</span></span>
    </label>
  );
}

export function Profile() {
  const toast = useToast();
  const prof = useAsync<any>(() => api.get('/me/profile'), []);
  const prefs = useAsync<any>(() => api.get('/me/preferences'), []);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [prefBusy, setPrefBusy] = useState(false);
  const [prefError, setPrefError] = useState('');
  useEffect(() => { if (prof.data) setEmail(prof.data.email ?? ''); }, [prof.data]);

  const save = async () => {
    setBusy(true); setError('');
    try { await api.put('/me/profile', { email }); toast.show('Email saved'); prof.reload(); } catch (e: any) { setError(friendly(e.message)); }
    setBusy(false);
  };
  const setPref = async (body: Record<string, boolean>) => {
    setPrefBusy(true); setPrefError('');
    try { await api.put('/me/preferences', body); prefs.reload(); toast.show('Saved'); } catch (e: any) { setPrefError(friendly(e.message)); }
    setPrefBusy(false);
  };

  return (
    <div>
      <PageHead title="My profile" sub="Your details and how your church may message you." />
      <div className="stack">
        <Card title="About you">
          <Load loading={prof.loading} error={prof.error} hasData={!!prof.data}>
            {prof.data && (
              <>
                <div className="grid cols-2">
                  <Field label="Name"><input value={prof.data.name ?? ''} readOnly /></Field>
                  <Field label="Phone number"><input value={phonePretty(prof.data.phone)} readOnly /></Field>
                </div>
                <Field label="Email" hint="We use this to email you low-balance alerts and other important notices">
                  <input type="email" inputMode="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                {error && <ErrorNote>{error}</ErrorNote>}
                <Button disabled={busy || email === (prof.data.email ?? '')} onClick={save}>{busy ? 'Saving…' : 'Save email'}</Button>
              </>
            )}
          </Load>
        </Card>
        <Card title="My message choices">
          <p className="muted">These choices apply to your own phone number, {prof.data ? phonePretty(prof.data.phone) : ''}.</p>
          <Load loading={prefs.loading} error={prefs.error} hasData={!!prefs.data}>
            {prefs.data && (
              <>
                <Toggle on={prefs.data.whatsappOptIn} disabled={prefBusy} onChange={(v) => setPref({ whatsappOptIn: v })}
                  title="Allow WhatsApp messages from my church" text="Your church can only send you WhatsApp messages if this is on. Receipts for your own giving are always sent." />
                <Toggle on={!prefs.data.smsOptOut} disabled={prefBusy} onChange={(v) => setPref({ smsOptOut: !v })}
                  title="Allow SMS messages from my church" text="Turn this off to stop SMS announcements. Receipts for your own giving are always sent." />
                {prefError && <ErrorNote>{prefError}</ErrorNote>}
                <Note>In-app messages are free and always reach you.</Note>
              </>
            )}
          </Load>
        </Card>
      </div>
      {toast.node}
    </div>
  );
}

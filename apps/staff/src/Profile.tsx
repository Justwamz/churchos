import { useEffect, useState } from 'react';
import { Button, Card, ErrorNote, Field, Note, SecurityPanel, phonePretty, useAsync, useToast } from '@churchos/ui';
import { api, friendly } from './session';
import { Load } from './bits';
import { PageHeader, StatusChip } from './ui';
import './setup.css';

function Toggle({ on, onChange, title, text, disabled }: { on: boolean; onChange: (v: boolean) => void; title: string; text: string; disabled?: boolean }) {
  return (
    <label className="setup-toggle">
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
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
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | undefined>();
  const [info, setInfo] = useState('');
  const [prefBusy, setPrefBusy] = useState(false);
  const [prefError, setPrefError] = useState('');
  useEffect(() => { if (prof.data) setEmail(prof.data.email ?? ''); }, [prof.data]);

  const save = async () => {
    setBusy(true); setError('');
    try {
      const r: any = await api.put('/me/profile', { email });
      setDevCode(r.devCode); setCode(''); setInfo('');
      toast.show(email.trim() ? 'We sent a code to your email' : 'Email removed');
      prof.reload();
    } catch (e: any) { setError(friendly(e.message)); }
    setBusy(false);
  };
  const verify = async () => {
    setBusy(true); setError(''); setInfo('');
    try { await api.post('/me/profile/verify', { code: code.trim() }); setCode(''); setDevCode(undefined); toast.show('Email confirmed'); prof.reload(); } catch (e: any) { setError(friendly(e.message)); }
    setBusy(false);
  };
  const resend = async () => {
    setBusy(true); setError(''); setInfo('');
    try { const r: any = await api.post('/me/profile/resend'); setDevCode(r.devCode); setInfo('We sent you a new code.'); }
    catch (e: any) { setError(e.status === 429 ? 'Please wait a minute before asking for another code.' : friendly(e.message)); }
    setBusy(false);
  };
  const setPref = async (body: Record<string, boolean>) => {
    setPrefBusy(true); setPrefError('');
    try { await api.put('/me/preferences', body); prefs.reload(); toast.show('Saved'); } catch (e: any) { setPrefError(friendly(e.message)); }
    setPrefBusy(false);
  };

  return (
    <div>
      <PageHeader title="My profile" subtitle="Your details and how your church may message you." />
      <div className="stack">
        <Card title="About you">
          <Load loading={prof.loading} error={prof.error} hasData={!!prof.data}>
            {prof.data && (
              <>
                <div className="grid cols-2">
                  <Field label="Name"><input value={prof.data.name ?? ''} readOnly /></Field>
                  <Field label="Phone number"><input value={phonePretty(prof.data.phone)} readOnly /></Field>
                </div>
                <Field label="Email" hint={prof.data.emailRequired ? 'Your role gets low-balance alerts by email, so you need a confirmed email address.' : 'Optional. We use this to email you important notices.'}>
                  <input type="email" inputMode="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                {prof.data.email && email === prof.data.email && (
                  <p>{prof.data.emailVerified ? <StatusChip tone="done">Confirmed</StatusChip> : <StatusChip tone="wait">Not confirmed yet</StatusChip>}</p>
                )}
                {prof.data.email && !prof.data.emailVerified && email === prof.data.email && (
                  <div className="stack">
                    <Field label="6-digit code" hint={<>We sent a code to {prof.data.email}.</>}>
                      <input inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
                    </Field>
                    {devCode && <div className="tiny">Development only: your code is <b>{devCode}</b></div>}
                    {info && <Note tone="good">{info}</Note>}
                    <div className="row"><Button disabled={busy || code.length < 6} onClick={verify}>Confirm email</Button><Button kind="ghost" disabled={busy} onClick={resend}>Send a new code</Button></div>
                  </div>
                )}
                {error && <ErrorNote>{error}</ErrorNote>}
                {email !== (prof.data.email ?? '') && <Button disabled={busy || (prof.data.emailRequired && !email.trim())} onClick={save}>{busy ? 'Saving…' : email.trim() ? 'Save and send a code' : 'Remove email'}</Button>}
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
        <SecurityPanel api={api} toast={toast.show} />
      </div>
      {toast.node}
    </div>
  );
}

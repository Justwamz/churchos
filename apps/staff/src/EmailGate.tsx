import { useEffect, useState } from 'react';
import { Button, ErrorNote, Field, Note } from '@churchos/ui';
import { api, friendly } from './session';

/**
 * Blocking dialog: people whose role receives alerts must have a confirmed email address.
 * Nothing behind it can be used until the code is entered.
 */
export function EmailGate({ initialEmail, onVerified }: { initialEmail?: string | null; onVerified: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState(initialEmail ?? '');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | undefined>();
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  // The dialog also opens when an email was saved but never confirmed, so start at the code step if the profile says so.
  useEffect(() => {
    api.get('/me/profile').then((p: any) => {
      if (p.emailVerified) onVerified();
      else if (p.email) { setEmail(p.email); setSaved(p.email); }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async () => {
    setBusy(true); setError(''); setInfo('');
    try {
      // The same address that is already saved sends no new code on its own, so ask for one.
      const r: any = email.trim().toLowerCase() === saved.toLowerCase()
        ? await api.post('/me/profile/resend').catch((e: any) => { if (e.status === 429) return {}; throw e; })
        : await api.put('/me/profile', { email });
      if (email.trim().toLowerCase() !== saved.toLowerCase()) setSaved(email.trim().toLowerCase());
      setDevCode(r.devCode);
      if (r.emailVerified) { onVerified(); return; }
      setStep(2);
    } catch (e: any) { setError(friendly(e.message)); }
    setBusy(false);
  };
  const resend = async () => {
    setBusy(true); setError(''); setInfo('');
    try {
      const r: any = await api.post('/me/profile/resend');
      setDevCode(r.devCode);
      setInfo('We sent you a new code.');
    } catch (e: any) {
      setError(e.status === 429 ? 'Please wait a minute before asking for another code.' : friendly(e.message));
    }
    setBusy(false);
  };
  const verify = async () => {
    setBusy(true); setError('');
    try { await api.post('/me/profile/verify', { code: code.trim() }); onVerified(); return; }
    catch (e: any) { setError(friendly(e.message)); }
    setBusy(false);
  };

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="Add your email address">
      <div className="modal" style={{ maxHeight: 'calc(100vh - 32px)', overflowY: 'auto' }}>
        <h2 style={{ marginTop: 0 }}>Add your email address</h2>
        <p className="muted">Your role gets messaging alerts, such as when credit is running low. We need an email address that we have checked, so those alerts reach you.</p>
        {step === 1 ? (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <Field label="Your email address"><input autoFocus type="email" inputMode="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            {error && <ErrorNote>{error}</ErrorNote>}
            <div><Button type="submit" disabled={busy || !email.includes('@')}>{busy ? 'Sending...' : 'Send me a code'}</Button></div>
          </form>
        ) : (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); verify(); }}>
            <Field label="6-digit code" hint={<>We sent a code to <b>{email}</b>. It may take a minute to arrive.</>}>
              <input autoFocus inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            </Field>
            {devCode && <div className="tiny">Development only: your code is <b>{devCode}</b></div>}
            {info && <Note tone="good">{info}</Note>}
            {error && <ErrorNote>{error}</ErrorNote>}
            <div className="row">
              <Button type="submit" disabled={busy || code.length < 6}>{busy ? 'Checking...' : 'Confirm email'}</Button>
              <Button kind="ghost" disabled={busy} onClick={resend}>Send a new code</Button>
              <Button kind="ghost" disabled={busy} onClick={() => { setStep(1); setError(''); setInfo(''); setCode(''); }}>Use a different email</Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

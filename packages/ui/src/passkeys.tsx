import { useState } from 'react';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { Api } from './api';
import { Badge, Button, Card, Empty, ErrorNote, Note, Table, shortDate, useAsync } from './index';

/** Passkeys (WebAuthn) for the four apps: add, remove, sign in, second factor, and the Security screen with sessions. */

export const passkeysSupported = (): boolean => {
  try { return browserSupportsWebAuthn(); } catch { return false; }
};

const DEVICE_FLAG = 'churchos:passkey-device';
/** True once a passkey was added on this browser, so the sign-in screen offers it even in demo mode. */
export const deviceHasPasskey = (): boolean => {
  try { return localStorage.getItem(DEVICE_FLAG) === '1'; } catch { return false; }
};
const markDevice = () => { try { localStorage.setItem(DEVICE_FLAG, '1'); } catch { /* storage blocked: the button just stays hidden in demo mode */ } };

/** A calm sentence for what the browser or the server said. */
export function passkeyError(e: any): string {
  if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') return 'The passkey was cancelled or timed out. Please try again.';
  if (e?.name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  if (typeof e?.message === 'string' && e.message && !e.message.trim().startsWith('{')) return e.message;
  return 'The passkey could not be used. Please try again.';
}

/** Adds a passkey. `pending` is only for the enrolment step of a sign-in that requires one (the answer then holds the new session). */
export async function addPasskey(api: Api, name: string, pending?: string): Promise<any> {
  const body = pending ? { pending } : {};
  const o = await api.post('/auth/passkeys/register/options', body);
  const credential = await startRegistration({ optionsJSON: o.options });
  const r = await api.post('/auth/passkeys/register/verify', { ...body, state: o.state, credential, name });
  markDevice();
  return r;
}

/** Signs in with a passkey alone (no phone number, no code). Returns {token, user}. */
export async function passkeySignIn(api: Api): Promise<any> {
  const o = await api.post('/auth/passkeys/login/options', {});
  const credential = await startAuthentication({ optionsJSON: o.options });
  return api.post('/auth/passkeys/login/verify', { state: o.state, credential });
}

/** The passkey step after the code, for an admin who has one. Returns {token, user}. */
export async function passkeySecondFactor(api: Api, pending: string): Promise<any> {
  const o = await api.post('/auth/passkeys/second/options', { pending });
  const credential = await startAuthentication({ optionsJSON: o.options });
  return api.post('/auth/passkeys/verify-second', { pending, state: o.state, credential });
}

/** Security screen: passkeys (add, rename on add, remove) and the places this account is signed in. */
export function SecurityPanel(p: { api: Api; toast?: (t: string, tone?: 'good' | 'bad') => void }) {
  const keys = useAsync(() => p.api.get<any>('/auth/passkeys'));
  const sessions = useAsync(() => p.api.get<any>('/auth/sessions'));
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const say = (t: string, tone: 'good' | 'bad' = 'good') => p.toast?.(t, tone);
  const supported = passkeysSupported();

  const add = async () => {
    setBusy(true); setError(undefined);
    try {
      await addPasskey(p.api, name.trim() || 'My passkey');
      setName(''); keys.reload(); say('Passkey added');
    } catch (e) { setError(passkeyError(e)); }
    setBusy(false);
  };
  const remove = async (id: string) => {
    if (!window.confirm('Remove this passkey? You will no longer be able to sign in with it.')) return;
    setError(undefined);
    try { await p.api.del(`/auth/passkeys/${id}`); keys.reload(); say('Passkey removed'); }
    catch (e: any) { setError(e?.message ?? 'Could not remove it.'); }
  };
  const revoke = async (id: string) => {
    try { await p.api.post(`/auth/sessions/${id}/revoke`, {}); sessions.reload(); say('Signed out of that device'); }
    catch (e: any) { setError(e?.message ?? 'Could not sign it out.'); }
  };
  const all = async () => {
    if (!window.confirm('Sign out everywhere, including this device?')) return;
    try { await p.api.post('/auth/logout-all', {}); } catch { /* already signed out */ }
    p.api.setToken(null);
    window.location.reload();
  };

  const info = keys.data;
  return (
    <>
      <Card title="Passkeys">
        <p className="muted">A passkey signs you in with your fingerprint, face or screen lock instead of a code, and cannot be phished.{info?.isAdmin ? ' Platform admins who have a passkey must show it after the SMS code.' : ''}</p>
        {info?.isAdmin && info.mode === 'sms' && info.passkeys.length === 0 && (
          <Note tone="warn">{info.passkeyRequiredForAdmins ? 'A passkey is required for platform admins. Add one now.' : 'You have no passkey yet. Please add one to protect this admin account.'}</Note>
        )}
        {keys.error && <ErrorNote>{keys.error}</ErrorNote>}
        {info && (info.passkeys.length === 0
          ? <Empty>No passkeys yet.</Empty>
          : (
            <Table head={['Name', 'Added', 'Last used', '']}>
              {info.passkeys.map((k: any) => (
                <tr key={k.id}>
                  <td><b>{k.name}</b></td>
                  <td>{shortDate(k.createdAt)}</td>
                  <td>{k.lastUsedAt ? shortDate(k.lastUsedAt) : <span className="tiny">Never</span>}</td>
                  <td><Button kind="danger" small onClick={() => remove(k.id)}>Remove</Button></td>
                </tr>
              ))}
            </Table>
          ))}
        {supported ? (
          <div className="row" style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <input aria-label="Passkey name" placeholder="Name, e.g. My phone" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} style={{ flex: '1 1 200px' }} />
            <Button onClick={add} disabled={busy}>{busy ? 'Waiting for your device…' : 'Add a passkey'}</Button>
          </div>
        ) : <Note>This browser does not support passkeys.</Note>}
        {error && <ErrorNote>{error}</ErrorNote>}
      </Card>
      <div style={{ height: 16 }} />
      <Card title="Where you are signed in" action={<Button kind="ghost" small onClick={all}>Sign out everywhere</Button>}>
        {sessions.error && <ErrorNote>{sessions.error}</ErrorNote>}
        {sessions.data && (sessions.data.sessions.length === 0
          ? <Empty>No active sessions.</Empty>
          : (
            <Table head={['Device', 'Signed in', 'Last seen', '']}>
              {sessions.data.sessions.map((s: any) => (
                <tr key={s.id}>
                  <td>{String(s.device).slice(0, 80)} {s.current && <Badge tone="good">This device</Badge>}</td>
                  <td>{shortDate(s.createdAt)}</td>
                  <td>{s.lastSeenAt ? shortDate(s.lastSeenAt) : ''}</td>
                  <td>{!s.current && <Button kind="ghost" small onClick={() => revoke(s.id)}>Sign out</Button>}</td>
                </tr>
              ))}
            </Table>
          ))}
      </Card>
    </>
  );
}

/** A banner for platform admins in sms mode who have no passkey yet. `onOpen` goes to the Security page. */
export function PasskeyBanner(p: { api: Api; onOpen: () => void }) {
  const info = useAsync(() => p.api.get<any>('/auth/passkeys'));
  const d = info.data;
  if (!d || !d.isAdmin || d.mode !== 'sms' || d.passkeys.length > 0 || !passkeysSupported()) return null;
  return (
    <div className="note warn" role="status" style={{ margin: '0 0 12px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ flex: '1 1 260px' }}>{d.passkeyRequiredForAdmins ? 'A passkey is required for platform admins.' : 'Protect this admin account: add a passkey.'}</span>
      <Button small onClick={p.onOpen}>Add a passkey</Button>
    </div>
  );
}

import { useState } from 'react';
import { Button, ErrorNote, Field, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { EmptyState, PageHeader, Section, Skeleton, StatusChip } from './ui';
import './worship.css';
import './kiosk.css';

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'Never');
const TONE: Record<string, 'wait' | 'done' | 'bad' | 'off'> = { waiting: 'wait', active: 'done', revoked: 'bad', expired: 'off' };
const TEXT: Record<string, string> = { waiting: 'Waiting to be paired', active: 'In use', revoked: 'Revoked', expired: 'Code expired' };

/** Kiosk: pair a tablet at the entrance so people can check themselves in, see the devices and switch one off. */
export function KioskAdmin() {
  const s = useSession();
  const toast = useToast();
  const list = useAsync(() => api.get<{ devices: any[] }>('/kiosk/devices'), []);
  const [name, setName] = useState('Entrance kiosk');
  const [branchId, setBranchId] = useState(s.branches[0]?.id ?? '');
  const [pair, setPair] = useState<{ code: string; path: string; expiresAt: string; minutes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const url = pair ? `${location.origin}${pair.path}` : '';

  const make = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.post('/kiosk/devices', { name, branchId });
      list.reload();
      return r;
    } catch (e: any) { setErr(friendly(e?.message)); return null; } finally { setBusy(false); }
  };
  const makeCode = async () => { const r = await make(); if (r) setPair(r); };
  const openHere = async () => { const r = await make(); if (r) location.assign(r.path); };
  const revoke = async (id: string, n: string) => {
    if (!window.confirm(`Switch off "${n}"? It will stop working straight away.`)) return;
    try { await api.post(`/kiosk/devices/${id}/revoke`, {}); toast.show('Kiosk switched off'); list.reload(); } catch (e: any) { setErr(friendly(e?.message)); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(url); toast.show('Link copied'); } catch { /* the link is shown, it can be typed */ } };

  return (
    <div className="stack">
      <PageHeader title="Kiosk" subtitle="A screen at the entrance where people check themselves in. It shows no member details." />
      {toast.node}
      {err && <ErrorNote>{err}</ErrorNote>}
      <Section title="Pair a device">
        <div className="ks-form">
          <Field label="Name of this kiosk"><input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></Field>
          {s.branches.length > 1 && (
            <Field label="Branch"><select value={branchId} onChange={(e) => setBranchId(e.target.value)}>{s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          )}
          <div className="ks-actions">
            <Button onClick={makeCode} disabled={busy || !branchId}>Make a pairing code</Button>
            <Button kind="ghost" onClick={openHere} disabled={busy || !branchId}>Open kiosk on this device</Button>
          </div>
        </div>
        {pair && (
          <div className="ks-code" role="status">
            <div className="lab">On the kiosk device, open this address and enter the code</div>
            <div className="big" aria-label={`Pairing code ${pair.code.split('').join(' ')}`}>{pair.code}</div>
            <div className="url"><code>{location.origin}/kiosk</code> <button type="button" className="btn small ghost" onClick={copy}>Copy link with code</button></div>
            <div className="lab">The code works once and runs out in {pair.minutes} minutes (at {when(pair.expiresAt)}).</div>
          </div>
        )}
      </Section>
      <Section title="Kiosks">
        {list.loading && !list.data ? <Skeleton rows={2} height={56} /> : !list.data?.devices.length ? <EmptyState title="No kiosks yet" text="Make a pairing code to set one up." /> : (
          <ul className="ks-list">
            {list.data.devices.map((d) => (
              <li key={d.id}>
                <div className="nm"><b>{d.name}</b><span>{d.branch}</span></div>
                <div className="meta"><StatusChip tone={TONE[d.status]}>{TEXT[d.status]}</StatusChip><span>Last seen: {when(d.lastSeenAt)}</span></div>
                {d.status !== 'revoked' && d.status !== 'expired' && <Button kind="danger" small onClick={() => revoke(d.id, d.name)}>Revoke</Button>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

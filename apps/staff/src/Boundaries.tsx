import { useState } from 'react';
import { Button, ErrorNote, Field, Note, useAsync, useToast } from '@churchos/ui';
import { api, friendly } from './session';
import { useWords } from './words';
import { Card, EmptyState, PageHeader, Section, Skeleton, Stat, StatTiles, StatusChip } from './ui';
import './attendance.css';
import './worship.css';

function Load({ loading, error, hasData, children }: { loading: boolean; error?: string; hasData: boolean; children: React.ReactNode }) {
  if (error && !hasData) return <ErrorNote>{friendly(error)}</ErrorNote>;
  if (loading && !hasData) return <Skeleton rows={3} height={72} />;
  return <>{error && <ErrorNote>{friendly(error)}</ErrorNote>}{children}</>;
}

const dayTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '-');
const metres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/** Reads the device position into lat/lng text fields. Never throws. */
export function useHere(set: (lat: string, lng: string, acc: number) => void) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const go = () => {
    setMsg('');
    if (!('geolocation' in navigator)) return setMsg('This browser cannot give a location. Type the numbers instead.');
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { setBusy(false); set(p.coords.latitude.toFixed(6), p.coords.longitude.toFixed(6), Math.round(p.coords.accuracy)); setMsg(`Location found, accurate to about ${Math.round(p.coords.accuracy)} m.`); },
      (e) => { setBusy(false); setMsg(e.code === 1 ? 'Location is blocked. Allow location for this site in your browser settings, or type the numbers.' : 'Could not read your location. Stand outside and try again, or type the numbers.'); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };
  return { go, busy, msg };
}

/** Latitude, longitude and distance fields with a "use my current location" button. */
export function PlaceFields({ lat, lng, radius, setLat, setLng, setRadius, min, max }: { lat: string; lng: string; radius: string; setLat: (s: string) => void; setLng: (s: string) => void; setRadius: (s: string) => void; min: number; max: number }) {
  const here = useHere((a, b) => { setLat(a); setLng(b); });
  const smax = Math.min(max, 2000);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div><Button small kind="ghost" disabled={here.busy} onClick={here.go}>{here.busy ? 'Reading your location...' : 'Use my current location'}</Button></div>
      {here.msg && <div className="tiny" role="status">{here.msg}</div>}
      <div className="at-filters">
        <Field label="Latitude"><input aria-label="Latitude" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="-1.2864" /></Field>
        <Field label="Longitude"><input aria-label="Longitude" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="36.8172" /></Field>
        <Field label={`Distance in metres (${min} to ${max})`}><input aria-label="Distance in metres" type="number" min={min} max={max} value={radius} onChange={(e) => setRadius(e.target.value)} /></Field>
      </div>
      <input type="range" aria-label="Distance slider" min={min} max={smax} step={10} value={Math.min(Math.max(Number(radius) || min, min), smax)} onChange={(e) => setRadius(e.target.value)} />
    </div>
  );
}

export function validPlace(lat: string, lng: string, radius: string, min: number, max: number): { lat: number; lng: number; radiusM: number } | string {
  const la = Number(lat), ln = Number(lng), r = Number(radius);
  if (lat.trim() === '' || lng.trim() === '' || !Number.isFinite(la) || !Number.isFinite(ln) || la < -90 || la > 90 || ln < -180 || ln > 180) return 'Enter a latitude between -90 and 90 and a longitude between -180 and 180, or use your current location.';
  if (!Number.isFinite(r) || r < min || r > max) return `Choose a distance between ${min} and ${max} metres.`;
  return { lat: la, lng: ln, radiusM: Math.round(r) };
}

function BranchCard({ b, canManage, onChanged, say }: { b: any; canManage: boolean; onChanged: () => void; say: (m: string, tone?: 'good' | 'bad') => void }) {
  const [lat, setLat] = useState(b.location ? String(b.location.lat) : '');
  const [lng, setLng] = useState(b.location ? String(b.location.lng) : '');
  const [radius, setRadius] = useState(String(b.location?.radiusM ?? 200));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const st = b.stats ?? { verified: 0, unchecked: 0, staff: 0, blocked: 0 };
  const save = async () => {
    setErr('');
    const v = validPlace(lat, lng, radius, 30, 2000);
    if (typeof v === 'string') return setErr(v);
    setBusy(true);
    try { await api.put(`/attendance/branches/${b.id}/location`, v); say(`Saved. Members must now be within ${v.radiusM} m of ${b.name} to check in.`); onChanged(); }
    catch (e: any) { setErr(friendly(e.message)); }
    setBusy(false);
  };
  const clear = async () => {
    if (!window.confirm(`Remove the location for ${b.name}? Members could then check in from anywhere.`)) return;
    setBusy(true); setErr('');
    try { await api.put(`/attendance/branches/${b.id}/location`, { clear: true }); setLat(''); setLng(''); say('The location was removed.'); onChanged(); }
    catch (e: any) { setErr(friendly(e.message)); }
    setBusy(false);
  };
  const tiles: [string, number, string][] = [
    ['Verified by location', st.verified, 'Members whose phone was inside the distance when they checked in.'],
    ['No location set', st.unchecked, 'Check-ins made when no place was set, so nothing could be checked.'],
    ['Scanned by an usher', st.staff, 'Checked in by an usher at the door, so no phone location was needed.'],
    ['Stopped by the boundary', st.blocked, 'Members who tried to check in from too far away, or whose phone could not say where it was.'],
  ];
  return (
    <Section title={b.name}>
    <Card>
      <div className="stack">
        <div>{b.location ? <StatusChip tone="done">{`Location set, ${b.location.radiusM} m`}</StatusChip> : <StatusChip tone="wait">No location set. Anyone can check in from anywhere.</StatusChip>}</div>
        {canManage ? (
          <>
            <PlaceFields lat={lat} lng={lng} radius={radius} setLat={setLat} setLng={setLng} setRadius={setRadius} min={30} max={2000} />
            <p className="tiny" style={{ margin: 0 }}>Members must be inside this distance to check in at the church. If your sanctuary is large or the signal is poor, use 150 to 300 m.</p>
            {err && <ErrorNote>{err}</ErrorNote>}
            <div className="wo-actions">
              <Button disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</Button>
              {b.location && <Button kind="danger" disabled={busy} onClick={clear}>Remove location</Button>}
            </div>
          </>
        ) : b.location && <div className="tiny">{b.location.lat}, {b.location.lng}</div>}
        <h4 style={{ margin: '8px 0 0' }}>Last 8 weeks</h4>
        <StatTiles>
          {tiles.map(([l, v, d]) => <Stat key={l} label={l} value={v} hint={d} />)}
        </StatTiles>
      </div>
    </Card>
    </Section>
  );
}

export function Boundaries() {
  const w = useWords();
  const toast = useToast();
  const d = useAsync<any>(() => api.get('/attendance/boundaries'), []);
  const data = d.data;
  return (
    <>
      <PageHeader title="Check-in boundary" subtitle="Where members must be to check in at church." />
      <Load loading={d.loading} error={d.error} hasData={!!data}>
        {data && (
          <div>
            <Note tone="info">{`Set the place of each branch. A member's phone must be inside the distance you choose. A single ${w.oneLower}, such as a crusade ground, can have its own place: see ${w.many}, Upcoming, Manage.`}</Note>
            {data.branches.length === 0 && <Card><EmptyState icon="building" title="No branches" /></Card>}
            {data.branches.map((b: any) => <BranchCard key={b.id} b={b} canManage={!!data.canManage} onChanged={d.reload} say={toast.show} />)}
            <Section title="Check-ins that were stopped" hint="If many members are stopped when they are really at church, make the distance bigger.">
            <Card pad={false}>
              {data.blocked.length === 0 ? <EmptyState icon="shield" title="No check-ins were stopped recently" /> : (
                <table className="at-table">
                  <thead><tr><th>Time</th><th>Name</th><th>What happened</th><th>{w.one}</th></tr></thead>
                  <tbody>
                    {data.blocked.map((x: any, i: number) => (
                      <tr key={i}>
                        <td data-l="Time">{dayTime(x.at)}</td>
                        <td data-l="Name"><b>{x.name}</b></td>
                        <td data-l="What happened">{x.status === 'away' ? `Too far (${metres(x.distanceM ?? 0)})` : 'Phone could not say where it was'}</td>
                        <td data-l={w.one}>{x.service}{x.branch ? <div className="tiny">{x.branch}</div> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            </Section>
          </div>
        )}
      </Load>
      {toast.node}
    </>
  );
}

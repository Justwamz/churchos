import { useEffect, useState } from 'react';
import { Button, ErrorNote, Note, useAsync, useToast } from '@churchos/ui';
import { api, friendly } from './session';
import './pastoral.css';
import './people.css';

type HL = { name: string; phone: string; note: string };

export function Helplines() {
  const toast = useToast();
  const d = useAsync<any>(() => api.get('/pastoral/settings'), []);
  const [rows, setRows] = useState<HL[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [blocked, setBlocked] = useState(false);
  useEffect(() => { if (d.data) setRows((d.data.helplines ?? []).map((h: any) => ({ name: h.name ?? '', phone: h.phone ?? '', note: h.note ?? '' }))); }, [d.data]);
  if (d.error && !d.data) return null; // people who cannot open this setting do not need an error here
  const set = (i: number, k: keyof HL, v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const save = async () => {
    setErr('');
    for (const r of rows) {
      if (!r.name.trim()) return setErr('Every helpline needs a name.');
      if (!/^[0-9+ ]{3,20}$/.test(r.phone.trim())) return setErr('Numbers can only use digits, spaces and +, 3 to 20 characters.');
    }
    setBusy(true);
    try {
      await api.put('/pastoral/settings', { helplines: rows.map((r) => ({ name: r.name.trim(), phone: r.phone.trim(), ...(r.note.trim() ? { note: r.note.trim() } : {}) })) });
      toast.show('Helplines saved'); d.reload();
    } catch (e: any) {
      if (e?.status === 403) setBlocked(true);
      setErr(e?.status === 403 ? '' : e?.code === 'bad_helplines' ? 'Please check the helplines. You can have 1 to 8, each with a name and a number.' : friendly(e?.message));
    }
    setBusy(false);
  };
  const off = blocked || d.data?.canEdit === false;
  return (
    <div>
      <div className="pp-stack">
        <p className="pp-note">Members see these numbers in the app when they need urgent help.</p>
        {d.data?.standard && <Note tone="warn">These are the standard numbers. Please check each one is right for your area before members rely on them.</Note>}
        {off && <Note>Only people who manage every branch can change the helplines.</Note>}
        {rows.map((r, i) => (
          <div className="pp-hl" key={i}>
            <label className="field"><span className="field-label">Name</span><input value={r.name} maxLength={60} disabled={off} onChange={(e) => set(i, 'name', e.target.value)} /></label>
            <label className="field"><span className="field-label">Number</span><input inputMode="tel" value={r.phone} maxLength={20} disabled={off} onChange={(e) => set(i, 'phone', e.target.value)} /></label>
            <label className="field"><span className="field-label">Note (optional)</span><input value={r.note} maxLength={120} disabled={off} onChange={(e) => set(i, 'note', e.target.value)} /></label>
            <Button kind="ghost" disabled={off || rows.length <= 1} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="pp-row-flex">
          <Button kind="ghost" disabled={off || rows.length >= 8} onClick={() => setRows((x) => [...x, { name: '', phone: '', note: '' }])}>Add a helpline</Button>
          <Button disabled={busy || off || !rows.length} onClick={save}>{busy ? 'Saving...' : 'Save helplines'}</Button>
        </div>
      </div>
      {toast.node}
    </div>
  );
}

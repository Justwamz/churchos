import { useEffect, useState } from 'react';
import { API_URL, Button, ErrorNote, Field, Note, kes, shortDate, useToast } from '@churchos/ui';
import { Card, Skeleton } from './ui';
import { api, friendly } from './session';
import './statements.css';
import './money.css';

/** Fetches a statement PDF with the token and opens it in a new tab. Returns a blob URL if the popup was blocked. */
async function openPdf(id: string): Promise<string | null> {
  const token = api.getToken();
  const res = await fetch(`${API_URL}/statements/${id}/pdf`, { headers: { 'x-churchos-app': 'staff', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!res.ok) throw new Error('Could not open the statement. Try again.');
  const url = URL.createObjectURL(await res.blob());
  const w = window.open(url, '_blank');
  if (!w) return url;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return null;
}

export function StatementCard({ member, years, reason, note, reasonOk }: { member: { id: string; name: string }; years: string[]; reason: string; note: string; reasonOk: boolean }) {
  const toast = useToast();
  const thisYear = new Date().getFullYear();
  const options = years.length ? years : Array.from({ length: 5 }, (_, i) => String(thisYear - i));
  const [year, setYear] = useState(options.includes(String(thisYear)) ? String(thisYear) : options[0]);
  const [list, setList] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const load = () => api.get<any>(`/members/${member.id}/statements`).then((r) => setList(r.statements ?? [])).catch((e) => { setList([]); setErr(friendly(e.message)); });
  useEffect(() => { load(); }, [member.id]);

  const open = async (id: string) => {
    setErr(''); setLink(null);
    try { const u = await openPdf(id); if (u) setLink(u); }
    catch (e: any) { setErr(friendly(e.message)); }
  };
  const make = async () => {
    setErr(''); setLink(null);
    if (!reasonOk) return setErr('Choose a reason first (for “Other”, write a short note).');
    setBusy(true);
    try {
      const r = await api.post<any>(`/members/${member.id}/statements`, { year: Number(year), reason, note: note.trim() });
      toast.show(`Statement ${r.number} made: ${r.gifts} gift${r.gifts === 1 ? '' : 's'}, ${kes(r.total)}.`, 'good');
      await open(r.id);
      load();
    } catch (e: any) { setErr(friendly(e.message)); }
    setBusy(false);
  };
  return (
    <div className="st-card">
      <h4 style={{ margin: 0, fontSize: 16 }}>Giving statement</h4>
      <div className="st-make">
        <Field label="Year"><select aria-label="Statement year" value={year} onChange={(e) => setYear(e.target.value)}>{options.map((y) => <option key={y}>{y}</option>)}</select></Field>
        <Button disabled={busy} onClick={make}>{busy ? 'Making...' : 'Make statement (PDF)'}</Button>
      </div>
      <div className="tiny">Uses the reason you gave to open this record. Making a statement is recorded and the member can see it.</div>
      {err && <ErrorNote>{err}</ErrorNote>}
      {link && <div className="tiny">Your browser blocked the new tab. <a href={link} target="_blank" rel="noreferrer">Open the PDF</a></div>}
      <h4 style={{ margin: '8px 0 0' }}>Statements for this member</h4>
      {list === null ? <Skeleton lines={2} /> : list.length === 0 ? <div className="muted">No statements made yet.</div> : (
        <div className="st-list">
          {list.map((s) => (
            <div className="st-row" key={s.id}>
              <div><b className="mono">{s.number}</b> · {s.year} · {kes(s.total)} <span className="tiny">({s.gifts} gift{s.gifts === 1 ? '' : 's'})</span></div>
              <div className="tiny">{shortDate(s.at)} · made by {s.by} · {s.reason}</div>
              <div><Button small kind="ghost" onClick={() => open(s.id)}>Open PDF</Button></div>
            </div>
          ))}
        </div>
      )}
      <div className="tiny">Opening a statement is recorded and the member can see it.</div>
      {toast.node}
    </div>
  );
}

export function StatementSettings() {
  const toast = useToast();
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.get<any>('/statements/settings').then((r) => setF({ registrationNo: r.registrationNo ?? '', kraPin: r.kraPin ?? '', signatoryName: r.signatoryName ?? '', signatoryTitle: r.signatoryTitle ?? '', footer: r.footer ?? '' })).catch((e) => setErr(friendly(e.message))); }, []);
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const save = async () => {
    setErr(''); setBusy(true);
    try { await api.put('/statements/settings', f); toast.show('Saved.', 'good'); }
    catch (e: any) { setErr(friendly(e.message)); }
    setBusy(false);
  };
  return (
    <Card>
      <div className="mn-cardhead"><h3>What appears on statements</h3></div>
      {!f ? (err ? <ErrorNote>{err}</ErrorNote> : <Skeleton lines={3} />) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div className="st-two">
            <Field label="Registration number"><input value={f.registrationNo} maxLength={60} onChange={(e) => set('registrationNo', e.target.value)} /></Field>
            <Field label="KRA PIN"><input value={f.kraPin} maxLength={30} onChange={(e) => set('kraPin', e.target.value)} /></Field>
            <Field label="Signatory name"><input value={f.signatoryName} maxLength={80} onChange={(e) => set('signatoryName', e.target.value)} /></Field>
            <Field label="Signatory title"><input value={f.signatoryTitle} maxLength={80} onChange={(e) => set('signatoryTitle', e.target.value)} /></Field>
          </div>
          <Field label="Footer text" hint={`${f.footer.length} of 400 characters`}><textarea rows={3} maxLength={400} value={f.footer} onChange={(e) => set('footer', e.target.value)} /></Field>
          <Note tone="info">ChurchOS makes no claim about tax treatment. Say what you need to in the footer.</Note>
          {err && <ErrorNote>{err}</ErrorNote>}
          <div><Button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save'}</Button></div>
        </form>
      )}
      {toast.node}
    </Card>
  );
}

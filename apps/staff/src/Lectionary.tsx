import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, Field, Note, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load, PageHead } from './bits';
import { Modal } from './MemberForm';
import './lectionary.css';

const DOT: Record<string, string> = { white: '#f4f1e8', red: '#c0392b', green: '#2e8b57', purple: '#6b3fa0', rose: '#e58fa6', blue: '#2f5fb3', gold: '#c9a227', black: '#222' };
const dateText = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-KE', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

type Row = { label: string; ref: string };

function DayModal({ day, seasons, colours, defaultDate, onClose, onDone }: { day?: any; seasons: string[]; colours: string[]; defaultDate: string; onClose: () => void; onDone: (m: string) => void }) {
  const [date, setDate] = useState<string>(day?.date ?? defaultDate);
  const [title, setTitle] = useState<string>(day?.title ?? '');
  const [season, setSeason] = useState<string>(day?.season ?? '');
  const [cycle, setCycle] = useState<string>(day?.cycle ?? '');
  const [colour, setColour] = useState<string>(day?.colour ?? '');
  const [note, setNote] = useState<string>(day?.note ?? '');
  const [rows, setRows] = useState<Row[]>(day?.readings?.length ? day.readings.map((r: any) => ({ label: r.label ?? '', ref: r.ref })) : [{ label: '', ref: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const setRow = (i: number, p: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const submit = async () => {
    setError('');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError('Choose the date.');
    if (title.trim().length < 2) return setError('Give the day a name.');
    const readings = rows.filter((r) => r.ref.trim()).map((r) => ({ ...(r.label.trim() ? { label: r.label.trim() } : {}), ref: r.ref.trim() }));
    setBusy(true);
    try {
      await api.put(`/lectionary/${date}`, { title: title.trim(), season: season || undefined, cycle: cycle || undefined, colour: colour || undefined, readings, note: note.trim() || undefined });
      onDone(day ? 'Saved.' : 'Day added.');
    } catch (e: any) { setError(friendly(e.message)); } finally { setBusy(false); }
  };
  return (
    <Modal title={day ? 'Change this day' : 'Add a day'} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="Date"><input type="date" value={date} disabled={!!day} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Name of the day"><input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Third Sunday of Advent" /></Field>
        <div className="lc-three">
          <Field label="Season"><select value={season} onChange={(e) => setSeason(e.target.value)}><option value="">None</option>{seasons.map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Year"><select value={cycle} onChange={(e) => setCycle(e.target.value)}><option value="">Not set</option><option>A</option><option>B</option><option>C</option></select></Field>
          <Field label="Colour"><select value={colour} onChange={(e) => setColour(e.target.value)}><option value="">None</option>{colours.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}</select></Field>
        </div>
        <div>
          <div className="field-label">Readings (up to 6)</div>
          <div className="stack" style={{ gap: 8 }}>
            {rows.map((r, i) => (
              <div className="lc-read" key={i}>
                <input aria-label={`Label ${i + 1}`} value={r.label} maxLength={40} onChange={(e) => setRow(i, { label: e.target.value })} placeholder="Label (optional)" />
                <input aria-label={`Reading ${i + 1}`} value={r.ref} maxLength={80} onChange={(e) => setRow(i, { ref: e.target.value })} placeholder="For example: Isaiah 35:1-10" />
                {rows.length > 1 && <Button small kind="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>}
              </div>
            ))}
          </div>
          {rows.length < 6 && <div style={{ marginTop: 8 }}><Button small kind="ghost" onClick={() => setRows([...rows, { label: '', ref: '' }])}>Add a reading</Button></div>}
          <p className="tiny">If you leave the label empty, ChurchOS fills in First reading, Psalm, Second reading and Gospel in order.</p>
        </div>
        <Field label="Note (optional)"><textarea rows={2} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button kind="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save'}</Button>
        </div>
      </form>
    </Modal>
  );
}

const FORMAT_EXAMPLE = '2026-11-29 | First Sunday of Advent | A | Isaiah 2:1-5; Psalm 122; Romans 13:11-14; Matthew 24:36-44';

function Paste({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [res, setRes] = useState<any>(null);
  const go = async () => {
    setErr(''); setRes(null);
    if (!text.trim()) return setErr('Paste at least one line first.');
    setBusy(true);
    try { const r = await api.post<any>('/lectionary/import', { text }); setRes(r); if (r.added || r.changed) onDone(); }
    catch (e: any) { setErr(friendly(e.message)); }
    setBusy(false);
  };
  return (
    <Card title="Paste a season">
      <div className="stack">
        <p style={{ margin: 0 }}>One day per line: <b>date | name of the day | A, B or C (optional) | references separated by semicolons</b>. Lines that start with # are ignored.</p>
        <code className="lc-example">{FORMAT_EXAMPLE}</code>
        <textarea aria-label="Lines to paste" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={FORMAT_EXAMPLE} style={{ width: '100%', fontFamily: 'monospace' }} />
        {err && <ErrorNote>{err}</ErrorNote>}
        <div><Button disabled={busy} onClick={go}>{busy ? 'Saving...' : 'Check and save'}</Button></div>
        {res && (
          <div className="stack" role="status" style={{ gap: 6 }}>
            <div><b>{res.added}</b> added, <b>{res.changed}</b> changed{res.errors?.length ? `, ${res.errors.length} line${res.errors.length === 1 ? '' : 's'} not saved` : '.'}</div>
            {res.errors?.length > 0 && (
              <ul className="lc-errors">
                {res.errors.map((e: any, i: number) => <li key={i}><b>Line {e.line}:</b> {e.message}<div className="tiny mono">{e.text}</div></li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

export function Lectionary() {
  const s = useSession();
  const toast = useToast();
  const [earlier, setEarlier] = useState(false);
  const [modal, setModal] = useState<{ day?: any } | null>(null);
  const [gone, setGone] = useState<any>(null);
  const d = useAsync<any>(async () => {
    const t = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
    return api.get(`/lectionary?from=${earlier ? addDays(t, -400) : t}&to=${addDays(t, 400)}`);
  }, [earlier]);
  const data = d.data;
  const canManage = data ? !!data.canManage : s.can('attendance.manage');
  const done = (m: string) => { setModal(null); toast.show(m); d.reload(); };
  const remove = async () => {
    try { await api.post(`/lectionary/${gone.date}/remove`, {}); setGone(null); toast.show('Removed.'); d.reload(); }
    catch (e: any) { setGone(null); toast.show(friendly(e.message), 'bad'); }
  };
  return (
    <>
      <PageHead title="Lectionary" sub="The readings for each Sunday and feast day." action={canManage ? <Button onClick={() => setModal({})}>Add a day</Button> : undefined} />
      <div className="stack">
        <Note tone="info">ChurchOS does not supply the lectionary or the readings. Enter the references from your own lectionary (the Revised Common Lectionary). Members see them after they check in.</Note>
        <Load loading={d.loading} error={d.error} hasData={!!data}>
          {data && (
            <Card title={earlier ? 'All days' : 'From today'}>
              {data.days.length === 0 ? <Empty>No days yet. Add one, or paste a whole season below.</Empty> : (
                <div className="lc-list">
                  {data.days.map((x: any) => (
                    <div className="lc-row" key={x.id}>
                      <div className="lc-date">{dateText(x.date)}</div>
                      <div className="lc-main">
                        <div className="lc-name">
                          {x.colour && <i className="lc-dot" title={x.colour} style={{ background: DOT[x.colour] ?? '#999' }} />}
                          <b>{x.title}</b>
                          {x.season && <Badge tone="info">{x.season}</Badge>}
                          {x.cycle && <Badge tone="muted">{`Year ${x.cycle}`}</Badge>}
                        </div>
                        <div className="chips">{x.readings.map((r: any, i: number) => <span className="chip lc-chip" key={i}>{r.label ? `${r.label}: ` : ''}{r.ref}</span>)}</div>
                        {x.note && <div className="tiny">{x.note}</div>}
                      </div>
                      {canManage && (
                        <div className="lc-btns">
                          <Button small kind="ghost" onClick={() => setModal({ day: x })}>Change</Button>
                          <Button small kind="danger" onClick={() => setGone(x)}>Remove</Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ marginTop: 12 }}><Button small kind="ghost" onClick={() => setEarlier(!earlier)}>{earlier ? 'Show from today only' : 'Show earlier'}</Button></div>
            </Card>
          )}
        </Load>
        {canManage && <Paste onDone={d.reload} />}
      </div>
      {modal && data && <DayModal day={modal.day} seasons={data.seasons} colours={data.colours} defaultDate={data.today ?? ''} onClose={() => setModal(null)} onDone={done} />}
      {gone && (
        <Modal title="Remove this day?" onClose={() => setGone(null)}>
          <div className="stack">
            <p style={{ margin: 0 }}>{gone.title} on {dateText(gone.date)} will no longer show to members.</p>
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <Button kind="ghost" onClick={() => setGone(null)}>Keep it</Button>
              <Button kind="danger" onClick={remove}>Remove</Button>
            </div>
          </div>
        </Modal>
      )}
      {toast.node}
    </>
  );
}

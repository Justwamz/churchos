import { useEffect, useState } from 'react';
import { Button, ErrorNote, Field, Note, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import './join-requests.css';
import { useWords } from './words';
import { Card, PageHeader, Section } from './ui';

/** Church setup > Wording, second card: whether people can find the church by typing its name. Owner (church.settings) edits; others read. */
function DirectoryCard() {
  const s = useSession();
  const toast = useToast();
  const d = useAsync<{ listed: boolean }>(() => api.get('/church/directory' + s.qs()), [s.qs()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const can = s.can('church.settings');
  const listed = d.data?.listed;
  const change = async (v: boolean) => {
    setBusy(true); setErr('');
    try { await api.put('/church/directory' + s.qs(), { listed: v }); toast.show(v ? 'Saved. Your church shows in the search.' : 'Saved. Your church is hidden from the search.'); d.reload(); }
    catch (e: any) { setErr(friendly(e.message)); }
    setBusy(false);
  };
  return (
    <>
      <Section title="Can people find your church by name?">
        <Card>
          {d.error && !d.data ? <ErrorNote>{friendly(d.error)}</ErrorNote> : (
            <>
              <label className={`jr-switch ${can ? '' : 'off'}`}>
                <input type="checkbox" role="switch" checked={!!listed} disabled={!can || busy || listed === undefined} onChange={(e) => change(e.target.checked)} />
                <span className="jr-track" aria-hidden="true" />
                <span>Show my church when people search by name</span>
              </label>
              <p className="jr-hint" style={{ margin: '8px 0 0' }}>People can always reach your church with its code or giving link. Turn this off if you do not want your church to appear in the search.</p>
              {!can && <p className="jr-hint" style={{ margin: '8px 0 0' }}>Only the owner can change this.</p>}
              {err && <div className="note bad" role="alert" style={{ marginTop: 12 }}>{err}</div>}
            </>
          )}
        </Card>
      </Section>
      {toast.node}
    </>
  );
}

/** Church setup > Wording: what this church calls its gatherings. The owner picks a preset or types their own pair; everyone else reads it. */
export function WordingPage() {
  const w = useWords();
  const toast = useToast();
  const [one, setOne] = useState(w.one);
  const [many, setMany] = useState(w.many);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setOne(w.one); setMany(w.many); }, [w.one, w.many]);

  const o = one.trim() || 'Service';
  const m = many.trim() || 'Services';
  const changed = one.trim() !== w.one || many.trim() !== w.many;
  const pick = (p: { one: string; many: string }) => { if (w.canChange) { setOne(p.one); setMany(p.many); setError(''); } };
  const save = async () => {
    setBusy(true); setError('');
    try { await w.save(one.trim(), many.trim()); toast.show('Saved. The whole app now says ' + many.trim() + '.'); } catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  const isPreset = (p: { one: string; many: string }) => p.one.toLowerCase() === one.trim().toLowerCase() && p.many.toLowerCase() === many.trim().toLowerCase();
  const custom = !w.presets.some(isPreset);

  return (
    <>
      <PageHeader title="Wording" subtitle="What your church calls its gatherings. It changes the menus and screens for everyone, in this app and for your members." />
      {!w.canChange && <Note tone="info">Only the owner can change this.</Note>}
      <Section title="Pick a word">
        <Card>
          <div className="chips" role="radiogroup" aria-label="Word for a gathering">
            {w.presets.map((p) => (
              <button key={p.one} type="button" role="radio" aria-checked={isPreset(p)} className={`chip ${isPreset(p) ? 'on' : ''}`} disabled={!w.canChange} onClick={() => pick(p)}>{p.one}</button>
            ))}
            <span className={`chip ${custom ? 'on' : ''}`} aria-hidden="true" style={{ cursor: 'default', opacity: custom ? 1 : 0.6 }}>Your own word</span>
          </div>
          <div className="grid cols-2" style={{ marginTop: 20 }}>
            <Field label="One gathering" hint="For example: Mass"><input value={one} disabled={!w.canChange} maxLength={24} onChange={(e) => setOne(e.target.value)} /></Field>
            <Field label="Several gatherings" hint="For example: Masses"><input value={many} disabled={!w.canChange} maxLength={24} onChange={(e) => setMany(e.target.value)} /></Field>
          </div>
          {error && <div className="note bad" role="alert">{error}</div>}
          {w.canChange && (
            <div className="row" style={{ marginTop: 4 }}>
              <Button onClick={save} disabled={busy || !changed || one.trim().length < 2 || many.trim().length < 2}>{busy ? 'Saving...' : 'Save'}</Button>
              {changed && <Button kind="ghost" onClick={() => { setOne(w.one); setMany(w.many); setError(''); }}>Undo</Button>}
            </div>
          )}
        </Card>
      </Section>
      <DirectoryCard />
      <Section title="How it will read">
        <Card>
          <ul className="wd-preview">
            <li>Next {o} starts at 10:00</li>
            <li>{m} this week: 4</li>
            <li>Check-in is open for {o.toLowerCase()}</li>
            <li>Add a new {o.toLowerCase()} to the weekly schedule</li>
          </ul>
        </Card>
      </Section>
      {toast.node}
    </>
  );
}

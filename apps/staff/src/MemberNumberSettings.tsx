import { useEffect, useState } from 'react';
import { Button, Card, ErrorNote, Field, Note } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Hist, Load } from './bits';
import { useAsync } from '@churchos/ui';

const PRESETS = ['M{SEQ:5}', 'GRC/{YYYY}/{SEQ:4}', '{BRANCH}-{SEQ:4}'];

export type NumberSettings = { pattern: string; next: number; preview: string; canEdit: boolean };

export function MemberNumberSettings({ settings, reload }: { settings: ReturnType<typeof useAsync<NumberSettings>>; reload: () => void }) {
  const s = useSession();
  const d = settings.data;
  const [pattern, setPattern] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (d) { setPattern(d.pattern); setNext(String(d.next)); } }, [d?.pattern, d?.next]);

  const save = async () => {
    setBusy(true); setError(''); setSaved(false);
    try {
      await api.put('/members/settings' + s.qs({ branch: undefined }), { pattern, next: next === '' ? undefined : Number(next) });
      setSaved(true);
      reload();
    } catch (e: any) { setError(friendly(e.message)); }
    setBusy(false);
  };

  return (
    <Card title="Member number format" action={<Hist entity="member_number_format" entityId={s.grant.org.id} title="Member number format" />}>
      <Load loading={settings.loading} error={settings.error} hasData={!!d}>
        {d && (
          <div className="stack">
            <div className="row" style={{ gap: 24 }}>
              <div><div className="tiny">Current format</div><b className="mono">{d.pattern}</b></div>
              <div><div className="tiny">Next number</div><b className="mono">{d.preview}</b></div>
            </div>
            <div className="tiny">
              <b>{'{SEQ:4}'}</b> counter with 4 digits · <b>{'{YYYY}'}</b> year · <b>{'{YY}'}</b> two-digit year · <b>{'{BRANCH}'}</b> branch code. For example GRC/{'{YYYY}'}/{'{SEQ:4}'}.
            </div>
            <Note tone="info">Changing the format only affects new members. Existing numbers never change.</Note>
            {d.canEdit && (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
                <div className="chips" aria-label="Example formats">
                  {PRESETS.map((p) => <button type="button" key={p} className={`chip ${pattern === p ? 'on' : ''}`} onClick={() => setPattern(p)}>{p}</button>)}
                </div>
                <div className="grid cols-2">
                  <Field label="Format"><input className="mono" value={pattern} onChange={(e) => setPattern(e.target.value)} /></Field>
                  <Field label="Next counter value"><input inputMode="numeric" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
                </div>
                {error && <ErrorNote>{error}</ErrorNote>}
                {saved && <Note tone="good">Saved. The next member will get {d.preview}.</Note>}
                <div><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save format'}</Button></div>
              </form>
            )}
            {!d.canEdit && <div className="tiny">Only the church owner can change the format.</div>}
          </div>
        )}
      </Load>
    </Card>
  );
}

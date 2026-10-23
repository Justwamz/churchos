import { useState } from 'react';
import { Failed, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import './join-requests.css';
import { Card, Section } from './ui';

/** Church setup > Logo and listing: whether people can find the church by typing its name. Owner (church.settings) edits; others read. */
export function DirectoryCard() {
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
          {d.error && !d.data ? <Failed onRetry={d.reload}>{friendly(d.error)}</Failed> : (
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

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Api } from './api';

/** Shared audit screens for the staff dashboard and the admin console (L104 to L109). Both expose the same endpoints under a base path. */

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Nairobi' }) : '';

const CAPACITY: Record<string, string> = { user: 'Staff', admin: 'ChurchOS admin', member: 'Member', system: 'System', psp: 'Payment provider' };
const CATEGORY_LABEL: Record<string, string> = { money: 'Money', member: 'People', record: 'Records', access: 'Access', config: 'Settings', security: 'Security', messaging: 'Messages', system: 'System' };

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.map(show).join(', ') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
};

function Chip({ children, tone }: { children: ReactNode; tone?: 'good' | 'warn' | 'bad' | 'info' | 'muted' }) {
  return <span className={`badge ${tone ?? 'muted'}`}>{children}</span>;
}

/** A before and after table for one event or one comparison. Masked values are marked, so nobody mistakes them for the real value. */
export function ChangeTable({ changes }: { changes: { field: string; label?: string; before: unknown; after: unknown; masked?: boolean }[] }) {
  if (!changes?.length) return <div className="tiny">No field changes were recorded for this event.</div>;
  return (
    <div className="table-wrap">
      <table className="table audit-changes">
        <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
        <tbody>
          {changes.map((c, i) => (
            <tr key={i}>
              <td>{c.label ?? c.field}{c.masked && <> <Chip tone="info">hidden</Chip></>}</td>
              <td className="audit-before">{show(c.before)}</td>
              <td className="audit-after">{show(c.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal audit-modal" style={{ width: wide ? 'min(920px, 100%)' : undefined }} onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button type="button" className="help-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * The history of one thing: every event, every saved version, and a side-by-side comparison of any two versions (L105).
 * `base` is '/audit' for a church and '/admin/audit' for platform admins.
 */
export function AuditHistory(p: { api: Api; base: string; entity: string; entityId: string; title: string; qs?: string; onClose: () => void }) {
  const [data, setData] = useState<any>();
  const [error, setError] = useState<string>();
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [cmp, setCmp] = useState<any>();
  const [snap, setSnap] = useState<any>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    p.api.get(`${p.base}/history?entity=${encodeURIComponent(p.entity)}&entityId=${encodeURIComponent(p.entityId)}${p.qs ?? ''}`)
      .then((d) => {
        setData(d);
        const v = d.versions ?? [];
        if (v.length >= 2) { setFrom(v[v.length - 2].version); setTo(v[v.length - 1].version); }
      })
      .catch((e) => setError(e.message ?? 'We could not load the history.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.entity, p.entityId]);

  const compare = async () => {
    if (from === null || to === null) return;
    setBusy(true); setSnap(undefined);
    try { setCmp(await p.api.get(`${p.base}/compare?entity=${encodeURIComponent(p.entity)}&entityId=${encodeURIComponent(p.entityId)}&from=${from}&to=${to}${p.qs ?? ''}`)); }
    catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  const open = async (n: number) => {
    setBusy(true); setCmp(undefined);
    try { setSnap(await p.api.get(`${p.base}/versions/${encodeURIComponent(p.entity)}/${encodeURIComponent(p.entityId)}/${n}${p.qs ? `?${p.qs.replace(/^&/, '')}` : ''}`)); }
    catch (e: any) { setError(e.message); }
    setBusy(false);
  };

  return (
    <Modal title={`History: ${p.title}`} onClose={p.onClose} wide>
      {error && <div className="note bad">{error}</div>}
      {!data && !error && <div className="spinner" />}
      {data && (
        <div className="stack">
          <section>
            <h3>Versions</h3>
            {data.versions.length === 0 ? <div className="tiny">No saved versions yet.</div> : (
              <>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Version</th><th>When</th><th>Who</th><th>What changed</th><th>Compare</th><th /></tr></thead>
                    <tbody>
                      {data.versions.map((v: any) => (
                        <tr key={v.version}>
                          <td>v{v.version}</td>
                          <td>{when(v.changed_at)}</td>
                          <td>{v.changed_by_name ?? 'System'}</td>
                          <td>{v.summary}</td>
                          <td>
                            <label className="tiny"><input type="radio" name="from" checked={from === v.version} onChange={() => setFrom(v.version)} /> from</label>{' '}
                            <label className="tiny"><input type="radio" name="to" checked={to === v.version} onChange={() => setTo(v.version)} /> to</label>
                          </td>
                          <td><button type="button" className="btn ghost small" onClick={() => open(v.version)}>Open</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {data.versions.length >= 2 && (
                  <div className="row" style={{ marginTop: 8 }}>
                    <button type="button" className="btn primary small" disabled={busy || from === null || to === null || from === to} onClick={compare}>Compare v{from ?? '?'} with v{to ?? '?'}</button>
                    <span className="tiny">Sensitive values such as phone numbers and dates of birth are shown hidden in history.</span>
                  </div>
                )}
              </>
            )}
            {cmp && (
              <div className="card" style={{ marginTop: 12 }}>
                <div className="tiny">Changes from v{cmp.from.version} ({cmp.from.changedBy ?? 'System'}) to v{cmp.to.version} ({cmp.to.changedBy ?? 'System'})</div>
                {cmp.changes.length === 0 ? <div className="empty">These two versions are identical.</div> : <ChangeTable changes={cmp.changes} />}
              </div>
            )}
            {snap && (
              <div className="card" style={{ marginTop: 12 }}>
                <div className="tiny">Version {snap.version}, saved {when(snap.changedAt)} by {snap.changedBy ?? 'System'}</div>
                <div className="table-wrap">
                  <table className="table"><tbody>
                    {Object.entries(snap.snapshot ?? {}).map(([k, v]) => <tr key={k}><td style={{ width: '35%' }}>{k.replace(/_/g, ' ')}</td><td>{show(v)}</td></tr>)}
                  </tbody></table>
                </div>
              </div>
            )}
          </section>
          <section>
            <h3>Timeline</h3>
            {data.events.length === 0 ? <div className="tiny">No events recorded.</div> : (
              <ol className="audit-timeline">
                {data.events.map((e: any) => (
                  <li key={e.id}>
                    <div className="row between"><strong>{e.summary}</strong><span className="tiny">{when(e.at)}</span></div>
                    <div className="tiny">{e.actor_name ?? 'System'} · {CAPACITY[e.actor_type] ?? e.actor_type}{e.app ? ` · ${e.app} app` : ''}</div>
                    {e.reason && <div className="note info" style={{ margin: '6px 0' }}>Reason: {e.reason}</div>}
                    {e.changes?.length > 0 && <ChangeTable changes={e.changes} />}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

export interface AuditLogProps {
  api: Api;
  /** '/audit' for a church, '/admin/audit' for ChurchOS admins. */
  base: string;
  /** Extra query string such as `&org=org_grace`. */
  qs?: string;
  canExport?: boolean;
  /** Platform admins can also filter by church. */
  showOrg?: boolean;
}

/** The searchable audit log with an integrity check, an event detail view and optional CSV export (L107, L108). */
export function AuditLog(p: AuditLogProps) {
  const [filters, setFilters] = useState({ q: '', category: '', actor: '', action: '', from: '', to: '' });
  const [rows, setRows] = useState<any[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<any>();
  const [history, setHistory] = useState<{ entity: string; id: string; title: string } | null>(null);
  const [integrity, setIntegrity] = useState<any>();
  const [checking, setChecking] = useState(false);

  const query = useCallback((cursor?: number | null) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
    q.set('limit', '50');
    if (cursor) q.set('before', String(cursor));
    return `${q.toString()}${p.qs ?? ''}`;
  }, [filters, p.qs]);

  const load = useCallback(async (append = false, cursor?: number | null) => {
    setLoading(true); setError(undefined);
    try {
      const r = await p.api.get(`${p.base}/events?${query(cursor)}`);
      setRows((cur) => (append ? [...cur, ...r.events] : r.events));
      setNext(r.nextBefore);
    } catch (e: any) { setError(e.message ?? 'We could not load the audit log.'); }
    setLoading(false);
  }, [p.api, p.base, query]);

  useEffect(() => {
    const t = setTimeout(() => load(false), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, p.qs]);

  const verify = async () => {
    setChecking(true);
    try { setIntegrity(await p.api.get(`${p.base}/verify`)); } catch (e: any) { setError(e.message); }
    setChecking(false);
  };

  const set = (k: keyof typeof filters) => (e: { target: { value: string } }) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const download = () => { p.api.openDownload(`/audit/export?${query(null)}`).catch((e: any) => setError(e.message)); };
  const entityTitle = (e: any) => `${(e.entity ?? '').replace(/_/g, ' ')} ${e.entity_id ?? ''}`.trim();

  const bad = integrity && (integrity.ok === false);
  return (
    <div className="stack">
      <div className="card">
        <div className="row between">
          <div>
            <h3>Integrity check</h3>
            <div className="tiny">Every event is chained to the one before it. If anything is changed or removed, the check says exactly where.</div>
          </div>
          <button type="button" className="btn ghost small" onClick={verify} disabled={checking}>{checking ? 'Checking…' : 'Verify integrity now'}</button>
        </div>
        {integrity && !bad && (
          <div className="note good">
            {integrity.chains
              ? `All ${integrity.chains.reduce((n: number, c: any) => n + c.events, 0).toLocaleString()} events across ${integrity.chains.length} logs verified. Nothing has been changed or removed.`
              : `All ${integrity.events.toLocaleString()} events verified. Nothing has been changed or removed.`}
          </div>
        )}
        {bad && (
          <div className="note bad" role="alert">
            <strong>The log does not verify.</strong>{' '}
            {integrity.chains
              ? integrity.chains.filter((c: any) => !c.ok).map((c: any) => `${c.chain}: ${c.reason} (event number ${c.brokenAtSeq})`).join('; ')
              : `${integrity.reason} (event number ${integrity.brokenAtSeq}).`}{' '}
            Please contact ChurchOS support straight away.
          </div>
        )}
      </div>

      <div className="card">
        <div className="audit-filters">
          <input type="search" placeholder="Search what happened…" value={filters.q} onChange={set('q')} aria-label="Search" />
          <select value={filters.category} onChange={set('category')} aria-label="Category">
            <option value="">Everything</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input placeholder="Who (name)" value={filters.actor} onChange={set('actor')} aria-label="Who" />
          <input placeholder="Action, e.g. record." value={filters.action} onChange={set('action')} aria-label="Action" />
          <input type="date" value={filters.from} onChange={set('from')} aria-label="From date" />
          <input type="date" value={filters.to} onChange={set('to')} aria-label="To date" />
        </div>
        <div className="row between" style={{ marginTop: 8 }}>
          <span className="tiny">{rows.length} shown{next ? ' (more available)' : ''}</span>
          {p.canExport && <button type="button" className="btn ghost small" onClick={download}>Download CSV</button>}
        </div>
        {error && <div className="note bad">{error}</div>}
        <div className="table-wrap">
          <table className="table audit-table">
            <thead><tr><th>When</th><th>Who</th><th>What happened</th><th>Type</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="audit-row" onClick={() => setOpen(e)} tabIndex={0} onKeyDown={(k) => k.key === 'Enter' && setOpen(e)}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>{when(e.at)}</td>
                  <td>{e.actor_name ?? 'System'}<div className="tiny">{CAPACITY[e.actor_type] ?? e.actor_type}</div></td>
                  <td>{e.summary}{e.changes?.length > 0 && <div className="tiny">{e.changes.length} field{e.changes.length === 1 ? '' : 's'} changed</div>}</td>
                  <td><Chip tone={e.category === 'security' || e.category === 'access' ? 'warn' : 'muted'}>{CATEGORY_LABEL[e.category] ?? e.category}</Chip></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading && <div className="spinner" />}
        {!loading && rows.length === 0 && !error && <div className="empty">No events match these filters.</div>}
        {next && !loading && <div style={{ textAlign: 'center', marginTop: 8 }}><button type="button" className="btn ghost small" onClick={() => load(true, next)}>Show older events</button></div>}
      </div>

      {open && (
        <Modal title="Event details" onClose={() => setOpen(undefined)} wide>
          <p style={{ marginTop: 0 }}><strong>{open.summary}</strong></p>
          <div className="table-wrap">
            <table className="table"><tbody>
              <tr><td style={{ width: '30%' }}>When</td><td>{when(open.at)}</td></tr>
              <tr><td>Who</td><td>{open.actor_name ?? 'System'} ({CAPACITY[open.actor_type] ?? open.actor_type})</td></tr>
              <tr><td>Action</td><td className="mono">{open.action}</td></tr>
              {open.entity && <tr><td>Record</td><td>{entityTitle(open)}</td></tr>}
              {open.reason && <tr><td>Reason given</td><td>{open.reason}</td></tr>}
              <tr><td>From</td><td>{open.app ? `${open.app} app` : 'unknown app'}{open.ip ? ` · IP ${open.ip}` : ''}</td></tr>
              {open.user_agent && <tr><td>Device</td><td className="tiny">{open.user_agent}</td></tr>}
              <tr><td>Reference</td><td className="mono tiny">{open.id}{open.request_id ? ` · request ${open.request_id}` : ''}</td></tr>
            </tbody></table>
          </div>
          {open.links && Object.keys(open.links).length > 0 && (
            <>
              <h3 style={{ marginTop: 14 }}>Related</h3>
              <div className="table-wrap"><table className="table"><tbody>
                {Object.entries(open.links).map(([k, v]) => <tr key={k}><td style={{ width: '30%' }}>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</td><td className="mono">{String(v)}</td></tr>)}
              </tbody></table></div>
            </>
          )}
          <h3 style={{ marginTop: 14 }}>What changed</h3>
          <ChangeTable changes={open.changes ?? []} />
          {open.entity && open.entity_id && (
            <div style={{ marginTop: 12 }}>
              <button type="button" className="btn primary small" onClick={() => { setHistory({ entity: open.entity, id: open.entity_id, title: entityTitle(open) }); setOpen(undefined); }}>View full history of this record</button>
            </div>
          )}
        </Modal>
      )}
      {history && <AuditHistory api={p.api} base={p.base} qs={p.qs} entity={history.entity} entityId={history.id} title={history.title} onClose={() => setHistory(null)} />}
    </div>
  );
}

/** A small "History" button that opens the history of one record. Drop it next to any record in any screen. */
export function HistoryButton(p: { api: Api; base: string; entity: string; entityId: string; title: string; qs?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn ghost small" onClick={() => setOpen(true)}>{p.label ?? 'History'}</button>
      {open && <AuditHistory api={p.api} base={p.base} qs={p.qs} entity={p.entity} entityId={p.entityId} title={p.title} onClose={() => setOpen(false)} />}
    </>
  );
}

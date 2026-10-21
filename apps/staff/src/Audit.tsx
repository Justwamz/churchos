import { Fragment, useCallback, useEffect, useState } from 'react';
import { AuditHistory, ChangeTable, Button, ErrorNote, Note } from '@churchos/ui';
import { api, useSession } from './session';
import { Card, EmptyState, PageHeader, SidePanel, Skeleton, StatusChip, Toolbar } from './ui';
import './setup.css';

/** Audit log: same endpoints as the shared AuditLog (events, verify, export), shown as a day-by-day timeline with a details panel. */
const CAPACITY: Record<string, string> = { user: 'Staff', admin: 'ChurchOS admin', member: 'Member', system: 'System', psp: 'Payment provider' };
const CATEGORY: Record<string, string> = { money: 'Money', member: 'People', record: 'Records', access: 'Access', config: 'Settings', security: 'Security', messaging: 'Messages', system: 'System' };
const TONE: Record<string, 'wait' | 'done' | 'info' | 'off'> = { security: 'wait', access: 'wait', money: 'done', member: 'info' };
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Nairobi' }) : '');
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' });
const day = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Nairobi' });
const entityTitle = (e: any) => `${(e.entity ?? '').replace(/_/g, ' ')} ${e.entity_id ?? ''}`.trim();
const EMPTY = { q: '', category: '', actor: '', action: '', from: '', to: '' };

export function AuditPage() {
  const session = useSession();
  const qs = session.orgs.length > 1 ? `&org=${session.grant.org.id}` : '';
  const [filters, setFilters] = useState(EMPTY);
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
    return `${q.toString()}${qs}`;
  }, [filters, qs]);

  const load = useCallback(async (append = false, cursor?: number | null) => {
    setLoading(true); setError(undefined);
    try {
      const r = await api.get(`/audit/events?${query(cursor)}`);
      setRows((cur) => (append ? [...cur, ...r.events] : r.events));
      setNext(r.nextBefore);
    } catch (e: any) { setError(e.message ?? 'We could not load the audit log.'); }
    setLoading(false);
  }, [query]);

  useEffect(() => {
    const t = setTimeout(() => load(false), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, qs]);

  const verify = async () => {
    setChecking(true);
    try { setIntegrity(await api.get('/audit/verify')); } catch (e: any) { setError(e.message); }
    setChecking(false);
  };
  const set = (k: keyof typeof filters) => (e: { target: { value: string } }) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const anyFilter = Object.values(filters).some(Boolean);
  const bad = integrity && integrity.ok === false;
  const canExport = session.can('audit.export');

  return (
    <>
      <PageHeader title="Audit log" subtitle="Everything that changes in your church, with who did it and when. Entries cannot be edited or deleted."
        actions={<Button kind="ghost" onClick={verify} disabled={checking}>{checking ? 'Checking…' : 'Verify integrity'}</Button>} />
      {integrity && !bad && (
        <Note tone="good">
          {integrity.chains
            ? `All ${integrity.chains.reduce((n: number, c: any) => n + c.events, 0).toLocaleString()} events across ${integrity.chains.length} logs verified. Nothing has been changed or removed.`
            : `All ${integrity.events.toLocaleString()} events verified. Nothing has been changed or removed.`}
        </Note>
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
      <div style={{ height: 12 }} />
      <Toolbar end={canExport ? <button type="button" className="btn ghost small" onClick={() => { api.openDownload(`/audit/export?${query(null)}`).catch(() => undefined); }}>Download CSV</button> : undefined}>
        <input type="search" placeholder="Search what happened" value={filters.q} onChange={set('q')} aria-label="Search" />
        <select value={filters.category} onChange={set('category')} aria-label="Category">
          <option value="">Everything</option>
          {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input placeholder="Who (name)" value={filters.actor} onChange={set('actor')} aria-label="Who" style={{ maxWidth: 180 }} />
        <input placeholder="Action, e.g. record." value={filters.action} onChange={set('action')} aria-label="Action" style={{ maxWidth: 190 }} />
        <input type="date" value={filters.from} onChange={set('from')} aria-label="From date" style={{ maxWidth: 170, flex: '0 1 160px' }} />
        <input type="date" value={filters.to} onChange={set('to')} aria-label="To date" style={{ maxWidth: 170, flex: '0 1 160px' }} />
        {anyFilter && <Button small kind="ghost" onClick={() => setFilters(EMPTY)}>Clear</Button>}
      </Toolbar>
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && rows.length === 0 && <Skeleton rows={6} height={64} />}
      {!loading && rows.length === 0 && !error && (
        <Card><EmptyState icon="list" title="No events match" text={anyFilter ? 'Try fewer filters or a wider date range.' : 'Changes in your church will be recorded here.'} /></Card>
      )}
      {rows.length > 0 && (
        <Card pad={false}>
          <ol className="setup-timeline" aria-label="Audit events">
            {rows.map((e, i) => (
              <Fragment key={e.id}>
                {(i === 0 || day(rows[i - 1].at) !== day(e.at)) && <li className="setup-day" aria-hidden="true">{day(e.at)}</li>}
                <li className="setup-ev" tabIndex={0} role="button" aria-label={`${e.summary}, ${e.actor_name ?? 'System'}. Open details`} onClick={() => setOpen(e)} onKeyDown={(k) => { if (k.key === 'Enter' || k.key === ' ') { k.preventDefault(); setOpen(e); } }}>
                  <span className={`setup-ev-dot ${e.category}`} aria-hidden="true" />
                  <div className="setup-ev-main">
                    <b>{e.summary}</b>
                    <span className="tiny">{e.actor_name ?? 'System'} · {CAPACITY[e.actor_type] ?? e.actor_type}{e.changes?.length > 0 ? ` · ${e.changes.length} field${e.changes.length === 1 ? '' : 's'} changed` : ''}</span>
                  </div>
                  <div className="setup-ev-side">
                    <StatusChip tone={TONE[e.category] ?? 'off'}>{CATEGORY[e.category] ?? e.category}</StatusChip>
                    <span className="tiny">{clock(e.at)}</span>
                  </div>
                </li>
              </Fragment>
            ))}
          </ol>
        </Card>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
        <span className="tiny">{rows.length} shown{next ? ' (more available)' : ''}</span>
        {next && !loading && <Button kind="ghost" small onClick={() => load(true, next)}>Show older events</Button>}
      </div>
      <p className="tiny" style={{ marginTop: 16 }}><b>Privacy.</b> Sensitive details such as phone numbers and dates of birth are hidden in the log. Showing one is itself recorded.</p>

      {open && (
        <SidePanel title="Event details" subtitle={when(open.at)} width={560} onClose={() => setOpen(undefined)}
          footer={open.entity && open.entity_id ? <Button onClick={() => { setHistory({ entity: open.entity, id: open.entity_id, title: entityTitle(open) }); setOpen(undefined); }}>View full history of this record</Button> : undefined}>
          <div className="stack">
            <b style={{ fontSize: 16 }}>{open.summary}</b>
            <dl className="setup-kv">
              <dt>Who</dt><dd>{open.actor_name ?? 'System'} ({CAPACITY[open.actor_type] ?? open.actor_type})</dd>
              <dt>Type</dt><dd>{CATEGORY[open.category] ?? open.category}</dd>
              <dt>Action</dt><dd className="mono">{open.action}</dd>
              {open.entity && <><dt>Record</dt><dd>{entityTitle(open)}</dd></>}
              {open.reason && <><dt>Reason given</dt><dd>{open.reason}</dd></>}
              <dt>From</dt><dd>{open.app ? `${open.app} app` : 'unknown app'}{open.ip ? ` · IP ${open.ip}` : ''}</dd>
              {open.user_agent && <><dt>Device</dt><dd className="tiny">{open.user_agent}</dd></>}
              <dt>Reference</dt><dd className="mono tiny">{open.id}{open.request_id ? ` · request ${open.request_id}` : ''}</dd>
            </dl>
            {open.links && Object.keys(open.links).length > 0 && (
              <div>
                <h3 style={{ marginBottom: 8 }}>Related</h3>
                <dl className="setup-kv">
                  {Object.entries(open.links).map(([k, v]) => <Fragment key={k}><dt>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt><dd className="mono">{String(v)}</dd></Fragment>)}
                </dl>
              </div>
            )}
            <div><h3 style={{ marginBottom: 8 }}>What changed</h3><ChangeTable changes={open.changes ?? []} /></div>
          </div>
        </SidePanel>
      )}
      {history && <AuditHistory api={api} base="/audit" qs={qs} entity={history.entity} entityId={history.id} title={history.title} onClose={() => setHistory(null)} />}
    </>
  );
}

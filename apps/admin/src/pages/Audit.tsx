import { useCallback, useEffect, useState } from 'react';
import { AuditHistory, Badge, Button, ChangeTable, Field, Note, useAsync } from '@churchos/ui';
import { Icon } from '../icons';
import { PageHeader, SidePanel } from '../ui';
import { api, errText, usePhone, type PageProps } from '../common';

const PAGE = 25;
const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' }) : '';
const whenLong = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Nairobi' }) : '';
const CAPACITY: Record<string, string> = { user: 'Staff', admin: 'ChurchOS admin', member: 'Member', system: 'System', psp: 'Payment provider' };
const CATEGORY_LABEL: Record<string, string> = { money: 'Money', member: 'People', record: 'Records', access: 'Access', config: 'Settings', security: 'Security', messaging: 'Messages', system: 'System' };
const EMPTY = { q: '', category: '', actor: '', action: '', from: '', to: '', org: '' };

/**
 * The platform audit log. Loads 25 events at a time (a "Show older events" button asks the API for the next 25), has one tidy Filters panel
 * on a phone, and compact two-line rows. Uses the same API as before (/admin/audit/events and /admin/audit/verify).
 */
export function Audit(_: PageProps) {
  const phone = usePhone();
  const t = useAsync(() => api.get<any[]>('/admin/tenants'));
  const [f, setF] = useState(EMPTY);
  const [showFilters, setShowFilters] = useState(false);
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
    for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
    q.set('limit', String(PAGE));
    if (cursor) q.set('before', String(cursor));
    return q.toString();
  }, [f]);

  const load = useCallback(async (append = false, cursor?: number | null) => {
    setLoading(true); setError(undefined);
    try {
      const r = await api.get<any>(`/admin/audit/events?${query(cursor)}`);
      setRows((cur) => (append ? [...cur, ...r.events] : r.events));
      setNext(r.nextBefore ?? null);
    } catch (e: any) { setError(errText(e)); }
    setLoading(false);
  }, [query]);

  useEffect(() => {
    const id = setTimeout(() => load(false), 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f]);

  const verify = async () => {
    setChecking(true);
    try { setIntegrity(await api.get('/admin/audit/verify')); } catch (e: any) { setError(errText(e)); }
    setChecking(false);
  };
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setF((c) => ({ ...c, [k]: e.target.value }));
  const active = (['category', 'actor', 'action', 'from', 'to', 'org'] as const).filter((k) => f[k]).length;
  const bad = integrity && integrity.ok === false;
  const entityTitle = (e: any) => `${(e.entity ?? '').replace(/_/g, ' ')} ${e.entity_id ?? ''}`.trim();
  const filtersOpen = !phone || showFilters;

  return (
    <>
      <PageHeader title="Audit log" subtitle="Every change across every church is recorded here. Entries cannot be edited or deleted."
        actions={<Button kind="ghost" onClick={verify} disabled={checking}>{checking ? 'Checking…' : 'Verify integrity now'}</Button>} />
      {integrity && !bad && (
        <Note tone="good">
          {integrity.chains
            ? `All ${integrity.chains.reduce((n: number, c: any) => n + c.events, 0).toLocaleString()} events across ${integrity.chains.length} logs verified. Nothing has been changed or removed.`
            : `All ${integrity.events?.toLocaleString?.() ?? ''} events verified. Nothing has been changed or removed.`}
        </Note>
      )}
      {bad && (
        <Note tone="bad">
          <strong>The log does not verify.</strong>{' '}
          {integrity.chains ? integrity.chains.filter((c: any) => !c.ok).map((c: any) => `${c.chain}: ${c.reason} (event number ${c.brokenAtSeq})`).join('; ') : `${integrity.reason} (event number ${integrity.brokenAtSeq}).`} Please contact ChurchOS support straight away.
        </Note>
      )}
      {(integrity || bad) && <div style={{ height: 12 }} />}

      <div className="pa-audit-bar">
        <input type="search" value={f.q} onChange={set('q')} aria-label="Search what happened" placeholder="Search what happened" />
        {phone && <Button kind="ghost" onClick={() => setShowFilters((s) => !s)}><Icon name="filter" size={18} /> Filters{active ? ` (${active})` : ''}</Button>}
      </div>
      {filtersOpen && (
        <div className="pa-audit-filters" role="group" aria-label="Filters">
          <Field label="Church">
            <select value={f.org} onChange={set('org')}>
              <option value="">All churches</option>
              {(t.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </Field>
          <Field label="Type of event">
            <select value={f.category} onChange={set('category')}>
              <option value="">Everything</option>
              {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Who did it"><input value={f.actor} onChange={set('actor')} placeholder="A name" /></Field>
          <Field label="Action code"><input value={f.action} onChange={set('action')} placeholder="For example: record" /></Field>
          <Field label="From date"><input type="date" value={f.from} onChange={set('from')} /></Field>
          <Field label="To date"><input type="date" value={f.to} onChange={set('to')} /></Field>
          {active > 0 && <div className="pa-audit-clear"><Button kind="ghost" small onClick={() => setF((c) => ({ ...EMPTY, q: c.q }))}>Clear filters</Button></div>}
        </div>
      )}

      <p className="tiny pa-count" role="status">{loading && rows.length === 0 ? 'Loading…' : `${rows.length} shown${next ? ' (older events available)' : ''}`}</p>
      {error && <Note tone="bad">{error}</Note>}

      <div className="pa-audit" role="list" aria-label="Audit events">
        <div className="pa-audit-head" aria-hidden="true"><span>When</span><span>Who</span><span>What happened</span><span>Type</span></div>
        {rows.map((e) => (
          <div role="listitem" key={e.id}>
            <button type="button" className="pa-audit-row" onClick={() => setOpen(e)}>
              <span className="pa-audit-when">{when(e.at)}</span>
              <span className="pa-audit-who">{e.actor_name ?? 'System'}<span className="tiny"> · {CAPACITY[e.actor_type] ?? e.actor_type}</span></span>
              <span className="pa-audit-what">{e.summary}{e.changes?.length > 0 && <span className="tiny"> · {e.changes.length} field{e.changes.length === 1 ? '' : 's'} changed</span>}</span>
              <span className="pa-audit-type"><Badge tone={e.category === 'security' || e.category === 'access' ? 'warn' : 'muted'}>{CATEGORY_LABEL[e.category] ?? e.category}</Badge></span>
            </button>
          </div>
        ))}
      </div>
      {!loading && rows.length === 0 && !error && <div className="empty">No events match these filters.</div>}
      {loading && <div className="spinner" />}
      {next && !loading && <div className="pa-more-row"><Button kind="ghost" onClick={() => load(true, next)}>Show older events ({PAGE} more)</Button></div>}

      {open && (
        <SidePanel title="Event details" subtitle={whenLong(open.at)} width={640} onClose={() => setOpen(undefined)}>
          <p className="pa-audit-summary"><strong>{open.summary}</strong></p>
          <dl className="pa-dl">
            <div><dt>Who</dt><dd>{open.actor_name ?? 'System'} ({CAPACITY[open.actor_type] ?? open.actor_type})</dd></div>
            <div><dt>Action</dt><dd><code>{open.action}</code></dd></div>
            {open.entity && <div><dt>Record</dt><dd>{entityTitle(open)}</dd></div>}
            {open.reason && <div><dt>Reason given</dt><dd>{open.reason}</dd></div>}
            <div><dt>From</dt><dd>{open.app ? `${open.app} app` : 'Unknown app'}{open.ip ? ` · IP ${open.ip}` : ''}</dd></div>
            {open.user_agent && <div><dt>Device</dt><dd className="tiny">{open.user_agent}</dd></div>}
            <div><dt>Reference</dt><dd><code className="tiny">{open.id}{open.request_id ? ` · request ${open.request_id}` : ''}</code></dd></div>
          </dl>
          {open.links && Object.keys(open.links).length > 0 && (
            <>
              <h3 className="pa-sub">Related</h3>
              <dl className="pa-dl">
                {Object.entries(open.links).map(([k, v]) => <div key={k}><dt>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt><dd><code>{String(v)}</code></dd></div>)}
              </dl>
            </>
          )}
          <h3 className="pa-sub">What changed</h3>
          <ChangeTable changes={open.changes ?? []} />
          {open.entity && open.entity_id && (
            <div className="pa-actions start">
              <Button small onClick={() => { setHistory({ entity: open.entity, id: open.entity_id, title: entityTitle(open) }); setOpen(undefined); }}>View full history of this record</Button>
            </div>
          )}
        </SidePanel>
      )}
      {history && <AuditHistory api={api} base="/admin/audit" entity={history.entity} entityId={history.id} title={history.title} onClose={() => setHistory(null)} />}
    </>
  );
}

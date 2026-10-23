import type { ReactNode } from 'react';
import { Failed, HistoryButton, Spinner, kes } from '@churchos/ui';
import { api, friendly, useSession } from './session';

/** Standard loading / error wrapper. */
export function Load({ loading, error, hasData, children, retry }: { loading: boolean; error?: string; hasData: boolean; children: ReactNode; retry?: () => void }) {
  if (error && !hasData) return <Failed onRetry={retry}>{friendly(error)}</Failed>;
  if (loading && !hasData) return <Spinner />;
  return <>{error && <Failed onRetry={retry}>{friendly(error)}</Failed>}{children}</>;
}

/** Horizontal bars drawn with plain CSS. */
export function Bars({ rows }: { rows: { key: string; label: string; value: number; hint?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {rows.map((r) => (
        <div key={r.key}>
          <div className="row between" style={{ fontSize: 14, marginBottom: 3 }}>
            <span>{r.label} {r.hint && <span className="tiny">{r.hint}</span>}</span>
            <b className="mono">{kes(r.value)}</b>
          </div>
          <div className="progress"><i style={{ width: `${Math.max(3, (r.value / max) * 100)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

export function PageHead({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1 style={{ margin: 0 }}>{title}</h1>{sub && <p>{sub}</p>}</div>
      {action}
    </div>
  );
}

/** Small ghost History button, shown only to people who may read the audit log. */
export function Hist({ entity, entityId, title, label }: { entity: string; entityId: string; title: string; label?: string }) {
  const s = useSession();
  if (!s.can('audit.view')) return null;
  return <HistoryButton api={api} base="/audit" entity={entity} entityId={entityId} title={title} label={label} qs={s.orgs.length > 1 ? `&org=${s.grant.org.id}` : ''} />;
}

import type { ReactNode } from 'react';
import { ErrorNote, Spinner, kes } from '@churchos/ui';
import { friendly } from './session';

/** Standard loading / error wrapper. */
export function Load({ loading, error, hasData, children }: { loading: boolean; error?: string; hasData: boolean; children: ReactNode }) {
  if (error && !hasData) return <ErrorNote>{friendly(error)}</ErrorNote>;
  if (loading && !hasData) return <Spinner />;
  return <>{error && <ErrorNote>{friendly(error)}</ErrorNote>}{children}</>;
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

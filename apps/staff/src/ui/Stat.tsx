import type { ReactNode } from 'react';

/** Stat: one summary number with a label and an optional hint. `tone` colours the value (good = green, wait = amber, bad = red). `onClick` makes it a button. */
export function Stat({ label, value, hint, tone, onClick }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'wait' | 'bad' | 'info'; onClick?: () => void }) {
  const inner = (
    <>
      <span className="u-stat-label">{label}</span>
      <span className="u-stat-value">{value}</span>
      {hint && <span className="u-stat-hint">{hint}</span>}
    </>
  );
  const cls = `u-stat ${tone ?? ''} ${onClick ? 'tap' : ''}`;
  return onClick ? <button type="button" className={cls} onClick={onClick}>{inner}</button> : <div className={cls}>{inner}</div>;
}

/** StatTiles: a responsive grid of Stat tiles (2 per row on a phone, up to 4+ on a desktop). Put 2 to 6 Stat children inside. */
export function StatTiles({ children }: { children: ReactNode }) {
  return <div className="u-stats">{children}</div>;
}

import type { ReactNode } from 'react';

/**
 * StatusChip: a small pill showing a state. ONE meaning per colour across the app:
 *   wait (amber) = waiting for someone     done (green) = finished/good     bad (red) = problem/refused
 *   info (blue)  = FYI/new                 off (grey)   = inactive/closed
 */
export function StatusChip({ tone = 'off', children }: { tone?: 'wait' | 'done' | 'bad' | 'info' | 'off'; children: ReactNode }) {
  return <span className={`u-chip ${tone}`}>{children}</span>;
}

import type { ReactNode } from 'react';
import { Failed } from '@churchos/ui';
import { friendly } from './session';
import { Skeleton, StatusChip } from './ui';
import './money.css';

/** Loading wrapper for the money pages: shimmer while loading, a friendly error, then the content. */
export function Loaded({ loading, error, hasData, children, rows = 4, height = 56, retry }: { loading: boolean; error?: string; hasData: boolean; children: ReactNode; rows?: number; height?: number; retry?: () => void }) {
  if (error && !hasData) return <Failed onRetry={retry}>{friendly(error)}</Failed>;
  if (loading && !hasData) return <Skeleton rows={rows} height={height} />;
  return <>{error && <Failed onRetry={retry}>{friendly(error)}</Failed>}{children}</>;
}

const TONE: Record<string, 'wait' | 'done' | 'bad' | 'info' | 'off'> = {
  pending: 'wait', available: 'info', paid_out: 'done', paid: 'done', confirmed: 'done', completed: 'done', approved: 'done', recorded: 'done',
  reversed: 'bad', refunded: 'bad', failed: 'bad', rejected: 'bad', suspense: 'wait', counted: 'wait', requested: 'wait', initiated: 'wait',
  awaiting_second: 'wait', created: 'wait',
};
const TEXT: Record<string, string> = {
  pending: 'In 48h hold', available: 'Ready to pay out', paid_out: 'Paid out', reversed: 'Reversed', refunded: 'Refunded', suspense: 'Held (unmatched)',
  counted: 'Awaiting sign-off', recorded: 'Recorded', awaiting_second: 'Awaiting 2nd approver',
};
/** A payment, cash or payout state as a StatusChip (same meaning as the old StatusBadge, new colours). */
export function PayChip({ status }: { status: string }) {
  return <StatusChip tone={TONE[status] ?? 'off'}>{TEXT[status] ?? String(status).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}</StatusChip>;
}

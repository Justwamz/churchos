import type { ReactNode } from 'react';
import { ErrorNote } from '@churchos/ui';
import { friendly } from './session';
import { Skeleton } from './ui';

/** Loading and error wrapper for the worship and events pages: a skeleton instead of a spinner. */
export function Load({ loading, error, hasData, children, rows = 3, height = 72 }: { loading: boolean; error?: string; hasData: boolean; children: ReactNode; rows?: number; height?: number }) {
  if (error && !hasData) return <ErrorNote>{friendly(error)}</ErrorNote>;
  if (loading && !hasData) return <Skeleton rows={rows} height={height} />;
  return <>{error && <ErrorNote>{friendly(error)}</ErrorNote>}{children}</>;
}

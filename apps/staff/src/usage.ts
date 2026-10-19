/**
 * Which pages this person opens most, kept on this device only (localStorage, optional: every read and write is guarded).
 * The Today panel shows the top few as shortcuts. Pages that are not in the registry or not allowed are filtered by the caller.
 */
const KEY = 'churchos:staff-visits';
type Visits = Record<string, { n: number; at: number }>;

const read = (): Visits => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

export function noteVisit(page: string) {
  if (!page || page === 'today' || page.startsWith('more')) return;
  try {
    const v = read();
    v[page] = { n: (v[page]?.n ?? 0) + 1, at: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(v));
    window.dispatchEvent(new CustomEvent('churchos:visits'));
  } catch { /* optional */ }
}

/** Most-used first; ties go to the most recent. */
export function topPages(limit = 5): string[] {
  return Object.entries(read()).sort((a, b) => b[1].n - a[1].n || b[1].at - a[1].at).slice(0, limit * 2).map(([id]) => id);
}

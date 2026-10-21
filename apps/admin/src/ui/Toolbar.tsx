import type { ReactNode } from 'react';

/**
 * Toolbar: the filter/search row above a list or table. Put a search input, selects and chips inside; put buttons that act on the list in `end`
 * (they sit on the right on a desktop and wrap below on a phone). Inputs inside stretch to fill the row.
 *   <Toolbar end={<Button small kind="ghost">Export CSV</Button>}><input placeholder="Search" /><select>...</select></Toolbar>
 */
export function Toolbar({ children, end }: { children?: ReactNode; end?: ReactNode }) {
  return (
    <div className="u-toolbar">
      <div className="u-toolbar-main">{children}</div>
      {end && <div className="u-toolbar-end">{end}</div>}
    </div>
  );
}

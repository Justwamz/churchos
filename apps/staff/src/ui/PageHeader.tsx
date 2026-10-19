import type { ReactNode } from 'react';
import { Tabs, type TabDef } from './Tabs';

/**
 * PageHeader: the top of every page. Title (page title style), an optional one-line subtitle, the primary actions on the right
 * (they stack under the title on a phone), and an optional tabs row. Use ONE per page, first thing inside the page.
 *   <PageHeader title="Expenses" subtitle="Record, approve and pay." actions={<Button>Record expense</Button>}
 *               tabs={[{ id: 'all', label: 'All' }, { id: 'wait', label: 'Waiting', badge: 2 }]} tab={tab} onTab={setTab} />
 * Keep actions to one primary button plus at most one or two secondary ones.
 */
export function PageHeader({ title, subtitle, actions, tabs, tab, onTab }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; tabs?: TabDef[]; tab?: string; onTab?: (id: string) => void }) {
  return (
    <header className="u-ph">
      <div className="u-ph-row">
        <div className="u-ph-text">
          <h1>{title}</h1>
          {subtitle && <p className="u-ph-sub">{subtitle}</p>}
        </div>
        {actions && <div className="u-ph-actions">{actions}</div>}
      </div>
      {tabs && tabs.length > 0 && <Tabs tabs={tabs} tab={tab} onTab={onTab} />}
    </header>
  );
}

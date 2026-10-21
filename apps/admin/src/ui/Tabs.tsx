import type { ReactNode } from 'react';

export type TabDef = { id: string; label: ReactNode; badge?: number | string };

/**
 * Tabs: an underline tab row for switching views inside one page (Pending / Approved / Paid).
 * Controlled: pass the active `tab` id and `onTab`. Scrolls sideways on a phone instead of wrapping.
 *   <Tabs tabs={[{ id: 'wait', label: 'Waiting', badge: 3 }, { id: 'done', label: 'Done' }]} tab={tab} onTab={setTab} />
 */
export function Tabs({ tabs, tab, onTab, className = '' }: { tabs: TabDef[]; tab?: string; onTab?: (id: string) => void; className?: string }) {
  return (
    <div className={`u-tabs ${className}`} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`u-tab ${tab === t.id ? 'on' : ''}`} onClick={() => onTab?.(t.id)}>
          {t.label}
          {t.badge !== undefined && t.badge !== 0 && <span className="u-tab-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

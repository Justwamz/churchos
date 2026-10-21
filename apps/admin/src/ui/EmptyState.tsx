import type { ReactNode } from 'react';
import { Icon, type IconName } from '../icons';

/** EmptyState: friendly "nothing here" block. An icon, a short title, one calm sentence, and optionally an action (a Button). Use instead of a bare "No data". */
export function EmptyState({ icon = 'sparkle', title, text, action }: { icon?: IconName; title: ReactNode; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="u-empty">
      <span className="u-empty-icon"><Icon name={icon} size={26} /></span>
      <b className="u-empty-title">{title}</b>
      {text && <p className="u-empty-text">{text}</p>}
      {action && <div className="u-empty-action">{action}</div>}
    </div>
  );
}

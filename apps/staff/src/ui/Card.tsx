import type { ReactNode } from 'react';

/**
 * Card: a white rounded surface for one group of content. `pad={false}` removes the padding (for a table that should touch the edges).
 * `onClick` makes the whole card a button (use for tappable tiles).
 */
export function Card({ children, className = '', pad = true, onClick }: { children: ReactNode; className?: string; pad?: boolean; onClick?: () => void }) {
  const cls = `u-card ${pad ? '' : 'flush'} ${onClick ? 'tap' : ''} ${className}`;
  return onClick ? <button type="button" className={cls} onClick={onClick}>{children}</button> : <div className={cls}>{children}</div>;
}

/**
 * Section: a titled block (section title style, 17px/700) with an optional action on the right and optional hint under the title.
 * Sections sit directly on the page background; put a Card inside for the content. Spacing between sections is built in.
 *   <Section title="Waiting for you" action={<Button small kind="ghost">See all</Button>}><Card>...</Card></Section>
 */
export function Section({ title, hint, action, children, className = '' }: { title?: ReactNode; hint?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`u-section ${className}`}>
      {(title || action) && (
        <div className="u-section-head">
          <div><h2>{title}</h2>{hint && <p className="u-section-hint">{hint}</p>}</div>
          {action && <div className="u-section-action">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

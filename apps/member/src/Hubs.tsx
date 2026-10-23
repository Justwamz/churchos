import { useEffect, type ReactNode } from 'react';
import { useAsync } from '@churchos/ui';
import { api } from './api';
import { BookPage } from './Booking';
import { EventsPage, NoticesPage } from './Community';
import { CreditNote, CreditPage } from './Credit';
import { Groups } from './Groups';
import { PrayerPage } from './Prayer';
import { ShopPage } from './Shop';
import type { ShopIntent } from './Shop';
import { SuggestionsPage } from './Suggestions';
import { TicketsPage } from './Tickets';
import { ServicesPage } from './Services';
import { Locked } from './LinkChurch';
import { useWords } from './Words';
import type { CommunitySection, EventsSub, ServicesSection } from './links';

export type { ServicesSection, EventsSub, CommunitySection } from './links';

/** A segmented control for a hub. Wraps long labels onto two lines instead of squeezing them. */
function Segments<T extends string>({ label, value, items, onChange }: { label: string; value: T; items: { key: T; label: string }[]; onChange: (k: T) => void }) {
  return (
    <div className="hub-nav">
      <div className="seg hub" role="tablist" aria-label={label}>
        {items.map((s) => <button key={s.key} type="button" role="tab" aria-selected={value === s.key} className={value === s.key ? 'on' : ''} onClick={() => onChange(s.key)}>{s.label}</button>)}
      </div>
    </div>
  );
}

/** Services tab: the services themselves, then everything the church puts on (events, tickets, event credit, bookings), then the shop. */
export function ServicesHub({ section, esub, onSection, onEsub, hasMembership, user, shopIntent, shopK }: {
  section: ServicesSection; esub: EventsSub; onSection: (s: ServicesSection) => void; onEsub: (s: EventsSub) => void;
  hasMembership: boolean; user: any; shopIntent?: ShopIntent; shopK: number;
}) {
  const wd = useWords();
  const credit = useAsync<any>(() => api.get('/me/credit'));
  useEffect(() => { const f = () => credit.reload(); window.addEventListener('churchos:credit-changed', f); return () => window.removeEventListener('churchos:credit-changed', f); }, []); // eslint-disable-line
  const hasCredit = Number(credit.data?.total ?? 0) > 0;
  const subs: { key: EventsSub; label: string }[] = [{ key: 'events', label: 'Events' }, { key: 'tickets', label: 'My tickets' }, { key: 'bookings', label: 'Bookings' }, ...(hasCredit || esub === 'credit' ? [{ key: 'credit' as EventsSub, label: 'Event credit' }] : [])];
  const subOn: EventsSub = esub === 'book' ? 'bookings' : esub;
  let body: ReactNode;
  if (section === 'services') body = <ServicesPage hasMembership={hasMembership} />;
  else if (section === 'shop') body = <ShopPage key={shopK} user={user} intent={shopIntent} />;
  else {
    body = (
      <>
        <div className="subnav" role="group" aria-label="Events and tickets">
          {subs.map((s) => <button key={s.key} type="button" className={`chip ${subOn === s.key ? 'on' : ''}`} aria-pressed={subOn === s.key} onClick={() => onEsub(s.key)}>{s.label}</button>)}
        </div>
        {esub === 'events' && <><CreditNote /><EventsPage /></>}
        {esub === 'tickets' && <TicketsPage onEvents={() => onEsub('events')} />}
        {(esub === 'bookings' || esub === 'book') && <BookPage key={esub} initialTab={esub === 'bookings' ? 'mine' : 'book'} />}
        {esub === 'credit' && <CreditPage user={user} onEvents={() => onEsub('events')} />}
      </>
    );
  }
  return (
    <div className="stack hub">
      <Segments label="Services, events and shop" value={section} onChange={onSection} items={[{ key: 'services', label: wd.many }, { key: 'events', label: 'Events and tickets' }, { key: 'shop', label: 'Shop' }]} />
      <div className={`hub-body hub-${section}${section === 'events' ? '-' + subOn : ''}`}>{body}</div>
    </div>
  );
}

/** Community tab: groups, prayer, the suggestion box and the notice board. */
export function CommunityHub({ section, onSection, unlinked, onLink }: { section: CommunitySection; onSection: (s: CommunitySection) => void; unlinked: boolean; onLink: () => void }) {
  if (unlinked) return <Locked onLink={onLink} />;
  return (
    <div className="stack hub">
      <Segments label="Community" value={section} onChange={onSection} items={[{ key: 'groups', label: 'Groups' }, { key: 'prayer', label: 'Prayer' }, { key: 'suggestions', label: 'Suggestion box' }, { key: 'notices', label: 'Notice board' }]} />
      <div className={`hub-body hub-${section}`}>
        {section === 'groups' && <Groups />}
        {section === 'prayer' && <PrayerPage />}
        {section === 'suggestions' && <SuggestionsPage />}
        {section === 'notices' && <NoticesPage />}
      </div>
    </div>
  );
}

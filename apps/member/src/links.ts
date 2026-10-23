// Where every deep link, notification link and hash route lands. Plain data and functions with no imports, so scripts/check-member-links.mjs can run it.

export type Tab = 'home' | 'give' | 'services' | 'community' | 'inbox' | 'kids' | 'profile';
export type GiveSub = 'give' | 'pledges' | 'history' | 'regular';
export type ProfileTarget = 'main' | 'data' | 'security';
export type ServicesSection = 'services' | 'events' | 'shop';
export type EventsSub = 'events' | 'tickets' | 'bookings' | 'book' | 'credit';
export type CommunitySection = 'groups' | 'prayer' | 'suggestions' | 'notices';

export const SERVICES_SECTIONS: ServicesSection[] = ['services', 'events', 'shop'];
export const EVENTS_SUBS: EventsSub[] = ['events', 'tickets', 'bookings', 'book', 'credit'];
export const COMMUNITY_SECTIONS: CommunitySection[] = ['groups', 'prayer', 'suggestions', 'notices'];
export const GIVE_SUBS: GiveSub[] = ['give', 'pledges', 'history', 'regular'];

/** Where the app should be: a tab, plus the section inside it. `shop` means open the shop (with whatever the shell already holds as its intent). */
export interface Place { tab: Tab; sub?: GiveSub; section?: string; esub?: EventsSub; psub?: ProfileTarget; purpose?: string }

/** `member:<page>?a=b` -> page + params; null for anything that is not a member link (staff links get no button). */
export function parseLink(link?: string | null): { page: string; params: Record<string, string> } | null {
  const m = /^member:([a-z-]+)(?:[?](.*))?$/i.exec(String(link ?? '').trim());
  if (!m) return null;
  const params: Record<string, string> = {};
  new URLSearchParams(m[2] ?? '').forEach((v, k) => { params[k] = v; });
  return { page: m[1].toLowerCase(), params };
}

/** Every `member:<page>` the app understands, and the place it opens. */
export const LINK_PAGES: Record<string, Place> = {
  home: { tab: 'home' },
  give: { tab: 'give' },
  tickets: { tab: 'services', section: 'events', esub: 'tickets' },
  credit: { tab: 'services', section: 'events', esub: 'credit' },
  bookings: { tab: 'services', section: 'events', esub: 'bookings' },
  book: { tab: 'services', section: 'events', esub: 'book' },
  events: { tab: 'services', section: 'events', esub: 'events' },
  shop: { tab: 'services', section: 'shop' },
  notices: { tab: 'community', section: 'notices' },
  prayer: { tab: 'community', section: 'prayer' },
  suggestions: { tab: 'community', section: 'suggestions' },
  groups: { tab: 'community', section: 'groups' },
  kids: { tab: 'kids' },
  me: { tab: 'profile', psub: 'main' },
};

/** The place a message link opens; null when it is not a member link. */
export function placeForLink(link: string, ctx: { unlinked: boolean; hasKids: boolean }): Place | null {
  const l = parseLink(link);
  if (!l) return null;
  if (ctx.unlinked && l.page !== 'give' && l.page !== 'me') return { tab: 'home' };
  if (l.page === 'give') return { tab: 'give', sub: GIVE_SUBS.find((x) => x === l.params.sub) ?? 'give' };
  if (l.page === 'kids') return { tab: ctx.hasKids ? 'kids' : 'home' };
  return LINK_PAGES[l.page] ?? { tab: 'home' };
}

/** The address bar hash for a place. */
export function hashFor(p: Place): string {
  if (p.tab === 'profile') return p.psub && p.psub !== 'main' ? `#profile/${p.psub}` : '#profile';
  if (p.tab === 'services') return p.section && p.section !== 'services' ? `#services/${p.section}` : '#services';
  if (p.tab === 'community') return p.section && p.section !== 'groups' ? `#community/${p.section}` : '#community';
  return `#${p.tab}`;
}

/** Old and new hash routes -> place. Old routes keep working: #me, #church, #help (now the profile), #groups (now Community). */
export function placeForHash(hash: string): Place {
  const [h, a] = hash.replace(/^#\/?/, '').split('/');
  switch (h) {
    case 'history': return { tab: 'give', sub: 'history' };
    case 'profile': return { tab: 'profile', psub: a === 'data' || a === 'security' ? a : 'main' };
    case 'me': case 'church': case 'help': return { tab: 'profile', psub: 'main' };
    case 'groups': return { tab: 'community', section: 'groups' };
    case 'services': return { tab: 'services', section: (SERVICES_SECTIONS as string[]).includes(a) ? a : 'services', esub: 'events' };
    case 'community': return { tab: 'community', section: (COMMUNITY_SECTIONS as string[]).includes(a) ? a : 'groups' };
    case 'give': case 'inbox': case 'kids': case 'home': return { tab: h as Tab };
    default: return LINK_PAGES[h] && h !== 'me' ? LINK_PAGES[h] : { tab: 'home' };
  }
}

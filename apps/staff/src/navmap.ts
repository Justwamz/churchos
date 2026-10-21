import type { IconName } from './icons';
/** The six areas of the staff app and the quick actions. Data only (no components), so any file may import it. See nav.tsx for the page registry. */
export type Words = { one: string; many: string; oneLower: string; manyLower: string };
export type NavGroup = { title?: string; ids: string[] };
export type Area = { id: string; label: string; icon: IconName; groups: NavGroup[] };

/** The six areas. Pages inside a group are ordered by how often people use them. */
export const AREAS: Area[] = [
  { id: 'today', label: 'Today', icon: 'today', groups: [{ ids: ['today'] }] },
  { id: 'people', label: 'People', icon: 'people', groups: [
    { ids: ['members', 'groups', 'children', 'transfers'] },
    { title: 'Care', ids: ['prayer', 'suggestions'] },
    { title: 'Records', ids: ['records', 'template'] },
  ] },
  { id: 'worship', label: 'Worship & events', icon: 'worship', groups: [
    { title: 'On the day', ids: ['usher', 'attendance', 'checkin'] },
    { title: 'Plan ahead', ids: ['services', 'lectionary', 'boundaries'] },
    { title: 'Events and rooms', ids: ['events', 'credit', 'bookings', 'calendar', 'resources'] },
  ] },
  { id: 'money', label: 'Money', icon: 'money', groups: [
    { title: 'Giving', ids: ['dashboard', 'collections', 'regular-giving', 'giving-records', 'cash'] },
    { title: 'Spending', ids: ['my-claims', 'expenses', 'projects'] },
    { title: 'Payouts', ids: ['settlements', 'payout', 'help'] },
    { title: 'Selling', ids: ['shop'] },
  ] },
  { id: 'communicate', label: 'Communicate', icon: 'communicate', groups: [
    { ids: ['messages', 'notices', 'adverts'] },
    { title: 'Settings', ids: ['wallets', 'integrations'] },
  ] },
  { id: 'setup', label: 'Church setup', icon: 'settings', groups: [
    { ids: ['team', 'verification', 'audit'] },
    { title: 'Your church', ids: ['wording', 'branding', 'profile'] },
  ] },
];

export const areaOfPage = (id: string) => AREAS.find((a) => a.groups.some((g) => g.ids.includes(id)));

/** Quick actions: each opens the page where the thing is done, and is offered only to people who may. */
export type QuickAction = { id: string; label: string; page: string; right: string; icon: IconName; keywords: string; /** Which form the page should open (see useAction in prefill.ts). */ action: string };
export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'add-member', label: 'Add a member', page: 'members', right: 'members.edit', icon: 'people', keywords: 'new person register', action: 'add' },
  { id: 'record-expense', label: 'Record an expense', page: 'expenses', right: 'expenses.record', icon: 'receipt', keywords: 'spend claim receipt', action: 'record' },
  { id: 'claim-expense', label: 'Claim an expense', page: 'my-claims', right: 'expenses.claim', icon: 'receipt', keywords: 'reimburse spent my own money receipt back', action: 'new' },
  { id: 'send-message', label: 'Send a message', page: 'messages', right: 'messages.send', icon: 'message', keywords: 'sms email announce', action: 'compose' },
  { id: 'new-event', label: 'Create an event', page: 'events', right: 'events.manage', icon: 'worship', keywords: 'new event plan service gathering', action: 'new' },
  { id: 'new-notice', label: 'Post a notice', page: 'notices', right: 'notices.manage', icon: 'communicate', keywords: 'new notice announcement board', action: 'new' },
];


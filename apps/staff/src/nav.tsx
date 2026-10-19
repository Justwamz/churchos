import { lazy, type ComponentType } from 'react';
import type { IconName } from './icons';
import { TodayPage } from './Today';
import { WordingPage } from './Wording';

/**
 * The page registry and the six areas of the staff app. This is the one place that says which page lives where.
 *  - `any`: the person needs at least one of these rights to open the page ('*' = everyone signed in). Unchanged from the old flat menu.
 *  - `label`: the nav label. For pages named after a gathering the label is a function of the church's wording (Services -> Masses).
 *  - `keywords`: extra words the command bar matches.
 * To add a page: add it to PAGES (lazy-loaded) and to one group of one area below.
 */
import type { Words } from './navmap';
export { AREAS, QUICK_ACTIONS, areaOfPage, type Area, type NavGroup, type QuickAction, type Words } from './navmap';
export type PageDef = { id: string; label: string | ((w: Words) => string); any: string[]; el: ComponentType; keywords?: string; icon?: IconName };

const L = <T extends Record<string, any>>(load: () => Promise<T>, name: keyof T) => lazy(() => load().then((m) => ({ default: m[name] as ComponentType })));

export const PAGES: PageDef[] = [
  { id: 'today', label: 'Today', any: ['*'], el: TodayPage, keywords: 'home start needs you', icon: 'today' },
  { id: 'dashboard', label: 'Overview', any: ['collections.view'], el: L(() => import('./Dashboard'), 'Dashboard'), keywords: 'dashboard money summary giving totals', icon: 'money' },
  { id: 'collections', label: 'Collections', any: ['collections.view'], el: L(() => import('./Collections'), 'Collections'), keywords: 'giving offering tithe payments', icon: 'money' },
  { id: 'giving-records', label: 'Giving records', any: ['giving.ledger'], el: L(() => import('./GivingRecord'), 'GivingRecords'), keywords: 'ledger statements members giving', icon: 'book' },
  { id: 'expenses', label: 'Expenses', any: ['expenses.view', 'expenses.record', 'expenses.approve'], el: L(() => import('./Expenses'), 'Expenses'), keywords: 'spending claims receipts budget approve', icon: 'receipt' },
  { id: 'regular-giving', label: 'Regular giving', any: ['collections.view'], el: L(() => import('./RegularGiving'), 'RegularGiving'), keywords: 'pledges standing recurring', icon: 'heart' },
  { id: 'settlements', label: 'Settlements', any: ['settlements.view'], el: L(() => import('./Settlements'), 'Settlements'), keywords: 'payouts bank paid out', icon: 'wallet' },
  { id: 'cash', label: 'Cash', any: ['cash.count', 'cash.approve'], el: L(() => import('./Cash'), 'Cash'), keywords: 'count envelope offering', icon: 'money' },
  { id: 'members', label: 'Members', any: ['members.view', 'members.edit'], el: L(() => import('./Members'), 'Members'), keywords: 'people households directory add member', icon: 'people' },
  { id: 'transfers', label: 'Transfers', any: ['transfers.approve'], el: L(() => import('./Members'), 'Transfers'), keywords: 'move branch church join', icon: 'people' },
  { id: 'groups', label: 'Groups', any: ['members.view', 'groups.manage'], el: L(() => import('./Groups'), 'Groups'), keywords: 'ministries teams cell fellowship', icon: 'people' },
  { id: 'messages', label: 'Messages', any: ['messages.send', 'messages.view'], el: L(() => import('./Messages'), 'Messages'), keywords: 'sms email send announce', icon: 'message' },
  { id: 'wallets', label: 'Messaging wallets', any: ['wallets.view'], el: L(() => import('./Wallets'), 'Wallets'), keywords: 'credit sms top up balance', icon: 'wallet' },
  { id: 'integrations', label: 'Messaging settings', any: ['integrations.manage', 'wallets.view'], el: L(() => import('./Integrations'), 'Integrations'), keywords: 'sender id sms provider email', icon: 'settings' },
  { id: 'notices', label: 'Notices', any: ['notices.view', 'notices.manage'], el: L(() => import('./Notices'), 'Notices'), keywords: 'announcements noticeboard', icon: 'communicate' },
  { id: 'events', label: 'Events', any: ['events.view', 'events.manage'], el: L(() => import('./Events'), 'Events'), keywords: 'tickets conference retreat', icon: 'today' },
  { id: 'bookings', label: 'Bookings', any: ['bookings.view'], el: L(() => import('./Bookings'), 'Bookings'), keywords: 'rooms hall venue reserve', icon: 'today' },
  { id: 'calendar', label: 'Calendar', any: ['bookings.view'], el: L(() => import('./CalendarPage'), 'CalendarPage'), keywords: 'schedule diary', icon: 'today' },
  { id: 'resources', label: 'Resources', any: ['bookings.view', 'resources.manage'], el: L(() => import('./Resources'), 'Resources'), keywords: 'rooms equipment halls', icon: 'building' },
  { id: 'shop', label: 'Shop', any: ['shop.view', 'shop.sell', 'shop.manage'], el: L(() => import('./Shop'), 'Shop'), keywords: 'sell products point of sale', icon: 'money' },
  { id: 'checkin', label: 'Event check-in', any: ['events.checkin'], el: L(() => import('./Checkin'), 'Checkin'), keywords: 'scan ticket qr door', icon: 'checkin' },
  { id: 'attendance', label: 'Attendance', any: ['attendance.view'], el: L(() => import('./Attendance'), 'Attendance'), keywords: 'headcount visitors who came', icon: 'people' },
  { id: 'services', label: (w) => w.many, any: ['attendance.manage'], el: L(() => import('./Services'), 'Services'), keywords: 'service mass schedule times weekly', icon: 'worship' },
  { id: 'lectionary', label: 'Lectionary', any: ['attendance.manage', 'attendance.view'], el: L(() => import('./Lectionary'), 'Lectionary'), keywords: 'reading of the day scripture', icon: 'book' },
  { id: 'boundaries', label: 'Check-in boundary', any: ['attendance.manage', 'attendance.view'], el: L(() => import('./Boundaries'), 'Boundaries'), keywords: 'location gps radius geofence', icon: 'building' },
  { id: 'usher', label: 'Usher', any: ['attendance.checkin'], el: L(() => import('./Usher'), 'Usher'), keywords: 'check in door welcome', icon: 'checkin' },
  { id: 'children', label: 'Children', any: ['kids.checkin', 'kids.manage'], el: L(() => import('./Children'), 'Children'), keywords: 'kids sunday school class pickup', icon: 'child' },
  { id: 'prayer', label: 'Prayer', any: ['prayer.respond'], el: L(() => import('./Prayer'), 'Prayer'), keywords: 'prayer requests', icon: 'heart' },
  { id: 'suggestions', label: 'Suggestions', any: ['suggestions.view'], el: L(() => import('./Suggestions'), 'Suggestions'), keywords: 'feedback suggestion box', icon: 'message' },
  { id: 'adverts', label: 'Adverts', any: ['adverts.view', 'adverts.manage', 'adverts.approve'], el: L(() => import('./Adverts'), 'Adverts'), keywords: 'promote ads sponsors', icon: 'communicate' },
  { id: 'projects', label: 'Projects', any: ['collections.view', 'projects.manage'], el: L(() => import('./Projects'), 'Projects'), keywords: 'building fund campaigns', icon: 'building' },
  { id: 'help', label: 'Payment help', any: ['reversals.request'], el: L(() => import('./Help'), 'Help'), keywords: 'reversal refund wrong payment', icon: 'shield' },
  { id: 'records', label: 'Records', any: ['records.view'], el: L(() => import('./Records'), 'Records'), keywords: 'certificates baptism marriage dedication', icon: 'book' },
  { id: 'template', label: 'Certificate design', any: ['records.view'], el: L(() => import('./Template'), 'Template'), keywords: 'certificate template logo signature', icon: 'edit' },
  { id: 'team', label: 'Team', any: ['team.view', 'team.manage'], el: L(() => import('./Team'), 'Team'), keywords: 'staff roles permissions invite', icon: 'people' },
  { id: 'audit', label: 'Audit log', any: ['audit.view'], el: L(() => import('./Audit'), 'AuditPage'), keywords: 'history changes who did', icon: 'list' },
  { id: 'verification', label: 'Verification', any: ['kyc.manage'], el: L(() => import('./Verification'), 'Verification'), keywords: 'kyc documents verify church', icon: 'shield' },
  { id: 'payout', label: 'Payout account', any: ['payouts.manage'], el: L(() => import('./Payout'), 'Payout'), keywords: 'bank mpesa till paybill withdraw', icon: 'wallet' },
  { id: 'wording', label: 'Wording', any: ['*'], el: WordingPage, keywords: 'service mass gathering name word call', icon: 'edit' },
  { id: 'profile', label: 'My profile', any: ['*'], el: L(() => import('./Profile'), 'Profile'), keywords: 'account me name email phone', icon: 'user' },
];

export const pageLabel = (p: PageDef, w: Words) => (typeof p.label === 'function' ? p.label(w) : p.label);

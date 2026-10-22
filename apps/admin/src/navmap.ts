import type { IconName } from './icons';

/** The 18 admin pages, grouped into five areas. Page ids are unchanged from the old flat sidebar. */
export type PageId = 'overview' | 'tenants' | 'suspense' | 'reversals' | 'payments' | 'settlements' | 'tools' | 'audit' | 'kyc' | 'payout-requests' | 'messaging' | 'outbox' | 'smsbox' | 'tariffs' | 'providers' | 'adverts' | 'data-requests' | 'security';

export type PageDef = { id: PageId; label: string; keywords: string; hint: string };
export const PAGES: PageDef[] = [
  { id: 'overview', label: 'Overview', keywords: 'home reconcile balance integrity dashboard summary', hint: 'Is the money where it should be?' },
  { id: 'payments', label: 'Payments', keywords: 'gifts transactions fees split stage', hint: 'Every payment and its fee split' },
  { id: 'settlements', label: 'Settlements', keywords: 'payouts run settlement paused churches pay', hint: 'Pay churches what has cleared' },
  { id: 'suspense', label: 'Suspense queue', keywords: 'unmatched unclaimed assign branch refund', hint: 'Payments we could not match' },
  { id: 'reversals', label: 'Reversal requests', keywords: 'refund approve second approver maker checker', hint: 'Return a payment' },
  { id: 'tenants', label: 'Tenants and fees', keywords: 'churches organisations fees bps platform fee tenants plan', hint: 'Churches and what they are charged' },
  { id: 'kyc', label: 'Church verification', keywords: 'kyc documents certificate kra review verify', hint: 'Review uploaded documents' },
  { id: 'payout-requests', label: 'Payout account changes', keywords: 'bank mobile destination change request approve', hint: 'Where a church is paid' },
  { id: 'messaging', label: 'Messaging', keywords: 'sms whatsapp wallets credit balance revenue', hint: 'Church wallets and earnings' },
  { id: 'tariffs', label: 'Tariffs', keywords: 'prices bands per message calculator plan', hint: 'What churches pay per message' },
  { id: 'providers', label: 'Providers', keywords: 'sender names approvals sms whatsapp email credentials', hint: 'Providers and sender approvals' },
  { id: 'adverts', label: 'Adverts', keywords: 'moderation takedown member app ads', hint: 'Moderate adverts' },
  { id: 'smsbox', label: 'SMS outbox', keywords: 'sms messages sent simulated receipts', hint: 'Simulated SMS' },
  { id: 'outbox', label: 'Email outbox', keywords: 'email mail simulated alerts', hint: 'Simulated email' },
  { id: 'tools', label: 'Test tools', keywords: 'simulate paybill clock advance development', hint: 'Simulate payments, move the clock' },
  { id: 'data-requests', label: 'Data requests', keywords: 'erase erasure delete account privacy data protection forget decide', hint: 'Approve or decline erasure requests' },
  { id: 'security', label: 'Security', keywords: 'passkey webauthn sessions devices sign out two factor second factor', hint: 'Passkeys and signed-in devices' },
  { id: 'audit', label: 'Audit log', keywords: 'history changes events who verify chain', hint: 'Every change, tamper-proof' },
];

export type Area = { id: string; label: string; icon: IconName; ids: PageId[] };
export const AREAS: Area[] = [
  { id: 'overview', label: 'Overview', icon: 'home', ids: ['overview'] },
  { id: 'money', label: 'Money', icon: 'money', ids: ['payments', 'settlements', 'suspense', 'reversals'] },
  { id: 'churches', label: 'Churches', icon: 'building', ids: ['tenants', 'kyc', 'payout-requests'] },
  { id: 'messaging', label: 'Messaging', icon: 'communicate', ids: ['messaging', 'tariffs', 'providers', 'adverts', 'smsbox', 'outbox'] },
  { id: 'platform', label: 'Platform', icon: 'settings', ids: ['tools', 'audit', 'data-requests', 'security'] },
];

export const pageById = (id: string) => PAGES.find((p) => p.id === id);
export const areaOfPage = (id: string) => AREAS.find((a) => (a.ids as string[]).includes(id));

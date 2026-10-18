import { createContext, useContext } from 'react';
import { createApi } from '@churchos/ui';

export const api = createApi('churchos:staff-token');

/** Any call that comes back 428 email_required opens the blocking email dialog (see EmailGate). */
export const EMAIL_REQUIRED_EVENT = 'churchos:email-required';
for (const m of ['get', 'post', 'put'] as const) {
  const original = (api as any)[m] as (...a: any[]) => Promise<any>;
  (api as any)[m] = (...a: any[]) =>
    original(...a).catch((e: any) => {
      if (e?.status === 428 && e?.code === 'email_required') window.dispatchEvent(new Event(EMAIL_REQUIRED_EVENT));
      throw e;
    });
}

export type Branch = { id: string; code: string; name: string; region?: string };
export type OrgGrant = { org: { id: string; name: string; fee_bearer?: string }; permissions: string[]; branches: Branch[] };

export type Session = {
  user: { id: string; name: string; phone: string; email?: string | null };
  orgs: OrgGrant[];
  grant: OrgGrant;
  can: (p: string) => boolean;
  /** 'all' or a branch id */
  scope: string;
  /** Query string for the current org and scope, e.g. "?org=x&branch=y". Extra params are appended. */
  qs: (extra?: Record<string, string | undefined>) => string;
  /** Branches this user may pick from, filtered to the org. */
  branches: Branch[];
  setScope: (s: string) => void;
  go: (page: string) => void;
};

export const SessionCtx = createContext<Session>(null as unknown as Session);
export const useSession = () => useContext(SessionCtx);

/** Turn server messages into calm, human wording. Never show raw JSON. */
export function friendly(msg: string | undefined): string {
  if (!msg) return 'Something went wrong. Please try again.';
  if (/no access to that branch/i.test(msg)) return 'You do not have access to this branch.';
  if (/missing permission/i.test(msg)) return 'You do not have access to this page.';
  if (/^\s*[{[]/.test(msg)) return 'Something went wrong. Please try again.';
  return msg;
}

export const label = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, ' ') : '-');
export const METHOD_LABEL: Record<string, string> = { mpesa: 'M-Pesa', airtel: 'Airtel Money', card: 'Card', tkash: 'T-Kash', cash: 'Recorded cash', anonymous: 'Anonymous' };
export const methodLabel = (m: string) => METHOD_LABEL[m] ?? label(m);

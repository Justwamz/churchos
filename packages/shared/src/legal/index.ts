import type { Operator } from '../operator';
import { OPERATOR } from '../operator';
import { childrenNotice } from './children';
import { cookieNotice } from './cookies';
import { dataProcessingAgreement } from './dpa';
import { messagingPolicy } from './messaging';
import { privacyNotice } from './privacy';
import { termsOfUse } from './terms';
import type { Block, ChurchInfo, DocSlug, LegalCtx, LegalDoc } from './types';

export type { Block, ChurchInfo, DocSlug, LegalCtx, LegalDoc, Section } from './types';
export { odpcSentence } from './types';

/** Bump this when the Terms of Use or the Privacy Notice change in a way people must read again. Everyone is asked to accept the new version. */
export const LEGAL_VERSION = '2026-10-23';
export const LEGAL_EFFECTIVE = '2026-10-23';
export const LEGAL_UPDATED = '2026-10-23';

export const legalDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export const DOC_SLUGS: DocSlug[] = ['privacy', 'terms', 'cookies', 'children', 'dpa', 'messaging'];

const BUILDERS: Record<DocSlug, (c: LegalCtx) => LegalDoc> = {
  privacy: privacyNotice, terms: termsOfUse, cookies: cookieNotice, children: childrenNotice, dpa: dataProcessingAgreement, messaging: messagingPolicy,
};

export function buildDoc(slug: DocSlug, church?: ChurchInfo | null, op: Operator = OPERATOR): LegalDoc {
  return BUILDERS[slug]({ op, church: church ?? null });
}

export const isDocSlug = (s: string): s is DocSlug => (DOC_SLUGS as string[]).includes(s);

/** Every string a document shows, for the release check and tests. */
export function docText(d: LegalDoc): string {
  const out: string[] = [d.title, d.blurb, ...d.summary];
  for (const s of d.sections) {
    out.push(s.title);
    for (const b of s.blocks as Block[]) {
      if (b.t === 'p' || b.t === 'note') out.push(b.text);
      else if (b.t === 'ul') out.push(...b.items);
      else out.push(...b.head, ...b.rows.flat());
    }
  }
  return out.join('\n');
}

/** Words and characters that mean a document was left unfinished. */
export const FORBIDDEN_IN_DOCS = ['[', 'TODO', 'XXX', 'placeholder', 'lorem', '{{'];
export const unfinishedMarkers = (text: string): string[] => FORBIDDEN_IN_DOCS.filter((w) => text.toLowerCase().includes(w.toLowerCase()));

/** Which documents each app shows in its index. The DPA is for staff only; the messaging policy is for staff and the DPA is accepted there. */
export const DOCS_FOR_APP: Record<string, DocSlug[]> = {
  staff: ['terms', 'privacy', 'cookies', 'children', 'dpa', 'messaging'],
  member: ['terms', 'privacy', 'cookies', 'children'],
  giving: ['terms', 'privacy', 'cookies', 'children'],
  admin: ['terms', 'privacy', 'cookies'],
};

/** The documents a signed-in person accepts together on the consent screen. */
export const ACCEPT_DOCS = ['terms_privacy', 'dpa', 'kids_guardian'] as const;
export type AcceptDoc = (typeof ACCEPT_DOCS)[number];

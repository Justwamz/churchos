import type { Operator } from '../operator';

/** Plain text content. No markup: the page renders it and the release check reads it. */
export type Block =
  | { t: 'p'; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'note'; text: string };

export interface Section { id: string; title: string; blocks: Block[] }

export interface LegalDoc {
  slug: DocSlug;
  title: string;
  /** One line shown under the title on the index page. */
  blurb: string;
  /** The summary box at the top. */
  summary: string[];
  sections: Section[];
}

export type DocSlug = 'privacy' | 'terms' | 'cookies' | 'children' | 'dpa' | 'messaging';

/** What a page knows about the church it is shown for. Every field is optional: a general sentence is used when it is missing. */
export interface ChurchInfo {
  name?: string | null;
  contact?: string | null;
  officer?: string | null;
}

export interface LegalCtx {
  op: Operator;
  church?: ChurchInfo | null;
}

export const p = (text: string): Block => ({ t: 'p', text });
export const ul = (...items: string[]): Block => ({ t: 'ul', items });
export const note = (text: string): Block => ({ t: 'note', text });
export const table = (head: string[], rows: string[][]): Block => ({ t: 'table', head, rows });

/** "the church" or the church's name. */
export const churchName = (c: LegalCtx) => (c.church?.name?.trim() ? c.church.name.trim() : 'your church');

/** The sentence about registration with the Office of the Data Protection Commissioner. It never claims registration unless the operator says so. */
export function odpcSentence(op: Operator): string {
  return op.odpcStatus === 'registered'
    ? `${op.name} is registered with the Office of the Data Protection Commissioner under number ${op.odpcNumber}.`
    : `${op.name} is not yet registered with the Office of the Data Protection Commissioner and will register as the Data Protection Act, 2019 and the Data Protection (Registration of Data Controllers and Data Processors) Regulations, 2021 require.`;
}

/** Who to write to. */
export const contactLine = (op: Operator) => `${op.email} (post: ${op.postalAddress}; office: ${op.address})`;

/** "your church's contact" sentence for the controller. */
export function churchContactSentence(c: LegalCtx): string {
  const n = c.church?.name?.trim();
  const contact = c.church?.contact?.trim();
  const officer = c.church?.officer?.trim();
  if (!n) return 'Each church is the controller of its own members. The church you belong to is named in the app, and you can ask its office for its contact details and for the person who handles data requests.';
  return `${n} is the controller of your membership data.${contact ? ` You can contact it at ${contact}.` : ' You can ask its office for its contact details.'}${officer ? ` Its person for data requests is ${officer}.` : ''}`;
}

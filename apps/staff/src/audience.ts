import type { Branch } from './session';

export const AGE_BANDS = ['0 to 5', '6 to 12', '13 to 17', '18 to 35', '36 to 59', '60 and over'];
export const CHANNEL_NAME: Record<string, string> = { inapp: 'In-app', sms: 'SMS', whatsapp: 'WhatsApp' };

export type Audience = { scope: { type: 'org' | 'region' | 'branch' | 'group'; id?: string }; who?: 'all' | 'adults' | 'children'; ageBands?: string[] | null; sex?: string | null };

const join = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Plain-words description of who a message goes to. Never mentions numbers or ids. */
export function describeAudience(a: Audience | undefined, branches: Branch[], groupName?: string | null, orgName?: string): string {
  if (!a) return 'Everyone';
  const s = a.scope;
  let where = 'Whole church';
  if (s.type === 'region') where = `Region: ${s.id}`;
  else if (s.type === 'branch') where = branches.find((b) => b.id === s.id)?.name ?? 'One branch';
  else if (s.type === 'group') where = `Group: ${groupName ?? 'a group'}`;
  else if (orgName) where = 'Whole church';
  const bands = a.ageBands?.length ? ` aged ${join(a.ageBands)}` : '';
  const sex = a.sex === 'male' ? 'men and boys' : a.sex === 'female' ? 'women and girls' : '';
  let who = 'everyone';
  if (a.who === 'adults') who = `adults${bands}`;
  else if (a.who === 'children') who = `guardians of children${bands}`;
  else if (bands) who = `everyone${bands}`;
  return `${where}, ${who}${sex ? ` (${sex} only)` : ''}`;
}

export function sendError(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case 'nobody': return 'No one matches this audience. Check who you chose and try again.';
    case 'bad_audience': return 'Please choose who this message is for.';
    case 'bad_title': return message || 'Give the message a short title.';
    case 'bad_body': return message || 'Write the message.';
    case 'in_past': return 'That time has already passed. Choose a time in the future, or send now.';
    case 'daily_cap': return message || 'The daily limit has been reached.';
    case 'forbidden': return message || 'You cannot send to that audience.';
    default: return message || 'Something went wrong. Please try again.';
  }
}

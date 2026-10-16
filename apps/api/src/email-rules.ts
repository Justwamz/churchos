import { HttpError } from './ctx';

/**
 * Which email addresses ChurchOS accepts, anywhere an address is typed in (L191): tickets, member profiles, staff alerts,
 * branch details. Made-up and throw-away addresses are refused so tickets, receipts and alerts reach a real person,
 * and so one person cannot get round a limit by inventing addresses.
 */

const SHAPE = /^[a-z0-9][a-z0-9._-]*@([a-z0-9-]+\.)+[a-z]{2,}$/;

/** Domains made for examples and testing, and the common "I don't want to give an email" ones. */
const FAKE_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'example.co.ke', 'test.com', 'test.org', 'test.net', 'test.co.ke', 'domain.com', 'email.com', 'mail.test', 'localhost',
  'invalid.com', 'noemail.com', 'none.com', 'nomail.com', 'fake.com', 'fakemail.com', 'asdf.com', 'abc.com', 'xyz.com', 'sample.com', 'yourdomain.com', 'yourmail.com', 'mydomain.com',
]);

/** Services that hand out inboxes nobody owns, so the address is gone in minutes. */
const THROWAWAY_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la', 'pokemail.net', 'spam4.me',
  '10minutemail.com', '10minutemail.net', '20minutemail.com', 'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmail.net', 'tempmailo.com', 'tempail.com', 'tmpmail.org', 'tmpmail.net',
  'yopmail.com', 'yopmail.net', 'yopmail.fr', 'trashmail.com', 'trashmail.net', 'trashmail.de', 'throwawaymail.com', 'throwaway.email', 'getnada.com', 'nada.email', 'dispostable.com',
  'maildrop.cc', 'mailnesia.com', 'mailcatch.com', 'fakeinbox.com', 'mohmal.com', 'emailondeck.com', 'getairmail.com', 'mintemail.com', 'mytemp.email', 'burnermail.io', 'discard.email',
  'spambox.us', 'spamgourmet.com', 'mailsac.com', 'inboxkitten.com', 'moakt.com', 'tempinbox.com', 'dropmail.me', 'emailfake.com', 'fakemailgenerator.com', 'harakirimail.com',
  'mailforspam.com', 'jetable.org', 'meltmail.com', 'anonbox.net', 'guerrillamail.de', 'sneakemail.com', 'tempr.email', 'luxusmail.org', 'cuvox.de', 'dayrep.com', 'einrot.com',
]);

/** The part before the @ that people type when they are making something up. */
const FAKE_LOCALS = new Set([
  'abc', 'abcd', 'abcde', 'abcdef', 'test', 'tester', 'testing', 'test1', 'test123', 'asdf', 'asdfg', 'asdfgh', 'qwerty', 'qwe', 'qwert', 'xyz', 'xxx', 'xx', 'aaa', 'aaaa',
  'user', 'username', 'demo', 'fake', 'none', 'noemail', 'no', 'nomail', 'noreply', 'email', 'mail', 'name', 'me', 'you', 'someone', 'anyone', 'nobody', 'null', 'na', 'nil',
  'a', 'b', 'c', 'ab', 'abc123', '123', '1234', '12345', '123456', 'sample', 'example', 'temp', 'temporary', 'dummy', 'random', 'unknown', 'hello', 'hi', 'sdf', 'zzz', 'zxc',
]);

export type EmailCheck = { ok: true; email: string; key: string } | { ok: false; message: string };

/** The mailbox as the provider sees it: Gmail ignores dots, and googlemail.com is gmail.com. Used to count one person once. */
export function emailKey(email: string): string {
  const [local, domain0] = email.toLowerCase().split('@');
  const domain = domain0 === 'googlemail.com' ? 'gmail.com' : domain0;
  return domain === 'gmail.com' ? `${local.replace(/\./g, '')}@${domain}` : `${local}@${domain}`;
}

export function checkEmail(raw: unknown): EmailCheck {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!email) return { ok: false, message: 'Enter an email address' };
  if (email.length > 120 || !SHAPE.test(email) || email.includes('..')) return { ok: false, message: 'Enter a valid email address' };
  const [local, domain] = email.split('@');
  const tld = domain.split('.').pop()!;
  if (/^(test|example|invalid|localhost|local|lan|internal)$/.test(tld) || FAKE_DOMAINS.has(domain) || /^example\./.test(domain)) {
    return { ok: false, message: 'Enter your own email address, not an example or test one' };
  }
  if (THROWAWAY_DOMAINS.has(domain)) return { ok: false, message: 'Throw-away email addresses are not accepted. Use an address you keep.' };
  if (local.includes('+')) return { ok: false, message: 'Addresses with a + in them are not accepted. Use your main email address.' };
  const plain = local.replace(/[._-]/g, '');
  if (plain.length < 3) return { ok: false, message: 'That email address looks made up. Enter your real one.' };
  if (FAKE_LOCALS.has(plain) || FAKE_LOCALS.has(local) || /^(.)\1{2,}$/.test(plain) || /^(abc|123|qwe|asd|xyz)[a-z0-9]{0,3}$/.test(plain) && plain.length <= 6) {
    return { ok: false, message: 'That email address looks made up. Enter your real one.' };
  }
  return { ok: true, email, key: emailKey(email) };
}

/** Throws a friendly 400 for an address ChurchOS does not accept; returns the cleaned address and its mailbox key. */
export function assertEmail(raw: unknown): { email: string; key: string } {
  const r = checkEmail(raw);
  if (!r.ok) throw new HttpError(400, r.message, 'bad_email');
  return { email: r.email, key: r.key };
}

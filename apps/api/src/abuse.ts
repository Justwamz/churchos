import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError, type Ctx } from './ctx';
import { clientIp, rateLimit, tooMany } from './ratelimit';

/**
 * Abuse limits for routes that spend money or church SMS credit, or that anyone on the internet can call.
 * Every number is a human-scale default; set the environment variable to change it (a whole number).
 * ABUSE_DISABLED=1 switches all of these off (tests only: the production default is on). The sign-in limits in otp.ts are separate.
 * Limits use `ctx.clock`, so tests can advance time. Counts live in the limiter from ratelimit.ts (swap its store to share them between servers).
 */
const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const num = (name: string, d: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
};

export const abuseDisabled = () => /^(1|true|yes)$/i.test(String(process.env.ABUSE_DISABLED ?? ''));

/** Read at call time so a deployment (or a test) can change them without a rebuild. */
export const abuse = () => ({
  // Payment prompts (STK push or card page): per target phone, per IP (signed-out callers), per signed-in user, per staff member.
  promptPhone10m: num('ABUSE_PROMPT_PHONE_10M', 3),
  promptPhoneDay: num('ABUSE_PROMPT_PHONE_DAY', 10),
  promptIpHour: num('ABUSE_PROMPT_IP_HOUR', 60), // shared church wifi and mobile carrier NAT make a small number unsafe
  promptUserHour: num('ABUSE_PROMPT_USER_HOUR', 30),
  promptStaffHour: num('ABUSE_PROMPT_STAFF_HOUR', 120),
  promptStaffPhone10m: num('ABUSE_PROMPT_STAFF_PHONE_10M', 10),
  // Church-paid welcome SMS from public check-in
  welcomePhoneDays: num('ABUSE_WELCOME_PHONE_DAYS', 30),
  welcomeTokenHour: num('ABUSE_WELCOME_TOKEN_HOUR', 30),
  welcomeIpHour: num('ABUSE_WELCOME_IP_HOUR', 5),
  // Free tickets and unpaid orders
  freeIpEventDay: num('ABUSE_FREE_IP_EVENT_DAY', 10),
  freePhoneEventDay: num('ABUSE_FREE_PHONE_EVENT_DAY', 10),
  unpaidPerPerson: num('ABUSE_UNPAID_ORDERS', 5), // per email, phone or signed-in user, across all events
  unpaidPerIp: num('ABUSE_UNPAID_ORDERS_IP', 10), // per IP within one hold window
  // Member-submitted free text (prayer, suggestions, group posts and comments, pick-up people)
  formUserHour: num('ABUSE_FORM_USER_HOUR', 20),
});

/**
 * Per-IP limits on public routes, applied in one onRequest hook so no route is left out. `max` can be overridden with ABUSE_<NAME>_MAX
 * (NAME upper-cased, dashes to underscores). The first matching row wins; everything else under /public (and /help) gets the grouped default.
 */
interface Row { name: string; re: RegExp; methods?: string[]; max: number; windowMs: number }
const TABLE: Row[] = [
  { name: 'credit', re: /^\/public\/credit\//, max: 20, windowMs: MIN },
  { name: 'statement', re: /^\/public\/statement\//, max: 20, windowMs: MIN },
  { name: 'order-secret', re: /^\/public\/tickets\/orders\/[^/]+/, max: 60, windowMs: MIN },
  { name: 'order-create', re: /^\/public\/tickets\/orders\/?$/, methods: ['POST'], max: 40, windowMs: 10 * MIN },
  { name: 'ticket-page', re: /^\/public\/tickets\/[^/]+\/?$/, max: 60, windowMs: MIN },
  { name: 'verify', re: /^\/public\/(verify|cert)\//, max: 30, windowMs: MIN },
  { name: 'event', re: /^\/public\/event\//, max: 60, windowMs: MIN },
  { name: 'checkin', re: /^\/public\/(here|live)\//, methods: ['POST'], max: 60, windowMs: 10 * MIN },
  { name: 'checkin-page', re: /^\/public\/(here|live)\//, methods: ['GET'], max: 120, windowMs: MIN },
  { name: 'give-poll', re: /^\/public\/give\/[^/]+/, methods: ['GET'], max: 120, windowMs: MIN },
  { name: 'give', re: /^\/public\/give\/?$/, methods: ['POST'], max: 60, windowMs: 10 * MIN },
  { name: 'checkout', re: /^\/public\/checkout\//, max: 60, windowMs: MIN },
  { name: 'help', re: /^\/help\//, max: 120, windowMs: MIN },
  { name: 'auth', re: /^\/auth\//, max: 120, windowMs: 10 * MIN },
];
const GROUP = { name: 'public', max: 300, windowMs: MIN };

const maxOf = (name: string, d: number) => num(`ABUSE_${name.toUpperCase().replace(/-/g, '_')}_MAX`, d);

/** Registers the grouped per-IP limits. Webhooks are not limited here (they are authenticated by the provider's signature). */
export function registerAbuseHooks(app: FastifyInstance, ctx: Ctx) {
  app.addHook('onRequest', async (req, reply) => {
    if (abuseDisabled()) return;
    const path = req.url.split('?')[0];
    const isPublic = path.startsWith('/public/') || path === '/public';
    const row = TABLE.find((r) => r.re.test(path) && (!r.methods || r.methods.includes(req.method)));
    if (!isPublic && !row) return;
    const ip = clientIp(req);
    const check = (name: string, max: number, windowMs: number) => {
      const r = rateLimit(ctx, `route:${name}:${ip}`, { max, windowMs });
      if (!r.ok) {
        reply.header('retry-after', String(r.retryAfterSec));
        throw new HttpError(429, 'Too many requests. Please wait a moment and try again.', 'rate_limited');
      }
    };
    if (row) check(row.name, maxOf(row.name, row.max), row.windowMs);
    if (isPublic) check(GROUP.name, maxOf(GROUP.name, GROUP.max), GROUP.windowMs);
  });
}

/** Checks one counter. Throws a friendly 429 with `retryAfterSec` (the error handler turns it into Retry-After). */
function hit(ctx: Ctx, key: string, max: number, windowMs: number, message: string) {
  const r = rateLimit(ctx, key, { max, windowMs });
  if (!r.ok) tooMany(message, r.retryAfterSec);
}

/**
 * Call right before a route sends a payment prompt (STK push) or opens a card checkout. Limits per target phone, per IP for signed-out
 * callers, and per signed-in user. A prompt that is never paid counts the same as a paid one; paying never resets anything.
 * `staff` is for a till operator: a generous per-person limit, never the IP limit.
 */
export function promptGuard(ctx: Ctx, req: FastifyRequest | undefined, o: { phone?: string | null; uid?: string | null; staff?: boolean }) {
  if (abuseDisabled()) return;
  const L = abuse();
  const phoneMsg = 'Too many payment requests to this number. Please wait a few minutes.';
  const moreMsg = 'Too many payment requests. Please wait a while and try again.';
  if (o.phone) {
    hit(ctx, `prompt:ph10:${o.phone}`, o.staff ? L.promptStaffPhone10m : L.promptPhone10m, 10 * MIN, phoneMsg);
    hit(ctx, `prompt:phday:${o.phone}`, L.promptPhoneDay, DAY, phoneMsg);
  }
  if (o.uid) hit(ctx, `prompt:${o.staff ? 'staff' : 'user'}:${o.uid}`, o.staff ? L.promptStaffHour : L.promptUserHour, HOUR, moreMsg);
  else if (req) hit(ctx, `prompt:ip:${clientIp(req)}`, L.promptIpHour, HOUR, moreMsg);
}

/** Member-submitted free text: prayer, suggestions, wall posts and comments, pick-up people. */
export function formGuard(ctx: Ctx, uid: string, what: string) {
  if (abuseDisabled()) return;
  hit(ctx, `form:${what}:${uid}`, abuse().formUserHour, HOUR, 'You are sending a lot in a short time. Please wait a while and try again.');
}

/** Counts `n` more items against a daily key (free tickets per IP/phone). */
export function dailyCap(ctx: Ctx, key: string, n: number, max: number, message: string) {
  if (abuseDisabled()) return;
  for (let i = 0; i < n; i++) hit(ctx, key, max, DAY, message);
}

export function hourlyHit(ctx: Ctx, key: string, max: number, message: string) {
  if (abuseDisabled()) return;
  hit(ctx, key, max, HOUR, message);
}

/** A visitor-typed name made safe to put in a church SMS: letters, hyphen and apostrophe only, at most 40, never a link. Null when it does not survive. */
export function safeSmsName(raw: unknown): string | null {
  const words = String(raw ?? '').normalize('NFKC').split(/\s+/);
  const kept: string[] = [];
  for (const w of words) {
    // A word that looks like a link, address, handle or number is dropped whole.
    if (!w || /[:/\\@.]|\d|www|https?/i.test(w)) continue;
    const clean = w.replace(/[^\p{L}'-]/gu, '').replace(/^[-']+|[-']+$/g, '');
    if (clean) kept.push(clean);
  }
  const name = kept.join(' ').slice(0, 40).trim();
  return (name.match(/\p{L}/gu) ?? []).length >= 2 ? name : null;
}

/** Counts one hit against `key` within a custom window. */
export function windowHit(ctx: Ctx, key: string, max: number, windowMs: number, message: string) {
  if (abuseDisabled()) return;
  hit(ctx, key, max, windowMs, message);
}

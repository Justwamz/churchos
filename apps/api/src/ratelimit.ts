import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, type Ctx } from './ctx';

export interface LimitRule {
  max: number;
  windowMs: number;
}
export interface LimitResult {
  ok: boolean;
  retryAfterSec: number;
  /** Hits counted in the current window, including this one. */
  count: number;
}

/**
 * The shape a shared store (Redis, the database) has to provide to replace the in-memory one later. Calls are synchronous here;
 * a shared store would make them async and the few callers would await.
 */
export interface LimitStore {
  hit(key: string, rule: LimitRule): LimitResult;
  peek(key: string): { count: number; retryAfterSec: number };
  reset(key: string): void;
  size(): number;
}

/**
 * In-memory fixed-window limiter. Never grows without bound: expired windows are swept on a timer (unref'd, so it never keeps
 * the process alive) and there is a hard cap on entries. At the cap the oldest entries are dropped first.
 */
export class MemoryLimiter implements LimitStore {
  private m = new Map<string, { count: number; resetAt: number }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private now: () => number = Date.now, private maxEntries = 50_000, sweepMs = 60_000) {
    if (sweepMs > 0) {
      this.timer = setInterval(() => this.prune(), sweepMs);
      this.timer.unref?.();
    }
  }

  prune() {
    const t = this.now();
    for (const [k, v] of this.m) if (v.resetAt <= t) this.m.delete(k);
  }

  hit(key: string, rule: LimitRule): LimitResult {
    const t = this.now();
    let e = this.m.get(key);
    if (!e || e.resetAt <= t) {
      if (!e && this.m.size >= this.maxEntries) {
        this.prune();
        // Still full: drop the oldest tenth. Map keeps insertion order.
        if (this.m.size >= this.maxEntries) {
          let n = Math.ceil(this.maxEntries / 10);
          for (const k of this.m.keys()) { this.m.delete(k); if (--n <= 0) break; }
        }
      }
      e = { count: 0, resetAt: t + rule.windowMs };
      this.m.delete(key);
      this.m.set(key, e);
    }
    e.count++;
    const retryAfterSec = Math.max(1, Math.ceil((e.resetAt - t) / 1000));
    return { ok: e.count <= rule.max, retryAfterSec, count: e.count };
  }

  peek(key: string) {
    const e = this.m.get(key);
    const t = this.now();
    if (!e || e.resetAt <= t) return { count: 0, retryAfterSec: 0 };
    return { count: e.count, retryAfterSec: Math.max(1, Math.ceil((e.resetAt - t) / 1000)) };
  }

  reset(key: string) {
    this.m.delete(key);
  }

  size() {
    return this.m.size;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

const stores = new WeakMap<object, LimitStore>();

/** The limiter for this app instance. It follows ctx.clock, so tests can advance time. Replace it with `setLimitStore` to share counts between servers. */
export function limiterFor(ctx: Ctx): LimitStore {
  let s = stores.get(ctx);
  if (!s) {
    s = new MemoryLimiter(() => ctx.clock.now().getTime());
    stores.set(ctx, s);
  }
  return s;
}

export function setLimitStore(ctx: Ctx, store: LimitStore) {
  stores.set(ctx, store);
}

/** Counts one hit against `key` and says whether the caller is still inside `{max, windowMs}`. */
export function rateLimit(ctx: Ctx, key: string, rule: LimitRule): LimitResult {
  return limiterFor(ctx).hit(key, rule);
}

/** The caller's address as Fastify worked it out (it honours the configured proxy hop count). Never parse X-Forwarded-For here. */
export function clientIp(req: FastifyRequest): string {
  return String(req.ip ?? 'unknown');
}

/** Throws the friendly 429 the apps show. */
export function tooMany(message: string, retryAfterSec: number): never {
  const e = new HttpError(429, message, 'rate_limited');
  (e as any).retryAfterSec = retryAfterSec;
  throw e;
}

/**
 * A route guard for public routes. Use as `{ preHandler: limitRoute(app, ctx, { name: 'search', max: 40, windowMs: 60_000, key: (req) => clientIp(req) }) }`.
 * Answers 429 with a Retry-After header when the caller is over the limit.
 */
export function limitRoute(
  _app: unknown,
  ctx: Ctx,
  o: { name: string; max: number; windowMs: number; key: (req: FastifyRequest) => string; message?: string },
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const r = rateLimit(ctx, `route:${o.name}:${o.key(req)}`, { max: o.max, windowMs: o.windowMs });
    if (!r.ok) {
      reply.header('retry-after', String(r.retryAfterSec));
      throw new HttpError(429, o.message ?? 'Too many requests. Please wait a moment and try again.', 'rate_limited');
    }
  };
}

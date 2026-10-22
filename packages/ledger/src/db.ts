import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';

/**
 * The only file that knows which Postgres we run on. Locally it is PGlite (real Postgres, embedded).
 * Moving to a server Postgres means replacing this file's implementation of `Db`.
 */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /** Runs fn inside one transaction. Nested calls join the outer transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** Runs fn as the restricted `app_user` role with row-level security scoped to one organisation. */
  asOrg<T>(orgId: string, fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * The tenant scope of the work in progress (AZ-20). Held in AsyncLocalStorage so handler code needs no change: every statement run
 * while a scope is active goes out as the low-privilege `churchos_app` role with `app.org_id` set, so row-level security filters it.
 * No scope at all (start-up, seeds, scheduled jobs, tests that call the database directly) means the owner connection, which has
 * `app.bypass = on` as its session default. The store is mutable: the request hook creates it and sign-in narrows it.
 */
export interface DbScope {
  /** Platform, system and keyed-by-secret paths: the owner connection, every row visible. */
  bypass: boolean;
  /** Organisations the work may see when bypass is off. Empty means nothing (fail closed). */
  orgIds: string[];
}
export const dbScope = new AsyncLocalStorage<DbScope>();

/** Runs fn with every row visible (jobs, webhooks, audit chain writes). Safe to nest anywhere. */
export function runSystem<T>(fn: () => Promise<T>): Promise<T> {
  return dbScope.run({ bypass: true, orgIds: [] }, fn);
}
/** Runs fn limited to the given organisations, whatever the surrounding scope was. */
export function runScoped<T>(orgIds: string[], fn: () => Promise<T>): Promise<T> {
  return dbScope.run({ bypass: false, orgIds }, fn);
}

const parsers = {
  20: (v: string) => Number(v), // int8
  1700: (v: string) => Number(v), // numeric
};

export async function createDb(dataDir?: string): Promise<Db> {
  const pg = new PGlite(dataDir, { parsers } as any);
  await pg.waitReady;
  // The owner connection sees every row. A scoped statement turns this off for its own transaction only.
  await pg.exec(`SET app.bypass = 'on'`);
  return wrap(pg, false);
}

interface TxState {
  /** What this transaction has been set up as, so the settings are only sent when the scope changes. */
  applied: string | null;
  /** asOrg owns this transaction's role and organisation: the ambient scope must not overwrite it. */
  pinned: boolean;
}

const sigOf = (sc: DbScope) => (sc.bypass ? 'bypass' : `org:${sc.orgIds.join(',')}`);

async function applyScope(pg: any, st: TxState, sc: DbScope) {
  if (st.pinned) return;
  const sig = sigOf(sc);
  if (st.applied === sig) return;
  if (sc.bypass) {
    await pg.query(`SELECT set_config('role','none',true), set_config('app.bypass','on',true), set_config('app.org_id','',true)`);
  } else {
    await pg.query(`SELECT set_config('role','churchos_app',true), set_config('app.bypass','off',true), set_config('app.org_id',$1,true)`, [sc.orgIds.join(',')]);
  }
  st.applied = sig;
}

function wrap(pg: any, inTx: boolean): Db {
  const st: TxState = { applied: null, pinned: false };
  const self: Db = {
    async query(sql, params = []) {
      const sc = dbScope.getStore();
      if (inTx) {
        // Inside a transaction a scope that is not bypass must reach the role switch; a changed scope is re-applied.
        if (sc) await applyScope(pg, st, sc);
        else if (st.applied && st.applied !== 'bypass') await applyScope(pg, st, { bypass: true, orgIds: [] });
      } else if (sc && !sc.bypass) {
        // One statement outside a transaction, scoped: it gets its own short transaction so the settings cannot leak to others.
        return pg.transaction(async (t: any) => {
          await applyScope(t, { applied: null, pinned: false }, sc);
          const r = await t.query(sql, params as any[], { parsers });
          return r.rows as any[];
        });
      }
      const r = await pg.query(sql, params as any[], { parsers });
      return r.rows as any[];
    },
    async exec(sql) {
      const sc = dbScope.getStore();
      if (inTx) {
        if (sc) await applyScope(pg, st, sc);
      } else if (sc && !sc.bypass) {
        return pg.transaction(async (t: any) => {
          await applyScope(t, { applied: null, pinned: false }, sc);
          await t.exec(sql);
        });
      }
      await pg.exec(sql);
    },
    async tx(fn) {
      if (inTx) return fn(self);
      return pg.transaction(async (t: any) => fn(wrap(t, true)));
    },
    async asOrg(orgId, fn) {
      return self.tx(async (t) => {
        (t as any).__pin?.();
        await t.exec('SET LOCAL ROLE app_user');
        await t.query("SELECT set_config('app.org_id', $1, true), set_config('app.bypass', 'off', true)", [orgId]);
        return fn(t);
      });
    },
    async close() {
      if (!inTx) await pg.close();
    },
  };
  (self as any).__pin = () => { st.pinned = true; };
  return self;
}

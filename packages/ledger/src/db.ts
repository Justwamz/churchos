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

const parsers = {
  20: (v: string) => Number(v), // int8
  1700: (v: string) => Number(v), // numeric
};

export async function createDb(dataDir?: string): Promise<Db> {
  const pg = new PGlite(dataDir, { parsers } as any);
  await pg.waitReady;
  return wrap(pg, false);
}

function wrap(pg: any, inTx: boolean): Db {
  const self: Db = {
    async query(sql, params = []) {
      const r = await pg.query(sql, params as any[]);
      return r.rows as any[];
    },
    async exec(sql) {
      await pg.exec(sql);
    },
    async tx(fn) {
      if (inTx) return fn(self);
      return pg.transaction(async (t: any) => fn(wrap(t, true)));
    },
    async asOrg(orgId, fn) {
      return self.tx(async (t) => {
        await t.exec('SET LOCAL ROLE app_user');
        await t.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
        return fn(t);
      });
    },
    async close() {
      if (!inTx) await pg.close();
    },
  };
  return self;
}

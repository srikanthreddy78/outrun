import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * One open transaction: a Drizzle instance and the raw client under it, so pg-boss
 * inserts (which speak raw SQL) commit or roll back with our own writes.
 */
export interface TxScope {
  db: Db;
  client: pg.PoolClient;
}

export function createDb(url: string, opts: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 5 });
  const db = drizzle(pool, { schema, casing: "snake_case" });
  return { db, pool, close: () => pool.end() };
}

export async function transaction<T>(h: Pick<DbHandle, "pool">, fn: (tx: TxScope) => Promise<T>): Promise<T> {
  const client = await h.pool.connect();
  try {
    await client.query("begin");
    const db = drizzle(client, { schema, casing: "snake_case" }) as unknown as Db;
    const out = await fn({ db, client });
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export { schema };

/** Test helper: a throwaway database per suite, migrated from scratch. */
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { createDb, type DbHandle } from "../db/client";
import { runMigrations } from "../db/migrate";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

export interface TempDb extends DbHandle {
  url: string;
  drop(): Promise<void>;
}

export async function createTempDatabase(baseUrl = TEST_DB_URL): Promise<TempDb> {
  if (!baseUrl) throw new Error("set DATABASE_URL (or TEST_DATABASE_URL) to run database tests");
  const name = `outrun_t_${uuidv7().replace(/-/g, "").slice(-16)}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  await runMigrations(url);
  const h = createDb(url, { max: 4 });
  return {
    ...h,
    url,
    async drop() {
      await h.close();
      const c = new pg.Client({ connectionString: baseUrl });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

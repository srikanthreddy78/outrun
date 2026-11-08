/**
 * What /api/health reports and pnpm smoke reads: the database answers, migrations and the
 * pg-boss schema are in place (the latest shipped migration is applied), which integrations are on fakes, demo mode, and when the last
 * Naive webhook arrived. No secrets, no counts of customer data.
 */
import { sql } from "drizzle-orm";
import journal from "../drizzle/meta/_journal.json";
import type { Db } from "./db/client";
import { logger } from "./log";

export interface Health {
  ok: boolean;
  checks: { db: boolean; migrations: boolean; queue: boolean };
  demo: boolean;
  fakes: string[];
  lastNaiveWebhookAt: string | null;
  commit: string | null;
}

/** The newest migration this build ships (drizzle records its journal `when` as created_at). */
export const LATEST_MIGRATION_AT: number = Math.max(...journal.entries.map((m) => m.when));

export async function checkHealth(opts: { db: Db; demo: boolean; fakes: string[] }): Promise<Health> {
  const checks = { db: false, migrations: false, queue: false };
  let lastNaiveWebhookAt: string | null = null;
  try {
    await opts.db.execute(sql`select 1`);
    checks.db = true;
  } catch (err) {
    logger.error({ err }, "health: database unreachable");
  }
  if (checks.db) {
    try {
      const r = await opts.db.execute<{ applied: string | null; boss: string | null }>(sql`
        select (select max(created_at)::text from drizzle.__drizzle_migrations) as applied,
               to_regclass('pgboss.job')::text as boss`);
      checks.migrations = Number(r.rows[0]?.applied ?? 0) >= LATEST_MIGRATION_AT;
      checks.queue = !!r.rows[0]?.boss;
      const w = await opts.db.execute<{ at: Date | string | null }>(
        sql`select max(ts) as at from events where type = 'webhook.received' and actor = 'provider:naive'`,
      );
      const at = w.rows[0]?.at;
      lastNaiveWebhookAt = at ? new Date(at).toISOString() : null;
    } catch (err) {
      logger.error({ err }, "health: check failed");
    }
  }
  return {
    ok: checks.db && checks.migrations && checks.queue,
    checks,
    demo: opts.demo,
    fakes: [...opts.fakes].sort(),
    lastNaiveWebhookAt,
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.RENDER_GIT_COMMIT ?? null,
  };
}

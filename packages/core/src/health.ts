/**
 * What /api/health reports and pnpm smoke reads: the database answers, migrations and the
 * pg-boss schema are in place, which integrations are on fakes, demo mode, and when the last
 * Naive webhook arrived. No secrets, no counts of customer data.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./db/client";

export interface Health {
  ok: boolean;
  checks: { db: boolean; migrations: boolean; queue: boolean };
  demo: boolean;
  fakes: string[];
  lastNaiveWebhookAt: string | null;
  commit: string | null;
}

export async function checkHealth(opts: { db: Db; demo: boolean; fakes: string[] }): Promise<Health> {
  const checks = { db: false, migrations: false, queue: false };
  let lastNaiveWebhookAt: string | null = null;
  try {
    await opts.db.execute(sql`select 1`);
    checks.db = true;
    const r = await opts.db.execute<{ events: string | null; boss: string | null }>(
      sql`select to_regclass('public.events')::text as events, to_regclass('pgboss.job')::text as boss`,
    );
    checks.migrations = !!r.rows[0]?.events;
    checks.queue = !!r.rows[0]?.boss;
    if (checks.migrations) {
      const w = await opts.db.execute<{ at: Date | null }>(
        sql`select max(created_at) as at from events where type = 'webhook.received' and actor = 'provider:naive'`,
      );
      const at = w.rows[0]?.at;
      lastNaiveWebhookAt = at ? new Date(at).toISOString() : null;
    }
  } catch {
    // ok stays false; the route answers 503.
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

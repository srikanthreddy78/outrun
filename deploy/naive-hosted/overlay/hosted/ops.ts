/**
 * Operations the Naive-hosted build adds (deploy/naive-hosted), behind the admin route and the
 * ticker's MCP tool. Naive apps answer requests and stop, so there is no always-on worker: a tick
 * starts the team's worker (apps/worker) inside one request, lets it work the queue and fire due
 * crons for a few seconds, then stops it.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { config } from "@outrun/core";
import { createDb } from "@outrun/core/db";
import { scanDomainHandler } from "@outrun/core/scan/job";
import { DEMO_PLACEHOLDER, seedDemo } from "@outrun/core/seed";
import { startWorker } from "@outrun/worker/worker";
import { getRuntime } from "../lib/runtime";

const dbUrl = (): string => {
  const c = config();
  const url = c.databaseUrlUnpooled ?? c.databaseUrl;
  if (!url) throw new Error("DATABASE_URL is not set on the app");
  return url;
};

export function bearerMatches(header: string | null, ...secrets: (string | undefined)[]): boolean {
  const token = /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
  if (token === undefined) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return secrets.some((s) => s !== undefined && s !== "" && timingSafeEqual(digest(s), digest(token)));
}

export async function runMigrationsHosted(): Promise<{ applied: true; folder: string }> {
  const folder = path.join(process.cwd(), "vendor", "core", "drizzle");
  const h = createDb(dbUrl(), { max: 1 });
  try {
    await migrate(h.db, { migrationsFolder: folder });
  } finally {
    await h.close();
  }
  return { applied: true, folder: "vendor/core/drizzle" };
}

/** The demo prospect; with NAIVE_HOSTED_TEST_INBOX it's the only address mail may go to. */
export async function seedHosted(): Promise<Record<string, string>> {
  const inbox = process.env.NAIVE_HOSTED_TEST_INBOX?.trim().toLowerCase();
  const demo = inbox
    ? {
        domain: inbox.split("@")[1] ?? DEMO_PLACEHOLDER.domain,
        name: "Outrun Test Co",
        contactName: "Test Founder",
        inbox,
      }
    : DEMO_PLACEHOLDER;
  const h = createDb(dbUrl(), { max: 1 });
  try {
    const ids = await seedDemo(h.db, demo);
    return { ...ids, inbox: demo.inbox, domain: demo.domain };
  } finally {
    await h.close();
  }
}

/** Mirrors apps/worker/src/main.ts: the team's worker plus the scan handler main.ts registers. */
export async function tick(seconds: number): Promise<{ seconds: number; fakes: string[]; jobs: unknown[] }> {
  const s = Math.max(3, Math.min(45, Math.round(seconds)));
  const scanDb = createDb(dbUrl());
  try {
    const worker = await startWorker({
      config: config(),
      schedules: true,
      pollingIntervalSeconds: 1,
      handlers: { scan_domain: scanDomainHandler(scanDb.db) },
    });
    const fakes = worker.runtime.fakes.map(String);
    await new Promise((resolve) => setTimeout(resolve, s * 1000));
    await worker.stop();
    return { seconds: s, fakes, jobs: await jobCounts() };
  } finally {
    await scanDb.close();
  }
}

/** Queues a crew session through the app's own queue, as outrun.plan_day does. */
export async function startCrewSession(input: {
  agent?: string;
  prospectId?: string;
  message?: string;
}): Promise<{ enqueued: boolean; jobId: string | null }> {
  if (!input.agent || !input.prospectId || !input.message)
    throw new Error("start needs agent, prospectId and message");
  const runtime = await getRuntime();
  const { jobId } = await runtime.queue.enqueue({
    type: "start_session",
    payload: {
      agent: input.agent,
      message: input.message,
      entity: { type: "prospect", id: input.prospectId },
    },
    idempotencyKey: `hosted:${input.agent}:${input.prospectId}:${Date.now()}`,
    traceId: `hosted-${Date.now()}`,
  });
  return { enqueued: true, jobId };
}

async function jobCounts(): Promise<unknown[]> {
  const h = createDb(dbUrl(), { max: 1 });
  try {
    const { rows } = await h.pool.query(
      "select name, state, count(*)::int as n from pgboss.job group by 1, 2 order by 1, 2",
    );
    return rows;
  } catch {
    return [];
  } finally {
    await h.close();
  }
}

export async function status(): Promise<Record<string, unknown>> {
  const h = createDb(dbUrl(), { max: 1 });
  const q = async (text: string): Promise<unknown[]> => {
    try {
      return (await h.pool.query(text)).rows;
    } catch (error) {
      return [{ error: (error as Error).message.slice(0, 120) }];
    }
  };
  try {
    return {
      demo: config().settings.demo,
      testInbox: process.env.NAIVE_HOSTED_TEST_INBOX ?? null,
      prospects: await q("select stage, count(*)::int as n from prospects group by 1 order by 1"),
      messages: await q("select status, count(*)::int as n from messages group by 1 order by 1"),
      sessions: await q(
        "select agent, status, count(*)::int as n from agent_sessions group by 1, 2 order by 1, 2",
      ),
      jobs: await q("select name, state, count(*)::int as n from pgboss.job group by 1, 2 order by 1, 2"),
      recentEvents: await q("select ts, actor, type from events order by ts desc limit 25"),
    };
  } finally {
    await h.close();
  }
}

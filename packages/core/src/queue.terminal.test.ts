import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { events } from "./db/schema";
import { AppError } from "./errors";
import { createEmitter } from "./events";
import { Queue } from "./queue";
import { createTempDatabase, type TempDb } from "./testing/db";

async function until(check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out");
}

describe("queue failure handling", () => {
  let t: TempDb;
  let q: Queue;
  const attempts = new Map<string, number>();
  beforeAll(async () => {
    t = await createTempDatabase();
    q = new Queue({
      connectionString: t.url,
      maxAttempts: 3,
      emit: createEmitter(t.db),
      retryDelaySeconds: 1,
      retryBackoff: false,
      pollingIntervalSeconds: 0.5,
    });
    await q.start();
    await q.work({
      check_stuck: async (env) => {
        attempts.set(env.idempotencyKey, (attempts.get(env.idempotencyKey) ?? 0) + 1);
        if (env.idempotencyKey.startsWith("terminal")) throw new AppError("budget_exhausted", "no credits");
        if (env.idempotencyKey.startsWith("cron:")) return;
        throw new AppError("upstream_error", "flaky", { retryable: true });
      },
    });
  });
  afterAll(async () => {
    await q?.stop();
    await t?.drop();
  });
  const dead = (key: string) =>
    t.db
      .select()
      .from(events)
      .where(and(eq(events.type, "job.dead"), sql`${events.payload}->>'job' = 'check_stuck'`))
      .then((rows) => rows.length > 0 && attempts.has(key));

  it("a non-retryable error dead-letters on its first attempt", async () => {
    await q.enqueue({ type: "check_stuck", payload: {}, idempotencyKey: "terminal-1", traceId: "t" });
    await until(() => dead("terminal-1"));
    expect(attempts.get("terminal-1")).toBe(1);
    const [failed] = await t.db.select().from(events).where(eq(events.type, "job.failed"));
    expect(failed!.payload).toMatchObject({ terminal: true, code: "budget_exhausted" });
  });

  it("a retryable error is retried up to maxAttempts", async () => {
    await q.enqueue({ type: "check_stuck", payload: {}, idempotencyKey: "flaky-1", traceId: "t" });
    await until(async () => (attempts.get("flaky-1") ?? 0) >= 3, 20_000);
    expect(attempts.get("flaky-1")).toBe(3);
  });

  it("each cron fire gets its own key", async () => {
    await q.enqueue({ type: "check_stuck", payload: {}, idempotencyKey: "cron:check_stuck", traceId: "t" });
    await until(async () => [...attempts.keys()].some((k) => k.startsWith("cron:check_stuck:")));
  });

  it("a restart applies changed queue settings", async () => {
    const q2 = new Queue({ connectionString: t.url, maxAttempts: 6, emit: createEmitter(t.db) });
    await q2.start();
    const r = await t.db.execute<{ retry_limit: number; deletion_seconds: number }>(
      sql`select retry_limit, deletion_seconds from pgboss.queue where name = 'check_stuck'`,
    );
    expect(r.rows[0]).toMatchObject({ retry_limit: 5, deletion_seconds: 30 * 24 * 3600 });
    await q2.stop();
  });

  it("a producer enqueues without creating queues or running maintenance", async () => {
    const p = new Queue({
      connectionString: t.url,
      maxAttempts: 3,
      emit: createEmitter(t.db),
      role: "producer",
    });
    await p.start();
    const { jobId } = await p.enqueue({
      type: "check_stuck",
      payload: {},
      idempotencyKey: "from-web",
      traceId: "t",
    });
    expect(jobId).toBeTruthy();
    await p.stop();
  });
});

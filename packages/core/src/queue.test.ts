import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { transaction } from "./db/client";
import { companies } from "./db/schema";
import { createEmitter, eventsFor, recordWebhookOnce } from "./events";
import { Queue, jobIdFor } from "./queue";
import { createTempDatabase, type TempDb } from "./testing/db";

describe("jobIdFor", () => {
  it("is stable per type and key, and a valid uuid", () => {
    const a = jobIdFor("scan_domain", "acme.dev");
    expect(a).toBe(jobIdFor("scan_domain", "acme.dev"));
    expect(a).not.toBe(jobIdFor("sync_crm", "acme.dev"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("queue and events", () => {
  let t: TempDb;
  let q: Queue;
  beforeAll(async () => {
    t = await createTempDatabase();
    q = new Queue({ connectionString: t.url, maxAttempts: 3, emit: createEmitter(t.db) });
    await q.start();
  });
  afterAll(async () => {
    await q?.stop();
    await t?.drop();
  });

  const jobCount = async (id: string) => {
    const r = await t.db.execute<{ n: string }>(
      sql`select count(*)::text as n from pgboss.job where id = ${id}`,
    );
    return Number(r.rows[0]?.n ?? 0);
  };

  it("enqueues inside the caller's transaction and rolls back with it", async () => {
    const key = "acme.dev:rollback";
    await expect(
      transaction(t, async (tx) => {
        await tx.db.insert(companies).values({ domain: "rollback.dev", source: "fixture" });
        await q.enqueue(
          { type: "scan_domain", payload: { domain: "rollback.dev" }, idempotencyKey: key, traceId: "t" },
          { tx },
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await jobCount(jobIdFor("scan_domain", key))).toBe(0);
    const c = await t.db.execute(sql`select 1 from companies where domain = 'rollback.dev'`);
    expect(c.rows).toHaveLength(0);
  });

  it("commits the job with the caller's writes", async () => {
    const key = "acme.dev:commit";
    await transaction(t, async (tx) => {
      await tx.db.insert(companies).values({ domain: "commit.dev", source: "fixture" });
      await q.enqueue(
        { type: "scan_domain", payload: { domain: "commit.dev" }, idempotencyKey: key, traceId: "t" },
        { tx },
      );
    });
    expect(await jobCount(jobIdFor("scan_domain", key))).toBe(1);
  });

  it("dedupes on the idempotency key", async () => {
    const env = { type: "sync_crm" as const, payload: {}, idempotencyKey: "dup", traceId: "t" };
    const first = await q.enqueue(env);
    const second = await q.enqueue(env);
    expect(first.jobId).not.toBeNull();
    expect(second.jobId).toBeNull();
  });

  it("emit writes to the ledger and validates the actor", async () => {
    const emit = createEmitter(t.db);
    await emit({
      actor: "naive:sdr",
      type: "draft.checked",
      entityType: "message",
      entityId: "m1",
      costUsd: 0.01,
    });
    const evs = await eventsFor(t.db, "m1");
    expect(evs[0]).toMatchObject({ actor: "naive:sdr", type: "draft.checked", costUsd: 0.01 });
    await expect(
      emit({ actor: "anyone", type: "x.y", entityType: "system", entityId: "m1" }),
    ).rejects.toThrow();
  });

  it("records each webhook delivery once", async () => {
    expect(await recordWebhookOnce(t.db, "stripe", "evt_1")).toBe(true);
    expect(await recordWebhookOnce(t.db, "stripe", "evt_1")).toBe(false);
    expect(await recordWebhookOnce(t.db, "naive", "evt_1")).toBe(true);
  });
});

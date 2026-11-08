import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agentSessions, events } from "./db/schema";
import { AppError } from "./errors";
import { createEmitter } from "./events";
import { FakeNaiveClient } from "./fakes/naive";
import { recordSessionState, startSession } from "./sessions";
import { createTempDatabase, type TempDb } from "./testing/db";

describe("startSession", () => {
  let t: TempDb;
  let naive: FakeNaiveClient;
  beforeAll(async () => {
    t = await createTempDatabase();
    naive = new FakeNaiveClient();
  });
  afterAll(async () => {
    await t?.drop();
  });
  const deps = () => ({ db: t.db, emit: createEmitter(t.db), naive });
  const entity = { type: "message" as const, id: "0190f6a0-0000-7000-8000-0000000000a1" };

  it("starts a session, records it and emits session.started", async () => {
    const r = await startSession(deps(), {
      agent: "closer",
      message: `Reply in thread ${entity.id}`,
      entity,
      idempotencyKey: "s1",
    });
    expect(r.kind).toBe("started");
    const [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.idempotencyKey, "s1"));
    expect(row).toMatchObject({
      agent: "closer",
      entityId: entity.id,
      status: "running",
      sessionId: r.sessionId,
    });
    const evs = await t.db.select().from(events).where(eq(events.type, "session.started"));
    expect(evs).toHaveLength(1);
    expect(naive.calls.find((c) => c.method === "startSession")?.args[0]).toMatchObject({
      metadata: { outrunSessionId: row!.id, entityType: "message", entityId: entity.id },
    });
  });

  it("messages the live session instead of starting a second one", async () => {
    const r = await startSession(deps(), {
      agent: "closer",
      message: "New reply arrived",
      entity,
      idempotencyKey: "s2",
    });
    expect(r.kind).toBe("messaged");
    expect(naive.calls.filter((c) => c.method === "startSession")).toHaveLength(1);
    expect(naive.calls.at(-1)).toMatchObject({ method: "send" });
  });

  it("is idempotent on its key", async () => {
    const r = await startSession(deps(), {
      agent: "closer",
      message: `Reply in thread ${entity.id}`,
      entity,
      idempotencyKey: "s1",
    });
    expect(r.kind).toBe("duplicate");
  });

  it("starts a fresh session once the old one terminated", async () => {
    const [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.idempotencyKey, "s1"));
    await recordSessionState(deps(), row!.sessionId!, { status: "cancelled", stopReason: null });
    const r = await startSession(deps(), { agent: "closer", message: "Again", entity, idempotencyKey: "s3" });
    expect(r.kind).toBe("started");
  });

  it("refuses an email address in the message", async () => {
    await expect(
      startSession(deps(), {
        agent: "closer",
        message: "write to bob@acme.dev",
        entity,
        idempotencyKey: "s4",
      }),
    ).rejects.toThrow();
  });

  it("keeps the row when Naive refuses, and the retry reuses it with the same metadata", async () => {
    const broken = new FakeNaiveClient();
    broken.startSession = async () => {
      throw new AppError("upstream_error", "naive down", { retryable: true });
    };
    const e2 = { type: "order" as const, id: "0190f6a0-0000-7000-8000-0000000000b2" };
    const input = {
      agent: "auditor" as const,
      message: `Audit order ${e2.id}`,
      entity: e2,
      idempotencyKey: "a1",
    };
    await expect(startSession({ ...deps(), naive: broken }, input)).rejects.toThrow("naive down");
    const [failed] = await t.db.select().from(agentSessions).where(eq(agentSessions.idempotencyKey, "a1"));
    expect(failed?.status).toBe("error");
    const r = await startSession(deps(), input);
    expect(r).toMatchObject({ kind: "started", recordId: failed!.id });
    const sent = naive.calls.filter((c) => c.method === "startSession").at(-1)!.args[0] as {
      metadata: unknown;
    };
    expect(sent.metadata).toMatchObject({ outrunSessionId: failed!.id });
  });

  it("reclaims a row stuck in starting by a crashed attempt", async () => {
    const e3 = { type: "order" as const, id: "0190f6a0-0000-7000-8000-0000000000c3" };
    const [stuck] = await t.db
      .insert(agentSessions)
      .values({
        agent: "auditor",
        entityType: e3.type,
        entityId: e3.id,
        idempotencyKey: "crashed",
        status: "starting",
      })
      .returning();
    const input = {
      agent: "auditor" as const,
      message: `Audit order ${e3.id}`,
      entity: e3,
      idempotencyKey: "a3",
    };
    await expect(startSession(deps(), input)).rejects.toMatchObject({ code: "conflict", retryable: true });
    await t.db.execute(
      sql`update agent_sessions set updated_at = now() - interval '11 minutes' where id = ${stuck!.id}`,
    );
    expect((await startSession(deps(), input)).kind).toBe("started");
    const [after] = await t.db.select().from(agentSessions).where(eq(agentSessions.id, stuck!.id));
    expect(after?.status).toBe("error");
  });

  it("records a messaged start's key, so re-running the job is a duplicate", async () => {
    const e4 = { type: "message" as const, id: "0190f6a0-0000-7000-8000-0000000000d4" };
    await startSession(deps(), { agent: "closer", message: "first", entity: e4, idempotencyKey: "m1" });
    expect(
      (await startSession(deps(), { agent: "closer", message: "second", entity: e4, idempotencyKey: "m2" }))
        .kind,
    ).toBe("messaged");
    const sends = naive.calls.filter((c) => c.method === "send").length;
    expect(
      (await startSession(deps(), { agent: "closer", message: "second", entity: e4, idempotencyKey: "m2" }))
        .kind,
    ).toBe("duplicate");
    expect(naive.calls.filter((c) => c.method === "send").length).toBe(sends);
  });

  it("starts fresh when the live session was ended in the Studio", async () => {
    const e5 = { type: "message" as const, id: "0190f6a0-0000-7000-8000-0000000000e5" };
    const first = await startSession(deps(), {
      agent: "closer",
      message: "first",
      entity: e5,
      idempotencyKey: "c1",
    });
    naive.cancel(first.sessionId!);
    const realSend = naive.send.bind(naive);
    naive.send = async () => {
      throw new AppError("not_found", "gone");
    };
    try {
      const r = await startSession(deps(), {
        agent: "closer",
        message: "again",
        entity: e5,
        idempotencyKey: "c2",
      });
      expect(r.kind).toBe("started");
      expect(r.sessionId).not.toBe(first.sessionId);
    } finally {
      naive.send = realSend;
    }
  });

  it("never revives a terminated session, and skips a state older than the last one", async () => {
    const e6 = { type: "message" as const, id: "0190f6a0-0000-7000-8000-0000000000f6" };
    const r = await startSession(deps(), { agent: "closer", message: "x", entity: e6, idempotencyKey: "o1" });
    const t0 = new Date("2026-11-07T10:00:00Z");
    expect(
      await recordSessionState(deps(), r.sessionId!, { status: "idle", stopReason: "end_turn" }, t0),
    ).not.toBeNull();
    const older = new Date(t0.getTime() - 1000);
    expect(
      await recordSessionState(deps(), r.sessionId!, { status: "running", stopReason: null }, older),
    ).toBeNull();
    await recordSessionState(
      deps(),
      r.sessionId!,
      { status: "cancelled", stopReason: null },
      new Date(t0.getTime() + 1000),
    );
    expect(
      await recordSessionState(
        deps(),
        r.sessionId!,
        { status: "running", stopReason: null },
        new Date(t0.getTime() + 2000),
      ),
    ).toBeNull();
    const [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.idempotencyKey, "o1"));
    expect(row?.status).toBe("terminated");
  });

  it("records state and spend from Naive", async () => {
    const [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.idempotencyKey, "a1"));
    await recordSessionState(deps(), row!.sessionId!, {
      status: "idle",
      stopReason: "budget_paused",
      consumedUsd: 0.5,
    });
    const [after] = await t.db.select().from(agentSessions).where(eq(agentSessions.id, row!.id));
    expect(after).toMatchObject({ status: "idle", stopReason: "budget_paused", spendUsd: "0.500000" });
  });
});

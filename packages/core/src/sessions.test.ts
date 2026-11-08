import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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

  it("frees the slot and the key when Naive refuses, so a retry can start it", async () => {
    const broken = new FakeNaiveClient();
    broken.startSession = async () => {
      throw new AppError("upstream_error", "naive down", { retryable: true });
    };
    const e2 = { type: "order" as const, id: "0190f6a0-0000-7000-8000-0000000000b2" };
    await expect(
      startSession(
        { ...deps(), naive: broken },
        { agent: "auditor", message: `Audit order ${e2.id}`, entity: e2, idempotencyKey: "a1" },
      ),
    ).rejects.toThrow("naive down");
    const r = await startSession(deps(), {
      agent: "auditor",
      message: `Audit order ${e2.id}`,
      entity: e2,
      idempotencyKey: "a1",
    });
    expect(r.kind).toBe("started");
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

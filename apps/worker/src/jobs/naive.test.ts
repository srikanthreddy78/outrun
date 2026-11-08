import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobEnvelope } from "@outrun/core/contracts";
import { agentSessions, companies, eq, events, messages, prospects } from "@outrun/core/db";
import { createEmitter } from "@outrun/core/events";
import { FakeNaiveClient } from "@outrun/core/fakes";
import { createTempDatabase, type TempDb } from "@outrun/core/testing/db";
import { naiveHandlers } from "./naive";

describe("Naive jobs", () => {
  let t: TempDb;
  const naive = new FakeNaiveClient();
  let handlers: ReturnType<typeof naiveHandlers>;
  let draftId: string;
  beforeAll(async () => {
    t = await createTempDatabase();
    handlers = naiveHandlers({
      db: { db: t.db, pool: t.pool, close: async () => {} },
      emit: createEmitter(t.db),
      integrations: { naive } as never,
    });
    const [c] = await t.db.insert(companies).values({ domain: "acme.dev", source: "fixture", kind: "prospect" }).returning();
    const [p] = await t.db.insert(prospects).values({ companyId: c!.id }).returning();
    const [m] = await t.db
      .insert(messages)
      .values({ prospectId: p!.id, direction: "outbound", kind: "first", status: "checked", subject: "s", body: "b", draftHash: "h" })
      .returning();
    draftId = m!.id;
  });
  afterAll(async () => {
    await t?.drop();
  });
  const run = (type: "start_session" | "handle_naive_event", payload: Record<string, unknown>, key: string) =>
    handlers[type]!(JobEnvelope.parse({ type, payload, idempotencyKey: key, traceId: "t" }), { jobId: "j", attempt: 1 });

  it("start_session starts a session through the service", async () => {
    naive.script("sdr", [{ tool: "send_email", input: { draftId: "", hash: "a".repeat(64) } }]);
    await run("start_session", { agent: "sdr", message: "Draft the first email for prospect p", entity: { type: "prospect", id: "p" } }, "ss1");
    const [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.idempotencyKey, "ss1"));
    expect(row?.status).toBe("running");
  });

  it("session.idle awaiting_approval marks the draft awaiting approval with Naive's ids", async () => {
    const [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.idempotencyKey, "ss1"));
    const s = naive.sessions.get(row!.sessionId!)!;
    s.pendingActions = [{ kind: "tool", toolCallId: "call_42", tool: "outrun.send_email", input: { draftId, hash: "h" } }];
    s.status = "idle";
    s.stopReason = "awaiting_approval";
    await run("handle_naive_event", { envelope: { id: "e1", type: "session.idle", created_at: "x", data: { session_id: s.id } } }, "n1");
    const [m] = await t.db.select().from(messages).where(eq(messages.id, draftId));
    expect(m).toMatchObject({ status: "awaiting_approval", naiveSessionId: s.id, naiveToolCallId: "call_42" });
    const [sess] = await t.db.select().from(agentSessions).where(eq(agentSessions.id, row!.id));
    expect(sess).toMatchObject({ status: "idle", stopReason: "awaiting_approval" });
    expect(await t.db.select().from(events).where(eq(events.type, "approval.waiting"))).toHaveLength(1);
  });

  it("tool.confirm.resolved marks the draft approved", async () => {
    await run("handle_naive_event", { envelope: { id: "e2", type: "tool.confirm.resolved", created_at: "x", data: { tool_call_id: "call_42", decision: "allow" } } }, "n2");
    const [m] = await t.db.select().from(messages).where(eq(messages.id, draftId));
    expect(m?.status).toBe("approved");
  });

  it("budget.exceeded raises an alert event", async () => {
    await run("handle_naive_event", { envelope: { id: "e3", type: "budget.exceeded", created_at: "x", data: { agent_id: "agt_fake_sdr" } } }, "n3");
    expect(await t.db.select().from(events).where(eq(events.type, "alert.naive_budget_exceeded"))).toHaveLength(1);
  });
});

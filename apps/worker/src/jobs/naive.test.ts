import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobEnvelope } from "@outrun/core/contracts";
import { agentSessions, clients, companies, eq, events, messages, prospects } from "@outrun/core/db";
import { createEmitter } from "@outrun/core/events";
import { FakeNaiveClient } from "@outrun/core/fakes";
import { createTempDatabase, type TempDb } from "@outrun/core/testing/db";
import { naiveHandlers, onIdle } from "./naive";

describe("Naive jobs", () => {
  let t: TempDb;
  let naive: FakeNaiveClient;
  let handlers: ReturnType<typeof naiveHandlers>;
  let deps: Parameters<typeof onIdle>[0];
  let prospectId: string;
  const idles: string[] = [];

  beforeAll(async () => {
    t = await createTempDatabase();
    naive = new FakeNaiveClient({ onIdle: (sid) => void idles.push(sid) });
    const emit = createEmitter(t.db);
    handlers = naiveHandlers({
      db: { db: t.db, pool: t.pool, close: async () => {} },
      emit,
      integrations: { naive } as never,
    });
    deps = { db: t.db, emit, naive };
    const [c] = await t.db
      .insert(companies)
      .values({ domain: "acme.dev", source: "fixture", kind: "prospect" })
      .returning();
    const [p] = await t.db.insert(prospects).values({ companyId: c!.id }).returning();
    prospectId = p!.id;
  });
  afterAll(async () => {
    await t?.drop();
  });

  const draft = async () => {
    const [m] = await t.db
      .insert(messages)
      .values({
        prospectId,
        direction: "outbound",
        kind: "first",
        status: "checked",
        subject: "s",
        body: "b",
        draftHash: "h",
      })
      .returning();
    return m!.id;
  };
  const statusOf = async (id: string) => (await t.db.select().from(messages).where(eq(messages.id, id)))[0]!;
  const run = (type: "start_session" | "handle_naive_event", payload: Record<string, unknown>, key: string) =>
    handlers[type]!(JobEnvelope.parse({ type, payload, idempotencyKey: key, traceId: "t" }), {
      jobId: "j",
      attempt: 1,
    });
  const startSdr = async (draftId: string, key: string) => {
    naive.script("sdr", [{ tool: "send_email", input: { draftId, hash: "h" } }]);
    await run(
      "start_session",
      { agent: "sdr", message: `Send draft ${draftId}`, entity: { type: "message", id: draftId } },
      key,
    );
    const [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.idempotencyKey, key));
    return row!.sessionId!;
  };
  const idle = (sid: string, id: string) =>
    run(
      "handle_naive_event",
      {
        envelope: {
          id,
          type: "session.idle",
          created_at: new Date().toISOString(),
          data: { session_id: sid },
        },
      },
      id,
    );

  it("session.idle on a held send marks the draft awaiting approval with Naive's ids", async () => {
    const d = await draft();
    const sid = await startSdr(d, "ss1");
    await idle(sid, "e1");
    const m = await statusOf(d);
    expect(m).toMatchObject({ status: "awaiting_approval", naiveSessionId: sid });
    expect(m.naiveToolCallId).toMatch(/^tc_/);
    const [sess] = await t.db.select().from(agentSessions).where(eq(agentSessions.sessionId, sid));
    expect(sess).toMatchObject({ status: "idle", stopReason: "awaiting_approval" });

    // A person allows it in the Studio; Naive runs the tool, then idles again.
    await naive.confirmTool(sid, m.naiveToolCallId!, "allow", "");
    await idle(sid, "e2");
    expect(await statusOf(d)).toMatchObject({ status: "approved" });
    const ev = (await t.db.select().from(events).where(eq(events.type, "approval.approved"))).find(
      (e) => e.entityId === d,
    );
    expect(ev?.payload).toMatchObject({ by: "user:usr_fake" });

    // A redelivered idle changes nothing.
    await idle(sid, "e2b");
    expect(
      (await t.db.select().from(events).where(eq(events.type, "approval.approved"))).filter(
        (e) => e.entityId === d,
      ),
    ).toHaveLength(1);
  });

  it("a deny marks the draft rejected", async () => {
    const d = await draft();
    const sid = await startSdr(d, "ss2");
    await idle(sid, "e3");
    await naive.confirmTool(sid, (await statusOf(d)).naiveToolCallId!, "deny", "tone");
    await idle(sid, "e4");
    expect((await statusOf(d)).status).toBe("rejected");
  });

  it("a fast approval decided before our first idle is still recorded", async () => {
    const d = await draft();
    const sid = await startSdr(d, "ss3");
    const tc = (await naive.getSession(sid)).pendingActions[0]!.toolCallId;
    await naive.confirmTool(sid, tc, "allow", "");
    await onIdle(deps, sid);
    expect(await statusOf(d)).toMatchObject({ status: "approved", naiveToolCallId: tc });
  });

  it("a session never parks another client's draft", async () => {
    const [other] = await t.db
      .insert(clients)
      .values({ slug: "acme-pay", name: "Acme Pay", domain: "acme-pay.dev" })
      .returning();
    const [m] = await t.db
      .insert(messages)
      .values({
        clientId: other!.id,
        direction: "outbound",
        kind: "first",
        status: "checked",
        subject: "s",
        body: "b",
        draftHash: "h",
      })
      .returning();
    // Outrun's sdr names the other client's draft in its held send.
    const sid = await startSdr(m!.id, "ss-cross");
    await idle(sid, "e-cross");
    expect(await statusOf(m!.id)).toMatchObject({ status: "checked", naiveSessionId: null });
  });

  it("budget.exceeded raises an alert keyed on the session, without the raw payload", async () => {
    await run(
      "handle_naive_event",
      {
        envelope: {
          id: "e9",
          type: "budget.exceeded",
          created_at: "2026-11-07T10:00:00Z",
          data: { session_id: "ses_x", code: "insufficient_credits", message: "secret detail" },
        },
      },
      "n9",
    );
    const [a] = await t.db.select().from(events).where(eq(events.type, "alert.naive_budget_exceeded"));
    expect(a).toMatchObject({ entityType: "agent_session", entityId: "ses_x" });
    expect(a!.payload).toEqual({ code: "insufficient_credits", param: null, action: "top up Naive credits" });
  });

  it("the fake reports every idle, like the webhook", () => {
    expect(idles.length).toBeGreaterThan(0);
  });
});

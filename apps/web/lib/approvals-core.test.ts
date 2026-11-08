import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "@outrun/core/db/query";
import { clients, events, messages } from "@outrun/core/db";
import { createEmitter } from "@outrun/core/events";
import { createTempDatabase, type TempDb } from "@outrun/core/testing/db";
import { submitDecisions } from "./approvals-core";

describe("approvals page decisions (SH-5)", () => {
  let t: TempDb;
  const confirms: unknown[][] = [];
  const naive = {
    confirmTool: async (...args: unknown[]) => {
      confirms.push(args);
    },
  };
  beforeAll(async () => {
    t = await createTempDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("sends the person's decision to Naive for held drafts only, and never marks a draft itself", async () => {
    const [held] = await t.db
      .insert(messages)
      .values({
        direction: "outbound",
        kind: "first",
        status: "awaiting_approval",
        naiveSessionId: "ses_1",
        naiveToolCallId: "tc_1",
      })
      .returning();
    const [checked] = await t.db
      .insert(messages)
      .values({ direction: "outbound", kind: "first", status: "checked" })
      .returning();
    const rt = {
      db: { db: t.db },
      emit: createEmitter(t.db),
      integrations: { naive },
    } as unknown as Parameters<typeof submitDecisions>[0];
    const n = await submitDecisions(rt, "srikanth@outrun.example", {
      ids: [held!.id, checked!.id],
      decision: "deny",
      reason: "wrong tone",
    });
    expect(n).toBe(1);
    expect(confirms).toEqual([
      ["ses_1", "tc_1", "deny", "rejected by srikanth@outrun.example: wrong tone", null],
    ]);
    const [still] = await t.db.select().from(messages).where(eq(messages.id, held!.id));
    expect(still!.status).toBe("awaiting_approval");
    const [ev] = await t.db.select().from(events).where(eq(events.type, "approval.submitted"));
    expect(ev).toMatchObject({ actor: "user:srikanth@outrun.example", entityId: held!.id });
  });

  it("a client approver decides only that client's held drafts, recorded as client:<email>", async () => {
    const [a] = await t.db
      .insert(clients)
      .values({ slug: "acme", name: "Acme", domain: "acme.dev" })
      .returning();
    const [b] = await t.db
      .insert(clients)
      .values({ slug: "beta", name: "Beta", domain: "beta.dev" })
      .returning();
    const held = (clientId: string, n: string) =>
      t.db
        .insert(messages)
        .values({
          clientId,
          direction: "outbound",
          kind: "first",
          status: "awaiting_approval",
          naiveSessionId: `ses_${n}`,
          naiveToolCallId: `tc_${n}`,
        })
        .returning();
    const [mine] = await held(a!.id, "a");
    const [theirs] = await held(b!.id, "b");
    const rt = {
      db: { db: t.db },
      emit: createEmitter(t.db),
      integrations: { naive },
    } as unknown as Parameters<typeof submitDecisions>[0];
    confirms.length = 0;
    const n = await submitDecisions(
      rt,
      "ada@acme.dev",
      { ids: [mine!.id, theirs!.id], decision: "allow", reason: "" },
      { clientId: a!.id },
    );
    expect(n).toBe(1);
    expect(confirms).toEqual([["ses_a", "tc_a", "allow", "approved by ada@acme.dev", null]]);
    const [ev] = await t.db.select().from(events).where(eq(events.entityId, mine!.id));
    expect(ev!.actor).toBe("client:ada@acme.dev");
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, contacts, events, messages, prospects, suppressions } from "./db/schema";
import { createEmitter } from "./events";
import type { Llm } from "./llm";
import { createTempDatabase, type TempDb } from "./testing/db";
import { FIXTURE_REPLIES } from "./testing/replies";
import { REPLY_CLASSES, ruleClass, runTriage } from "./triage";

describe("triage_reply (SH-7, SH-10)", () => {
  let t: TempDb;
  let jobs: { payload: Record<string, unknown>; idempotencyKey: string }[];
  let llmCalls: number;
  let n = 0;
  // A scripted model that returns the fixture's label, so this test checks everything but the model.
  const llmFor =
    (label: string): Llm =>
    async (call) => {
      llmCalls++;
      return {
        data: call.schema.parse({ label, confidence: 0.9 }),
        costUsd: 0,
        model: "fake",
        provider: "fake",
        fellBack: false,
      };
    };
  const deps = (label = "interested") => ({
    db: t.db,
    emit: createEmitter(t.db),
    llm: llmFor(label),
    appUrl: "https://outrun.example",
    enqueue: async (j: { payload: Record<string, unknown>; idempotencyKey: string }) => {
      jobs.push(j);
      return {};
    },
  });

  async function inbound(r: { from: string; subject: string; body: string }) {
    const i = ++n;
    const [co] = await t.db
      .insert(companies)
      .values({ domain: `tri${i}.dev`, name: "T", source: "fixture", kind: "prospect" })
      .returning();
    const [c] = await t.db
      .insert(contacts)
      .values({ companyId: co!.id, name: "T", email: `t@tri${i}.dev`, sourceUrl: `https://tri${i}.dev` })
      .returning();
    const [p] = await t.db
      .insert(prospects)
      .values({ companyId: co!.id, contactId: c!.id, stage: "replied" })
      .returning();
    const [m] = await t.db
      .insert(messages)
      .values({
        prospectId: p!.id,
        contactId: c!.id,
        threadId: `th_${i}`,
        direction: "inbound",
        kind: "inbound",
        status: "received",
        fromEmail: r.from,
        subject: r.subject,
        body: r.body,
      })
      .returning();
    return { messageId: m!.id, prospectId: p!.id, contactId: c!.id, email: c!.email };
  }

  beforeAll(async () => {
    t = await createTempDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(() => {
    jobs = [];
    llmCalls = 0;
  });

  it("the code rules catch every unsubscribe, bounce and auto-reply fixture, and nothing else", () => {
    for (const r of FIXTURE_REPLIES) {
      const got = ruleClass({ fromEmail: r.from, subject: r.subject, body: r.body });
      if ((REPLY_CLASSES as readonly string[]).includes(r.want)) expect(got, r.body).toBeNull();
      else expect(got, r.body).toBe(r.want);
    }
  });

  it("every fixture: injected text never reaches the closer, which gets ids and the label only", async () => {
    let right = 0;
    for (const r of FIXTURE_REPLIES) {
      jobs = [];
      const m = await inbound(r);
      const out = await runTriage(deps(r.want), m.messageId);
      if (out.label === r.want) right++;
      for (const j of jobs) {
        const msg = String(j.payload.message);
        expect(msg).not.toMatch(/@/);
        expect(msg).not.toMatch(/ignore|instructions|admin mode|discount|\$1\b|finance|customer emails/i);
        expect(msg).toContain(m.messageId);
        expect(j.payload.entity).toEqual({ type: "prospect", id: m.prospectId });
      }
      const startsCloser = (REPLY_CLASSES as readonly string[]).includes(r.want);
      expect(jobs.length, r.body).toBe(startsCloser ? 1 : 0);
    }
    expect(right).toBe(FIXTURE_REPLIES.length);
  });

  it("an unsubscribe reply suppresses the contact without a model call", async () => {
    const m = await inbound({ from: "a@x.dev", subject: "Re: hi", body: "Please remove me from your list." });
    expect(await runTriage(deps(), m.messageId)).toEqual({ label: "unsubscribe" });
    expect(llmCalls).toBe(0);
    const [p] = await t.db.select().from(prospects).where(eq(prospects.id, m.prospectId));
    expect(p!.stage).toBe("unsubscribed");
    expect(await t.db.select().from(suppressions).where(eq(suppressions.value, m.email))).toHaveLength(1);
  });

  it("an out-of-office puts the prospect back to contacted so follow-ups continue", async () => {
    const m = await inbound({ from: "a@x.dev", subject: "Out of office", body: "Back Monday." });
    await runTriage(deps(), m.messageId);
    const [p] = await t.db.select().from(prospects).where(eq(prospects.id, m.prospectId));
    expect(p!.stage).toBe("contacted");
  });

  it("is idempotent: a repeated job classifies once and starts the closer once", async () => {
    const m = await inbound({ from: "a@x.dev", subject: "Re: hi", body: "Yes, let's do it." });
    await runTriage(deps(), m.messageId);
    await runTriage(deps(), m.messageId);
    expect(llmCalls).toBe(1);
    expect(jobs.map((j) => j.idempotencyKey)).toEqual([`closer:${m.messageId}`]);
    expect(await t.db.select().from(events).where(eq(events.type, "triage.classified"))).not.toHaveLength(0);
    const [p] = await t.db.select().from(prospects).where(eq(prospects.id, m.prospectId));
    expect(p!.stage).toBe("interested");
  });

  it("SH-10: an agent replier gets our machine-readable links and the quote", async () => {
    const m = await inbound({ from: "bot@x.dev", subject: "Re: hi", body: "task: quote\nformat: json" });
    await runTriage(deps("agent"), m.messageId);
    const msg = String(jobs[0]!.payload.message);
    for (const p of ["/llms.txt", "/openapi.json", "/api/mcp", "/.well-known/agent-card.json", "499 USD"])
      expect(msg).toContain(p);
  });
});

describe("triage for a client", () => {
  it("names the client and its offer, not Outrun", async () => {
    const { triageSystem, clientAgentReplyBrief } = await import("./triage");
    const s = triageSystem("Acme Pay, which offers: a demo of invoice matching");
    expect(s).toContain("from Acme Pay, which offers: a demo of invoice matching.");
    expect(s).not.toContain("Outrun");
    const b = clientAgentReplyBrief({
      name: "Acme Pay",
      pitch: "a demo",
      callToActionUrl: "https://acme-pay.dev/demo",
    });
    expect(b).toContain("next_step: https://acme-pay.dev/demo");
    expect(b).not.toMatch(/llms\.txt|USD/);
  });
});

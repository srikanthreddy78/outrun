import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { CREW_TOOLS, type AgentName } from "../contracts";
import { CLIENT_FOCUS_MAX, CLIENT_FOCUS_MIN, OUTRUN_CLIENT_ID } from "./constants";
import { allTools } from "./crew/tools";
import { ToolRegistry } from "./crew/registry";
import type { ToolContext } from "./crew/types";
import { clients, companies, contacts, events, messages, prospects } from "./db/schema";
import { createEmitter } from "./events";
import { clientInsights, proposalsFor } from "./insights";
import { applyProfileProposal, rejectProfileProposal } from "./insights";
import { createTempDatabase, type TempDb } from "./testing/db";

const NOW = new Date("2026-11-06T18:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const profile = {
  summary: "Acme Pay sells invoice-matching APIs to finance teams.",
  icp: {
    description: "B2B SaaS with a finance team",
    includeKeywords: ["invoicing", "accounts payable"],
    excludeKeywords: ["agency"],
    buyerRoles: ["CFO", "Head of Finance"],
    companySizes: ["11-50"],
  },
  offer: {
    pitch: "A 20-minute demo of automated invoice matching.",
    callToActionUrl: "https://acme-pay.dev/demo",
    prices: [{ label: "Starter", amount: "$49/month" }],
  },
  allowedLinkHosts: [],
  sender: { name: "Ada", postalAddress: "1 Market St, San Francisco, CA 94105" },
  tone: "plain",
  sources: ["https://acme-pay.dev/"],
};

describe("the CEO learns from the ledger", () => {
  let t: TempDb;
  let acme: string;
  let other: string;
  let jobs: { type: string; payload: Record<string, unknown> }[] = [];
  const pid: Record<string, string> = {};
  const settings = { sendDailyCap: 30, discoveryDailyCap: 0, demo: false };
  let registry: ToolRegistry;
  const ctx = (agent: AgentName, clientId: string): ToolContext => ({
    agent,
    clientId,
    requestId: "r",
    db: t.db,
    now: () => NOW,
    enqueue: async (j) => {
      jobs.push(j as never);
      return { jobId: "j" };
    },
    emit: createEmitter(t.db),
  });
  const ceo = (tool: string, input: unknown) =>
    registry.call("ceo", tool, input, ctx("ceo", OUTRUN_CLIENT_ID));

  let n = 0;
  async function prospect(
    clientId: string,
    o: { fact: string; role: string | null; parts: { signal: string; points: number }[]; stage?: "won" },
  ) {
    n++;
    const [co] = await t.db
      .insert(companies)
      .values({ domain: `lead${n}.dev`, name: `Lead ${n}`, source: "fixture" })
      .returning();
    const [ct] = o.role
      ? await t.db
          .insert(contacts)
          .values({
            companyId: co!.id,
            name: "X",
            role: o.role,
            email: `x${n}@lead${n}.dev`,
            sourceUrl: "https://x.dev",
          })
          .returning()
      : [undefined];
    const [p] = await t.db
      .insert(prospects)
      .values({
        clientId,
        companyId: co!.id,
        contactId: ct?.id ?? null,
        stage: o.stage ?? "contacted",
        facts: [{ key: "product", value: o.fact, sourceUrl: "https://x.dev" }],
      })
      .returning();
    await t.db.insert(events).values({
      actor: "naive:researcher",
      type: "prospect.researched",
      entityType: "prospect",
      entityId: p!.id,
      payload: { fitScore: 50, parts: o.parts.map((x) => ({ ...x, reason: "r" })) },
      ts: ago(20),
    });
    return p!.id;
  }
  async function message(
    clientId: string,
    prospectId: string,
    o: {
      kind: "first" | "followup" | "inbound";
      subject?: string;
      at: Date;
      label?: string;
      status?: string;
    },
  ) {
    const inbound = o.kind === "inbound";
    const [m] = await t.db
      .insert(messages)
      .values({
        clientId,
        prospectId,
        direction: inbound ? "inbound" : "outbound",
        kind: o.kind,
        status: (o.status ?? (inbound ? "received" : "sent")) as never,
        subject: o.subject ?? "",
        sentAt: inbound ? null : o.at,
        createdAt: o.at,
      })
      .returning();
    if (o.label)
      await t.db.insert(events).values({
        actor: "worker",
        type: "triage.classified",
        entityType: "message",
        entityId: m!.id,
        payload: { label: o.label },
        ts: o.at,
      });
    return m!.id;
  }
  const decision = (messageId: string, d: "allow" | "deny", reason: string | null, at: Date) =>
    t.db.insert(events).values({
      actor: "client:ada@acme-pay.dev",
      type: "approval.submitted",
      entityType: "message",
      entityId: messageId,
      payload: { decision: d, toolCallId: "tc", reason },
      ts: at,
    });

  beforeAll(async () => {
    t = await createTempDatabase();
    registry = new ToolRegistry(
      allTools({ settings, outreach: { appUrl: "https://outrun.example", settings, mx: async () => true } }),
    );
    const [a] = await t.db
      .insert(clients)
      .values({
        slug: "acme-pay",
        name: "Acme Pay",
        domain: "acme-pay.dev",
        status: "active",
        dnsStatus: "verified",
        profileConfirmedAt: ago(30),
        confirmedBy: "user:o@x.dev",
        profile,
      })
      .returning();
    const [b] = await t.db
      .insert(clients)
      .values({
        slug: "beta",
        name: "Beta",
        domain: "beta.dev",
        status: "active",
        profileConfirmedAt: ago(30),
        profile: {
          ...profile,
          sources: ["https://beta.dev/"],
          offer: { ...profile.offer, callToActionUrl: "https://beta.dev/x" },
        },
      })
      .returning();
    acme = a!.id;
    other = b!.id;
    const buyer = { signal: "contact", points: 30 };
    const plain = { signal: "contact", points: 10 };
    const match = { signal: "match", points: 25 };
    pid.p1 = await prospect(acme, { fact: "invoicing for SaaS", role: "CFO", parts: [match, buyer] });
    pid.p2 = await prospect(acme, { fact: "invoicing tools", role: "Engineer", parts: [match, plain] });
    pid.p3 = await prospect(acme, { fact: "payroll", role: "CFO", parts: [buyer], stage: "won" });
    pid.p4 = await prospect(acme, { fact: "payroll", role: null, parts: [] });
    pid.p5 = await prospect(acme, { fact: "invoicing", role: "Head of Finance", parts: [match, buyer] });
    pid.old = await prospect(acme, { fact: "invoicing", role: "CFO", parts: [match, buyer] });
    pid.beta = await prospect(other, { fact: "invoicing", role: "CFO", parts: [match, buyer] });

    const f1 = await message(acme, pid.p1, { kind: "first", subject: "Ledgerly and invoicing", at: ago(10) });
    await message(acme, pid.p1, { kind: "followup", subject: "Re: x", at: ago(7) });
    await message(acme, pid.p1, { kind: "inbound", at: ago(6), label: "interested" });
    await message(acme, pid.p2, { kind: "first", subject: "Lead 2's invoices", at: ago(9) });
    await message(acme, pid.p2, { kind: "inbound", at: ago(5), label: "not_now" });
    await message(acme, pid.p3, { kind: "first", subject: "Payroll", at: ago(8) });
    await message(acme, pid.p4, { kind: "first", subject: "Hello", at: ago(8) });
    await message(acme, pid.p4, { kind: "inbound", at: ago(8), label: "bounce" });
    await message(acme, pid.p5, { kind: "first", subject: "Quick one", at: ago(4) });
    await message(acme, pid.p5, { kind: "inbound", at: ago(3), label: "unsubscribe" });
    // Outside the window: neither counted nor attributed.
    await message(acme, pid.old, { kind: "first", subject: "Old", at: ago(60) });
    await message(acme, pid.old, { kind: "inbound", at: ago(59), label: "interested" });
    // Another client's reply and rejection never count for Acme.
    const bf = await message(other, pid.beta, { kind: "first", subject: "Beta subject", at: ago(5) });
    await message(other, pid.beta, { kind: "inbound", at: ago(4), label: "interested" });
    await decision(bf, "deny", "Beta: never say free", ago(4));

    const d1 = await message(acme, pid.p2, {
      kind: "followup",
      subject: "d1",
      at: ago(3),
      status: "rejected",
    });
    const d2 = await message(acme, pid.p3, {
      kind: "followup",
      subject: "d2",
      at: ago(2),
      status: "rejected",
    });
    await decision(f1, "allow", null, ago(10));
    await decision(d1, "deny", "too pushy", ago(3));
    await decision(d2, "deny", "wrong first name", ago(2));
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("counts sends, replies, interest, wins, unsubscribes and bounces, per contacted prospect", async () => {
    const i = await clientInsights(t.db, acme, { since: ago(30) });
    expect(i).toMatchObject({
      sent: 6,
      contacted: 5,
      replies: 2,
      interested: 1,
      replyRate: 0.4,
      interestRate: 0.2,
      wins: 1,
      unsubscribes: 1,
      bounces: 1,
    });
  });

  it("breaks replies down by ICP keyword, fit signal and buyer role", async () => {
    const i = await clientInsights(t.db, acme, { since: ago(30) });
    const row = (rows: { key: string }[], key: string) => rows.find((r) => r.key === key);
    expect(row(i.byKeyword, "invoicing")).toEqual({
      key: "invoicing",
      contacted: 3,
      replied: 2,
      interested: 1,
      replyRate: 0.667,
      interestRate: 0.333,
    });
    expect(row(i.byKeyword, "(none)")).toMatchObject({ contacted: 2, replied: 0 });
    expect(row(i.bySignal, "contact +30")).toMatchObject({ contacted: 3, replied: 1, interested: 1 });
    expect(row(i.bySignal, "contact +10")).toMatchObject({ contacted: 1, replied: 1, interested: 0 });
    expect(row(i.byBuyerRole, "CFO")).toMatchObject({ contacted: 2, replied: 1 });
    expect(row(i.byBuyerRole, "Head of Finance")).toMatchObject({ contacted: 1, replied: 0 });
    expect(row(i.byBuyerRole, "(other)")).toMatchObject({ contacted: 2, replied: 1 });
  });

  it("reads approval rejections and replied-to subjects for this client only", async () => {
    const i = await clientInsights(t.db, acme, { since: ago(30) });
    expect(i.approvals).toEqual({
      decided: 3,
      rejected: 2,
      rejectRate: 0.667,
      lastRejectionReasons: ["wrong first name", "too pushy"],
    });
    expect(i.repliedSubjects).toEqual(["Lead 2's invoices", "Ledgerly and invoicing"]);
    const out = CREW_TOOLS.client_insights.output.safeParse(await ceo("client_insights", { clientId: acme }));
    expect(out.success).toBe(true);
  });

  it("hands the lessons to a client's sdr and closer in get_brief; Outrun's brief has none", async () => {
    const brief = (await registry.call("sdr", "get_brief", { prospectId: pid.p4 }, ctx("sdr", acme))) as {
      lessons: { rejectionReasons: string[]; repliedSubjects: string[] } | null;
    };
    expect(brief.lessons).toEqual({
      rejectionReasons: ["wrong first name", "too pushy"],
      repliedSubjects: ["Lead 2's invoices", "Ledgerly and invoicing", "Old"],
    });
    const closer = (await registry.call(
      "closer",
      "get_brief",
      { prospectId: pid.p1 },
      ctx("closer", acme),
    )) as {
      lessons: unknown;
    };
    expect(closer.lessons).toEqual(brief.lessons);
    const beta = (await registry.call("sdr", "get_brief", { prospectId: pid.beta }, ctx("sdr", other))) as {
      lessons: { rejectionReasons: string[] };
    };
    expect(beta.lessons.rejectionReasons).toEqual(["Beta: never say free"]);
  });

  it("rejects a proposal that touches prices, the offer or the sender at the schema", async () => {
    for (const changes of [
      { prices: [{ label: "Plan", amount: "$1" }] },
      { addIncludeKeywords: ["payroll"], offer: { pitch: "free" } },
      { sender: { name: "Eve" } },
    ])
      await expect(
        ceo("propose_profile_change", { clientId: acme, changes, evidence: "3 of 5 replied" }),
      ).rejects.toMatchObject({ code: "bad_request" });
    expect(await proposalsFor(t.db, acme)).toEqual([]);
  });

  it("proposes, refuses a second within 7 days, and applies the accepted change to the confirmed profile", async () => {
    const first = (await ceo("propose_profile_change", {
      clientId: acme,
      changes: { addIncludeKeywords: ["payroll"], addExcludeKeywords: ["consumer"], buyerRoles: ["CFO"] },
      evidence: "invoicing: 2 of 3 replied; (none): 0 of 2",
    })) as { ok: true; proposalId: string };
    expect(first.ok).toBe(true);
    const second = (await ceo("propose_profile_change", {
      clientId: acme,
      changes: { companySizes: [] },
      evidence: "1 of 1",
    })) as { ok: false; reason: string };
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/still waits for the owner/);

    const [ev] = await t.db.select().from(events).where(eq(events.type, "ceo.proposal"));
    expect(ev).toMatchObject({ actor: "naive:ceo", entityId: acme });
    expect(ev!.payload).toMatchObject({
      proposalId: first.proposalId,
      evidence: expect.stringMatching(/2 of 3/),
    });

    await applyProfileProposal(
      { db: t.db, emit: createEmitter(t.db) },
      acme,
      first.proposalId,
      "user:o@x.dev",
    );
    const [c] = await t.db.select().from(clients).where(eq(clients.id, acme));
    expect(c!.profileConfirmedAt).not.toBeNull();
    expect(c!.status).toBe("active");
    const icp = (c!.profile as typeof profile).icp;
    expect(icp.includeKeywords).toEqual(["invoicing", "accounts payable", "payroll"]);
    expect(icp.excludeKeywords).toEqual(["agency", "consumer"]);
    expect(icp.buyerRoles).toEqual(["CFO"]);
    expect((c!.profile as typeof profile).offer).toEqual(profile.offer);
    const [acc] = await t.db
      .select()
      .from(events)
      .where(and(eq(events.type, "ceo.proposal_accepted"), eq(events.entityId, acme)));
    expect(acc!.actor).toBe("user:o@x.dev");
    await expect(
      applyProfileProposal({ db: t.db, emit: createEmitter(t.db) }, acme, first.proposalId, "user:o@x.dev"),
    ).rejects.toMatchObject({ code: "conflict" });

    // Resolved, but still inside the week: refused.
    const third = (await ceo("propose_profile_change", {
      clientId: acme,
      changes: { companySizes: [] },
      evidence: "1 of 1",
    })) as { ok: false; reason: string };
    expect(third.reason).toMatch(/one proposal per client per 7 days/);
  });

  it("refuses a change that would leave an invalid profile, and records an owner's rejection", async () => {
    const bad = (await ceo("propose_profile_change", {
      clientId: other,
      changes: { dropIncludeKeywords: ["invoicing", "accounts payable"] },
      evidence: "0 of 9 replied",
    })) as { ok: false; reason: string };
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/invalid profile/);
    const ok = (await ceo("propose_profile_change", {
      clientId: other,
      changes: { dropIncludeKeywords: ["accounts payable"] },
      evidence: "accounts payable: 0 of 9 replied",
    })) as { ok: true; proposalId: string };
    await rejectProfileProposal(
      { db: t.db, emit: createEmitter(t.db) },
      other,
      ok.proposalId,
      "keep it",
      "user:o@x.dev",
    );
    const [p] = await proposalsFor(t.db, other);
    expect(p!.status).toBe("rejected");
    const [c] = await t.db.select().from(clients).where(eq(clients.id, other));
    expect((c!.profile as typeof profile).icp.includeKeywords).toEqual(["invoicing", "accounts payable"]);
  });

  it("bounds the focus, and plan_day drafts that many first emails, within the send cap", async () => {
    expect([CLIENT_FOCUS_MIN, CLIENT_FOCUS_MAX]).toEqual([2, 25]);
    const input = CREW_TOOLS.set_client_focus.input;
    expect(input.safeParse({ clientId: acme, dailyDraftLimit: 1, reason: "x" }).success).toBe(false);
    expect(input.safeParse({ clientId: acme, dailyDraftLimit: 26, reason: "x" }).success).toBe(false);
    await expect(
      ceo("set_client_focus", { clientId: OUTRUN_CLIENT_ID, dailyDraftLimit: 5, reason: "x" }),
    ).rejects.toMatchObject({ code: "bad_request" });

    for (let i = 0; i < 8; i++)
      await prospect(acme, { fact: "invoicing", role: "CFO", parts: [] }).then((id) =>
        t.db.update(prospects).set({ stage: "researched" }).where(eq(prospects.id, id)),
      );
    const plan = async (r = registry) => {
      jobs = [];
      const out = (await r.call("orchestrator", "plan_day", {}, ctx("orchestrator", acme))) as {
        enqueued: { agent: string; prospectId: string | null }[];
      };
      return out.enqueued.filter((e) => e.agent === "sdr" && e.prospectId).length;
    };
    expect(await plan()).toBe(8);

    const set = await ceo("set_client_focus", {
      clientId: acme,
      dailyDraftLimit: 3,
      reason: "2 of 5 replied",
    });
    expect(set).toEqual({ dailyDraftLimit: 3, previous: null });
    expect(await plan()).toBe(3);

    // A focus above the send cap is held to the cap.
    await ceo("set_client_focus", { clientId: acme, dailyDraftLimit: 25, reason: "40% reply rate" });
    expect(await plan()).toBe(8);
    const capped = new ToolRegistry(allTools({ settings: { ...settings, sendDailyCap: 4 } }));
    expect(await plan(capped)).toBe(4);
    const [ev] = await t.db
      .select()
      .from(events)
      .where(and(eq(events.type, "ceo.focus_set"), eq(events.entityId, acme)))
      .orderBy(events.ts);
    expect(ev).toMatchObject({
      actor: "naive:ceo",
      payload: { dailyDraftLimit: 3, reason: "2 of 5 replied" },
    });
    const i = await clientInsights(t.db, acme, { since: ago(30) });
    expect(i.focus?.dailyDraftLimit).toBe(25);
  });
});

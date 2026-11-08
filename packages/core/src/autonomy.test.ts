import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COUNTED_TYPES, autonomyReport, classifyActor, redactText } from "./autonomy";
import { agentSessions, clients, companies, events, messages, prospects } from "./db/schema";
import { createEmitter } from "./events";
import { createTempDatabase, type TempDb } from "./testing/db";

/** Every string anywhere in a value. */
const strings = (v: unknown): string[] =>
  typeof v === "string"
    ? [v]
    : Array.isArray(v)
      ? v.flatMap(strings)
      : v && typeof v === "object"
        ? Object.values(v).flatMap(strings)
        : [];

describe("classifyActor", () => {
  it("splits agents, system and people", () => {
    expect(classifyActor("naive:acme-researcher")).toBe("agent");
    expect(classifyActor("naive:ceo")).toBe("agent");
    for (const a of ["worker", "web", "system", "provider:naive", "provider:stripe"])
      expect(classifyActor(a)).toBe("system");
    expect(classifyActor("user:srikanth@outrun.example")).toBe("human");
    expect(classifyActor("client:ada@acme.dev")).toBe("human");
  });
});

describe("the counted set", () => {
  it("counts business actions and people, not plumbing or approval echoes", () => {
    const counted = new Set<string>(COUNTED_TYPES);
    for (const t of ["email.sent", "triage.classified", "prospect.filed", "approval.submitted", "ceo.brief"])
      expect(counted.has(t)).toBe(true);
    for (const t of [
      "llm.call",
      "llm.cost",
      "job.done",
      "tool.called",
      "webhook.received",
      "session.idle",
      "approval.approved",
      "approval.rejected",
    ])
      expect(counted.has(t)).toBe(false);
  });
});

describe("redactText", () => {
  it("drops emails and unknown domains, keeps allowed ones", () => {
    const out = redactText("mail ada@acme.dev about hidden.io and acme.dev", new Set(["acme.dev"]));
    expect(out).toBe("mail [email] about [domain] and acme.dev");
  });
});

describe("autonomyReport", () => {
  let t: TempDb;
  let acmeId: string;
  const since = new Date(Date.now() - 7 * 24 * 3_600_000);

  beforeAll(async () => {
    t = await createTempDatabase();
    const emit = createEmitter(t.db);
    const [acme] = await t.db
      .insert(clients)
      .values({ slug: "acme", name: "Acme", domain: "acme.dev", status: "active" })
      .returning();
    acmeId = acme!.id;
    const [contactedCo, quietCo] = await t.db
      .insert(companies)
      .values([
        { domain: "contacted-co.com", source: "manual" },
        { domain: "secret-co.com", source: "manual" },
      ])
      .returning();
    const [contacted, quiet] = await t.db
      .insert(prospects)
      .values([
        { clientId: acmeId, companyId: contactedCo!.id, stage: "contacted", filedReason: "uses Stripe" },
        {
          clientId: acmeId,
          companyId: quietCo!.id,
          stage: "filed",
          filedReason: "owner bob@secret-co.com runs secret-co.com",
        },
      ])
      .returning();
    const [sent, reply] = await t.db
      .insert(messages)
      .values([
        {
          clientId: acmeId,
          prospectId: contacted!.id,
          direction: "outbound",
          kind: "first",
          status: "sent",
          toEmail: "cto@contacted-co.com",
          subject: "Private subject",
          body: "Private body",
        },
        {
          clientId: acmeId,
          prospectId: contacted!.id,
          direction: "inbound",
          kind: "inbound",
          status: "received",
          fromEmail: "cto@contacted-co.com",
          subject: "Re: Private subject",
          body: "Sure, tell me more",
        },
      ])
      .returning();
    const [kick] = await t.db
      .insert(agentSessions)
      .values({
        clientId: acmeId,
        agent: "orchestrator",
        entityType: "client",
        entityId: acmeId,
        idempotencyKey: `ceo:2026-11-08:${acmeId}`,
        spendUsd: "0.5",
      })
      .returning();

    const agent = "naive:acme-researcher" as const;
    await emit({
      actor: agent,
      type: "prospect.filed",
      entityType: "prospect",
      entityId: contacted!.id,
      payload: { domain: "contacted-co.com", source: "manual" },
    });
    await emit({
      actor: agent,
      type: "prospect.filed",
      entityType: "prospect",
      entityId: quiet!.id,
      payload: { domain: "secret-co.com", source: "manual" },
    });
    await emit({
      actor: agent,
      type: "prospect.researched",
      entityType: "prospect",
      entityId: contacted!.id,
      payload: {},
    });
    await emit({
      actor: "naive:acme-writer",
      type: "draft.rejected",
      entityType: "prospect",
      entityId: quiet!.id,
      payload: { kind: "first", reasons: ["mentions secret-co.com without a source"] },
    });
    await emit({
      actor: "worker",
      type: "email.sent",
      entityType: "message",
      entityId: sent!.id,
      payload: { kind: "first" },
    });
    await emit({
      actor: "worker",
      type: "triage.classified",
      entityType: "message",
      entityId: reply!.id,
      payload: { label: "interested" },
    });
    await emit({
      actor: "worker",
      type: "session.started",
      entityType: "agent_session",
      entityId: kick!.id,
      payload: { agent: "orchestrator", entity: { type: "client", id: acmeId } },
    });
    await emit({
      actor: "naive:ceo",
      type: "ceo.brief",
      entityType: "system",
      entityId: "ceo:brief:2026-11-08",
      payload: { day: "2026-11-08", summary: "Ask ada@acme.dev; secret-co.com is promising" },
    });
    await emit({
      actor: "user:srikanth@outrun.example",
      type: "client.profile_confirmed",
      entityType: "client",
      entityId: acmeId,
      payload: {},
    });
    await emit({
      actor: "client:ada@acme.dev",
      type: "approval.submitted",
      entityType: "message",
      entityId: sent!.id,
      payload: { decision: "allow", reason: "ok from ada@acme.dev" },
    });
    // Noise: never counted, but its cost is spend.
    await emit({
      actor: "worker",
      type: "llm.call",
      entityType: "system",
      entityId: "triage",
      costUsd: 0.25,
    });
    await emit({ actor: agent, type: "tool.called", entityType: "system", entityId: "x", costUsd: 0.1 });
    await emit({ actor: "provider:agentmail", type: "job.done", entityType: "system", entityId: "y" });
    // Outside the window.
    await t.db.insert(events).values({
      ts: new Date(since.getTime() - 3_600_000),
      actor: "user:old@outrun.example",
      type: "client.added",
      entityType: "client",
      entityId: acmeId,
    });
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("counts actors over the counted set and computes autonomy %", async () => {
    const r = await autonomyReport(t.db, { since });
    expect(r.counts).toEqual({ agent: 5, system: 3, human: 2, total: 10 });
    expect(r.autonomyPct).toBe(80);
    expect(r.deliveries).toMatchObject({
      emailsSent: 1,
      repliesHandled: 1,
      clientsOnboarded: 1,
      prospectsFiled: 2,
      prospectsResearched: 1,
      ordersPaid: 0,
    });
    expect(r.spend).toEqual({ agentUsd: 0.6, systemUsd: 0.25, humanUsd: 0, totalUsd: 0.85 });
  });

  it("lists decisions, including the CEO kick, and human step-ins", async () => {
    const r = await autonomyReport(t.db, { since });
    const types = r.decisions.map((d) => d.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "prospect.filed",
        "triage.classified",
        "draft.rejected",
        "ceo.brief",
        "ceo.kick",
      ]),
    );
    expect(r.decisions.find((d) => d.type === "ceo.kick")!.summary).toContain("Acme");
    expect(r.decisions.find((d) => d.type === "triage.classified")!.summary).toContain("interested");
    expect(r.stepIns.map((s) => s.type).sort()).toEqual(["approval.submitted", "client.profile_confirmed"]);
    expect(r.stepIns.find((s) => s.type === "approval.submitted")!.summary).toContain("Approved");
  });

  it("filters to one client", async () => {
    const r = await autonomyReport(t.db, { since, clientId: "00000000-0000-7000-8000-000000000000" });
    expect(r.counts.total).toBe(0);
    expect(r.autonomyPct).toBeNull();
    const acme = await autonomyReport(t.db, { since, clientId: acmeId });
    expect(acme.counts.total).toBe(9); // everything but the agency-wide CEO brief
  });

  it("redacts: no @, no subjects or bodies, no prospect domains, people as roles", async () => {
    const r = await autonomyReport(t.db, { since, redact: true });
    const all = strings(r);
    expect(all.filter((s) => s.includes("@"))).toEqual([]);
    expect(all.some((s) => s.includes("Private"))).toBe(false);
    expect(all.some((s) => s.includes("secret-co.com"))).toBe(false);
    expect(all.some((s) => s.includes("contacted-co.com"))).toBe(false);
    expect(r.stepIns.map((s) => s.actor).sort()).toEqual(["client approver", "owner"]);
    expect(r.counts.total).toBe(10);
    // No free text reaches the public page: agents' reasons, the brief, the owner's words.
    expect(all.some((s) => s.includes("without a source"))).toBe(false);
    expect(all.some((s) => s.includes("promising"))).toBe(false);
    expect(all.some((s) => s.includes("ok from"))).toBe(false);
    expect(r.decisions.find((d) => d.type === "draft.rejected")!.summary).toContain("1 problem found");
    // Acme's profile isn't confirmed, so its own name stays off the public page.
    expect(all.some((s) => s.includes("Acme"))).toBe(false);
  });
});

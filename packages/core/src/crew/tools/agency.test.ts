import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AgentName } from "../../../contracts";
import { OUTRUN_CLIENT_ID } from "../../constants";
import { agentSessions, clients, companies, events, messages, prospects } from "../../db/schema";
import { createEmitter } from "../../events";
import { createTempDatabase, type TempDb } from "../../testing/db";
import type { ToolDef } from "../registry";
import type { ToolContext } from "../types";
import {
  agencyOverview,
  agencyStatus,
  clientReport,
  getClientProfile,
  kickClient,
  latestBrief,
  listClients,
  saveBrief,
} from "./agency";

describe("agency tools: every client's profile, and the CEO's", () => {
  let t: TempDb;
  let jobs: { type: string; idempotencyKey: string; payload: Record<string, unknown> }[];
  const seen = new Set<string>();
  let acme: string;
  let beta: string;
  const now = new Date("2026-11-10T17:00:00Z");
  const ctx = (agent: AgentName, clientId = OUTRUN_CLIENT_ID): ToolContext => ({
    agent,
    clientId,
    requestId: "r",
    db: t.db,
    now: () => now,
    enqueue: async (j) => {
      if (seen.has(j.idempotencyKey)) return { jobId: null };
      seen.add(j.idempotencyKey);
      jobs.push(j as never);
      return { jobId: "j" };
    },
    emit: createEmitter(t.db),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = <D extends ToolDef<any>>(def: D, input: unknown, c: ToolContext) =>
    def.handler(def.input.parse(input), c) as ReturnType<D["handler"]>;

  beforeAll(async () => {
    t = await createTempDatabase();
    jobs = [];
    const [a] = await t.db
      .insert(clients)
      .values({
        slug: "acme",
        name: "Acme",
        domain: "acme.example",
        status: "active",
        profileConfirmedAt: now,
        profile: { icp: "fintech APIs" },
      })
      .returning();
    const [b] = await t.db
      .insert(clients)
      .values({ slug: "beta", name: "Beta", domain: "beta.example", status: "awaiting_confirmation" })
      .returning();
    acme = a!.id;
    beta = b!.id;
    const [co] = await t.db
      .insert(companies)
      .values({ domain: "lead.example", source: "fixture" })
      .returning();
    const [p] = await t.db
      .insert(prospects)
      .values({ clientId: acme, companyId: co!.id, stage: "contacted" })
      .returning();
    await t.db.insert(messages).values([
      {
        clientId: acme,
        prospectId: p!.id,
        direction: "outbound",
        kind: "first",
        status: "sent",
        sentAt: now,
      },
      { clientId: acme, prospectId: p!.id, direction: "inbound", kind: "inbound", status: "received" },
      {
        clientId: acme,
        prospectId: p!.id,
        direction: "outbound",
        kind: "reply",
        status: "awaiting_approval",
        updatedAt: new Date(now.getTime() - 30 * 3_600_000),
      },
    ]);
    await t.db.insert(agentSessions).values([
      {
        clientId: acme,
        agent: "sdr",
        entityType: "prospect",
        entityId: p!.id,
        idempotencyKey: "s1",
        status: "idle",
        spendUsd: "0.25",
        createdAt: now,
      },
      {
        clientId: acme,
        agent: "researcher",
        entityType: "prospect",
        entityId: p!.id,
        idempotencyKey: "s2",
        status: "error",
        createdAt: now,
      },
    ]);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("get_client_profile returns the caller's own client, never another", async () => {
    expect(await call(getClientProfile, {}, ctx("sdr", acme))).toMatchObject({
      slug: "acme",
      confirmed: true,
      profile: { icp: "fintech APIs" },
    });
    expect(await call(getClientProfile, {}, ctx("sdr"))).toMatchObject({ slug: "outrun" });
  });

  it("list_clients names every client's six agents", async () => {
    const { clients: list } = await call(listClients, {}, ctx("ceo"));
    expect(list.map((c) => c.slug)).toEqual(["outrun", "acme", "beta"]);
    expect(list[1]!.crew.map((m) => m.naiveAgent)).toEqual([
      "acme-orchestrator",
      "acme-prospector",
      "acme-researcher",
      "acme-sdr",
      "acme-closer",
      "acme-auditor",
    ]);
    expect(list[0]!.crew[3]).toEqual({ role: "sdr", naiveAgent: "sdr" });
  });

  it("client_report counts one client's work, per agent", async () => {
    const r = await call(clientReport, { clientId: acme }, ctx("ceo"));
    expect(r).toMatchObject({ sent: 1, replies: 1, approvalsWaiting: 1, oldestApprovalHours: 30 });
    expect(r.stages.contacted).toBe(1);
    expect(r.agents.find((a) => a.role === "sdr")).toMatchObject({
      naiveAgent: "acme-sdr",
      sessions: 1,
      spendUsd: 0.25,
    });
    expect(r.agents.find((a) => a.role === "researcher")).toMatchObject({ failed: 1 });
    expect(r.agents.find((a) => a.role === "closer")).toMatchObject({ sessions: 0, lastSessionAt: null });
    const o = await call(clientReport, { clientId: OUTRUN_CLIENT_ID }, ctx("ceo"));
    expect(o).toMatchObject({ sent: 0, replies: 0, approvalsWaiting: 0 });
  });

  it("agency_status rolls everyone up and says who needs attention", async () => {
    const s = await call(agencyStatus, {}, ctx("ceo"));
    expect(s.clients).toMatchObject({ active: 2, awaiting_confirmation: 1 });
    expect(s.totals).toMatchObject({ sent: 1, replies: 1, approvalsWaiting: 1, spendUsd: 0.25 });
    const why = s.attention.map((a) => `${a.slug}: ${a.reason}`);
    expect(why).toContain("beta: its target customer and offer wait for the owner to confirm");
    expect(why.some((w) => w.startsWith("acme:") && w.includes("waiting for the client's approval"))).toBe(
      true,
    );
    expect(why.some((w) => w.startsWith("acme:") && w.includes("failed"))).toBe(true);
  });

  it("kick_client starts an active, confirmed client's orchestrator once a day, and nobody else's", async () => {
    expect(await call(kickClient, { clientId: acme }, ctx("ceo"))).toEqual({ enqueued: true, reason: null });
    expect(await call(kickClient, { clientId: acme }, ctx("ceo"))).toEqual({
      enqueued: false,
      reason: "already started today",
    });
    expect((await call(kickClient, { clientId: beta }, ctx("ceo"))).enqueued).toBe(false);
    expect((await call(kickClient, { clientId: OUTRUN_CLIENT_ID }, ctx("ceo"))).reason).toMatch(
      /own schedule/,
    );
    expect(jobs.filter((j) => j.type === "start_session")).toEqual([
      expect.objectContaining({
        idempotencyKey: `ceo:2026-11-10:${acme}`,
        payload: expect.objectContaining({
          agent: "orchestrator",
          clientId: acme,
          entity: { type: "client", id: acme },
        }),
      }),
    ]);
  });

  it("the agency page lists every client with its six agents and what needs attention", async () => {
    const o = await agencyOverview(t.db, now);
    expect(o.clients.map((c) => c.slug)).toEqual(["outrun", "acme", "beta"]);
    const a = o.clients[1]!;
    expect(a.crew).toHaveLength(6);
    expect(a.crew.find((m) => m.role === "sdr")).toMatchObject({ naiveAgent: "acme-sdr", sessions: 1 });
    expect(o.clients[2]!.attention[0]).toMatch(/confirm/);
  });

  it("save_brief keeps the day's brief and asks the worker to email it once", async () => {
    expect(await call(saveBrief, { summary: "acme: 1 sent, 1 reply." }, ctx("ceo"))).toEqual({ saved: true });
    await call(saveBrief, { summary: "acme: 1 sent, 1 reply." }, ctx("ceo"));
    expect(jobs.filter((j) => j.type === "send_ceo_brief").map((j) => j.idempotencyKey)).toEqual([
      "ceo:brief:2026-11-10",
    ]);
    expect(await latestBrief(t.db, "2026-11-10")).toMatchObject({ summary: "acme: 1 sent, 1 reply." });
    const evs = await t.db.select().from(events).where(eq(events.type, "ceo.brief"));
    expect(evs[0]!.actor).toBe("naive:ceo");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AgentName } from "../../../contracts";
import { OUTRUN_CLIENT_ID } from "../../constants";
import { clientCandidates, clients, companies, prospects } from "../../db/schema";
import { createEmitter } from "../../events";
import { FakeMonid } from "../../fakes";
import { scoreClientFit } from "../../scoring/fit";
import { hunterQuery, parseHunterDiscover, runRefreshClientSources } from "../../sources/clientSources";
import { createTempDatabase, type TempDb } from "../../testing/db";
import type { ToolDef } from "../registry";
import type { ToolContext } from "../types";
import { checkDraft, getBrief, priceWords } from "./outreach";
import { fileProspect, listCandidates, saveResearch } from "./prospecting";

const now = new Date("2026-11-10T17:00:00Z");
const profile = {
  summary: "Acme Pay sells invoice-matching APIs to finance teams.",
  icp: {
    description: "B2B SaaS with a finance team",
    includeKeywords: ["invoicing", "accounts payable"],
    excludeKeywords: ["agency"],
    buyerRoles: ["CFO", "Head of Finance"],
    companySizes: ["11-50", "51-200"],
  },
  offer: {
    pitch: "A 20-minute demo of automated invoice matching.",
    callToActionUrl: "https://acme-pay.dev/demo",
    prices: [{ label: "Starter", amount: "$49/month" }],
  },
  allowedLinkHosts: ["docs.acme-pay.dev"],
  sender: { name: "Ada Lovelace", postalAddress: "1 Market St, San Francisco, CA 94105" },
  tone: "plain",
  sources: ["https://acme-pay.dev/"],
};

describe("a client's crew finds and writes from its own profile", () => {
  let t: TempDb;
  let monid: FakeMonid;
  let clientId: string;
  let prospectId: string;
  const deps = {
    settings: { discoveryDailyCap: 5, demo: false, sendDailyCap: 30 },
    enrich: async () => ({ facts: [], contacts: [], costUsd: 0 }),
  };
  const outreach = {
    appUrl: "https://outrun.example",
    settings: { sendDailyCap: 30, demo: false },
    mx: async () => true,
  };
  const ctx = (agent: AgentName, c = clientId): ToolContext => ({
    agent,
    clientId: c,
    requestId: "r",
    db: t.db,
    now: () => now,
    enqueue: async () => ({ jobId: "j" }),
    emit: createEmitter(t.db),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = <D extends ToolDef<any>>(def: D, input: unknown, c: ToolContext) =>
    def.handler(def.input.parse(input), c) as ReturnType<D["handler"]>;

  beforeAll(async () => {
    t = await createTempDatabase();
    monid = new FakeMonid();
    monid.hunter.set("invoicing", [
      { domain: "ledgerly.dev", organization: "Ledgerly" },
      { domain: "https://www.billflow.dev", organization: "Billflow" },
      { domain: "acme-pay.dev", organization: "Acme Pay itself" },
      { domain: "github.com", organization: "not a company domain" },
    ]);
    const [c] = await t.db
      .insert(clients)
      .values({
        slug: "acme-pay",
        name: "Acme Pay",
        domain: "acme-pay.dev",
        status: "active",
        dnsStatus: "verified",
        profileConfirmedAt: now,
        profile,
      })
      .returning();
    clientId = c!.id;
    // An Outrun candidate the client must never see.
    await t.db.insert(companies).values({ domain: "outrun-lead.dev", source: "fixture" });
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("builds Hunter's query from the ICP and parses its answer", () => {
    expect(hunterQuery(profile as never, 15)).toEqual({
      keywords: { include: ["invoicing", "accounts payable"], exclude: ["agency"], match: "any" },
      headcount: ["11-50", "51-200"],
      limit: 15,
    });
    expect(parseHunterDiscover({ data: [{ domain: "a.dev", organization: "A" }, { nope: 1 }] })).toEqual([
      { domain: "a.dev", name: "A" },
    ]);
    expect(parseHunterDiscover("garbage")).toEqual([]);
  });

  it("searches once per run, skipping the client itself and platform hosts", async () => {
    const out = await runRefreshClientSources(
      { db: t.db, emit: createEmitter(t.db), monid, settings: deps.settings },
      clientId,
    );
    expect(out).toMatchObject({ found: 2, added: 2, costUsd: 0 });
    expect(monid.runs.at(-1)!.endpoint).toBe("hunterio:/discover");
    const again = await runRefreshClientSources(
      { db: t.db, emit: createEmitter(t.db), monid, settings: deps.settings },
      clientId,
    );
    expect(again.added).toBe(0);
    expect(await t.db.select().from(clientCandidates)).toHaveLength(2);
  });

  it("doesn't search for a client that isn't active, or in demo mode", async () => {
    const [b] = await t.db
      .insert(clients)
      .values({ slug: "beta", name: "Beta", domain: "beta.dev" })
      .returning();
    const n = monid.runs.length;
    expect(
      (
        await runRefreshClientSources(
          { db: t.db, emit: createEmitter(t.db), monid, settings: deps.settings },
          b!.id,
        )
      ).skipped,
    ).toBe("the client is draft");
    expect(
      (
        await runRefreshClientSources(
          { db: t.db, emit: createEmitter(t.db), monid, settings: { ...deps.settings, demo: true } },
          clientId,
        )
      ).skipped,
    ).toBe("demo mode");
    expect(monid.runs).toHaveLength(n);
  });

  it("lists and files only the client's own candidates, with no scan or CRM sync", async () => {
    const { candidates } = await call(listCandidates(deps), {}, ctx("prospector"));
    expect(candidates.map((c) => c.domain).sort()).toEqual(["billflow.dev", "ledgerly.dev"]);
    const [outrunLead] = await t.db.select().from(companies).where(eq(companies.domain, "outrun-lead.dev"));
    await expect(
      call(fileProspect(deps), { companyId: outrunLead!.id, reason: "x" }, ctx("prospector")),
    ).rejects.toMatchObject({ code: "not_found" });

    const ledgerly = candidates.find((c) => c.domain === "ledgerly.dev")!;
    const jobs: string[] = [];
    const c = {
      ...ctx("prospector"),
      enqueue: async (j: { type: string }) => (jobs.push(j.type), { jobId: "j" }),
    };
    const filed = await call(
      fileProspect(deps),
      { companyId: ledgerly.companyId, reason: "invoicing API" },
      c as never,
    );
    expect(filed.status).toBe("filed");
    prospectId = filed.prospectId;
    expect(jobs).toEqual([]);
    const [co] = await t.db.select().from(companies).where(eq(companies.id, ledgerly.companyId));
    expect(co!.kind).toBe("candidate"); // still Outrun's to find, too
    expect((await call(listCandidates(deps), {}, ctx("prospector"))).candidates).toHaveLength(1);
    // Outrun's own list never shows the client's Hunter finds as Outrun's.
    const outrun = await call(listCandidates(deps), {}, ctx("prospector", OUTRUN_CLIENT_ID));
    expect(outrun.candidates.map((x) => x.domain)).toContain("outrun-lead.dev");
  });

  it("scores fit from the client's ICP", async () => {
    const out = await call(
      saveResearch,
      {
        prospectId,
        facts: [
          {
            key: "product",
            value: "Invoicing and accounts payable automation",
            sourceUrl: "https://ledgerly.dev/",
          },
          { key: "headcount", value: "40 employees", sourceUrl: "https://ledgerly.dev/about" },
        ],
        contacts: [
          { name: "Cy", role: "CFO", email: "cy@ledgerly.dev", sourceUrl: "https://ledgerly.dev/team" },
        ],
      },
      ctx("researcher"),
    );
    expect(out.fitScore).toBe(90);
    const excluded = scoreClientFit(profile.icp, {
      source: "hunter",
      summary: "A design agency",
      facts: [],
      contact: null,
    });
    expect(excluded.parts.map((p) => p.signal)).toContain("excluded");
  });

  it("briefs with the client's offer, and checks drafts against facts, prices and links", async () => {
    const brief = await call(getBrief(outreach), { prospectId }, ctx("sdr"));
    expect(brief).toMatchObject({ scoreUrl: null, offer: null, checks: [], client: { name: "Acme Pay" } });
    expect(brief.facts.map((f) => f.key)).toEqual(["product", "headcount"]);

    const draft = (body: string, cited: string[]) =>
      call(
        checkDraft(outreach),
        { prospectId, kind: "first", subject: "Invoice matching", body, citedCheckIds: cited },
        ctx("sdr"),
      );
    const good = await draft(
      "Saw Ledgerly automates accounts payable. Starter is $49 a month; a 20-minute demo: https://acme-pay.dev/demo — docs at https://docs.acme-pay.dev/start",
      ["product"],
    );
    expect(good).toMatchObject({ ok: true });
    const bad = await draft(
      "Only $19 today! https://evil.example/pay https://checkout.stripe.com/c/pay/cs_x",
      ["scan_llms_txt"],
    );
    expect(bad.ok).toBe(false);
    const reasons = (bad as { reasons: string[] }).reasons.join(" | ");
    expect(reasons).toContain("scan_llms_txt is not a fact saved for this prospect");
    expect(reasons).toContain("$19 is not a listed price; use only $49");
    expect(reasons).toContain("link to evil.example isn't allowed");
    expect(reasons).toContain("link to checkout.stripe.com isn't allowed");
  });

  it("another client can't see this client's prospect", async () => {
    const [b] = await t.db.select().from(clients).where(eq(clients.slug, "beta"));
    await expect(call(getBrief(outreach), { prospectId }, ctx("sdr", b!.id))).rejects.toMatchObject({
      code: "not_found",
    });
    await t.db
      .update(clients)
      .set({ status: "active", profileConfirmedAt: now, profile })
      .where(eq(clients.id, b!.id));
    await expect(call(getBrief(outreach), { prospectId }, ctx("sdr", b!.id))).rejects.toMatchObject({
      code: "not_found",
    });
    const mine = await t.db
      .select()
      .from(prospects)
      .where(and(eq(prospects.clientId, b!.id)));
    expect(mine).toHaveLength(0);
  });

  it("reads listed prices as numbers", () => {
    expect([...priceWords(["$49/month", "$1,200 a year"])].sort()).toEqual(["1,200", "1200", "49"]);
  });
});

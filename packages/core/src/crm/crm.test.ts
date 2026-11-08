import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, contacts, messages, prospects } from "../db/schema";
import { createEmitter } from "../events";
import { FakeHubSpot } from "../fakes/others";
import { createHubSpotClient } from "../integrations/hubspot";
import { createMonidClient } from "../integrations/monid";
import { createTempDatabase, type TempDb } from "../testing/db";
import { runSyncCrm } from "./sync";

type Rec = { method: string; url: string; body: unknown };
function recordFetch(replies: (r: Rec) => { status?: number; json?: unknown }) {
  const seen: Rec[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const r = {
      method: init.method ?? "GET",
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(r);
    const out = replies(r);
    return new Response(out.json === undefined ? "" : JSON.stringify(out.json), {
      status: out.status ?? 200,
    });
  });
  return seen;
}

describe("HubSpot client (SH-4), recorded responses", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("upserts on outrun_id, associates, and maps our stage", async () => {
    const seen = recordFetch((r) =>
      r.url.includes("batch/upsert")
        ? { json: { status: "COMPLETE", results: [{ id: "hs_1", properties: {} }] } }
        : { json: {} },
    );
    const hs = createHubSpotClient("pat-test");
    await hs.upsertDeal({
      outrunId: "p-1",
      name: "Acme: Outrun",
      stage: "checkout_sent",
      companyId: "hs_co",
    });
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "https://api.hubapi.com/crm/v3/objects/deals/batch/upsert",
      body: {
        inputs: [
          {
            idProperty: "outrun_id",
            id: "p-1",
            properties: {
              dealstage: "contractsent",
              outrun_stage: "checkout_sent",
              outrun_id: "p-1",
              pipeline: "default",
            },
          },
        ],
      },
    });
    expect(seen[1]).toMatchObject({
      method: "PUT",
      url: "https://api.hubapi.com/crm/v4/objects/deals/hs_1/associations/default/companies/hs_co",
    });
  });

  it("a 429 is a retryable error; a 400 is not", async () => {
    recordFetch(() => ({ status: 429, json: { message: "rate limit" } }));
    await expect(
      createHubSpotClient("t").upsertCompany({ outrunId: "c", domain: "a.dev", name: "A" }),
    ).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
    recordFetch(() => ({ status: 400, json: { message: "bad" } }));
    await expect(
      createHubSpotClient("t").upsertCompany({ outrunId: "c", domain: "a.dev", name: "A" }),
    ).rejects.toMatchObject({
      code: "upstream_error",
      retryable: false,
    });
  });
});

describe("Monid client (SH-3), recorded responses", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts a run, polls until COMPLETED, and returns the provider data and cost", async () => {
    let polls = 0;
    const seen = recordFetch((r) => {
      if (r.method === "POST") return { json: { runId: "run_1", status: "READY" } };
      polls++;
      return polls < 2
        ? { json: { runId: "run_1", status: "RUNNING" } }
        : {
            json: {
              runId: "run_1",
              status: "COMPLETED",
              providerResponse: { status: 200, data: { data: { uuid: "x" } } },
              cost: { value: 0.2 },
            },
          };
    });
    const monid = createMonidClient("monid_test_x", { sleep: async () => {} });
    const out = await monid.run("akta:/v1/company/enrichment", {
      queryParams: { company: "https://acme.dev", sections: ["firmographic"] },
    });
    expect(out).toEqual({ data: { data: { uuid: "x" } }, costUsd: 0.2 });
    expect(seen[0]).toMatchObject({
      url: "https://api.monid.ai/v1/run",
      body: { provider: "akta", endpoint: "/v1/company/enrichment" },
    });
    expect(seen.at(-1)!.url).toBe("https://api.monid.ai/v1/runs/run_1");
  });

  it("a provider 404 is an empty answer, as the live API returns it (HTTP 404 with the run)", async () => {
    recordFetch(() => ({
      status: 404,
      json: { runId: "r", status: "COMPLETED", providerResponse: { status: 404 }, cost: { value: 0 } },
    }));
    await expect(
      createMonidClient("k", { sleep: async () => {} }).run("akta:/v1/company/enrichment", {}),
    ).resolves.toEqual({ data: null, costUsd: 0 });
    // An unknown endpoint or a bad key is still an error.
    recordFetch(() => ({ status: 401, json: { error: "bad key" } }));
    await expect(createMonidClient("k", { sleep: async () => {} }).run("akta:/x", {})).rejects.toThrow(
      "monid: HTTP 401",
    );
  });

  it("a provider error or a blocked run is an error, not data", async () => {
    recordFetch(() => ({
      json: { runId: "r", status: "COMPLETED", providerResponse: { status: 422, data: { error: "bad" } } },
    }));
    await expect(createMonidClient("k", { sleep: async () => {} }).run("akta:/x", {})).rejects.toThrow(
      /provider HTTP 422/,
    );
    recordFetch(() => ({ json: { runId: "r", status: "BLOCKED" } }));
    await expect(createMonidClient("k", { sleep: async () => {} }).run("akta:/x", {})).rejects.toThrow(
      /BLOCKED/,
    );
  });
});

describe("sync_crm (SH-4)", () => {
  let t: TempDb;
  beforeAll(async () => {
    t = await createTempDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("mirrors company, contact, deal and emails; a rerun creates no duplicates", async () => {
    const [co] = await t.db
      .insert(companies)
      .values({ domain: "crm.dev", name: "Crm", source: "fixture", kind: "prospect" })
      .returning();
    const [c] = await t.db
      .insert(contacts)
      .values({ companyId: co!.id, name: "Ada Lovelace", email: "ada@crm.dev", sourceUrl: "https://crm.dev" })
      .returning();
    const [p] = await t.db
      .insert(prospects)
      .values({ companyId: co!.id, contactId: c!.id, stage: "contacted" })
      .returning();
    await t.db.insert(messages).values([
      {
        prospectId: p!.id,
        direction: "outbound",
        kind: "first",
        status: "sent",
        subject: "Hi",
        body: "b",
        sentAt: new Date(),
      },
      {
        prospectId: p!.id,
        direction: "outbound",
        kind: "followup",
        status: "checked",
        subject: "Draft",
        body: "b",
      },
    ]);
    const hubspot = new FakeHubSpot();
    const deps = { db: t.db, emit: createEmitter(t.db), hubspot };
    expect(await runSyncCrm(deps, p!.id)).toEqual({ synced: true, emailsLogged: 1 });
    expect(await runSyncCrm(deps, p!.id)).toEqual({ synced: true, emailsLogged: 0 });
    expect([...hubspot.records.keys()].sort()).toEqual([
      `company:${co!.id}`,
      `contact:${c!.id}`,
      `deal:${p!.id}`,
    ]);
    expect(hubspot.emails).toHaveLength(1);
    expect(hubspot.records.get(`deal:${p!.id}`)!.data).toMatchObject({ stage: "contacted" });
  });
});

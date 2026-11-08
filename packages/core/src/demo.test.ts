import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { assertDemoDiscovery, assertDemoRecipient } from "./demo";
import { companies, contacts, prospects } from "./db/schema";
import { recordWebhookOnce } from "./events";
import { checkHealth } from "./health";
import { demoInboxes, seedDemo } from "./seed";
import { createTempDatabase, type TempDb } from "./testing/db";

describe("demo mode", () => {
  let t: TempDb;
  beforeAll(async () => {
    t = await createTempDatabase();
    await seedDemo(t.db, {
      domain: "Teammate.dev",
      name: "Teammate",
      contactName: "Sam",
      inbox: "Sam@Teammate.dev",
    });
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("seeds idempotently and records the demo inbox", async () => {
    const a = await seedDemo(t.db, {
      domain: "teammate.dev",
      name: "Teammate",
      contactName: "Sam",
      inbox: "sam@teammate.dev",
    });
    const b = await seedDemo(t.db, {
      domain: "teammate.dev",
      name: "Teammate",
      contactName: "Sam",
      inbox: "sam@teammate.dev",
    });
    expect(a).toEqual(b);
    expect(await demoInboxes(t.db)).toEqual(["sam@teammate.dev"]);
  });

  it("allows email only to the seeded inbox while in demo", async () => {
    await expect(assertDemoRecipient(t.db, { demo: true }, "SAM@teammate.dev ")).resolves.toBeUndefined();
    await expect(assertDemoRecipient(t.db, { demo: true }, "ceo@bigco.com")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(assertDemoRecipient(t.db, { demo: false }, "ceo@bigco.com")).resolves.toBeUndefined();
  });

  it("ignores a prospect an agent filed with reason demo; only the seed's flag counts", async () => {
    const [c] = await t.db
      .insert(companies)
      .values({ domain: "bigco.com", source: "fixture", kind: "prospect" })
      .returning();
    const [ct] = await t.db
      .insert(contacts)
      .values({
        companyId: c!.id,
        name: "CEO",
        role: "CEO",
        email: "ceo@bigco.com",
        sourceUrl: "https://bigco.com",
      })
      .returning();
    await t.db.insert(prospects).values({ companyId: c!.id, contactId: ct!.id, filedReason: "demo" });
    await expect(assertDemoRecipient(t.db, { demo: true }, "ceo@bigco.com")).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("refuses a demo inbox that belongs to another company", async () => {
    await expect(
      seedDemo(t.db, { domain: "other.dev", name: "Other", contactName: "X", inbox: "ceo@bigco.com" }),
    ).rejects.toThrow(/another company/);
  });

  it("allows discovery only from fixtures while in demo", () => {
    expect(() => assertDemoDiscovery({ demo: true }, "monid")).toThrow(/fixtures/);
    expect(() => assertDemoDiscovery({ demo: true }, "fixture")).not.toThrow();
    expect(() => assertDemoDiscovery({ demo: false }, "monid")).not.toThrow();
  });

  it("refuses a live Stripe key in demo mode", () => {
    const live = ["sk", "live", "x".repeat(24)].join("_");
    expect(() => loadConfig({ OUTRUN_DEMO: "true", STRIPE_SECRET_KEY: live })).toThrow(/test-mode/);
    expect(() => loadConfig({ OUTRUN_DEMO: "false", STRIPE_SECRET_KEY: live })).not.toThrow();
  });
});

describe("health", () => {
  let t: TempDb;
  beforeAll(async () => {
    t = await createTempDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("reports db and migrations, and a missing pg-boss schema as not ok", async () => {
    const h = await checkHealth({ db: t.db, demo: true, fakes: ["stripe", "hubspot"] });
    expect(h.checks.db).toBe(true);
    expect(h.checks.migrations).toBe(true);
    expect(h.fakes).toEqual(["hubspot", "stripe"]);
    expect(h.ok).toBe(h.checks.queue);
    expect(h.lastNaiveWebhookAt).toBeNull();
    await recordWebhookOnce(t.db, "naive", "evt_health");
    expect((await checkHealth({ db: t.db, demo: true, fakes: [] })).lastNaiveWebhookAt).not.toBeNull();
  });
});

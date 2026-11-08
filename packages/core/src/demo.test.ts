import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { assertDemoDiscovery, assertDemoRecipient } from "./demo";
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
  });
});

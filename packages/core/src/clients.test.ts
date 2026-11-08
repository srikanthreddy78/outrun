import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { slugify } from "../contracts";
import { addClient, confirmProfile, saveDraftProfile, setPaused, startProfiling } from "./clients";
import { clientUsers, clients } from "./db/schema";
import { createEmitter } from "./events";
import { createTempDatabase, type TempDb } from "./testing/db";

const profile = (over: Record<string, unknown> = {}) => ({
  summary: "Acme sells invoice APIs to finance teams.",
  icp: {
    description: "B2B SaaS companies with a finance team of 5+",
    includeKeywords: ["invoicing", "accounts payable"],
    buyerRoles: ["CFO", "Head of Finance"],
  },
  offer: {
    pitch: "A 20-minute demo of automated invoice matching.",
    callToActionUrl: "https://acme-pay.dev/demo",
    prices: [{ label: "Starter", amount: "$49/month" }],
  },
  sender: { name: "Ada Lovelace", title: "Founder", postalAddress: "1 Market St, San Francisco, CA 94105" },
  sources: ["https://acme-pay.dev/", "https://acme-pay.dev/pricing"],
  ...over,
});

describe("onboarding a client", () => {
  let t: TempDb;
  let jobs: { idempotencyKey: string; payload: Record<string, unknown> }[];
  const deps = () => ({
    db: t.db,
    emit: createEmitter(t.db),
    enqueue: async (j: { idempotencyKey: string; payload: Record<string, unknown> }) => {
      jobs.push(j);
      return { jobId: "j" };
    },
  });
  beforeAll(async () => {
    t = await createTempDatabase();
    jobs = [];
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("slugifies names for agent names", () => {
    expect(slugify("Acme Labs, Inc.")).toBe("acme-labs-inc");
    expect(slugify("  Blue Sky  ")).toBe("blue-sky");
  });

  it("goes draft → profiling → awaiting_confirmation → email_setup, with the owner confirming", async () => {
    const c = await addClient(
      deps(),
      { name: "Acme Pay", domain: "acme-pay.dev", approverEmails: ["Ada@Acme-Pay.dev"] },
      "user:owner@outrun.dev",
    );
    expect(c).toMatchObject({ slug: "acme-pay", status: "draft" });
    expect(await t.db.select().from(clientUsers).where(eq(clientUsers.clientId, c.id))).toMatchObject([
      { email: "ada@acme-pay.dev", role: "approver" },
    ]);

    await startProfiling(deps(), c.id, "user:owner@outrun.dev");
    await startProfiling(deps(), c.id, "user:owner@outrun.dev");
    expect(jobs.map((j) => j.idempotencyKey)).toEqual([`onboard:${c.id}:profile`, `onboard:${c.id}:profile`]);
    expect(jobs[0]!.payload).toMatchObject({ agent: "researcher", clientId: c.id });

    expect(await saveDraftProfile(deps(), c.id, profile(), "naive:acme-pay-researcher")).toEqual({
      status: "awaiting_confirmation",
    });
    expect(
      await confirmProfile(deps(), c.id, profile({ tone: "warm, brief" }), "user:owner@outrun.dev"),
    ).toEqual({
      status: "email_setup",
    });
    const [row] = await t.db.select().from(clients).where(eq(clients.id, c.id));
    expect(row).toMatchObject({ confirmedBy: "user:owner@outrun.dev", profile: { tone: "warm, brief" } });
    // A later draft from the agent never overwrites what the owner confirmed.
    await saveDraftProfile(deps(), c.id, profile({ tone: "shouty" }), "naive:acme-pay-researcher");
    const [again] = await t.db.select().from(clients).where(eq(clients.id, c.id));
    expect((again!.profile as { tone: string }).tone).toBe("warm, brief");
  });

  it("refuses a draft that doesn't cite the client's own site or links elsewhere", async () => {
    const c = await addClient(deps(), { name: "Beta", domain: "beta-co.dev" }, "user:owner@outrun.dev");
    await expect(
      saveDraftProfile(
        deps(),
        c.id,
        profile({ sources: ["https://elsewhere.dev/"] }),
        "naive:beta-researcher",
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      saveDraftProfile(
        deps(),
        c.id,
        profile({
          sources: ["https://beta-co.dev/"],
          offer: { pitch: "x", callToActionUrl: "https://evil.example/pay", prices: [] },
        }),
        "naive:beta-researcher",
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("refuses a duplicate slug or domain, and Outrun's slug", async () => {
    await expect(
      addClient(deps(), { name: "Acme Pay", domain: "other.dev" }, "user:o@x.dev"),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      addClient(deps(), { name: "Other", domain: "acme-pay.dev" }, "user:o@x.dev"),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      addClient(deps(), { name: "Outrun", domain: "x.dev" }, "user:o@x.dev"),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("pauses and resumes to where it was", async () => {
    const [c] = await t.db.select().from(clients).where(eq(clients.slug, "acme-pay"));
    expect(await setPaused(deps(), c!.id, true, "user:o@x.dev")).toEqual({ status: "paused" });
    expect(await setPaused(deps(), c!.id, false, "user:o@x.dev")).toEqual({ status: "email_setup" });
  });
});

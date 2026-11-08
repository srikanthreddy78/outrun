import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { eq } from "drizzle-orm";
import { auditCrawls, orders, reports } from "../db/schema";
import { createEmitter } from "../events";
import { FakeApify } from "../fakes";
import { createTempDatabase, TEST_DB_URL, type TempDb } from "../testing/db";
import { handleApifyWebhook } from "../webhooks/apify";
import { getPublicCrawlPages, savePaidAudit, startPublicCrawl } from "./crawl";

describe.skipIf(!TEST_DB_URL)("paid public audit flow", () => {
  let temp: TempDb;
  const orderId = uuidv7();
  const apify = new FakeApify([
    { url: "https://demo.outrun.dev/docs?token=private", title: "Docs", text: "Read-only docs" },
    { url: "https://other.example/", title: "Other", text: "Outside site" },
  ]);
  const jobs: Array<{ type: string; idempotencyKey: string; payload: Record<string, unknown> }> = [];

  beforeAll(async () => {
    temp = await createTempDatabase();
    await temp.db.insert(orders).values({
      id: orderId,
      domain: "demo.outrun.dev",
      contactEmail: "buyer@demo.outrun.dev",
      product: "auditKit",
      state: "auditing",
      amountUsd: "499.00",
    });
  });
  afterAll(async () => {
    await temp?.drop();
  });

  it("starts one capped public crawl, accepts one authenticated completion, and saves cited findings", async () => {
    const deps = {
      db: temp.db,
      apify,
      appUrl: "https://outrun.test",
      emit: createEmitter(temp.db),
      preflight: async () => {},
    };
    const [first, second] = await Promise.all([
      startPublicCrawl(deps, orderId),
      startPublicCrawl(deps, orderId),
    ]);
    expect([first.status, second.status].sort()).toEqual(["already_running", "started"]);
    expect(apify.runs).toHaveLength(1);
    expect(apify.runs[0]?.input.maxCrawlPages).toBe(50);
    const runId = first.status === "started" ? first.crawlId : second.crawlId;
    const rawBody = JSON.stringify({
      eventType: "ACTOR.RUN.SUCCEEDED",
      resource: { id: runId, status: "SUCCEEDED", defaultDatasetId: `ds_${runId}`, usageTotalUsd: 0.2 },
    });
    const queue = {
      enqueue: async (job: { type: string; idempotencyKey: string; payload: Record<string, unknown> }) => {
        jobs.push(job);
        return { jobId: job.idempotencyKey };
      },
    };
    expect(
      (await handleApifyWebhook({ rawBody, header: "wrong", secret: "secret", db: temp, queue })).status,
    ).toBe(401);
    expect(
      (await handleApifyWebhook({ rawBody, header: "secret", secret: "secret", db: temp, queue })).body
        .duplicate,
    ).toBe(false);
    expect(
      (await handleApifyWebhook({ rawBody, header: "secret", secret: "secret", db: temp, queue })).body
        .duplicate,
    ).toBe(true);
    expect(jobs.filter((job) => job.type === "handle_apify_event")).toHaveLength(1);

    await temp.db.update(auditCrawls).set({ status: "succeeded" }).where(eq(auditCrawls.orderId, orderId));
    const page = await getPublicCrawlPages(deps, { orderId, limit: 10 });
    expect(page.pages).toHaveLength(1);
    expect(page.pages[0]?.url).toBe("https://demo.outrun.dev/docs");
    expect(page.pages[0]?.content).toEqual({ untrusted: true, text: "Read-only docs" });
    const input = {
      orderId,
      summary: "Documentation needs examples.",
      findings: [
        {
          title: "Missing examples",
          severity: "medium" as const,
          detail: "Add examples",
          pageUrl: "https://demo.outrun.dev/docs?token=private",
        },
      ],
    };
    const save = { db: temp.db, enqueue: queue.enqueue, emit: deps.emit };
    const report = await savePaidAudit(save, input);
    expect((await savePaidAudit(save, input)).reportId).toBe(report.reportId);
    const [stored] = await temp.db.select().from(reports).where(eq(reports.id, report.reportId));
    expect(JSON.stringify(stored?.audit)).not.toContain("token=private");
    expect(jobs.filter((job) => job.type === "build_kit").map((job) => job.idempotencyKey)).toEqual([
      `build_kit:${orderId}`,
      `build_kit:${orderId}`,
    ]);
  });
});

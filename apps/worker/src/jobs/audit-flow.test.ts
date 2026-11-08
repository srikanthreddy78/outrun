import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, orders, reports } from "@outrun/core/db";
import { createEmitter } from "@outrun/core/events";
import { createFakes } from "@outrun/core/fakes";
import { startPublicCrawl, getPublicCrawlPages, savePaidAudit } from "@outrun/core/audit/crawl";
import { handleApifyWebhook } from "@outrun/core/webhooks/apify";
import { buildKit } from "@outrun/core/kit/build";
import { deliverReport, getDeliveredReport } from "@outrun/core/report/delivery";
import { downloadAsset, renderReportPage } from "@outrun/core/audit/pipeline";
import type { Llm } from "@outrun/core/llm";
import type { Queue } from "@outrun/core/queue";
import { createTempDatabase, TEST_DB_URL, type TempDb } from "../../../../packages/core/src/testing/db";
import { auditHandlers } from "./audit";

describe.skipIf(!TEST_DB_URL)("paid order through fake audit delivery", () => {
  let temp: TempDb;
  beforeAll(async () => {
    temp = await createTempDatabase();
  });
  afterAll(async () => {
    await temp?.drop();
  });

  it("delivers every Kit asset and wakes the auditor once for a duplicate crawl webhook", async () => {
    const orderId = randomUUID();
    const fakes = createFakes();
    const emit = createEmitter(temp.db);
    const enqueued: string[] = [];
    const enqueue = (async (job: { type: string }) => {
      enqueued.push(job.type);
      return { jobId: `fake-${job.type}` };
    }) as Queue["enqueue"];
    await temp.db.insert(orders).values({
      id: orderId,
      domain: "demo.outrun.dev",
      contactEmail: "buyer@demo.outrun.dev",
      product: "auditKit",
      state: "paid",
      amountUsd: "499.00",
    });

    const handlers = auditHandlers({ db: temp, emit, integrations: fakes });
    await handlers.start_audit!({ payload: { orderId } } as never, {} as never);
    const crawl = await startPublicCrawl(
      { db: temp.db, apify: fakes.apify, appUrl: "https://outrun.test", emit, preflight: async () => {} },
      orderId,
    );
    expect(crawl.status).toBe("started");
    const rawBody = JSON.stringify({
      eventType: "ACTOR.RUN.SUCCEEDED",
      resource: {
        id: crawl.crawlId,
        status: "SUCCEEDED",
        defaultDatasetId: `ds_${crawl.crawlId}`,
        usageTotalUsd: 0.2,
      },
    });
    const webhook = { rawBody, header: "secret", secret: "secret", db: temp, queue: { enqueue } };
    expect((await handleApifyWebhook(webhook)).body.duplicate).toBe(false);
    expect((await handleApifyWebhook(webhook)).body.duplicate).toBe(true);
    expect(enqueued.filter((type) => type === "handle_apify_event")).toHaveLength(1);
    const eventPayload = {
      runId: crawl.crawlId,
      status: "SUCCEEDED",
      datasetId: `ds_${crawl.crawlId}`,
      costUsd: 0.2,
    };
    await handlers.handle_apify_event!({ payload: eventPayload } as never, {} as never);
    await handlers.handle_apify_event!({ payload: eventPayload } as never, {} as never);
    const auditor = [...fakes.naive.sessions.values()].find((session) => session.agent === "auditor");
    expect(auditor?.messages.filter((message) => message.includes("Public crawl"))).toHaveLength(1);
    const pages = await getPublicCrawlPages({ db: temp.db, apify: fakes.apify }, { orderId, limit: 10 });
    expect(pages.pages.length).toBeGreaterThan(0);

    const saved = await savePaidAudit(
      { db: temp.db, enqueue, emit },
      {
        orderId,
        summary: "The docs need a clearer quickstart.",
        findings: [
          {
            title: "Quickstart examples",
            severity: "medium",
            detail: "Add a runnable example",
            pageUrl: "https://demo.outrun.dev/docs",
          },
        ],
      },
    );
    expect(enqueued).toContain("build_kit");
    const llm: Llm = async (call) => ({
      data: call.schema.parse({
        content:
          call.purpose === "kit.server_json"
            ? JSON.stringify({
                name: "dev.outrun/demo",
                description: "Improve docs [f1]",
                version: "1.0.0",
                remotes: [{ type: "streamable-http", url: "https://demo.outrun.dev/mcp" }],
              })
            : "# Draft\nImprove the quickstart [f1]",
      }),
      costUsd: 0.1,
      model: "fake",
      provider: "fake",
      fellBack: false,
    });
    await buildKit({ db: temp.db, llm, discover: fakes.discover, enqueue, emit }, orderId, saved.reportId);
    expect(enqueued).toContain("deliver_report");
    await deliverReport(
      {
        db: temp.db,
        appUrl: "https://outrun.test",
        sendTransactional: fakes.sendTransactional,
        hubspot: fakes.hubspot,
        emit,
      },
      orderId,
      saved.reportId,
    );
    const [order] = await temp.db.select().from(orders).where(eq(orders.id, orderId));
    const [reportRow] = await temp.db.select().from(reports).where(eq(reports.id, saved.reportId));
    const delivered = await getDeliveredReport(temp.db, reportRow!.accessToken);
    expect(order?.state).toBe("delivered");
    expect(fakes.agentmail.transactional).toHaveLength(1);
    expect(renderReportPage(delivered!)).toContain("noindex,nofollow");
    const assets = delivered!.assets;
    expect(assets).toHaveLength(9);
    for (const asset of assets) expect(downloadAsset(delivered!, asset.name).status).toBe(200);
  });
});

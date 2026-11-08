import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "@outrun/core/db";
import { auditCrawls, orders } from "@outrun/core/db";
import { createEmitter } from "@outrun/core/events";
import { createFakes } from "@outrun/core/fakes";
import { createTempDatabase, TEST_DB_URL, type TempDb } from "@outrun/core/testing/db";
import type { JobEnvelope } from "@outrun/core/contracts";
import { auditHandlers } from "./audit";

describe.skipIf(!TEST_DB_URL)("auditor worker handoff", () => {
  let temp: TempDb;
  const orderId = randomUUID();
  const integrations = createFakes();
  beforeAll(async () => {
    temp = await createTempDatabase();
    await temp.db.insert(orders).values({
      id: orderId,
      domain: "demo.outrun.dev",
      contactEmail: "buyer@demo.outrun.dev",
      product: "growth",
      state: "paid",
      amountUsd: "1500.00",
    });
  });
  afterAll(async () => {
    await temp?.drop();
  });

  it("starts the auditor only for a paid order and wakes the same session once when the crawl finishes", async () => {
    const handlers = auditHandlers({ db: temp, emit: createEmitter(temp.db), integrations });
    const start = handlers.start_audit!;
    const env = (type: "start_audit" | "handle_apify_event", payload: Record<string, unknown>, key: string) =>
      ({
        type,
        version: 1,
        payload,
        idempotencyKey: key,
        traceId: "test",
      }) as JobEnvelope;
    await start(env("start_audit", { orderId }, `start_audit:${orderId}`), { jobId: "j1", attempt: 1 });
    const [order] = await temp.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order?.state).toBe("auditing");
    expect(integrations.naive.sessions.size).toBe(1);
    const [session] = [...integrations.naive.sessions.values()];
    await temp.db
      .insert(auditCrawls)
      .values({ orderId, runId: "run123", datasetId: "dataset123", status: "running" });
    const complete = env(
      "handle_apify_event",
      { runId: "run123", status: "SUCCEEDED", datasetId: "dataset123", costUsd: 0.2 },
      "apify:run123:SUCCEEDED",
    );
    await handlers.handle_apify_event!(complete, { jobId: "j2", attempt: 1 });
    await handlers.handle_apify_event!(complete, { jobId: "j2", attempt: 2 });
    expect(integrations.naive.sessions.size).toBe(1);
    expect(session?.messages).toHaveLength(2);
    const [crawl] = await temp.db.select().from(auditCrawls).where(eq(auditCrawls.orderId, orderId));
    expect(crawl?.status).toBe("succeeded");
    expect(crawl?.costUsd).toBe("0.200000");
  });
});

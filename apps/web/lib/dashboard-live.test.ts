import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { companies, events, orders, prospects, scans, agentSessions } from "@outrun/core/db";
import { createTempDatabase, TEST_DB_URL, type TempDb } from "../../../packages/core/src/testing/db";

const { runtimeMock } = vi.hoisted(() => ({ runtimeMock: vi.fn() }));
vi.mock("./runtime", () => ({ getRuntime: runtimeMock }));
vi.mock("./replay-dead-job", () => ({ replayDeadJob: vi.fn() }));

import { loadDashboardSnapshot } from "./dashboard-live";
import LedgerPage from "../app/dashboard/ledger/page";
import OrdersPage from "../app/dashboard/orders/page";
import AgentsPage from "../app/dashboard/agents/page";
import HealthPage from "../app/dashboard/health/page";

describe.skipIf(!TEST_DB_URL)("seeded Ops Ledger page", () => {
  let temp: TempDb;
  beforeAll(async () => {
    temp = await createTempDatabase();
    runtimeMock.mockResolvedValue({ db: temp, config: { settings: { demo: true } }, fakes: ["naive"] });
    const [company] = await temp.db
      .insert(companies)
      .values({ domain: "example.com", source: "fixture" })
      .returning();
    await temp.db.insert(prospects).values({ companyId: company!.id });
    await temp.db
      .insert(scans)
      .values({ domain: "example.com", version: 1, scannerVersion: "fixture", score: 80, checks: [] });
    await temp.db.insert(orders).values({
      domain: "example.com",
      contactEmail: "buyer@example.com",
      product: "auditKit",
      state: "delivered",
      amountUsd: "499.00",
      deliveredAt: new Date(),
    });
    await temp.db.insert(events).values([
      {
        actor: "provider:apify",
        type: "crawl.completed",
        entityType: "order",
        entityId: "order-1",
        costUsd: "0.200000",
      },
      { actor: "worker", type: "kit.built", entityType: "order", entityId: "order-1", costUsd: "0.800000" },
      {
        actor: "provider:monid",
        type: "prospect.enriched",
        entityType: "company",
        entityId: "company-1",
        costUsd: "1.000000",
      },
      {
        actor: "provider:naive",
        type: "webhook.received",
        entityType: "webhook",
        entityId: "naive:seeded-delivery",
      },
    ]);
    await temp.db.insert(agentSessions).values({
      agent: "auditor",
      entityType: "order",
      entityId: "order-1",
      idempotencyKey: "seeded-auditor",
      status: "terminated",
      spendUsd: "0.500000",
    });
  });
  afterAll(async () => {
    await temp?.drop();
  });

  it("renders persisted funnel counts and hand-computed cost", async () => {
    const snapshot = await loadDashboardSnapshot();
    expect(snapshot.summary).toMatchObject({
      candidates: 1,
      scanned: 1,
      paidOrders: 1,
      deliveredAudits: 1,
      revenueUsd: 499,
      costsUsd: 2.5,
      costPerDeliveredAuditUsd: 2.5,
    });
    vi.stubGlobal("React", React);
    const html = renderToStaticMarkup(await LedgerPage());
    expect(html).toContain("Candidates 1");
    expect(html).toContain("Revenue $499.00");
    expect(html).toContain("Cost per delivered audit $2.50");
    expect(renderToStaticMarkup(await OrdersPage())).toContain("example.com");
    expect(renderToStaticMarkup(await AgentsPage())).toContain("$0.5000");
    expect(renderToStaticMarkup(await HealthPage())).toContain("Database: ready");
    expect(snapshot.health.lastNaiveWebhookAt).not.toBeNull();
    vi.unstubAllGlobals();
  });
});

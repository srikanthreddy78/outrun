import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { eq } from "drizzle-orm";
import { downloadAsset, renderReportPage } from "../audit/pipeline";
import { companies, orders, prospects, reports } from "../db/schema";
import { createEmitter } from "../events";
import { FakeAgentMail, FakeHubSpot } from "../fakes";
import { createTempDatabase, TEST_DB_URL } from "../testing/db";
import { deliverReport, getDeliveredReport } from "./delivery";

describe.skipIf(!TEST_DB_URL)("report delivery", () => {
  it("sends once, mirrors the Delivered deal, and exposes the private report and assets", async () => {
    const temp = await createTempDatabase();
    try {
      const [company] = await temp.db
        .insert(companies)
        .values({
          domain: "example.com",
          name: "Example",
          source: "fixture",
        })
        .returning();
      const [prospect] = await temp.db.insert(prospects).values({ companyId: company!.id }).returning();
      const orderId = uuidv7();
      const reportId = uuidv7();
      const token = randomBytes(32).toString("base64url");
      await temp.db.insert(orders).values({
        id: orderId,
        prospectId: prospect!.id,
        domain: "example.com",
        contactEmail: "buyer@example.com",
        product: "auditKit",
        state: "auditing",
        amountUsd: "499.00",
      });
      await temp.db.insert(reports).values({
        id: reportId,
        orderId,
        accessToken: token,
        audit: {
          summary: "Docs need examples",
          crawlRunId: "run1",
          findings: [
            {
              id: "f1",
              title: "Docs",
              detail: "Add examples",
              evidence: { sourceUrl: "https://example.com/docs" },
            },
          ],
        },
        kit: {
          assets: Array.from({ length: 9 }, (_, i) => ({
            name: i ? `asset-${i}.md` : "llms.txt",
            content: "# Example [f1]",
            mediaType: "text/markdown",
          })),
          costUsd: 0.8,
          completedAt: new Date().toISOString(),
        },
      });
      const mail = new FakeAgentMail();
      const hubspot = new FakeHubSpot();
      const deps = {
        db: temp.db,
        appUrl: "https://outrun.test",
        sendTransactional: mail.sendTransactional,
        hubspot,
        emit: createEmitter(temp.db),
      };
      expect(await getDeliveredReport(temp.db, token)).toBeNull();
      await deliverReport(deps, orderId, reportId);
      await deliverReport(deps, orderId, reportId);
      const [order] = await temp.db.select().from(orders).where(eq(orders.id, orderId));
      const delivered = await getDeliveredReport(temp.db, token);
      expect(order?.state).toBe("delivered");
      expect(mail.transactional).toHaveLength(1);
      expect(mail.transactional[0]?.text).toContain(`/report/${token}`);
      expect(hubspot.records.get(`deal:${orderId}`)?.data).toMatchObject({ stage: "Delivered" });
      const html = renderReportPage(delivered!);
      expect(html).toContain("noindex,nofollow");
      expect(html).toContain("Docs need examples");
      expect(html).toContain("https://example.com/docs");
      expect(downloadAsset(delivered!, "llms.txt").status).toBe(200);
      expect(await getDeliveredReport(temp.db, "invalid")).toBeNull();
    } finally {
      await temp.drop();
    }
  });
});

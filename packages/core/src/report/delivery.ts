import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { companies, orders, prospects, reports, auditCrawls } from "../db/schema";
import { AppError } from "../errors";
import type { Emit } from "../events";
import type { HubSpotClient, SendTransactionalFn } from "../integrations/types";
import type { Report } from "../audit/pipeline";

const StoredAudit = z.object({
  summary: z.string().optional(),
  findings: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      detail: z.string(),
      evidence: z.object({ checkId: z.string().optional(), sourceUrl: z.string().optional() }),
    }),
  ),
  crawlRunId: z.string(),
});
const StoredKit = z.object({
  assets: z.array(z.object({ name: z.string(), content: z.string(), mediaType: z.string() })),
  costUsd: z.number().nonnegative(),
  completedAt: z.string(),
});
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export async function getDeliveredReport(db: Db, token: string): Promise<Report | null> {
  if (!TOKEN.test(token)) return null;
  const [report] = await db.select().from(reports).where(eq(reports.accessToken, token));
  if (!report) return null;
  const [order] = await db.select().from(orders).where(eq(orders.id, report.orderId));
  if (!order || order.state !== "delivered" || !order.deliveredAt || order.product === "freeScan")
    return null;
  const audit = StoredAudit.safeParse(report.audit);
  const kit = StoredKit.safeParse(report.kit);
  if (!audit.success || !kit.success) return null;
  const [crawl] = await db
    .select({ costUsd: auditCrawls.costUsd })
    .from(auditCrawls)
    .where(eq(auditCrawls.orderId, order.id));
  return {
    orderId: order.id,
    domain: order.domain,
    offer: order.product,
    token,
    audit: {
      orderId: order.id,
      domain: order.domain,
      summary: audit.data.summary,
      findings: audit.data.findings,
      crawlRunId: audit.data.crawlRunId,
    },
    assets: kit.data.assets,
    totalCostUsd: kit.data.costUsd + Number(crawl?.costUsd ?? 0),
    deliveredAt: order.deliveredAt.toISOString(),
  };
}

export async function deliverReport(
  deps: {
    db: Db;
    appUrl: string;
    sendTransactional: SendTransactionalFn;
    hubspot: HubSpotClient;
    emit: Emit;
  },
  orderId: string,
  reportId: string,
): Promise<void> {
  const [order] = await deps.db.select().from(orders).where(eq(orders.id, orderId));
  const [report] = await deps.db
    .select()
    .from(reports)
    .where(and(eq(reports.id, reportId), eq(reports.orderId, orderId)));
  if (!order || !report) throw new AppError("not_found", "audit report not found");
  if (order.state === "delivered") return;
  if (order.state !== "auditing") throw new AppError("conflict", "order is not auditing");
  const kit = StoredKit.safeParse(report.kit);
  if (!kit.success || kit.data.assets.length < 9)
    throw new AppError("conflict", "Kit is not complete", { retryable: true });
  const url = `${deps.appUrl}/report/${report.accessToken}`;
  await deps.sendTransactional({
    to: order.contactEmail,
    subject: `Your ${order.product === "growth" ? "Growth" : "Audit + Kit"} report is ready`,
    text: `Your audit and implementation Kit for ${order.domain} are ready.\n\nOpen your private report: ${url}\n\nThis link grants access to the report and downloadable assets.`,
    idempotencyKey: `deliver_report:${orderId}`,
  });
  if (order.prospectId) {
    const [prospect] = await deps.db.select().from(prospects).where(eq(prospects.id, order.prospectId));
    const [company] = prospect
      ? await deps.db.select().from(companies).where(eq(companies.id, prospect.companyId))
      : [];
    if (company) {
      const mirror = await deps.hubspot.upsertCompany({
        outrunId: company.id,
        domain: company.domain,
        name: company.name,
      });
      await deps.hubspot.upsertDeal({
        outrunId: order.id,
        name: `${order.domain} ${order.product}`,
        stage: "Delivered",
        companyId: mirror.id,
      });
    }
  }
  const [updated] = await deps.db
    .update(orders)
    .set({ state: "delivered", deliveredAt: new Date() })
    .where(and(eq(orders.id, orderId), eq(orders.state, "auditing")))
    .returning({ id: orders.id });
  if (updated)
    await deps.emit({
      actor: "worker",
      type: "report.delivered",
      entityType: "order",
      entityId: orderId,
      payload: { reportId },
    });
}

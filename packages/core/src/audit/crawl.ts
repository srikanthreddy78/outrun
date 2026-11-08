import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { untrusted, type ToolInput } from "../../contracts";
import { AUDIT_MAX_PAGES } from "../constants";
import type { Db } from "../db/client";
import { auditCrawls, orders, reports, scans } from "../db/schema";
import { AppError } from "../errors";
import type { Emit } from "../events";
import type { ApifyClient } from "../integrations/types";
import type { Queue } from "../queue";
import { scrubText } from "../crew/scrub";
import { normalizeDomain } from "../scan/scan";
import { safeFetch } from "../safeFetch";

export interface CrawlDeps {
  db: Db;
  apify: ApifyClient;
  appUrl: string;
  emit: Emit;
  preflight?: (url: string) => Promise<unknown>;
}

function cleanPublicPageUrl(raw: string, domain: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`))
    )
      return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export async function startPublicCrawl(deps: CrawlDeps, orderId: string) {
  const [order] = await deps.db.select().from(orders).where(eq(orders.id, orderId));
  if (!order || (order.product !== "auditKit" && order.product !== "growth"))
    throw new AppError("not_found", "paid order not found");
  if (order.state !== "paid" && order.state !== "auditing")
    throw new AppError("conflict", "order is not ready for audit");
  const domain = normalizeDomain(order.domain);
  await (deps.preflight ?? safeFetch)(`https://${domain}/`);
  const [claimed] = await deps.db.insert(auditCrawls).values({ orderId }).onConflictDoNothing().returning();
  if (!claimed) {
    const [existing] = await deps.db.select().from(auditCrawls).where(eq(auditCrawls.orderId, orderId));
    if (!existing) throw new AppError("conflict", "crawl claim unavailable", { retryable: true });
    if (existing.status === "failed") throw new AppError("conflict", "crawl failed; manual review required");
    return {
      crawlId: existing.runId ?? `pending:${orderId}`,
      status: existing.status === "succeeded" ? ("finished" as const) : ("already_running" as const),
    };
  }
  try {
    const run = await deps.apify.runActor({
      actorId: "apify~website-content-crawler",
      input: {
        startUrls: [{ url: `https://${domain}/` }],
        maxCrawlPages: AUDIT_MAX_PAGES,
        maxResults: AUDIT_MAX_PAGES,
        maxCrawlDepth: 3,
        useSitemaps: false,
      },
      webhookUrl: `${deps.appUrl}/api/webhooks/apify`,
      idempotencyKey: `audit:${orderId}`,
    });
    await deps.db
      .update(auditCrawls)
      .set({ runId: run.runId, datasetId: run.datasetId, status: "running" })
      .where(eq(auditCrawls.orderId, orderId));
    await deps.emit({
      actor: "naive:auditor",
      type: "crawl.started",
      entityType: "order",
      entityId: orderId,
      payload: { runId: run.runId },
    });
    return { crawlId: run.runId, status: "started" as const };
  } catch (error) {
    // Do not automatically release the claim. A timed-out API call may have started a paid run.
    await deps.emit({
      actor: "worker",
      type: "crawl.start_uncertain",
      entityType: "order",
      entityId: orderId,
      payload: { reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" },
    });
    throw error;
  }
}

export async function getPublicCrawlPages(
  deps: Pick<CrawlDeps, "db" | "apify">,
  input: { orderId: string; cursor?: string; limit: number },
) {
  const [order] = await deps.db.select().from(orders).where(eq(orders.id, input.orderId));
  const [crawl] = await deps.db.select().from(auditCrawls).where(eq(auditCrawls.orderId, input.orderId));
  if (!order || !crawl?.datasetId || crawl.status !== "succeeded")
    throw new AppError("conflict", "crawl is not finished");
  const offset = input.cursor === undefined ? 0 : Number(input.cursor);
  if (!Number.isInteger(offset) || offset < 0 || offset >= AUDIT_MAX_PAGES)
    throw new AppError("bad_request", "invalid crawl cursor");
  const limit = Math.min(input.limit, AUDIT_MAX_PAGES - offset);
  const page = await deps.apify.getDataset(crawl.datasetId, { offset, limit });
  const pages = page.items.flatMap((item) => {
    const url = cleanPublicPageUrl(item.url, order.domain);
    return url
      ? [{ url, title: untrusted(scrubText(item.title)), content: untrusted(scrubText(item.text)) }]
      : [];
  });
  const next = offset + limit;
  return { pages, nextCursor: next < Math.min(page.total, AUDIT_MAX_PAGES) ? String(next) : null };
}

export async function savePaidAudit(
  deps: { db: Db; enqueue: Pick<Queue, "enqueue">["enqueue"]; emit: Emit },
  input: ToolInput<"save_audit">,
) {
  const [order] = await deps.db.select().from(orders).where(eq(orders.id, input.orderId));
  if (!order || (order.product !== "auditKit" && order.product !== "growth"))
    throw new AppError("not_found", "paid order not found");
  if (order.state !== "auditing") throw new AppError("conflict", "order is not auditing");
  const [crawl] = await deps.db.select().from(auditCrawls).where(eq(auditCrawls.orderId, input.orderId));
  if (!crawl?.runId || crawl.status !== "succeeded") throw new AppError("conflict", "crawl is not finished");
  const [latestScan] = await deps.db
    .select({ checks: scans.checks })
    .from(scans)
    .where(eq(scans.domain, order.domain))
    .orderBy(desc(scans.createdAt))
    .limit(1);
  const knownChecks = new Set(
    (latestScan?.checks ?? []).flatMap((check): string[] =>
      check && typeof check === "object" && "id" in check && typeof check.id === "string"
        ? [check.id.replace(/-/g, "_")]
        : [],
    ),
  );
  // Agents see ids as llms_txt (get_brief, get_prospect) or as stored (llms-txt): both are one check.
  for (const finding of input.findings) {
    if (finding.checkId && !knownChecks.has(finding.checkId.replace(/-/g, "_")))
      throw new AppError("bad_request", `unknown check ID: ${finding.checkId}`);
    if (finding.pageUrl && !cleanPublicPageUrl(finding.pageUrl, order.domain))
      throw new AppError("bad_request", "finding URL must be an audited public page");
  }
  const audit = {
    orderId: input.orderId,
    domain: order.domain,
    summary: scrubText(input.summary),
    findings: input.findings.map((finding, index) => ({
      id: `f${index + 1}`,
      title: scrubText(finding.title),
      severity: finding.severity,
      detail: scrubText(finding.detail),
      evidence: {
        ...(finding.checkId ? { checkId: finding.checkId } : {}),
        ...(finding.pageUrl ? { sourceUrl: cleanPublicPageUrl(finding.pageUrl, order.domain)! } : {}),
      },
    })),
    crawlRunId: crawl.runId,
  };
  const [inserted] = await deps.db
    .insert(reports)
    .values({ orderId: input.orderId, accessToken: randomBytes(32).toString("base64url"), audit })
    .onConflictDoNothing()
    .returning({ id: reports.id });
  const [row] = inserted
    ? [inserted]
    : await deps.db.select({ id: reports.id }).from(reports).where(eq(reports.orderId, input.orderId));
  if (!row) throw new AppError("internal", "audit report unavailable");
  await deps.enqueue({
    type: "build_kit",
    payload: { orderId: input.orderId, reportId: row.id },
    idempotencyKey: `build_kit:${input.orderId}`,
    traceId: `audit-${input.orderId}`,
  });
  if (inserted)
    await deps.emit({
      actor: "naive:auditor",
      type: "audit.saved",
      entityType: "report",
      entityId: row.id,
      payload: { orderId: input.orderId, findings: audit.findings.length },
    });
  return { reportId: row.id };
}

import type { ApifyClient } from "../../integrations/types";
import { getPublicCrawlPages, savePaidAudit, startPublicCrawl } from "../../audit/crawl";
import { defineTool } from "../registry";

export function auditTools(
  apify: ApifyClient,
  appUrl: string,
  preflight?: (url: string) => Promise<unknown>,
) {
  const startCrawl = defineTool({
    name: "start_crawl",
    handler: (input, ctx) =>
      startPublicCrawl(
        { db: ctx.db, apify, appUrl, emit: ctx.emit, ...(preflight ? { preflight } : {}) },
        input.orderId,
      ),
  });
  const getCrawlPages = defineTool({
    name: "get_crawl_pages",
    handler: (input, ctx) => getPublicCrawlPages({ db: ctx.db, apify }, input),
  });
  const saveAudit = defineTool({
    name: "save_audit",
    handler: (input, ctx) => savePaidAudit({ db: ctx.db, enqueue: ctx.enqueue, emit: ctx.emit }, input),
  });
  return [startCrawl, getCrawlPages, saveAudit];
}

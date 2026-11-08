import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AUDIT_MAX_PAGES } from "../constants";
import { normalizeDomain } from "../scan/scan";
import type { ApifyClient as ApifyPort } from "./types";

const API = "https://api.apify.com/v2";
const PublicCrawlInput = z.strictObject({
  startUrls: z.array(z.strictObject({ url: z.url() })).length(1),
  maxCrawlPages: z.literal(AUDIT_MAX_PAGES),
  maxResults: z.literal(AUDIT_MAX_PAGES),
  maxCrawlDepth: z.number().int().min(0).max(3),
  useSitemaps: z.literal(false),
});

/** Public pages only. Test-account credentials never enter this client. */
export class ApifyClient implements ApifyPort {
  constructor(
    private readonly token: string,
    private readonly webhookSecret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!token || !webhookSecret) throw new Error("Apify token and webhook secret are required");
  }

  async runActor(req: Parameters<ApifyPort["runActor"]>[0]): ReturnType<ApifyPort["runActor"]> {
    if (req.actorId !== "apify~website-content-crawler") throw new Error("Unsupported crawl actor");
    if (new URL(req.webhookUrl).protocol !== "https:") throw new Error("Apify webhook URL must use HTTPS");
    const input = PublicCrawlInput.parse(req.input);
    if (input.startUrls[0]!.url !== `https://${normalizeDomain(input.startUrls[0]!.url)}/`)
      throw new Error("Crawl must start at a public HTTPS domain root");
    const webhook = {
      eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.TIMED_OUT", "ACTOR.RUN.ABORTED"],
      requestUrl: req.webhookUrl,
      headersTemplate: JSON.stringify({ "x-outrun-apify-secret": this.webhookSecret }),
      idempotencyKey: req.idempotencyKey,
    };
    const params = new URLSearchParams({
      maxItems: String(AUDIT_MAX_PAGES),
      webhooks: Buffer.from(JSON.stringify([webhook])).toString("base64"),
    });
    const response = await this.fetcher(`${API}/actors/${req.actorId}/runs?${params}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Apify run HTTP ${response.status}`);
    const body = (await response.json()) as { data?: { id?: unknown; defaultDatasetId?: unknown } };
    const runId = body.data?.id;
    const datasetId = body.data?.defaultDatasetId;
    if (typeof runId !== "string" || typeof datasetId !== "string")
      throw new Error("Apify run response missing identifiers");
    return { runId, datasetId };
  }

  async getDataset(
    datasetId: string,
    opts: { offset: number; limit: number },
  ): ReturnType<ApifyPort["getDataset"]> {
    if (!/^[A-Za-z0-9]+$/.test(datasetId)) throw new Error("Invalid dataset ID");
    if (!Number.isInteger(opts.offset) || opts.offset < 0 || !Number.isInteger(opts.limit) || opts.limit < 1)
      throw new Error("Invalid dataset page");
    const limit = Math.min(opts.limit, AUDIT_MAX_PAGES);
    const params = new URLSearchParams({ offset: String(opts.offset), limit: String(limit), format: "json" });
    const response = await this.fetcher(`${API}/datasets/${datasetId}/items?${params}`, {
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Apify dataset HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error("Invalid Apify dataset");
    const items = body.slice(0, limit).flatMap((value): { url: string; title: string; text: string }[] => {
      if (!value || typeof value !== "object") return [];
      const page = value as Record<string, unknown>;
      if (typeof page.url !== "string") return [];
      return [
        {
          url: page.url,
          title: typeof page.title === "string" ? page.title.slice(0, 500) : "",
          text: (typeof page.text === "string"
            ? page.text
            : typeof page.markdown === "string"
              ? page.markdown
              : ""
          ).slice(0, 20_000),
        },
      ];
    });
    const headerTotal = Number(response.headers.get("x-apify-pagination-total"));
    const total =
      Number.isInteger(headerTotal) && headerTotal >= 0 ? headerTotal : opts.offset + items.length;
    return { items, total };
  }
}

export function verifyApifyWebhookHeader(header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const received = Buffer.from(header);
  const expected = Buffer.from(secret);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

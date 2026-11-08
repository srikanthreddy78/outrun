import {
  CACHE_TTL_MS,
  MARKETING_CHECKS,
  READINESS_CHECKS,
  SCAN_VERSION,
  type Check,
  type Effectiveness,
  type FunnelMetrics,
  type PrivateSupplement,
  type ScanResult,
  type ScanSource,
  type Score,
} from "./contracts";
import { safeFetch, validatePublicUrl } from "../safeFetch";
import { isIP } from "node:net";

const html = (body: string) => /<html[\s>]/i.test(body);
// Pages are attacker-controlled: cap what any regex sees and keep every scan linear.
const MAX_SCAN_HTML = 256 * 1024;
const MAX_TAG = 2048;
const MAX_INNER = 4096;
const cap = (body: string) => (body.length > MAX_SCAN_HTML ? body.slice(0, MAX_SCAN_HTML) : body);
const CTA_WORDS = /(get started|sign up|start free|book demo|buy now|try free|contact sales)/i;

function stripBlocks(body: string, name: string): string {
  const open = new RegExp(`<${name}\\b`, "gi");
  const close = new RegExp(`</${name}>`, "gi");
  let out = "";
  let from = 0;
  for (let m = open.exec(body); m; m = open.exec(body)) {
    const gt = body.indexOf(">", m.index);
    if (gt < 0) break;
    close.lastIndex = gt + 1;
    const end = close.exec(body);
    if (!end) break;
    out += body.slice(from, m.index);
    from = open.lastIndex = end.index + end[0].length;
  }
  return out + body.slice(from);
}

function stripTags(body: string): string {
  let out = "";
  let from = 0;
  for (let lt = body.indexOf("<"); lt >= 0; lt = body.indexOf("<", lt + 1)) {
    const gt = body.indexOf(">", lt + 1);
    if (gt < 0) break;
    out += body.slice(from, lt) + " ";
    from = gt + 1;
    lt = gt;
  }
  return out + body.slice(from);
}

export const bodyText = (body: string) =>
  stripTags(stripBlocks(stripBlocks(cap(body), "script"), "style"))
    .replace(/\s+/g, " ")
    .trim();

/** Each open tag of these names with its inner HTML, bounded by the close tag, the next open tag and MAX_INNER. */
function elements(page: string, names: string): { tag: string; inner: string; closed: boolean }[] {
  const open = new RegExp(`<(?:${names})\\b`, "gi");
  const close = new RegExp(`</(?:${names})\\s*>`, "i");
  const starts = [...page.matchAll(open)].map((m) => m.index);
  const found: { tag: string; inner: string; closed: boolean }[] = [];
  let gt = -1;
  for (const [i, start] of starts.entries()) {
    if (gt < start) gt = page.indexOf(">", start);
    if (gt < 0) break;
    if (gt - start > MAX_TAG) continue;
    const segment = page.slice(gt + 1, Math.min(starts[i + 1] ?? page.length, gt + 1 + MAX_INNER));
    const end = close.exec(segment);
    found.push({
      tag: page.slice(start, gt + 1),
      inner: end ? segment.slice(0, end.index) : segment,
      closed: !!end,
    });
  }
  return found;
}

const after = (text: string, marker: RegExp) => {
  const at = text.search(marker);
  return at < 0 ? "" : text.slice(at);
};
const isOk = (status: number) => status >= 200 && status < 300;
const record = (id: string, status: Check["status"], evidence: string, sourceUrl?: string): Check => {
  const readiness = READINESS_CHECKS.find((item) => item[0] === id);
  const marketing = MARKETING_CHECKS.find((item) => item[0] === id);
  const definition = readiness ?? marketing;
  if (!definition) throw new Error(`Unknown check ${id}`);
  return {
    id,
    category: readiness ? "readiness" : "marketing",
    tier: ["ssr-answer", "llms-txt", "sitemap", "clear-cta", "value-proposition"].includes(id)
      ? "quick"
      : "full",
    label: definition[1],
    weight: definition[2],
    status,
    evidence,
    sourceUrl,
  };
};
const score = (checks: Check[], category: Check["category"]): Score => {
  const subset = checks.filter((check) => check.category === category);
  const assessed = subset.filter((check) => check.status === "pass" || check.status === "fail");
  const assessedWeight = assessed.reduce((sum, check) => sum + check.weight, 0);
  return {
    value: assessedWeight
      ? Math.round(
          (100 *
            assessed
              .filter((check) => check.status === "pass")
              .reduce((sum, check) => sum + check.weight, 0)) /
            assessedWeight,
        )
      : null,
    assessedWeight,
    totalWeight: (category === "readiness" ? READINESS_CHECKS : MARKETING_CHECKS).reduce(
      (sum, item) => sum + item[2],
      0,
    ),
  };
};
export function effectiveness(metrics: FunnelMetrics): Effectiveness {
  const validDate = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
  if (!validDate(metrics.startDate) || !validDate(metrics.endDate) || metrics.startDate > metrics.endDate)
    throw new Error("Valid metric dates required");
  for (const value of Object.values(metrics))
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0))
      throw new Error("Metrics must be nonnegative");
  return {
    source: "agent-supplied",
    period: { startDate: metrics.startDate, endDate: metrics.endDate },
    ...(metrics.visits && metrics.leads !== undefined ? { visitToLead: metrics.leads / metrics.visits } : {}),
    ...(metrics.leads && metrics.customers !== undefined
      ? { leadToCustomer: metrics.customers / metrics.leads }
      : {}),
    ...(metrics.customers && metrics.spendUsd !== undefined
      ? { customerAcquisitionCostUsd: metrics.spendUsd / metrics.customers }
      : {}),
    ...(metrics.spendUsd && metrics.revenueUsd !== undefined
      ? { returnOnAdSpend: metrics.revenueUsd / metrics.spendUsd }
      : {}),
  };
}
function assemble(
  domain: string,
  state: ScanResult["state"],
  checks: Check[],
  supplement?: PrivateSupplement,
  journey?: ScanResult["journey"],
): ScanResult {
  const now = new Date();
  const topActions = checks
    .filter((check) => check.status === "fail")
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((check) => `Fix ${check.label.toLowerCase()} (${check.id})`);
  return {
    version: SCAN_VERSION,
    domain,
    state,
    scannedAt: now.toISOString(),
    ...(state === "complete" ? { cachedUntil: new Date(now.getTime() + CACHE_TTL_MS).toISOString() } : {}),
    checks,
    scores: {
      siteReadiness: score(checks, "readiness"),
      marketingCoverage: score(checks, "marketing"),
      ...(supplement?.metrics ? { marketingEffectiveness: effectiveness(supplement.metrics) } : {}),
    },
    topActions,
    ...(journey ? { journey } : {}),
    reportUrl: `/score/${encodeURIComponent(domain)}`,
  };
}
export function normalizeDomain(input: string): string {
  const url = validatePublicUrl(input.includes("://") ? input : `https://${input}`);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Expected a domain");
  const domain = url.hostname.toLowerCase();
  if (
    !domain.includes(".") ||
    isIP(domain) ||
    /\.(?:local|localhost|internal|test|invalid|example|onion)$/.test(domain)
  )
    throw new Error("Expected a public domain");
  return domain;
}
const probe = async (source: ScanSource, url: string) => {
  try {
    const response = await source(url);
    return { ...response, body: cap(response.body) };
  } catch {
    return undefined;
  }
};
const status = (ok: boolean | undefined): Check["status"] =>
  ok === undefined ? "unknown" : ok ? "pass" : "fail";
const locate = (base: string, path: string) => new URL(path, base).toString();

export async function quickScan(domainInput: string, source: ScanSource = safeFetch): Promise<ScanResult> {
  const domain = normalizeDomain(domainInput);
  const base = `https://${domain}/`;
  const [home, llms, sitemap] = await Promise.all([
    probe(source, base),
    probe(source, locate(base, "/llms.txt")),
    probe(source, locate(base, "/sitemap.xml")),
  ]);
  const page = home && isOk(home.status) ? home.body : "";
  const cta = elements(page, "a|button").some((el) => CTA_WORDS.test(bodyText(el.inner)));
  const checks = [
    record(
      "ssr-answer",
      status(home ? isOk(home.status) && html(page) && bodyText(page).length > 100 : undefined),
      home ? "Rendered HTML text inspected" : "Homepage fetch failed",
      base,
    ),
    record(
      "llms-txt",
      status(llms ? isOk(llms.status) && /#[^\n]+/.test(llms.body) : undefined),
      llms ? `HTTP ${llms.status}` : "Fetch failed",
      locate(base, "/llms.txt"),
    ),
    record(
      "sitemap",
      status(sitemap ? isOk(sitemap.status) && /<urlset|<sitemapindex/i.test(sitemap.body) : undefined),
      sitemap ? `HTTP ${sitemap.status}` : "Fetch failed",
      locate(base, "/sitemap.xml"),
    ),
    record(
      "clear-cta",
      status(home ? cta : undefined),
      home ? (cta ? "Primary action found" : "No clear action found") : "Homepage fetch failed",
      base,
    ),
    record(
      "value-proposition",
      status(home ? elements(page, "h1").some((el) => /^[^<]{12,}/.test(el.inner)) : undefined),
      home ? "Visible heading inspected" : "Homepage fetch failed",
      base,
    ),
  ];
  return assemble(domain, "partial", checks);
}

function extractCta(base: string, page: string): string | undefined {
  for (const el of elements(cap(page), "a")) {
    const href = /href=["']([^"']+)["']/i.exec(el.tag)?.[1];
    if (!href || !el.closed || !CTA_WORDS.test(bodyText(el.inner))) continue;
    try {
      return validatePublicUrl(new URL(href, base).toString()).toString();
    } catch {
      /* skip unsafe navigation */
    }
  }
}
export async function fullScan(
  partial: ScanResult,
  source: ScanSource = safeFetch,
  supplement?: PrivateSupplement,
): Promise<ScanResult> {
  const base = `https://${partial.domain}/`;
  const paths = [
    "/",
    "/robots.txt",
    "/openapi.json",
    "/.well-known/agent.json",
    "/docs",
    "/nonexistent-outrun-readiness-check",
    "/mcp",
  ];
  const responses = await Promise.all(paths.map((path) => probe(source, locate(base, path))));
  const [home, robots, openapi, wellKnown, docs, missing, mcp] = responses;
  const page = home?.body ?? "";
  const check = (id: string, result: boolean | undefined, evidence: string, path = "/") =>
    record(id, status(result), evidence, locate(base, path));
  const checks = [
    ...partial.checks,
    check(
      "markdown",
      home
        ? elements(page, "link").some((el) => /(?:text\/markdown|\.md["'])/i.test(el.tag)) ||
            /\.md(?:"|')/i.test(page)
        : undefined,
      "Markdown alternate link inspected",
    ),
    check(
      "ai-robots",
      robots
        ? isOk(robots.status) && /user-agent:\s*(?:GPTBot|ClaudeBot|Google-Extended|\*)/i.test(robots.body)
        : undefined,
      "robots.txt inspected",
      "/robots.txt",
    ),
    check(
      "json-ld",
      home
        ? elements(page, "script").some((el) => /type=["']application\/ld\+json/i.test(el.tag))
        : undefined,
      "JSON-LD script inspected",
    ),
    check(
      "honest-404",
      missing ? missing.status === 404 : undefined,
      missing ? `HTTP ${missing.status}` : "Fetch failed",
      "/nonexistent-outrun-readiness-check",
    ),
    record("rate-limit", "unknown", "No safe way to induce a rate limit on a public site"),
    record(
      "mcp",
      mcp?.status === 404
        ? "fail"
        : mcp &&
            /text\/event-stream/i.test(mcp.headers["content-type"] ?? "") &&
            (mcp.headers["mcp-session-id"] || mcp.headers["mcp-protocol-version"])
          ? "pass"
          : "unknown",
      mcp
        ? `Read-only GET: HTTP ${mcp.status}; Streamable HTTP not confirmed without protocol evidence`
        : "Fetch failed",
      mcp ? locate(base, "/mcp") : undefined,
    ),
    check(
      "well-known",
      wellKnown ? isOk(wellKnown.status) && wellKnown.body.trim().length > 0 : undefined,
      wellKnown ? `HTTP ${wellKnown.status}` : "Fetch failed",
      "/.well-known/agent.json",
    ),
    check(
      "openapi",
      openapi ? isOk(openapi.status) && /["']?openapi["']?\s*:/i.test(openapi.body) : undefined,
      openapi ? `HTTP ${openapi.status}` : "Fetch failed",
      "/openapi.json",
    ),
    record("mcp-registry", "unknown", "Registry lookup unavailable; no conclusion"),
    check(
      "machine-pricing",
      home
        ? /(?:price|Offer)/i.test(after(page, /application\/ld\+json/i)) ||
            /href=["'][^"']*pricing\.(?:json|xml)/i.test(page)
        : undefined,
      "Machine-readable pricing inspected",
    ),
    check(
      "docs",
      docs ? isOk(docs.status) && bodyText(docs.body).length > 30 : undefined,
      docs ? `HTTP ${docs.status}` : "Fetch failed",
      "/docs",
    ),
    check(
      "social-proof",
      home ? /(testimonial|case stud|trusted by|customer stor)/i.test(page) : undefined,
      "Homepage proof markers inspected",
    ),
    check(
      "contact-path",
      home ? /href=["'](?:mailto:|[^"']*contact)/i.test(page) : undefined,
      "Contact links inspected",
    ),
    check(
      "analytics-tag",
      home ? /(gtag\(|googletagmanager|plausible\.io|posthog|segment\.com)/i.test(page) : undefined,
      "Public analytics tag inspected",
    ),
  ];
  const journey: NonNullable<ScanResult["journey"]> = { urls: [], outcome: "unknown" };
  let next = extractCta(base, page);
  for (let i = 0; i < 3 && next; i++) {
    if (journey.urls.includes(next)) break;
    journey.urls.push(next);
    const response = await probe(source, next);
    if (!response) break;
    if (/(checkout|payment|billing)/i.test(next)) {
      journey.outcome = "payment-wall";
      break;
    }
    if (/<form\b/i.test(response.body) || /(sign.?up|register|log.?in)/i.test(next)) {
      journey.outcome = "signup-wall";
      break;
    }
    journey.outcome = "public";
    next = extractCta(next, response.body);
  }
  const publicResult = assemble(partial.domain, "complete", checks, undefined, journey);
  return supplement ? withPrivateSupplement(publicResult, supplement) : publicResult;
}

export function withPrivateSupplement(publicResult: ScanResult, supplement: PrivateSupplement): ScanResult {
  const urls = (supplement.campaignUrls ?? []).map(validatePublicUrl);
  const campaign = urls.length
    ? record(
        "campaign-tracking",
        urls.every((url) => url.searchParams.has("utm_source") && url.searchParams.has("utm_campaign"))
          ? "pass"
          : "fail",
        `Agent supplied ${urls.length} campaign URL(s); tracking parameters inspected`,
        urls[0]?.toString(),
      )
    : undefined;
  const checks = campaign ? [...publicResult.checks, campaign] : publicResult.checks;
  const topActions =
    campaign?.status === "fail"
      ? [...publicResult.topActions, "Fix campaign URL tracking (campaign-tracking)"].slice(0, 3)
      : publicResult.topActions;
  return {
    ...publicResult,
    checks,
    topActions,
    scores: {
      ...publicResult.scores,
      marketingCoverage: score(checks, "marketing"),
      ...(supplement.metrics ? { marketingEffectiveness: effectiveness(supplement.metrics) } : {}),
    },
  };
}

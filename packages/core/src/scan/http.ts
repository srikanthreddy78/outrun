import { PRODUCTS } from "../constants";
import type { ScanResult } from "./contracts";
import { normalizeDomain } from "./scan";
import { RateLimitError, type ScanService } from "./service";

const esc = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
export function renderScorePage(result: ScanResult): string {
  const row = (label: string, value: number | null) =>
    `<div class="score"><strong>${esc(label)}</strong><span>${value === null ? "Pending" : `${value}/100`}</span></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(result.domain)} readiness scan</title><meta name="robots" content="noindex"><style>body{font:16px system-ui;max-width:850px;margin:4rem auto;padding:0 1.5rem;background:#fbfaf7;color:#182522}header,section{margin-bottom:2rem}.score{display:flex;justify-content:space-between;padding:1rem;border:1px solid #ccd6d0;margin:.6rem 0}li{margin:.7rem 0}a.button{display:inline-block;padding:.9rem 1.2rem;background:#124e3a;color:white;text-decoration:none;border-radius:.4rem}</style></head><body><header><a href="/">Outrun</a><h1>${esc(result.domain)} readiness scan</h1><p>${result.state === "complete" ? "Public scan complete" : "Quick results are ready. Deeper checks are queued."}</p></header><main>${row("Site readiness", result.scores.siteReadiness.value)}${row("Marketing coverage", result.scores.marketingCoverage.value)}${result.scores.marketingEffectiveness ? "<p>Marketing effectiveness uses metrics supplied by the business agent.</p>" : "<p>Marketing effectiveness requires dated funnel metrics supplied by the business agent.</p>"}<section><h2>Top actions</h2><ol>${result.topActions.map((action) => `<li>${esc(action)}</li>`).join("")}</ol></section><section><h2>Checks</h2><ul>${result.checks.map((check) => `<li><strong>${esc(check.label)}</strong>: ${esc(check.status)} — ${esc(check.evidence)}${check.sourceUrl ? ` <a href="${esc(check.sourceUrl)}">Source</a>` : ""}</li>`).join("")}</ul></section><p>Gated areas are untested in the free scan. The full remediation plan and assets are delivered with a paid offer.</p><a class="button" href="/checkout?package=growth&domain=${encodeURIComponent(result.domain)}">Start ${esc(PRODUCTS.growth.name)} — $${PRODUCTS.growth.priceUsd.toLocaleString("en-US")}/month</a><p><a href="/checkout?package=auditKit&domain=${encodeURIComponent(result.domain)}">One-time ${esc(PRODUCTS.auditKit.name)} — $${PRODUCTS.auditKit.priceUsd}</a></p></main></body></html>`;
}
export function renderLandingPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Outrun</title></head><body><main><h1>Make your product easier for agents to find, understand, and use.</h1><p>Scan your public site for agent readiness and visible marketing coverage.</p><form action="/score" method="get"><label>Domain <input name="domain" type="text" required placeholder="example.com"></label><button>Get free scan</button></form><h2>How it works</h2><p>We scan public pages, show evidence and top actions, then deliver a full audit and implementation Kit when you buy.</p><h2>Plans</h2><p><a href="/checkout?package=growth">${PRODUCTS.growth.name}: $${PRODUCTS.growth.priceUsd.toLocaleString("en-US")}/month</a> includes the initial Audit + Kit and monthly work.</p><p><a href="/checkout?package=auditKit">${PRODUCTS.auditKit.name}: $${PRODUCTS.auditKit.priceUsd} one time</a> includes the same initial audit and Kit.</p><h2>For agents</h2><p><a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/api/mcp">MCP</a></p></main></body></html>`;
}
export function renderLandingMarkdown(): string {
  return `# Outrun\n\nScan public agent readiness and marketing coverage.\n\n- Free scan: $0, GET /api/score?domain=example.com\n- ${PRODUCTS.growth.name}: $${PRODUCTS.growth.priceUsd.toLocaleString("en-US")}/month, includes initial Audit + Kit and monthly work\n- ${PRODUCTS.auditKit.name}: $${PRODUCTS.auditKit.priceUsd} one time, same initial Audit + Kit\n\nAgent interfaces: /llms.txt, /openapi.json, /api/mcp.\n`;
}
export function renderScoreMarkdown(result: ScanResult): string {
  return `# ${result.domain} readiness scan\n\nState: ${result.state}\nSite readiness: ${result.scores.siteReadiness.value ?? "pending"}/100\nMarketing coverage: ${result.scores.marketingCoverage.value ?? "pending"}/100\n${result.scores.marketingEffectiveness ? "Marketing effectiveness: agent-supplied dated metrics\n" : ""}\n## Top actions\n${result.topActions.map((action) => `- ${action}`).join("\n")}\n\n## Checks\n${result.checks.map((check) => `- ${check.id}: ${check.status}; ${check.evidence}${check.sourceUrl ? `; ${check.sourceUrl}` : ""}`).join("\n")}\n`;
}
export async function scoreApi(
  service: ScanService,
  domain: string,
  ip: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  let normalized: string;
  try {
    normalized = normalizeDomain(domain);
  } catch {
    return {
      status: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "invalid_domain" }),
    };
  }
  try {
    const result = await service.request(normalized, ip);
    return {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(result),
    };
  } catch (error) {
    if (error instanceof RateLimitError)
      return {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(error.retryAfter) },
        body: JSON.stringify({ error: "rate_limited" }),
      };
    return {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "60" },
      body: JSON.stringify({ error: "scan_unavailable" }),
    };
  }
}

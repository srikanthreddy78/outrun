import { SCAN_CACHE_DAYS } from "../constants";

export const SCAN_VERSION = 1;
export const CACHE_TTL_MS = SCAN_CACHE_DAYS * 24 * 60 * 60 * 1000;
export type CheckStatus = "pass" | "fail" | "unknown" | "gated";
export type Check = {
  id: string;
  category: "readiness" | "marketing";
  tier: "quick" | "full";
  label: string;
  status: CheckStatus;
  evidence: string;
  sourceUrl?: string;
  weight: number;
};
export type Score = { value: number | null; assessedWeight: number; totalWeight: number };
export type FunnelMetrics = {
  startDate: string;
  endDate: string;
  visits?: number;
  leads?: number;
  customers?: number;
  revenueUsd?: number;
  spendUsd?: number;
};
export type PrivateSupplement = {
  campaignUrls?: string[];
  metrics?: FunnelMetrics;
  suppliedBy: "business-agent";
};
export type Effectiveness = {
  source: "agent-supplied";
  period: { startDate: string; endDate: string };
  visitToLead?: number;
  leadToCustomer?: number;
  customerAcquisitionCostUsd?: number;
  returnOnAdSpend?: number;
};
export type ScanResult = {
  version: number;
  domain: string;
  state: "queued" | "partial" | "complete";
  scannedAt: string;
  cachedUntil?: string;
  checks: Check[];
  scores: { siteReadiness: Score; marketingCoverage: Score; marketingEffectiveness?: Effectiveness };
  topActions: string[];
  journey?: { urls: string[]; outcome: "public" | "signup-wall" | "payment-wall" | "unknown" };
  reportUrl: string;
};
export type ScanSource = (
  url: string,
) => Promise<{ url: string; status: number; headers: Record<string, string>; body: string }>;

export const READINESS_CHECKS = [
  ["ssr-answer", "Answer available without JavaScript", 10],
  ["markdown", "Markdown alternate", 5],
  ["llms-txt", "llms.txt", 8],
  ["ai-robots", "AI bot rules", 5],
  ["sitemap", "Sitemap", 6],
  ["json-ld", "JSON-LD structured data", 8],
  ["honest-404", "Honest 404", 5],
  ["rate-limit", "429 with Retry-After", 4],
  ["mcp", "Streamable HTTP MCP", 10],
  ["well-known", ".well-known metadata", 5],
  ["openapi", "OpenAPI document", 8],
  ["mcp-registry", "MCP Registry listing", 6],
  ["machine-pricing", "Machine-readable pricing", 10],
  ["docs", "Reachable documentation", 10],
] as const;

export const MARKETING_CHECKS = [
  ["clear-cta", "Clear primary action", 25],
  ["value-proposition", "Clear value proposition", 20],
  ["social-proof", "Customer proof", 20],
  ["contact-path", "Contact path", 20],
  ["analytics-tag", "Analytics tag visible", 15],
  ["campaign-tracking", "Campaign URL tracking", 15],
] as const;

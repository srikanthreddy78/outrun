/**
 * Enrichment for one prospect, from two Naive data tools:
 *
 * - Meta Extract ($0.032 a call) reads the company's homepage: title, description, and the
 *   JSON-LD it publishes (founding date, founder, social profiles in `sameAs`).
 * - Compact Profile Snapshot ($0.15 a call, only when it has the company) adds HQ country,
 *   funding, revenue band, go-to-market motion, customer segments and social profiles. Its
 *   source covers established companies; for most early startups it answers 404 at no charge,
 *   which is itself a signal that the company is small.
 */
import { runDataTool, type NaiveClient } from "./naive-api.ts";

export const META_EXTRACT_TOOL =
  "uTjo9s5uNtSBUILJpuCvT50PXl8XjneqkGTXrkO2CTbO4pedIjof9yRMLIp0T6Y9rj9Iqd4tmy7RU9g";
export const COMPANY_PROFILE_TOOL =
  "MmaxbykMU6KWSm42R7mfgd8yqbapsZSPmk5gM33B41hgf5U8hzjwghK7uIZ88SAb3VNP6qgPKWyW3Eh4z5E";

export const SOCIAL_PLATFORMS = [
  "tiktok",
  "instagram",
  "youtube",
  "x",
  "linkedin",
  "github",
  "reddit",
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export interface Enrichment {
  version: 1;
  enrichedAt: string;
  costMicroUsd: number;
  homepage: {
    found: boolean;
    title: string | null;
    description: string | null;
    foundingDate: string | null;
  };
  profile: {
    found: boolean;
    hqCountry: string | null;
    foundedYear: number | null;
    fundingStage: string | null;
    totalFundingUsd: number | null;
    revenueEstimate: string | null;
    gtmMotions: string[];
    customerSegments: string[];
  };
  socials: Partial<Record<SocialPlatform, string>>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Maps a profile URL to the platform it belongs to, by host. */
export function socialPlatformOf(url: string): SocialPlatform | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok";
  if (host === "instagram.com") return "instagram";
  if (host === "youtube.com" || host === "youtu.be") return "youtube";
  if (host === "x.com" || host === "twitter.com") return "x";
  if (host === "linkedin.com") return "linkedin";
  if (host === "github.com") return "github";
  if (host === "reddit.com") return "reddit";
  return null;
}

/** Every JSON-LD node, flattening `@graph` arrays. */
function jsonLdNodes(jsonLd: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = asRecord(value);
    if (Object.keys(record).length === 0) return;
    nodes.push(record);
    if (record["@graph"] !== undefined) visit(record["@graph"]);
  };
  visit(jsonLd);
  return nodes;
}

export function parseHomepage(data: unknown): {
  homepage: Enrichment["homepage"];
  socials: Enrichment["socials"];
} {
  const record = asRecord(data);
  const og = asRecord(record["og"]);
  const socials: Enrichment["socials"] = {};
  let foundingDate: string | null = null;
  for (const node of jsonLdNodes(record["json_ld"])) {
    foundingDate ??= asString(node["foundingDate"]);
    const sameAs = typeof node["sameAs"] === "string" ? [node["sameAs"]] : asArray(node["sameAs"]);
    for (const url of sameAs) {
      const href = asString(url);
      const platform = href === null ? null : socialPlatformOf(href);
      if (platform !== null && href !== null) socials[platform] ??= href;
    }
  }
  return {
    homepage: {
      found: true,
      title: asString(record["title"]) ?? asString(og["title"]),
      description: asString(record["description"]) ?? asString(og["description"]),
      foundingDate,
    },
    socials,
  };
}

export function parseProfile(data: unknown): {
  profile: Enrichment["profile"];
  socials: Enrichment["socials"];
} {
  const root = asRecord(asRecord(data)["data"]);
  const firmographic = asRecord(root["firmographic"]);
  const funding = asRecord(asRecord(root["funding_detail"])["funding_overview"]);
  const socials: Enrichment["socials"] = {};
  for (const entry of asArray(asRecord(root["digital_presence"])["social_media_profiles"])) {
    const href = asString(asRecord(entry)["url"]);
    const platform = href === null ? null : socialPlatformOf(href);
    if (platform !== null && href !== null) socials[platform] ??= href;
  }
  return {
    profile: {
      found: true,
      hqCountry: asString(asRecord(asRecord(root["location"])["hq"])["country"]),
      foundedYear: asNumber(firmographic["founded_year"]),
      fundingStage: asString(funding["funding_stage"]),
      totalFundingUsd: asNumber(funding["total_funding_usd"]),
      revenueEstimate: asString(asRecord(root["financial_estimate"])["revenue_estimate"]),
      gtmMotions: asArray(asRecord(root["business_model"])["gtm_motion"])
        .map((motion) => asString(asRecord(motion)["type"]))
        .filter((motion): motion is string => motion !== null),
      customerSegments: asArray(asRecord(root["customer_profile"])["segment"])
        .map((segment) => asString(asRecord(segment)["title"]))
        .filter((segment): segment is string => segment !== null),
    },
    socials,
  };
}

const EMPTY_PROFILE: Enrichment["profile"] = {
  found: false,
  hqCountry: null,
  foundedYear: null,
  fundingStage: null,
  totalFundingUsd: null,
  revenueEstimate: null,
  gtmMotions: [],
  customerSegments: [],
};

/** Runs both tools for one domain. A tool that fails or has no record leaves its half empty. */
export async function enrich(client: NaiveClient, domain: string, now: Date): Promise<Enrichment> {
  const url = `https://${domain}`;
  const [meta, profile] = await Promise.all([
    runDataTool(client, META_EXTRACT_TOOL, { url }).catch(() => null),
    runDataTool(client, COMPANY_PROFILE_TOOL, { company: url }).catch(() => null),
  ]);
  const homepage =
    meta?.status === "succeeded"
      ? parseHomepage(meta.data)
      : { homepage: { found: false, title: null, description: null, foundingDate: null }, socials: {} };
  const company =
    profile?.status === "succeeded" ? parseProfile(profile.data) : { profile: EMPTY_PROFILE, socials: {} };
  return {
    version: 1,
    enrichedAt: now.toISOString(),
    costMicroUsd: (meta?.cost_micro_usd ?? 0) + (profile?.cost_micro_usd ?? 0),
    homepage: homepage.homepage,
    profile: company.profile,
    socials: { ...company.socials, ...homepage.socials },
  };
}

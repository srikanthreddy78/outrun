/**
 * The fit score: a deterministic 0-100 for how well a prospect matches the customer in
 * wiki/PRODUCT.md, a small team shipping a product people sign up for, built for or with
 * coding agents, that Outrun could market on TikTok and Instagram. Code decides the score and
 * every point carries its reason, so a score can always be explained and never drifts with a
 * model's mood.
 */
import type { Enrichment } from "./enrich.ts";

export interface FitInput {
  company: string;
  domain: string;
  whyFit: string;
  contactEmail: string;
  contactName: string | null;
  contactRole: string | null;
  enrichment: Enrichment;
}

export interface FitPart {
  signal: string;
  points: number;
  reason: string;
}

export interface FitScore {
  score: number;
  band: "strong" | "good" | "weak";
  parts: FitPart[];
}

/** EU and UK countries, by ISO 3166 alpha-3 (the profile source's format) and alpha-2. */
const EU_UK = new Set([
  "AUT",
  "BEL",
  "BGR",
  "HRV",
  "CYP",
  "CZE",
  "DNK",
  "EST",
  "FIN",
  "FRA",
  "DEU",
  "GRC",
  "HUN",
  "IRL",
  "ITA",
  "LVA",
  "LTU",
  "LUX",
  "MLT",
  "NLD",
  "POL",
  "PRT",
  "ROU",
  "SVK",
  "SVN",
  "ESP",
  "SWE",
  "GBR",
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "GB",
  "UK",
]);

/** Country-code top-level domains that point to the EU or UK when the profile has no HQ. */
const EU_UK_TLDS = [
  ".be",
  ".nl",
  ".de",
  ".fr",
  ".uk",
  ".ie",
  ".es",
  ".it",
  ".se",
  ".dk",
  ".fi",
  ".pl",
  ".at",
  ".pt",
];

const SELF_SERVE =
  /\b(sign[ -]?up|start (for )?free|free (plan|tier|trial)|try (it )?(for )?free|get started|no credit card)\b/i;
const AGENT_NATIVE = /\b(agents?|agentic|mcp|claude|cursor|codex|llms?|copilot)\b/i;
const FOUNDER_ROLE = /\b(founder|co-?founder|ceo|cto)\b/i;
const FREE_MAIL = /@(gmail|yahoo|outlook|hotmail|icloud|proton|aol)\./i;

const BIG_REVENUE = /\$(\d+)(m|b)\+?|\$(\d+)b/i;

function revenueIsLarge(estimate: string | null): boolean {
  if (estimate === null) return false;
  const match = BIG_REVENUE.exec(estimate.replace(/,/g, ""));
  if (match === null) return false;
  if (/b/i.test(match[2] ?? "") || match[3] !== undefined) return true;
  return Number(match[1]) >= 10;
}

const thisYear = (now: Date): number => now.getUTCFullYear();

function foundedYearOf(enrichment: Enrichment): number | null {
  if (enrichment.profile.foundedYear !== null) return enrichment.profile.foundedYear;
  const year = Number(enrichment.homepage.foundingDate?.slice(0, 4));
  return Number.isInteger(year) && year > 1990 ? year : null;
}

export function scoreFit(input: FitInput, now: Date): FitScore {
  const { enrichment } = input;
  const parts: FitPart[] = [];
  const add = (signal: string, points: number, reason: string): void => {
    parts.push({ signal, points, reason });
  };
  const text = [enrichment.homepage.title, enrichment.homepage.description, input.whyFit]
    .filter(Boolean)
    .join(" ");

  // 1. A product people sign up for and use themselves (PRODUCT.md: Outrun uses it like a real user).
  const plg = enrichment.profile.gtmMotions.some((motion) => /product[- ]led/i.test(motion));
  if (SELF_SERVE.test(text) || plg) {
    add(
      "self_serve",
      20,
      plg ? "Product-led growth in the company profile" : "Homepage invites people to sign up or start free",
    );
  } else {
    add("self_serve", 0, "No sign-up or free start found on the homepage");
  }

  // 2. Small and early: the team that hands marketing to its coding agent.
  const founded = foundedYearOf(enrichment);
  const large =
    revenueIsLarge(enrichment.profile.revenueEstimate) ||
    (enrichment.profile.totalFundingUsd ?? 0) >= 50_000_000;
  if (large) {
    add(
      "size",
      -15,
      `Established company (revenue ${enrichment.profile.revenueEstimate ?? "unknown"}, funding $${((enrichment.profile.totalFundingUsd ?? 0) / 1e6).toFixed(0)}M)`,
    );
  } else if (!enrichment.profile.found) {
    add("size", 20, "Not in the company database yet, which usually means an early startup");
  } else if (founded !== null && founded >= thisYear(now) - 3) {
    add("size", 20, `Founded ${founded}`);
  } else {
    add("size", 10, founded === null ? "Small, founding year unknown" : `Founded ${founded}, still small`);
  }

  // 3. An audience TikTok and Instagram can reach.
  const segments = enrichment.profile.customerSegments.join(" ");
  if (/consumer|individual|creator|prosumer/i.test(segments)) {
    add("audience", 15, "Sells to individuals or consumers");
  } else if (
    /smb|small|startup|developer/i.test(segments) ||
    /\b(developers?|builders?|indie)\b/i.test(text)
  ) {
    add("audience", 10, "Sells to developers, builders or small businesses");
  } else if (/enterprise/i.test(segments)) {
    add("audience", 0, "Sells mainly to enterprises");
  } else {
    add("audience", 5, "Audience unclear");
  }

  // 4. Built for or with agents: the people Outrun's own marketing reaches.
  if (AGENT_NATIVE.test(text)) add("agent_native", 15, "Builds for or with AI agents");
  else add("agent_native", 0, "No agent angle found");

  // 5. Social presence: no TikTok or Instagram yet is the gap Outrun fills.
  const onShortVideo = enrichment.socials.tiktok !== undefined || enrichment.socials.instagram !== undefined;
  if (!onShortVideo) add("social_gap", 10, "No TikTok or Instagram found: room for Outrun to start them");
  else add("social_gap", 0, "Already on TikTok or Instagram");

  // 6. A reachable person: founders read their own inbox.
  const local = input.contactEmail.split("@")[0]?.toLowerCase() ?? "";
  if (FREE_MAIL.test(input.contactEmail)) {
    add("contact", -10, "Free-mail address, not the company's own");
  } else if (input.contactName !== null && FOUNDER_ROLE.test(input.contactRole ?? "")) {
    add("contact", 15, `A named founder: ${input.contactName}`);
  } else if (local === "founders" || FOUNDER_ROLE.test(input.contactRole ?? "")) {
    add("contact", 12, "The founders' inbox");
  } else if (["hello", "hi", "hey", "team", "contact", "info", "partnerships"].includes(local)) {
    add("contact", 6, "A general inbox");
  } else if (["sales", "support", "help", "licensing", "billing"].includes(local)) {
    add("contact", 0, "A sales or support inbox");
  } else {
    add("contact", 8, "A named or personal company address");
  }

  // 7. Cold email to the EU and UK needs more care (GDPR, PECR).
  const hq = enrichment.profile.hqCountry?.toUpperCase() ?? null;
  const euTld = EU_UK_TLDS.some((tld) => input.domain.endsWith(tld));
  if ((hq !== null && EU_UK.has(hq)) || (hq === null && euTld)) {
    add("region", -20, hq !== null ? `Headquartered in ${hq} (EU/UK)` : "EU/UK country domain");
  }

  const raw = parts.reduce((sum, part) => sum + part.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  return { score, band: score >= 70 ? "strong" : score >= 50 ? "good" : "weak", parts };
}

export function fitSummary(fit: FitScore): string {
  return fit.parts.map((part) => `${part.points >= 0 ? "+" : ""}${part.points} ${part.reason}`).join("\n");
}

/**
 * SH-3: the fit score, 0-100, computed by code from saved facts so it can always be explained.
 * Outrun's ICP (naive/skills/prospector.md): small B2B software companies whose customers are
 * increasingly AI agents — APIs, developer tools, MCP servers, SaaS with a public API.
 * gapScore is separate: how much of the readiness scan fails (100 − score).
 */
export interface FitInput {
  source: string;
  summary: string;
  facts: { key: string; value: string }[];
  contact: { email: string; role: string } | null;
}
export interface FitPart {
  signal: string;
  points: number;
  reason: string;
}

const AGENTIC = /\b(mcp|model context protocol|ai agents?|agentic|llms?|copilot|assistant api)\b/i;
const DEVTOOL =
  /\b(api|apis|sdk|developer|developers|devtools?|cli|infrastructure|platform for (engineers|developers)|open[- ]source)\b/i;
const B2B = /\b(b2b|saas|teams?|businesses|companies|enterprise|startups|smbs?)\b/i;
const CONSUMER = /\b(consumers?|individuals?|personal|dating|games?|fitness|recipes?|travel deals)\b/i;
const BUYER_ROLE =
  /\b(founder|co-?founder|ceo|cto|vp eng|head of (eng|developer|devrel|growth|product)|devrel)\b/i;
export const FREE_MAIL =
  /@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|mac|proton|protonmail|aol|gmx|mail|yandex|zoho|fastmail|hey)\.[a-z.]+$/i;

function headcount(facts: FitInput["facts"]): number | null {
  const v = facts.find((f) => f.key === "headcount")?.value;
  const m = v?.match(/(\d[\d,]*)/);
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
}

export function scoreFit(input: FitInput): { score: number; parts: FitPart[] } {
  const parts: FitPart[] = [];
  const add = (signal: string, points: number, reason: string) => parts.push({ signal, points, reason });
  const text = [input.summary, ...input.facts.map((f) => f.value)].join(" ");

  if (input.source === "mcp_registry") add("agentic", 30, "Already ships an MCP server");
  else if (AGENTIC.test(text)) add("agentic", 25, "Builds for or with AI agents");
  else add("agentic", 0, "No agent angle found");

  if (DEVTOOL.test(text)) add("product", 20, "An API, SDK or developer product");
  else add("product", 5, "Product type unclear");

  if (CONSUMER.test(text) && !B2B.test(text)) add("audience", -15, "Sells mainly to consumers");
  else if (B2B.test(text) || /segment/.test(input.facts.map((f) => f.key).join(" ")))
    add("audience", 15, "Sells to businesses or developers");
  else add("audience", 5, "Audience unclear");

  const size = headcount(input.facts);
  if (size === null) add("size", 10, "Size unknown, likely early");
  else if (size <= 200) add("size", 15, `Small team (${size}+)`);
  else if (size <= 1000) add("size", 5, `Mid-size (${size}+)`);
  else add("size", -10, `Large company (${size}+): slow to buy a $499 kit`);

  if (!input.contact) add("contact", 0, "No business contact yet");
  else if (BUYER_ROLE.test(input.contact.role)) add("contact", 20, `A buyer: ${input.contact.role}`);
  else add("contact", 10, "A business contact");

  const score = Math.max(
    0,
    Math.min(
      100,
      parts.reduce((s, p) => s + p.points, 0),
    ),
  );
  return { score, parts };
}

/** The part of a client's profile its fit score reads. */
export interface ClientIcp {
  includeKeywords: readonly string[];
  excludeKeywords: readonly string[];
  buyerRoles: readonly string[];
  companySizes: readonly string[];
}

const words = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const mentions = (text: string, kw: string) => {
  const k = words(kw).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return k ? new RegExp(`\\b${k}\\b`, "i").test(text) : false;
};

/** A size range like "11-50" or "10001+" contains n. */
function inSize(range: string, n: number): boolean {
  const m = /^(\d+)(?:-(\d+)|\+)$/.exec(range);
  if (!m) return false;
  return n >= Number(m[1]) && (m[2] === undefined || n <= Number(m[2]));
}

/**
 * A client's fit score, 0-100, from its confirmed ICP: keywords the company matches, keywords
 * that rule it out, its size against the sizes asked for, and whether the contact is a buyer.
 */
export function scoreClientFit(icp: ClientIcp, input: FitInput): { score: number; parts: FitPart[] } {
  const parts: FitPart[] = [];
  const add = (signal: string, points: number, reason: string) => parts.push({ signal, points, reason });
  const text = [input.summary, ...input.facts.map((f) => `${f.key} ${f.value}`)].join(" ");

  const hits = icp.includeKeywords.filter((k) => mentions(text, k));
  if (hits.length >= 2) add("match", 40, `Matches ${hits.slice(0, 3).join(", ")}`);
  else if (hits.length === 1) add("match", 25, `Matches ${hits[0]}`);
  else add("match", input.source === "hunter" ? 10 : 0, "No ICP keyword in the saved facts yet");

  const bad = icp.excludeKeywords.filter((k) => mentions(text, k));
  if (bad.length) add("excluded", -40, `Ruled out by ${bad.slice(0, 3).join(", ")}`);

  const size = headcount(input.facts);
  if (!icp.companySizes.length || size === null) add("size", 10, "Size not a constraint or unknown");
  else if (icp.companySizes.some((r) => inSize(r, size))) add("size", 20, `Size fits (${size})`);
  else add("size", -10, `Size ${size} is outside ${icp.companySizes.join(", ")}`);

  if (!input.contact) add("contact", 0, "No business contact yet");
  else if (icp.buyerRoles.some((r) => mentions(input.contact!.role, r)))
    add("contact", 30, `A buyer: ${input.contact.role}`);
  else add("contact", 10, "A business contact");

  const score = Math.max(
    0,
    Math.min(
      100,
      parts.reduce((s, p) => s + p.points, 0),
    ),
  );
  return { score, parts };
}

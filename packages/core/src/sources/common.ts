/** Shared helpers for the discovery sources (SH-2). Source text is untrusted data. */
import { Domain } from "../../contracts";
import type { DiscoveredCompany } from "../integrations/types";
import { safeFetch } from "../safeFetch";

/** Hosts that belong to a platform, not the company: never a prospect's domain. */
const PLATFORM = [
  "github.com",
  "githubusercontent.com",
  "github.io",
  "gitlab.com",
  "bitbucket.org",
  "npmjs.com",
  "pypi.org",
  "smithery.ai",
  "glama.ai",
  "mcp.so",
  "pulsemcp.com",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "workers.dev",
  "pages.dev",
  "onrender.com",
  "fly.dev",
  "railway.app",
  "replit.app",
  "modal.run",
  "ngrok.io",
  "ngrok-free.app",
  "cloudfunctions.net",
  "azurewebsites.net",
  "amazonaws.com",
  "producthunt.com",
  "ycombinator.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "medium.com",
  "substack.com",
  "notion.site",
  "google.com",
  "apple.com",
  "chromewebstore.google.com",
];
const TWO_LEVEL = /\.(co|com|org|net|ac|gov|edu)\.[a-z]{2}$/;

/** The registrable domain of a URL or host ("api.acme.co.uk" → "acme.co.uk"), or null. */
export function registrableDomain(urlOrHost: string | undefined | null): string | null {
  if (!urlOrHost) return null;
  let host: string;
  try {
    host = new URL(/^[a-z]+:\/\//i.test(urlOrHost) ? urlOrHost : `https://${urlOrHost}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":")) return null;
  if (PLATFORM.some((p) => host === p || host.endsWith(`.${p}`))) return null;
  const labels = host.split(".");
  const keep = TWO_LEVEL.test(host) ? 3 : 2;
  const d = labels.slice(-keep).join(".");
  return Domain.safeParse(d).success ? d : null;
}

export const clean = (s: string | undefined | null, max = 500): string =>
  (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** First of each domain wins. */
export function dedupe(list: DiscoveredCompany[]): DiscoveredCompany[] {
  const seen = new Set<string>();
  return list.filter((c) => (seen.has(c.domain) ? false : (seen.add(c.domain), true)));
}

export type SourceFetch = (url: string) => Promise<{ url: string; status: number; body: string }>;

/** Source GETs go through safeFetch: public hosts only, bounded size and time. */
export const sourceFetch: SourceFetch = (url) => safeFetch(url, { maxBytes: 8_000_000, timeoutMs: 20_000 });

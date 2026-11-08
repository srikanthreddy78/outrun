/** Y Combinator companies by tag, from the public yc-oss mirror of the YC directory. Active only. */
import type { DiscoveredCompany } from "../integrations/types";
import { clean, dedupe, registrableDomain, type SourceFetch } from "./common";

export const YC_TAGS = ["developer-tools", "api"] as const;
export const ycUrl = (tag: string) => `https://yc-oss.github.io/api/tags/${tag}.json`;

interface YcCompany {
  slug?: string;
  name?: string;
  website?: string;
  one_liner?: string;
  status?: string;
}

export function parseYc(list: YcCompany[]): DiscoveredCompany[] {
  const out: DiscoveredCompany[] = [];
  for (const c of list) {
    if (c.status !== "Active" || !c.slug) continue;
    const domain = registrableDomain(c.website);
    if (!domain) continue;
    out.push({
      domain,
      name: clean(c.name, 120) || domain,
      source: "yc",
      sourceRef: `yc:${c.slug}`,
      summary: clean(c.one_liner),
    });
  }
  return dedupe(out);
}

export async function fetchYc(get: SourceFetch, limit: number): Promise<DiscoveredCompany[]> {
  const out: DiscoveredCompany[] = [];
  for (const tag of YC_TAGS) {
    const res = await get(ycUrl(tag));
    if (res.status !== 200) throw new Error(`yc ${tag}: HTTP ${res.status}`);
    out.push(...parseYc(JSON.parse(res.body) as YcCompany[]));
  }
  return dedupe(out).slice(0, limit);
}

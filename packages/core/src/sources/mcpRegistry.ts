/**
 * The official MCP Registry (registry.modelcontextprotocol.io): companies that ship an MCP
 * server. The domain comes from websiteUrl, then the first remote's host.
 */
import type { DiscoveredCompany } from "../integrations/types";
import { clean, dedupe, registrableDomain, type SourceFetch } from "./common";

export const MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";

interface RegistryPage {
  servers?: {
    server?: {
      name?: string;
      title?: string;
      description?: string;
      websiteUrl?: string;
      remotes?: { url?: string }[];
    };
  }[];
  metadata?: { nextCursor?: string };
}

export function parseMcpRegistry(page: RegistryPage): {
  companies: DiscoveredCompany[];
  next: string | null;
} {
  const companies: DiscoveredCompany[] = [];
  for (const { server: s } of page.servers ?? []) {
    if (!s?.name) continue;
    const domain = registrableDomain(s.websiteUrl) ?? registrableDomain(s.remotes?.[0]?.url);
    if (!domain) continue;
    companies.push({
      domain,
      name: clean(s.title, 120) || domain,
      source: "mcp_registry",
      sourceRef: s.name,
      summary: clean(s.description),
    });
  }
  return { companies: dedupe(companies), next: page.metadata?.nextCursor ?? null };
}

export async function fetchMcpRegistry(get: SourceFetch, limit: number): Promise<DiscoveredCompany[]> {
  const out: DiscoveredCompany[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10 && out.length < limit; page++) {
    const url = `${MCP_REGISTRY_URL}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await get(url);
    if (res.status !== 200) throw new Error(`mcp registry: HTTP ${res.status}`);
    const { companies, next } = parseMcpRegistry(JSON.parse(res.body) as RegistryPage);
    out.push(...companies);
    if (!next) break;
    cursor = next;
  }
  return dedupe(out).slice(0, limit);
}

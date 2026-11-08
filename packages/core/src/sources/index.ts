/**
 * SH-2: discover(). The MCP Registry first (companies already shipping for agents), then YC
 * developer-tools and API companies, then today's Product Hunt launches. Glama's API now needs a
 * key and attribution under its data license, so it isn't a source until the team has one.
 * In demo mode only the fixture candidates are returned.
 */
import { createFakeDiscover } from "../fakes/others";
import type { DiscoverFn, DiscoveredCompany } from "../integrations/types";
import { logger } from "../log";
import { dedupe, sourceFetch, type SourceFetch } from "./common";
import { fetchMcpRegistry } from "./mcpRegistry";
import { fetchProductHunt } from "./producthunt";
import { fetchYc } from "./yc";

export { registrableDomain } from "./common";
export { parseMcpRegistry } from "./mcpRegistry";
export { parseProductHuntFeed } from "./producthunt";
export { parseYc } from "./yc";

export function createDiscover(opts: { demo: boolean; get?: SourceFetch }): DiscoverFn {
  const get = opts.get ?? sourceFetch;
  const fixtures = createFakeDiscover();
  return async ({ limit }) => {
    if (opts.demo) return fixtures({ limit });
    const out: DiscoveredCompany[] = [];
    for (const [name, run] of [
      ["mcp_registry", fetchMcpRegistry],
      ["yc", fetchYc],
      ["producthunt", fetchProductHunt],
    ] as const) {
      if (out.length >= limit) break;
      try {
        out.push(...(await run(get, limit - out.length)));
      } catch (err) {
        // A source being down costs its candidates, not the run.
        logger.warn({ source: name, err: (err as Error).message }, "discovery source failed");
      }
    }
    return dedupe(out).slice(0, limit);
  };
}

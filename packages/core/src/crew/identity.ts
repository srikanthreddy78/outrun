/**
 * A crew member is one client's role. Outrun's crew keeps the names it had before clients
 * existed (`sdr`); any other client's crew is `<slug>-<role>` (`acme-sdr`) on Naive and
 * /api/crew/mcp/<slug>/<role> on our side.
 */
import { AGENTS, type AgentName } from "../../contracts";
import { OUTRUN_CLIENT_SLUG } from "../constants";

export function naiveAgentName(agent: AgentName, clientSlug: string = OUTRUN_CLIENT_SLUG): string {
  return clientSlug === OUTRUN_CLIENT_SLUG ? agent : `${clientSlug}-${agent}`;
}

/** The client and role behind a Naive agent name, or null for an agent that isn't ours. */
export function parseNaiveAgentName(name: string): { agent: AgentName; clientSlug: string } | null {
  if ((AGENTS as readonly string[]).includes(name))
    return { agent: name as AgentName, clientSlug: OUTRUN_CLIENT_SLUG };
  for (const a of AGENTS) {
    if (!name.endsWith(`-${a}`)) continue;
    const slug = name.slice(0, -(a.length + 1));
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug !== OUTRUN_CLIENT_SLUG)
      return { agent: a, clientSlug: slug };
  }
  return null;
}

export function crewMcpPath(agent: AgentName, clientSlug: string = OUTRUN_CLIENT_SLUG): string {
  return clientSlug === OUTRUN_CLIENT_SLUG ? agent : `${clientSlug}/${agent}`;
}

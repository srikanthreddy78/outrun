/**
 * A crew member is one client's role. Outrun's crew keeps the names it had before clients
 * existed (`sdr`); any other client's crew is `<slug>-<role>` (`acme-sdr`) on Naive and
 * /api/crew/mcp/<slug>/<role> on our side. Naive names use dashes, so `account_manager` is
 * `acme-account-manager` there.
 */
import { type AgentName, CLIENT_ROLES, OUTRUN_AGENTS } from "../../contracts";
import { OUTRUN_CLIENT_SLUG } from "../constants";

/** A role as Naive spells it: lowercase letters, digits and dashes. */
export const naiveRole = (agent: AgentName): string => agent.replace(/_/g, "-");

export function naiveAgentName(agent: AgentName, clientSlug: string = OUTRUN_CLIENT_SLUG): string {
  return clientSlug === OUTRUN_CLIENT_SLUG ? naiveRole(agent) : `${clientSlug}-${naiveRole(agent)}`;
}

/** The client and role behind a Naive agent name, or null for an agent that isn't ours. */
export function parseNaiveAgentName(name: string): { agent: AgentName; clientSlug: string } | null {
  if ((OUTRUN_AGENTS as readonly string[]).includes(name))
    return { agent: name as AgentName, clientSlug: OUTRUN_CLIENT_SLUG };
  // The CEO serves the whole agency, so no client has one.
  for (const a of CLIENT_ROLES) {
    const n = naiveRole(a);
    if (!name.endsWith(`-${n}`)) continue;
    const slug = name.slice(0, -(n.length + 1));
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug !== OUTRUN_CLIENT_SLUG)
      return { agent: a, clientSlug: slug };
  }
  return null;
}

export function crewMcpPath(agent: AgentName, clientSlug: string = OUTRUN_CLIENT_SLUG): string {
  return clientSlug === OUTRUN_CLIENT_SLUG ? agent : `${clientSlug}/${agent}`;
}

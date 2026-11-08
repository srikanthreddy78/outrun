import { createHmac, timingSafeEqual } from "node:crypto";
import { AGENTS, type AgentName, CLIENT_ROLES } from "../../contracts";
import { OUTRUN_CLIENT_SLUG } from "../constants";

/**
 * The bearer token one crew member presents to its crew MCP URL. A crew member is a client's
 * role: Outrun's crew signs `outrun-crew:<role>` (its tokens predate clients and stay valid);
 * any other client's signs `outrun-crew:<slug>:<role>`, so no client's token opens another's.
 */
export function crewToken(secret: string, agent: AgentName, clientSlug: string = OUTRUN_CLIENT_SLUG): string {
  const subject = clientSlug === OUTRUN_CLIENT_SLUG ? agent : `${clientSlug}:${agent}`;
  return createHmac("sha256", secret).update(`outrun-crew:${subject}`).digest("base64url");
}

/** Constant-time check that `presented` is this crew member's token. */
export function verifyCrewToken(
  secret: string,
  agent: AgentName,
  presented: string | null | undefined,
  clientSlug: string = OUTRUN_CLIENT_SLUG,
): boolean {
  if (!presented) return false;
  const want = Buffer.from(crewToken(secret, agent, clientSlug));
  const got = Buffer.from(presented);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Client slugs: lowercase letters, digits and single hyphens; they appear in agent names and URLs. */
export const CLIENT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Env var names `naive up` reads the vault credentials from. */
export const crewTokenEnv = (agent: AgentName, clientSlug: string = OUTRUN_CLIENT_SLUG): string =>
  clientSlug === OUTRUN_CLIENT_SLUG
    ? `CREW_TOKEN_${agent.toUpperCase()}`
    : `CREW_TOKEN_${clientSlug.replace(/-/g, "_").toUpperCase()}_${agent.toUpperCase()}`;

export function crewTokenEnvAll(
  secret: string,
  clientSlugs: readonly string[] = [OUTRUN_CLIENT_SLUG],
): Record<string, string> {
  return Object.fromEntries(
    clientSlugs.flatMap((slug) =>
      // The CEO is the agency's, not a client's: only Outrun's slug carries it.
      (slug === OUTRUN_CLIENT_SLUG ? AGENTS : CLIENT_ROLES).map((a) => [
        crewTokenEnv(a, slug),
        crewToken(secret, a, slug),
      ]),
    ),
  );
}

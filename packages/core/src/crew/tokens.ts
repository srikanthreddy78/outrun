import { createHmac, timingSafeEqual } from "node:crypto";
import { AGENTS, type AgentName } from "../../contracts";

/** The bearer token one agent presents to /api/crew/mcp/<agent>: HMAC(CREW_TOKEN_SECRET, agent). */
export function crewToken(secret: string, agent: AgentName): string {
  return createHmac("sha256", secret).update(`outrun-crew:${agent}`).digest("base64url");
}

/** Constant-time check that `presented` is this agent's token. */
export function verifyCrewToken(
  secret: string,
  agent: AgentName,
  presented: string | null | undefined,
): boolean {
  if (!presented) return false;
  const want = Buffer.from(crewToken(secret, agent));
  const got = Buffer.from(presented);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Env var names `naive up` reads the vault credentials from. */
export const crewTokenEnv = (agent: AgentName): string => `CREW_TOKEN_${agent.toUpperCase()}`;

export function crewTokenEnvAll(secret: string): Record<string, string> {
  return Object.fromEntries(AGENTS.map((a) => [crewTokenEnv(a), crewToken(secret, a)]));
}

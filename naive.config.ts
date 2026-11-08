/**
 * Outrun's crew on Naive. `pnpm naive:up --dry-run` previews it; only Srikanth applies it, from
 * main, after reviewing the dry run. Everything here is generated from naive/crew.ts.
 *
 * APP_URL must be the deployed https origin: each agent's MCP server is <APP_URL>/api/crew/mcp/<agent>,
 * and its bearer token (CREW_TOKEN_<AGENT>, derived from CREW_TOKEN_SECRET by scripts/naive-up.ts)
 * sits in the vault, keyed by that URL. Agents never see the token.
 */
import { defineProject } from "@usenaive-sdk/blueprints";
import { AGENTS } from "./packages/core/contracts";
import { crewTokenEnv } from "./packages/core/src/crew/tokens";
import { IDENTITY, PROJECT_NAME, VAULT, crew, crewMcpUrl } from "./naive/crew";
import { MCP_SERVER_NAME } from "./packages/core/contracts";

const appUrl = process.env.APP_URL ?? "";
if (!/^https:\/\//.test(appUrl) && process.env.NAIVE_CONFIG_ALLOW_LOCAL !== "1") {
  throw new Error(
    "naive.config.ts: APP_URL must be the deployed https origin (e.g. https://outrun.vercel.app)",
  );
}

export default defineProject({
  name: PROJECT_NAME,
  description: "Outrun: an autonomous growth crew for agent-native businesses.",
  skills: AGENTS.map((a) => ({ slug: a, file: `naive/skills/${a}.md` })),
  identities: [{ name: IDENTITY, description: "Outrun's crew persona" }],
  vaults: [
    {
      // Org-wide, not bound to the persona: sessions name no identity, and a persona-bound vault
      // is only used by sessions that carry that identity.
      name: VAULT,
      credentials: AGENTS.map((a) => ({
        kind: "static_bearer" as const,
        key: `crew-${a}`,
        mcp_server_url: crewMcpUrl(appUrl, a),
        value: { from_env: crewTokenEnv(a) },
      })),
    },
  ],
  agents: crew(appUrl).map((a) => ({
    name: a.name,
    description: a.description,
    model: a.model,
    budget: a.budget,
    system: a.system,
    skills: a.skills,
    identity: IDENTITY,
    tools: a.tools,
    mcp_servers: [{ name: MCP_SERVER_NAME, url: a.mcpUrl }],
    // No multiagent team (coming soon on Naive) and no handoffs; outrun.plan_day starts sessions.
    handoffs: false as const,
    ...(a.schedule
      ? {
          schedules: [
            {
              cron: a.schedule.cron,
              timezone: a.schedule.timezone,
              input: a.schedule.input,
              budget_micro_usd: a.schedule.budget_micro_usd,
            },
          ],
        }
      : {}),
  })),
});

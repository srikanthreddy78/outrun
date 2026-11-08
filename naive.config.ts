/**
 * The agency on Naive: the CEO, Outrun's own crew, and one six-agent crew per client listed in
 * .naive/clients.json (written by `pnpm clients:export`). `pnpm naive:up --dry-run` previews it;
 * only Srikanth applies it, from main, after reviewing the dry run. Everything here is generated
 * from naive/crew.ts.
 *
 * APP_URL must be the deployed https origin: each agent's MCP server is
 * <APP_URL>/api/crew/mcp/<role> (Outrun's crew and the CEO) or <APP_URL>/api/crew/mcp/<slug>/<role>,
 * and its bearer token (CREW_TOKEN_<..>, derived from CREW_TOKEN_SECRET by scripts/naive-up.ts)
 * sits in the vault, keyed by that URL. Agents never see the token.
 */
import { defineProject } from "@usenaive-sdk/blueprints";
import { IDENTITY, PROJECT_NAME, VAULT, crew, loadClientCrews, skillFiles } from "./naive/crew";
import { MCP_SERVER_NAME } from "./packages/core/contracts";

const appUrl = process.env.APP_URL ?? "";
if (!/^https:\/\//.test(appUrl) && process.env.NAIVE_CONFIG_ALLOW_LOCAL !== "1") {
  throw new Error(
    "naive.config.ts: APP_URL must be the deployed https origin (e.g. https://outrun.vercel.app)",
  );
}

const members = crew(appUrl, loadClientCrews());

export default defineProject({
  name: PROJECT_NAME,
  description: "Outrun: an agency of AI crews, one per client, run by a CEO agent.",
  skills: skillFiles(),
  identities: [{ name: IDENTITY, description: "Outrun's crew persona" }],
  vaults: [
    {
      // Org-wide, not bound to the persona: sessions name no identity, and a persona-bound vault
      // is only used by sessions that carry that identity.
      name: VAULT,
      credentials: members.map((a) => ({
        kind: "static_bearer" as const,
        key: `crew-${a.name}`,
        mcp_server_url: a.mcpUrl,
        value: { from_env: a.tokenEnv },
      })),
    },
  ],
  agents: members.map((a) => ({
    name: a.name,
    description: a.description,
    model: a.model,
    budget: a.budget,
    system: a.system,
    skills: a.skills,
    identity: IDENTITY,
    tools: a.tools,
    mcp_servers: [{ name: MCP_SERVER_NAME, url: a.mcpUrl }],
    // No multiagent team (coming soon on Naive) and no handoffs; outrun.plan_day and
    // outrun.kick_client start sessions.
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

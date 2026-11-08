/**
 * provision_client_crew: gives a self-serve client its six Naive agents at runtime, through the
 * Naive REST API, instead of waiting for the owner's `pnpm clients:export && naive up`.
 *
 *   agents (POST /v1/agents, the same body naive.config.ts declares: naive/crew.ts agentConfig)
 *   → vault tokens (POST /v1/vaults/{id}/credentials into the org vault naive up made)
 *   → schedules (POST /v1/deployments, for members that have one; client crews have none today:
 *     the CEO starts their days with outrun.kick_client)
 *   → client.crew_provisioned, then startProfiling: the client's researcher drafts the profile.
 *
 * Idempotent: anything that already exists by name (agents), key and URL (credentials) or agent
 * and cron (deployments) is skipped, every POST carries an Idempotency-Key, and a 409 counts as
 * done. A missing key, a key without agents:write or admin, or no vault yet ends in
 * client.crew_pending with the reason; the owner then runs clients:export and naive up.
 * Token values are derived here and sent to Naive only; they are never logged or emitted.
 */
import { eq } from "drizzle-orm";
import { agentConfig, clientCrew, credentialKey, VAULT } from "../../../naive/crew";
import { startProfiling, type ClientDeps } from "./clients";
import { OUTRUN_CLIENT_ID } from "./constants";
import { crewToken } from "./crew/tokens";
import type { Db } from "./db/client";
import { clients } from "./db/schema";
import { AppError } from "./errors";
import type { Emit } from "./events";
import type { NaiveClient } from "./integrations/types";

export interface ProvisionDeps {
  db: Db;
  emit: Emit;
  enqueue: ClientDeps["enqueue"];
  /** null when NAIVE_API_KEY isn't set (the runtime is on the fake). */
  naive: NaiveClient | null;
  appUrl: string;
  /** CREW_TOKEN_SECRET: the crew tokens are derived from it, exactly as for naive up. */
  secret: string | undefined;
  /** The client's members; naive/crew.ts clientCrew unless a test gives one a schedule. */
  crew?: typeof clientCrew;
}

export type ProvisionResult =
  | { status: "provisioned"; agents: string[]; created: string[]; credentials: number; deployments: number }
  | { status: "pending"; reason: string };

/** A 409, or an error code saying so: someone (naive up, an earlier try) made it first. */
const exists = (err: unknown) =>
  err instanceof AppError && (err.code === "conflict" || /already_exists|already exists/.test(err.message));

/** 401/403: the key lacks agents:write (agents) or admin (vault credentials). */
const scopeError = (err: unknown) =>
  err instanceof AppError && (err.code === "not_configured" || err.code === "forbidden");

export async function provisionClientCrew(deps: ProvisionDeps, clientId: string): Promise<ProvisionResult> {
  const [c] = await deps.db.select().from(clients).where(eq(clients.id, clientId));
  if (!c || c.id === OUTRUN_CLIENT_ID) throw new AppError("not_found", "no such client");

  const pending = async (reason: string): Promise<ProvisionResult> => {
    await deps.emit({
      actor: "worker",
      type: "client.crew_pending",
      entityType: "client",
      entityId: c.id,
      payload: { slug: c.slug, reason, fallback: "pnpm clients:export && pnpm naive:up" },
    });
    return { status: "pending", reason };
  };
  if (!deps.naive) return pending("NAIVE_API_KEY is not set");
  if (!deps.secret) return pending("CREW_TOKEN_SECRET is not set");
  if (!/^https:\/\//.test(deps.appUrl)) return pending("APP_URL must be the deployed https origin");
  const naive = deps.naive;
  const members = (deps.crew ?? clientCrew)(deps.appUrl, { slug: c.slug, name: c.name });
  const key = (what: string) => `provision:${c.id}:${what}`;

  const created: string[] = [];
  let credentials = 0;
  let deployments = 0;
  try {
    const ids = new Map((await naive.listAgents()).map((a) => [a.name, a.id]));
    let raced = false;
    for (const m of members) {
      if (ids.has(m.name)) continue;
      try {
        const { id } = await naive.createAgent(agentConfig(m), key(m.name));
        ids.set(m.name, id);
        created.push(m.name);
      } catch (err) {
        if (!exists(err)) throw err;
        raced = true;
      }
    }
    if (raced) for (const a of await naive.listAgents()) ids.set(a.name, a.id);

    const vault = (await naive.listVaults()).find((v) => v.name === VAULT);
    if (!vault) return pending(`no vault named ${VAULT}; run naive up once to create it`);
    const rows = await naive.listCredentials(vault.id);
    for (const m of members) {
      const k = credentialKey(m);
      if (rows.some((r) => r.kind === "static_bearer" && r.key === k && r.mcp_server_url === m.mcpUrl))
        continue;
      try {
        await naive.createCredential(
          vault.id,
          {
            kind: "static_bearer",
            key: k,
            value: crewToken(deps.secret, m.role, c.slug),
            mcp_server_url: m.mcpUrl,
          },
          key(k),
        );
        credentials++;
      } catch (err) {
        if (!exists(err)) throw err;
      }
    }

    const scheduled = members.filter((m) => m.schedule);
    if (scheduled.length) {
      const live = await naive.listDeployments();
      for (const m of scheduled) {
        const s = m.schedule!;
        const agentId = ids.get(m.name);
        if (!agentId || live.some((d) => d.agent_id === agentId && d.cron === s.cron)) continue;
        try {
          await naive.createDeployment(
            {
              agent_id: agentId,
              cron: s.cron,
              timezone: s.timezone,
              input_template: s.input,
              budget_micro_usd: s.budget_micro_usd,
            },
            key(`${m.name}:schedule`),
          );
          deployments++;
        } catch (err) {
          if (!exists(err)) throw err;
        }
      }
    }
  } catch (err) {
    if (scopeError(err)) return pending((err as AppError).message);
    throw err;
  }

  const agents = members.map((m) => m.name);
  await deps.emit({
    actor: "worker",
    type: "client.crew_provisioned",
    entityType: "client",
    entityId: c.id,
    payload: { slug: c.slug, agents, created, credentials, deployments },
  });
  // The crew exists: its researcher drafts the profile. A later run finds it past profiling.
  const [now] = await deps.db.select({ status: clients.status }).from(clients).where(eq(clients.id, c.id));
  if (now?.status === "draft" || now?.status === "profiling") await startProfiling(deps, c.id, "worker");
  return { status: "provisioned", agents, created, credentials, deployments };
}

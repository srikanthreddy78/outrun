/**
 * The crew's tool server. Outrun's crew is at /api/crew/mcp/<role>; any other client's crew at
 * /api/crew/mcp/<client slug>/<role>. Each crew member connects with its own bearer (HMAC of
 * CREW_TOKEN_SECRET, its client and role, sealed in the Naive vault) and sees only its role's
 * tools, registered unprefixed so Naive shows them as `outrun.<tool>`, working on its client's
 * rows only. Every call is a ledger event with actor `naive:<agent>` (`naive:<slug>-<agent>` for
 * other clients). Errors come back as the contract's ErrorBody.
 */
import { randomUUID } from "node:crypto";
import { createMcpHandler } from "mcp-handler";
import type { z } from "zod";
import { AGENTS, type AgentName, type ErrorBody } from "@outrun/core/contracts";
import { CLIENT_SLUG_RE, verifyCrewToken } from "@outrun/core/crew/tokens";
import { OUTRUN_CLIENT_ID, OUTRUN_CLIENT_SLUG } from "@outrun/core/constants";
import { clients, eq } from "@outrun/core/db/query";
import { AppError, toAppError } from "@outrun/core";
import type { Runtime } from "@outrun/core/runtime";
import type { ToolContext } from "@outrun/core/crew";
import { logger } from "@outrun/core/log";

type CrewRuntime = Pick<Runtime, "config" | "db" | "emit" | "queue" | "registry">;

function errorResponse(err: AppError, requestId: string): Response {
  return Response.json(err.toBody(requestId) satisfies ErrorBody, { status: err.status });
}

export interface CrewMember {
  agent: AgentName;
  clientSlug: string;
}

/**
 * Agent and bearer checks, from config alone, before any database work. `path` is the part of
 * the URL after /api/crew/mcp/: `<role>` for Outrun's crew, `<client slug>/<role>` for another's.
 */
export function authorizeCrew(
  secret: string | undefined,
  path: string,
  req: Request,
): CrewMember | { response: Response } {
  const requestId = randomUUID();
  const parts = path.split("/");
  const [clientSlug, agentParam] = parts.length === 2 ? parts : [OUTRUN_CLIENT_SLUG, parts[0]];
  if (
    parts.length > 2 ||
    !agentParam ||
    !clientSlug ||
    !CLIENT_SLUG_RE.test(clientSlug) ||
    (parts.length === 2 && clientSlug === OUTRUN_CLIENT_SLUG) ||
    !(AGENTS as readonly string[]).includes(agentParam)
  ) {
    return { response: errorResponse(new AppError("not_found", "unknown agent"), requestId) };
  }
  const agent = agentParam as AgentName;
  if (!secret) {
    return {
      response: errorResponse(new AppError("not_configured", "crew tokens are not configured"), requestId),
    };
  }
  const bearer = req.headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
    ?.trim();
  if (!verifyCrewToken(secret, agent, bearer, clientSlug)) {
    return { response: errorResponse(new AppError("unauthorized", "invalid crew token"), requestId) };
  }
  return { agent, clientSlug };
}

export async function crewMcpResponse(rt: CrewRuntime, path: string, req: Request): Promise<Response> {
  const auth = authorizeCrew(rt.config.keys.crewTokenSecret, path, req);
  if ("response" in auth) return auth.response;
  return serveCrew(rt, auth, req);
}

/** The client behind a verified slug: Outrun needs no lookup; a paused or unknown client is refused. */
async function resolveClient(rt: CrewRuntime, slug: string): Promise<string | AppError> {
  if (slug === OUTRUN_CLIENT_SLUG) return OUTRUN_CLIENT_ID;
  const [c] = await rt.db.db
    .select({ id: clients.id, status: clients.status })
    .from(clients)
    .where(eq(clients.slug, slug));
  if (!c) return new AppError("not_found", "unknown agent");
  if (c.status === "paused") return new AppError("forbidden", "this client is paused");
  return c.id;
}

/** For an authorized crew member: its role's tools only, on its client's rows only. */
export async function serveCrew(rt: CrewRuntime, member: CrewMember, req: Request): Promise<Response> {
  const { agent, clientSlug } = member;
  const clientId = await resolveClient(rt, clientSlug);
  if (clientId instanceof AppError) return errorResponse(clientId, randomUUID());
  const actor = clientSlug === OUTRUN_CLIENT_SLUG ? `naive:${agent}` : `naive:${clientSlug}-${agent}`;
  const handler = createMcpHandler(
    (server) => {
      for (const tool of rt.registry.forAgent(agent)) {
        const inputSchema = tool.input as unknown as z.ZodObject<z.ZodRawShape>;
        server.registerTool(tool.name, { description: tool.description, inputSchema }, async (args) => {
          const callId = randomUUID();
          const ctx: ToolContext = {
            agent,
            clientId,
            requestId: callId,
            db: rt.db.db,
            now: () => new Date(),
            enqueue: (job, o) => rt.queue.enqueue(job, o),
            emit: rt.emit,
          };
          const record = (payload: Record<string, unknown>) =>
            rt
              .emit({
                actor,
                type: "tool.called",
                entityType: "system",
                entityId: tool.name,
                payload: { tool: tool.name, requestId: callId, ...payload },
              })
              .catch((err: unknown) => logger.error({ err, tool: tool.name }, "tool.called event failed"));
          let result: unknown;
          try {
            result = await rt.registry.call(agent, tool.name, args, ctx);
          } catch (err) {
            const e = toAppError(err);
            if (e.code === "internal")
              logger.error({ err: e.cause ?? err, tool: tool.name, agent }, "crew tool failed");
            await record({ ok: false, code: e.code });
            return {
              isError: true,
              content: [{ type: "text" as const, text: JSON.stringify(e.toBody(callId)) }],
            };
          }
          // The tool's work is done; a failed ledger write must not tell the agent it failed.
          await record({ ok: true });
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        });
      }
    },
    { serverInfo: { name: "outrun", version: "0.1.0" } },
  );
  return handler(req);
}

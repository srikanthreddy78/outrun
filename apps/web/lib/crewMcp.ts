/**
 * The crew's tool server: /api/crew/mcp/<agent>. Each agent connects with its own bearer
 * (HMAC of CREW_TOKEN_SECRET and its name, sealed in the Naive vault) and sees only its own
 * tools, registered unprefixed so Naive shows them as `outrun.<tool>`. Every call is a ledger
 * event with actor `naive:<agent>`. Errors come back as the contract's ErrorBody.
 */
import { randomUUID } from "node:crypto";
import { createMcpHandler } from "mcp-handler";
import type { z } from "zod";
import { AGENTS, type AgentName, type ErrorBody } from "@outrun/core/contracts";
import { verifyCrewToken } from "@outrun/core/crew/tokens";
import { AppError, toAppError } from "@outrun/core";
import type { Runtime } from "@outrun/core/runtime";
import type { ToolContext } from "@outrun/core/crew";
import { logger } from "@outrun/core/log";

type CrewRuntime = Pick<Runtime, "config" | "db" | "emit" | "queue" | "registry">;

function errorResponse(err: AppError, requestId: string): Response {
  return Response.json(err.toBody(requestId) satisfies ErrorBody, { status: err.status });
}

/** Agent and bearer checks, from config alone, before any database work. */
export function authorizeCrew(
  secret: string | undefined,
  agentParam: string,
  req: Request,
): { agent: AgentName } | { response: Response } {
  const requestId = randomUUID();
  if (!(AGENTS as readonly string[]).includes(agentParam)) {
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
  if (!verifyCrewToken(secret, agent, bearer)) {
    return { response: errorResponse(new AppError("unauthorized", "invalid crew token"), requestId) };
  }
  return { agent };
}

export async function crewMcpResponse(rt: CrewRuntime, agentParam: string, req: Request): Promise<Response> {
  const auth = authorizeCrew(rt.config.keys.crewTokenSecret, agentParam, req);
  if ("response" in auth) return auth.response;
  return serveCrew(rt, auth.agent, req);
}

/** For an authorized agent: its tools only. */
export async function serveCrew(rt: CrewRuntime, agent: AgentName, req: Request): Promise<Response> {
  const handler = createMcpHandler(
    (server) => {
      for (const tool of rt.registry.forAgent(agent)) {
        const inputSchema = tool.input as unknown as z.ZodObject<z.ZodRawShape>;
        server.registerTool(tool.name, { description: tool.description, inputSchema }, async (args) => {
          const callId = randomUUID();
          const ctx: ToolContext = {
            agent,
            requestId: callId,
            db: rt.db.db,
            now: () => new Date(),
            enqueue: (job, o) => rt.queue.enqueue(job, o),
            emit: rt.emit,
          };
          const record = (payload: Record<string, unknown>) =>
            rt
              .emit({
                actor: `naive:${agent}`,
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

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

type CrewRuntime = Pick<Runtime, "config" | "db" | "emit" | "queue" | "registry">;

function errorResponse(err: AppError, requestId: string): Response {
  return Response.json(err.toBody(requestId) satisfies ErrorBody, { status: err.status });
}

export async function crewMcpResponse(rt: CrewRuntime, agentParam: string, req: Request): Promise<Response> {
  const requestId = randomUUID();
  if (!(AGENTS as readonly string[]).includes(agentParam)) {
    return errorResponse(new AppError("not_found", "unknown agent"), requestId);
  }
  const agent = agentParam as AgentName;
  const secret = rt.config.keys.crewTokenSecret;
  if (!secret) return errorResponse(new AppError("not_configured", "crew tokens are not configured"), requestId);
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!verifyCrewToken(secret, agent, bearer)) {
    return errorResponse(new AppError("unauthorized", "invalid crew token"), requestId);
  }

  const handler = createMcpHandler(
    (server) => {
      for (const tool of rt.registry.forAgent(agent)) {
        const inputSchema = tool.input as unknown as z.ZodObject<z.ZodRawShape>;
        server.registerTool(
          tool.name,
          { description: tool.description, inputSchema },
          async (args) => {
            const callId = randomUUID();
            const ctx: ToolContext = {
              agent,
              requestId: callId,
              db: rt.db.db,
              now: () => new Date(),
              enqueue: (job, o) => rt.queue.enqueue(job, o),
              emit: rt.emit,
            };
            try {
              const result = await rt.registry.call(agent, tool.name, args, ctx);
              await rt.emit({
                actor: `naive:${agent}`,
                type: "tool.called",
                entityType: "system",
                entityId: tool.name,
                payload: { tool: tool.name, ok: true, requestId: callId },
              });
              return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
            } catch (err) {
              const e = toAppError(err);
              await rt
                .emit({
                  actor: `naive:${agent}`,
                  type: "tool.called",
                  entityType: "system",
                  entityId: tool.name,
                  payload: { tool: tool.name, ok: false, code: e.code, requestId: callId },
                })
                .catch(() => {});
              return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(e.toBody(callId)) }] };
            }
          },
        );
      }
    },
    { serverInfo: { name: "outrun", version: "0.1.0" } },
  );
  return handler(req);
}

/**
 * Wiring for the public, agent-facing endpoints: /api/mcp, /api/a2a and the discovery files.
 * The tools themselves live in @outrun/core/public; this file only connects them to the
 * runtime and to Matthew's scan service.
 */
import { randomUUID } from "node:crypto";
import { createMcpHandler } from "mcp-handler";
import type { z } from "zod";
import { PUBLIC_TOOLS, type PublicToolName } from "@outrun/core/contracts";
import { AppError } from "@outrun/core";
import { logger } from "@outrun/core/log";
import { callPublicTool, type PublicDeps } from "@outrun/core/public/service";
import { getRuntime } from "./runtime";
import { requesterIp, scanService } from "./scan-service";

export { requesterIp };

export async function publicDeps(): Promise<PublicDeps> {
  const rt = await getRuntime();
  return {
    db: rt.db.db,
    emit: rt.emit,
    stripe: rt.integrations.stripe,
    appUrl: rt.config.appUrl,
    selfServe: {
      enqueue: (j) => rt.queue.enqueue(j),
      sendTransactional: rt.integrations.sendTransactional,
      secret: rt.config.keys.crewTokenSecret,
    },
    scan: async (domain, ip) => {
      const service = await scanService();
      if (!service)
        throw new AppError("not_configured", "scanning is unavailable right now", { retryable: true });
      return service.request(domain, ip);
    },
  };
}

const READ_ONLY: Record<PublicToolName, boolean> = {
  get_readiness_score: true,
  get_quote: true,
  buy_audit: false,
  get_order_status: true,
  hire_agency: false,
};

/** The public MCP server: the five tools, no auth, structured output on every call. */
export function publicMcpHandler(deps: () => Promise<PublicDeps>, callerIp: string) {
  return createMcpHandler(
    (server) => {
      for (const name of Object.keys(PUBLIC_TOOLS) as PublicToolName[]) {
        const def = PUBLIC_TOOLS[name];
        server.registerTool(
          name,
          {
            title: name.replace(/_/g, " "),
            description: def.description,
            inputSchema: def.input as unknown as z.ZodObject<z.ZodRawShape>,
            outputSchema: def.output as unknown as z.ZodObject<z.ZodRawShape>,
            annotations: {
              readOnlyHint: READ_ONLY[name],
              idempotentHint: true,
              destructiveHint: false,
              openWorldHint: name === "get_readiness_score",
            },
          },
          async (args) => {
            const requestId = randomUUID();
            try {
              const out = await callPublicTool(await deps(), name, args, {
                protocol: "mcp",
                callerIp,
                requestId,
              });
              return {
                structuredContent: out as Record<string, unknown>,
                content: [{ type: "text" as const, text: JSON.stringify(out) }],
              };
            } catch (err) {
              const e = err instanceof AppError ? err : new AppError("internal", "internal error");
              if (e.code === "internal") logger.error({ err, tool: name }, "public tool failed");
              return {
                isError: true,
                content: [{ type: "text" as const, text: JSON.stringify(e.toBody(requestId)) }],
              };
            }
          },
        );
      }
    },
    {
      serverInfo: { name: "outrun", version: "1.0.0" },
      instructions:
        "Outrun scores agent-readiness and sells audits. Call get_quote, then buy_audit with your own idempotencyKey, pay at checkoutUrl, and poll get_order_status until the state is delivered. To hire Outrun's agency for a free outbound trial, call hire_agency.",
    },
  );
}

/** Discovery documents are public and cacheable for a few minutes. */
export const discoveryHeaders = (type: string): Record<string, string> => ({
  "content-type": type,
  "cache-control": "public, max-age=300",
  "access-control-allow-origin": "*",
});

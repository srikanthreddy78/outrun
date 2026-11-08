import { config } from "@outrun/core";
import { mcpServerCard } from "@outrun/core/public/discovery";
import { discoveryHeaders } from "@/lib/public";

export const dynamic = "force-dynamic";

/** Describes the public MCP server, so a client can find /api/mcp and its tools without connecting. */
export function GET(): Response {
  return new Response(JSON.stringify(mcpServerCard(config().appUrl), null, 2), {
    headers: discoveryHeaders("application/json"),
  });
}

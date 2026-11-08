import { publicDeps, publicMcpHandler, requesterIp } from "@/lib/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The public MCP server for other companies' agents (Streamable HTTP, no auth). */
async function handle(req: Request): Promise<Response> {
  return publicMcpHandler(publicDeps, requesterIp(req))(req);
}

export { handle as GET, handle as POST, handle as DELETE };

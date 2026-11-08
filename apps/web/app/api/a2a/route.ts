import { handleA2a } from "@outrun/core/public/a2a";
import { logger } from "@outrun/core/log";
import { publicDeps, requesterIp } from "@/lib/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };

/** A2A JSON-RPC 2.0 for other companies' agents: message/send and tasks/get. */
export async function POST(req: Request): Promise<Response> {
  const body = await req.text();
  if (body.length > 64 * 1024) {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } },
      { status: 413, headers: CORS },
    );
  }
  try {
    const reply = await handleA2a(await publicDeps(), body, { callerIp: requesterIp(req) });
    return Response.json(reply, { headers: CORS });
  } catch (err) {
    logger.error({ err }, "a2a request failed");
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } },
      { status: 503, headers: { ...CORS, "retry-after": "30" } },
    );
  }
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: { ...CORS, "access-control-allow-methods": "POST, OPTIONS" },
  });
}

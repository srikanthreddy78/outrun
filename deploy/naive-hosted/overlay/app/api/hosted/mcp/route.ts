/**
 * The Naive-hosted build's own MCP endpoint (deploy/naive-hosted): one `tick` tool, offered to
 * the hosted project's ticker agent as `outrun-hosted.tick`. Its schedule is what replaces the
 * always-on worker. The bearer is the token Naive mints for this app's agents (VETTA_MCP_TOKEN).
 */
import { bearerMatches, status, tick } from "../../../../hosted/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TOOLS = [
  {
    name: "tick",
    description:
      "Run the Outrun worker for about 30 seconds: process queued jobs and fire due crons. Returns job counts.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "status",
    description: "Read-only counts of prospects, messages, sessions and jobs, and the latest events.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: { name?: string } };
const result = (id: Rpc["id"], value: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result: value });

export async function POST(req: Request): Promise<Response> {
  if (
    !bearerMatches(
      req.headers.get("authorization"),
      process.env.VETTA_MCP_TOKEN,
      process.env.NAIVE_HOSTED_ADMIN_TOKEN,
    )
  ) {
    return Response.json({ error: "missing or invalid bearer token" }, { status: 401 });
  }
  const msg = (await req.json().catch(() => ({}))) as Rpc;
  if (msg.method?.startsWith("notifications/")) return new Response(null, { status: 202 });
  if (msg.method === "initialize") {
    return Response.json(
      result(msg.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "outrun-hosted", version: "0.1.0" },
      }),
    );
  }
  if (msg.method === "ping") return Response.json(result(msg.id, {}));
  if (msg.method === "tools/list") return Response.json(result(msg.id, { tools: TOOLS }));
  if (msg.method === "tools/call") {
    try {
      const out = msg.params?.name === "status" ? await status() : await tick(30);
      return Response.json(result(msg.id, { content: [{ type: "text", text: JSON.stringify(out) }] }));
    } catch (error) {
      return Response.json(
        result(msg.id, {
          content: [{ type: "text", text: (error as Error).message.slice(0, 300) }],
          isError: true,
        }),
      );
    }
  }
  return Response.json({
    jsonrpc: "2.0",
    id: msg.id ?? null,
    error: { code: -32601, message: "method not found" },
  });
}

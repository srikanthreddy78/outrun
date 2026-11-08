import { crewMcpResponse } from "@/lib/crewMcp";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request, ctx: { params: Promise<{ agent: string }> }): Promise<Response> {
  const { agent } = await ctx.params;
  return crewMcpResponse(await getRuntime(), agent, req);
}

export { handle as GET, handle as POST, handle as DELETE };

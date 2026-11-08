import { config } from "@outrun/core";
import { authorizeCrew, serveCrew } from "@/lib/crewMcp";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request, ctx: { params: Promise<{ agent: string }> }): Promise<Response> {
  const { agent } = await ctx.params;
  // Reject unknown agents and bad tokens before touching the database.
  const auth = authorizeCrew(config().keys.crewTokenSecret, agent, req);
  if ("response" in auth) return auth.response;
  return serveCrew(await getRuntime(), auth.agent, req);
}

export { handle as GET, handle as POST, handle as DELETE };

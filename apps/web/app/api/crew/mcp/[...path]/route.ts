import { config } from "@outrun/core";
import { authorizeCrew, serveCrew } from "@/lib/crewMcp";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** /api/crew/mcp/<role> for Outrun's crew, /api/crew/mcp/<client slug>/<role> for another client's. */
async function handle(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  // Reject unknown agents and bad tokens before touching the database.
  const auth = authorizeCrew(config().keys.crewTokenSecret, path.join("/"), req);
  if ("response" in auth) return auth.response;
  return serveCrew(await getRuntime(), auth, req);
}

export { handle as GET, handle as POST, handle as DELETE };

/**
 * POST /api/hosted/admin {op}: migrate, seed, tick or status. Naive-hosted build only
 * (deploy/naive-hosted); the bearer is NAIVE_HOSTED_ADMIN_TOKEN, kept in the deploy's local state.
 */
import {
  bearerMatches,
  runMigrationsHosted,
  seedHosted,
  startCrewSession,
  status,
  tick,
} from "../../../../hosted/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  if (!bearerMatches(req.headers.get("authorization"), process.env.NAIVE_HOSTED_ADMIN_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    op?: string;
    seconds?: number;
    agent?: string;
    prospectId?: string;
    message?: string;
  };
  try {
    switch (body.op) {
      case "migrate":
        return Response.json(await runMigrationsHosted());
      case "seed":
        return Response.json(await seedHosted());
      case "tick":
        return Response.json(await tick(body.seconds ?? 30));
      case "status":
        return Response.json(await status());
      case "start":
        return Response.json(await startCrewSession(body));
      default:
        return Response.json({ error: "op must be migrate, seed, tick, status or start" }, { status: 400 });
    }
  } catch (error) {
    console.error(error);
    return Response.json({ error: (error as Error).message.slice(0, 300) }, { status: 500 });
  }
}

import { config } from "@outrun/core";
import { agentCard } from "@outrun/core/public/a2a";
import { discoveryHeaders } from "@/lib/public";

export const dynamic = "force-dynamic";

/** The A2A agent card (A2A v0.3 well-known path). /.well-known/agent.json serves the same card. */
export function GET(): Response {
  return new Response(JSON.stringify(agentCard(config().appUrl), null, 2), {
    headers: discoveryHeaders("application/json"),
  });
}

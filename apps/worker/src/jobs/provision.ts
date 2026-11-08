/** provision_client_crew: a self-serve client's six agents on Naive (see @outrun/core/provision). */
import { logger } from "@outrun/core/log";
import { provisionClientCrew } from "@outrun/core/provision";
import type { Handlers } from "@outrun/core/queue";
import type { Runtime } from "@outrun/core/runtime";
import { z } from "zod";

const Payload = z.object({ clientId: z.string().uuid() });

export function provisionHandlers(
  rt: Pick<Runtime, "db" | "emit" | "integrations" | "queue" | "config" | "fakes">,
): Handlers {
  return {
    provision_client_crew: async (env) => {
      const p = Payload.parse(env.payload);
      const out = await provisionClientCrew(
        {
          db: rt.db.db,
          emit: rt.emit,
          enqueue: (j) => rt.queue.enqueue(j),
          // The fake stands in only when NAIVE_API_KEY is unset; a test's own fake is a real choice.
          naive: rt.fakes.includes("naive") ? null : rt.integrations.naive,
          appUrl: rt.config.appUrl,
          secret: rt.config.keys.crewTokenSecret,
        },
        p.clientId,
      );
      logger.info(
        {
          clientId: p.clientId,
          status: out.status,
          ...(out.status === "pending" ? { reason: out.reason } : {}),
        },
        "provision_client_crew",
      );
    },
  };
}

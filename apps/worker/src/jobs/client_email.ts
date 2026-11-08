/** client_email_setup: a client's own sending domain and inbox on AgentMail (see email/clientDomain). */
import { runClientEmailSetup } from "@outrun/core/email/clientDomain";
import type { Handlers } from "@outrun/core/queue";
import type { Runtime } from "@outrun/core/runtime";
import { z } from "zod";

const Payload = z.object({ clientId: z.string().uuid(), startedAt: z.string().datetime({ offset: true }) });

export function clientEmailHandlers(rt: Pick<Runtime, "db" | "emit" | "integrations" | "queue">): Handlers {
  return {
    client_email_setup: async (env) => {
      const p = Payload.parse(env.payload);
      await runClientEmailSetup(
        {
          db: rt.db.db,
          emit: rt.emit,
          agentmail: rt.integrations.agentmail,
          enqueue: (j) => rt.queue.enqueue(j),
        },
        p.clientId,
        p.startedAt,
        env.traceId,
      );
    },
  };
}

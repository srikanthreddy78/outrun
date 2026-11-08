/** SH-6: the send_email job. The rules live in @outrun/core/email/send. */
import { hasMx } from "@outrun/core/email/mx";
import { runSendEmail } from "@outrun/core/email/send";
import type { Handlers } from "@outrun/core/queue";
import type { Runtime } from "@outrun/core/runtime";
import { z } from "zod";

const Payload = z.object({ messageId: z.uuid() });

export function sendEmailHandlers(
  rt: Pick<Runtime, "db" | "emit" | "integrations" | "config" | "queue">,
): Handlers {
  return {
    send_email: async (env) => {
      const { messageId } = Payload.parse(env.payload);
      await runSendEmail(
        {
          db: rt.db.db,
          emit: rt.emit,
          agentmail: rt.integrations.agentmail,
          mx: hasMx,
          enqueue: (job) => rt.queue.enqueue(job),
          appUrl: rt.config.appUrl,
          unsubscribeSecret: rt.config.keys.crewTokenSecret,
          inbox: rt.config.keys.agentmailInboxId,
          settings: rt.config.settings,
        },
        messageId,
        env.traceId,
      );
    },
  };
}

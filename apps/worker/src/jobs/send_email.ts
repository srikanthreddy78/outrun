/** SH-6: the send_email job. The rules live in @outrun/core/email/send. */
import { eq, messages } from "@outrun/core/db";
import { runSendEmail } from "@outrun/core/email/send";
import type { Handlers } from "@outrun/core/queue";
import type { Runtime } from "@outrun/core/runtime";
import { z } from "zod";

const Payload = z.object({ messageId: z.uuid() });

/** Enqueues sync_crm for a message's prospect, once per message. */
export async function syncProspectOf(
  rt: Pick<Runtime, "db" | "queue">,
  messageId: string,
  traceId: string,
): Promise<void> {
  const [m] = await rt.db.db
    .select({ prospectId: messages.prospectId })
    .from(messages)
    .where(eq(messages.id, messageId));
  if (!m?.prospectId) return;
  await rt.queue.enqueue({
    type: "sync_crm",
    payload: { prospectId: m.prospectId },
    idempotencyKey: `crm:${m.prospectId}:msg:${messageId}`,
    traceId,
  });
}

export function sendEmailHandlers(
  rt: Pick<Runtime, "db" | "emit" | "integrations" | "config" | "queue" | "mx">,
): Handlers {
  return {
    send_email: async (env) => {
      const { messageId } = Payload.parse(env.payload);
      const out = await runSendEmail(
        {
          db: rt.db.db,
          emit: rt.emit,
          agentmail: rt.integrations.agentmail,
          mx: rt.mx,
          enqueue: (job) => rt.queue.enqueue(job),
          appUrl: rt.config.appUrl,
          unsubscribeSecret: rt.config.keys.crewTokenSecret,
          inbox: rt.config.keys.agentmailInboxId,
          settings: rt.config.settings,
        },
        messageId,
        env.traceId,
      );
      // SH-4: HubSpot mirrors the email and the new stage.
      if (out.status === "sent") await syncProspectOf(rt, messageId, env.traceId);
    },
  };
}

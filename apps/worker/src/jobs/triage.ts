/** SH-7: triage_reply. The rules live in @outrun/core/triage. */
import type { Handlers } from "@outrun/core/queue";
import type { Runtime } from "@outrun/core/runtime";
import { runTriage } from "@outrun/core/triage";
import { z } from "zod";

const Payload = z.object({ messageId: z.uuid() });

export function triageHandlers(rt: Pick<Runtime, "db" | "emit" | "llm" | "config" | "queue">): Handlers {
  return {
    triage_reply: async (env) => {
      const { messageId } = Payload.parse(env.payload);
      await runTriage(
        {
          db: rt.db.db,
          emit: rt.emit,
          llm: rt.llm,
          appUrl: rt.config.appUrl,
          enqueue: (j) => rt.queue.enqueue(j),
        },
        messageId,
      );
    },
  };
}

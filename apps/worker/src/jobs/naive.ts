/**
 * start_session and handle_naive_event. Naive tells us what happened; we update our records
 * and mark drafts awaiting approval. We never decide approvals ourselves: a person does, in our
 * dashboard or the Studio, and Naive enforces it.
 */
import { AgentName, Entity, NaiveEnvelope } from "@outrun/core/contracts";
import { and, eq, messages } from "@outrun/core/db";
import type { Runtime } from "@outrun/core/runtime";
import type { Handlers } from "@outrun/core/queue";
import { recordSessionState, startSession } from "@outrun/core/sessions";
import { z } from "zod";

const SEND_TOOLS = new Set(["outrun.send_email", "outrun.reply_email"]);
const StartPayload = z.object({ agent: AgentName, message: z.string(), entity: Entity });
const DraftArgs = z.object({ draftId: z.string() });

export function naiveHandlers(rt: Pick<Runtime, "db" | "emit" | "integrations">): Handlers {
  const deps = { db: rt.db.db, emit: rt.emit, naive: rt.integrations.naive };
  return {
    start_session: async (env) => {
      const p = StartPayload.parse(env.payload);
      await startSession(deps, { ...p, idempotencyKey: env.idempotencyKey });
    },

    handle_naive_event: async (env) => {
      const e = NaiveEnvelope.parse((env.payload as { envelope: unknown }).envelope);
      const data = e.data as Record<string, unknown>;
      const sessionId = typeof data.session_id === "string" ? data.session_id : undefined;

      switch (e.type) {
        case "session.idle": {
          if (!sessionId) return;
          const s = await deps.naive.getSession(sessionId);
          await recordSessionState(deps, sessionId, s);
          if (s.stopReason !== "awaiting_approval") return;
          for (const a of s.pendingActions) {
            if (a.kind !== "tool" || !SEND_TOOLS.has(a.tool)) continue;
            const args = DraftArgs.safeParse(a.input);
            if (!args.success) continue;
            const updated = await deps.db
              .update(messages)
              .set({ status: "awaiting_approval", naiveSessionId: sessionId, naiveToolCallId: a.toolCallId })
              .where(and(eq(messages.id, args.data.draftId), eq(messages.status, "checked")))
              .returning({ id: messages.id });
            if (updated[0]) {
              await deps.emit({
                actor: "worker",
                type: "approval.waiting",
                entityType: "message",
                entityId: updated[0].id,
                payload: { sessionId, toolCallId: a.toolCallId, tool: a.tool },
              });
            }
          }
          return;
        }
        case "session.running": {
          if (sessionId) await recordSessionState(deps, sessionId, { status: "running", stopReason: null });
          return;
        }
        case "tool.confirm.resolved": {
          const toolCallId = typeof data.tool_call_id === "string" ? data.tool_call_id : undefined;
          const decision = data.decision === "allow" ? "approved" : data.decision === "deny" ? "rejected" : undefined;
          if (!toolCallId || !decision) return;
          const rows = await deps.db
            .update(messages)
            .set({ status: decision })
            .where(and(eq(messages.naiveToolCallId, toolCallId), eq(messages.status, "awaiting_approval")))
            .returning({ id: messages.id });
          for (const r of rows) {
            await deps.emit({
              actor: "provider:naive",
              type: `approval.${decision}`,
              entityType: "message",
              entityId: r.id,
              payload: { toolCallId, by: data.decided_by ?? data.actor ?? null },
            });
          }
          return;
        }
        case "budget.exceeded": {
          await deps.emit({
            actor: "provider:naive",
            type: "alert.naive_budget_exceeded",
            entityType: "system",
            entityId: typeof data.agent_id === "string" ? data.agent_id : "naive",
            payload: data,
          });
          return;
        }
        default:
          await deps.emit({ actor: "provider:naive", type: "naive.event_ignored", entityType: "system", entityId: e.id, payload: { type: e.type } });
      }
    },
  };
}

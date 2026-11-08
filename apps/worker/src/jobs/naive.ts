/**
 * start_session and handle_naive_event. Naive tells us what happened; we update our records.
 * We never decide approvals: a person does, in the Naive Studio, and Naive enforces it.
 *
 * Only session.idle and budget.exceeded reach a webhook. Each session.idle we:
 *   1. read the session back and record its state;
 *   2. mark drafts held on an `ask` send tool as awaiting approval, with Naive's ids;
 *   3. read the session's events since the last seq we applied, and turn each
 *      tool.confirm.resolved row into approved or rejected for its draft.
 * Every step is idempotent, so a redelivered or extra idle is harmless.
 */
import { AgentName, Entity, NaiveEnvelope } from "@outrun/core/contracts";
import { agentSessions, and, eq, inArray, messages, sql } from "@outrun/core/db";
import type { Emit } from "@outrun/core/events";
import type { NaiveClient, NaiveEvent } from "@outrun/core/integrations";
import type { Handlers } from "@outrun/core/queue";
import type { Runtime } from "@outrun/core/runtime";
import { recordSessionState, startSession } from "@outrun/core/sessions";
import { z } from "zod";

const SEND_TOOLS = new Set(["outrun.send_email", "outrun.reply_email"]);
const StartPayload = z.object({ agent: AgentName, message: z.string(), entity: Entity });
const DraftArgs = z.object({ draftId: z.string().uuid() });
const Resolved = z.object({
  tool_call_id: z.string(),
  decision: z.enum(["allow", "deny"]),
  actor: z.object({ type: z.string(), id: z.string() }).nullable().optional(),
});
const BudgetData = z.object({
  session_id: z.string().optional(),
  code: z.string().optional(),
  param: z.string().optional(),
});

type Deps = { db: Runtime["db"]["db"]; emit: Emit; naive: NaiveClient };

export function naiveHandlers(rt: Pick<Runtime, "db" | "emit" | "integrations">): Handlers {
  const deps: Deps = { db: rt.db.db, emit: rt.emit, naive: rt.integrations.naive };
  return {
    start_session: async (env) => {
      const p = StartPayload.parse(env.payload);
      await startSession(deps, { ...p, idempotencyKey: env.idempotencyKey });
    },

    handle_naive_event: async (env) => {
      const e = NaiveEnvelope.parse((env.payload as { envelope: unknown }).envelope);
      const data = e.data;
      const sessionId = typeof data.session_id === "string" ? data.session_id : undefined;
      const at = new Date(e.created_at);

      switch (e.type) {
        case "session.idle":
          if (sessionId) await onIdle(deps, sessionId, Number.isNaN(at.getTime()) ? new Date() : at);
          return;
        case "budget.exceeded": {
          const b = BudgetData.parse(data);
          await deps.emit({
            actor: "provider:naive",
            type: "alert.naive_budget_exceeded",
            entityType: b.session_id ? "agent_session" : "system",
            entityId: b.session_id ?? "naive",
            payload: {
              code: b.code ?? null,
              param: b.param ?? null,
              action:
                b.code === "insufficient_credits" ? "top up Naive credits" : "raise the agent's budget cap",
            },
          });
          return;
        }
        default:
          await deps.emit({
            actor: "provider:naive",
            type: "naive.event_ignored",
            entityType: "system",
            entityId: e.id,
            payload: { type: e.type },
          });
      }
    },
  };
}

/** Exported for tests and the fake's onIdle hook. */
export async function onIdle(deps: Deps, sessionId: string, at: Date = new Date()): Promise<void> {
  const s = await deps.naive.getSession(sessionId);
  await recordSessionState(deps, sessionId, s, at);

  if (s.stopReason === "awaiting_approval") {
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
          payload: { sessionId, toolCallId: a.toolCallId, tool: a.tool, parkedSeq: a.parkedSeq },
        });
      }
    }
  }

  await applyDecisions(deps, sessionId);
}

/** Turns tool.confirm.resolved rows after our last applied seq into draft decisions. */
async function applyDecisions(deps: Deps, sessionId: string): Promise<void> {
  const [row] = await deps.db
    .select({ id: agentSessions.id, lastSeq: agentSessions.lastSeq })
    .from(agentSessions)
    .where(eq(agentSessions.sessionId, sessionId));
  if (!row) return;
  const evs: NaiveEvent[] = await deps.naive.getEvents(sessionId, {
    afterSeq: row.lastSeq,
    includeAccepted: true,
  });
  if (evs.length === 0) return;

  // The tool call ids Naive held, mapped to the draft each one carried.
  const proposed = new Map<string, string>();
  for (const ev of evs) {
    if (ev.type !== "tool.confirm.resolved") continue;
    const args = DraftArgs.safeParse((ev.data as { proposed_args?: unknown }).proposed_args);
    if (args.success) proposed.set(String(ev.data.tool_call_id), args.data.draftId);
  }

  for (const ev of evs) {
    if (ev.type !== "tool.confirm.resolved") continue;
    const r = Resolved.safeParse(ev.data);
    if (!r.success) continue;
    const status = r.data.decision === "allow" ? "approved" : "rejected";
    const draftId = proposed.get(r.data.tool_call_id);
    // Match on Naive's tool call id; a fast approval can land before our idle marked the
    // draft, so also match the draft named in the call's arguments while still `checked`.
    const rows = await deps.db
      .update(messages)
      .set({ status, naiveSessionId: sessionId, naiveToolCallId: r.data.tool_call_id })
      .where(
        and(
          inArray(messages.status, ["awaiting_approval", "checked"]),
          draftId
            ? sql`(${messages.naiveToolCallId} = ${r.data.tool_call_id} or ${messages.id} = ${draftId})`
            : eq(messages.naiveToolCallId, r.data.tool_call_id),
        ),
      )
      .returning({ id: messages.id });
    for (const m of rows) {
      await deps.emit({
        actor: "provider:naive",
        type: `approval.${status}`,
        entityType: "message",
        entityId: m.id,
        payload: {
          sessionId,
          toolCallId: r.data.tool_call_id,
          by: r.data.actor ? `${r.data.actor.type}:${r.data.actor.id}` : null,
        },
      });
    }
  }

  const maxSeq = Math.max(...evs.map((e) => e.seq));
  await deps.db
    .update(agentSessions)
    .set({ lastSeq: sql`greatest(${agentSessions.lastSeq}, ${maxSeq})` })
    .where(eq(agentSessions.id, row.id));
}

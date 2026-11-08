/** The approvals page's decision step, kept out of the server action so tests can call it. */
import { and, desc, eq, events, inArray, messages } from "@outrun/core/db/query";
import type { Runtime } from "@outrun/core/runtime";

export async function submitDecisions(
  rt: { db: Runtime["db"]; emit: Runtime["emit"]; integrations: Pick<Runtime["integrations"], "naive"> },
  email: string,
  f: { ids: string[]; decision: "allow" | "deny"; reason: string },
  /** A client approver from the portal: only that client's messages, recorded as client:<email>. */
  scope?: { clientId: string },
): Promise<number> {
  const held = await rt.db.db
    .select({ id: messages.id, sessionId: messages.naiveSessionId, toolCallId: messages.naiveToolCallId })
    .from(messages)
    .where(
      and(
        inArray(messages.id, f.ids),
        eq(messages.status, "awaiting_approval"),
        ...(scope ? [eq(messages.clientId, scope.clientId)] : []),
      ),
    );
  let n = 0;
  for (const m of held) {
    if (!m.sessionId || !m.toolCallId) continue;
    const [waiting] = await rt.db.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.type, "approval.waiting"), eq(events.entityId, m.id)))
      .orderBy(desc(events.ts))
      .limit(1);
    const parkedSeq = (waiting?.payload as { parkedSeq?: number | null } | undefined)?.parkedSeq ?? null;
    const reason = `${f.decision === "allow" ? "approved" : "rejected"} by ${email}${f.reason ? `: ${f.reason}` : ""}`;
    await rt.integrations.naive.confirmTool(m.sessionId, m.toolCallId, f.decision, reason, parkedSeq);
    await rt.emit({
      actor: scope ? `client:${email}` : `user:${email}`,
      type: "approval.submitted",
      entityType: "message",
      entityId: m.id,
      payload: { decision: f.decision, toolCallId: m.toolCallId, reason: f.reason || null },
    });
    n++;
  }
  return n;
}

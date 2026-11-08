/**
 * Starting Naive sessions. One live session per agent and entity (a partial unique index
 * enforces it); a second start for the same pair messages the live session instead. The
 * message names ids only. Every start is recorded in agent_sessions and the ledger.
 */
import { and, eq, inArray } from "drizzle-orm";
import { StartSessionInput, type StopReason } from "../contracts";
import type { Db } from "./db/client";
import { agentSessions } from "./db/schema";
import { AppError } from "./errors";
import type { Emit } from "./events";
import type { NaiveClient } from "./integrations/types";

export interface SessionDeps {
  db: Db;
  emit: Emit;
  naive: NaiveClient;
}

export type StartOutcome =
  | { kind: "started"; sessionId: string; recordId: string }
  | { kind: "messaged"; sessionId: string; recordId: string }
  | { kind: "duplicate"; sessionId: string | null; recordId: string };

const LIVE = ["starting", "running", "idle"] as const;

export async function startSession(deps: SessionDeps, raw: StartSessionInput): Promise<StartOutcome> {
  const input = StartSessionInput.parse(raw);
  const { agent, entity, idempotencyKey, message } = input;

  const [same] = await deps.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.idempotencyKey, idempotencyKey));
  if (same) return { kind: "duplicate", sessionId: same.sessionId, recordId: same.id };

  const [live] = await deps.db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.agent, agent),
        eq(agentSessions.entityType, entity.type),
        eq(agentSessions.entityId, entity.id),
        inArray(agentSessions.status, [...LIVE]),
      ),
    );
  if (live?.sessionId) {
    await deps.naive.send(live.sessionId, message, idempotencyKey);
    await deps.emit({
      actor: "worker",
      type: "session.messaged",
      entityType: "agent_session",
      entityId: live.id,
      payload: { agent, sessionId: live.sessionId, entity },
    });
    return { kind: "messaged", sessionId: live.sessionId, recordId: live.id };
  }
  if (live)
    throw new AppError("conflict", `a ${agent} session for ${entity.type} ${entity.id} is still starting`, {
      retryable: true,
    });

  const [row] = await deps.db
    .insert(agentSessions)
    .values({ agent, entityType: entity.type, entityId: entity.id, idempotencyKey, status: "starting" })
    .onConflictDoNothing()
    .returning();
  if (!row)
    throw new AppError("conflict", `a live ${agent} session for ${entity.type} ${entity.id} already exists`, {
      retryable: true,
    });

  try {
    const agentId = await deps.naive.resolveAgentId(agent);
    const { sessionId } = await deps.naive.startSession({
      agentId,
      message,
      idempotencyKey,
      metadata: { outrunSessionId: row.id, entityType: entity.type, entityId: entity.id },
    });
    await deps.db
      .update(agentSessions)
      .set({ sessionId, status: "running" })
      .where(eq(agentSessions.id, row.id));
    await deps.emit({
      actor: "worker",
      type: "session.started",
      entityType: "agent_session",
      entityId: row.id,
      payload: { agent, sessionId, entity },
    });
    return { kind: "started", sessionId, recordId: row.id };
  } catch (err) {
    // Free the slot (and the key) so the job's retry can start it; Naive's own Idempotency-Key
    // makes a retried create safe if the first one did land.
    await deps.db.delete(agentSessions).where(eq(agentSessions.id, row.id));
    await deps.emit({
      actor: "worker",
      type: "session.start_failed",
      entityType: entity.type,
      entityId: entity.id,
      payload: { agent, error: (err as Error).message.slice(0, 300) },
    });
    throw err;
  }
}

/** Applies a session state we learned from Naive (webhook or read-back) to our record. */
export async function recordSessionState(
  deps: Pick<SessionDeps, "db" | "emit">,
  sessionId: string,
  state: { status: string; stopReason: StopReason | null; consumedUsd?: number },
): Promise<string | null> {
  const status =
    state.status === "idle"
      ? "idle"
      : state.status === "running" || state.status === "queued"
        ? "running"
        : "terminated";
  const rows = await deps.db
    .update(agentSessions)
    .set({
      status,
      stopReason: state.stopReason,
      lastEventAt: new Date(),
      ...(state.consumedUsd !== undefined ? { spendUsd: state.consumedUsd.toFixed(6) } : {}),
    })
    .where(eq(agentSessions.sessionId, sessionId))
    .returning({ id: agentSessions.id, agent: agentSessions.agent });
  const row = rows[0];
  if (!row) return null;
  await deps.emit({
    actor: `naive:${row.agent}`,
    type: `session.${status}`,
    entityType: "agent_session",
    entityId: row.id,
    payload: { sessionId, stopReason: state.stopReason, consumedUsd: state.consumedUsd ?? null },
  });
  return row.id;
}

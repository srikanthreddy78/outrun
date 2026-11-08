/**
 * Starting Naive sessions. One live session per agent and entity (a partial unique index
 * enforces it); a second start for the same pair messages the live session instead. The
 * message names ids only. Every start is recorded in agent_sessions and the ledger.
 *
 * A start's row is keyed by its idempotency key and never deleted: a retry reuses the same
 * row, so Naive sees the same body under the same Idempotency-Key and replays the session
 * instead of creating a second one.
 */
import { and, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { StartSessionInput, type StopReason } from "../contracts";
import { SESSION_START_STALE_MINUTES } from "./constants";
import type { Db } from "./db/client";
import { agentSessions, events } from "./db/schema";
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
const TERMINAL_NAIVE = new Set(["completed", "failed", "cancelled", "terminated", "expired"]);

type Row = typeof agentSessions.$inferSelect;

function pgCode(err: unknown): { code?: string; constraint?: string } {
  const e = (err as { cause?: unknown })?.cause ?? err;
  return (e ?? {}) as { code?: string; constraint?: string };
}

export async function startSession(deps: SessionDeps, raw: StartSessionInput): Promise<StartOutcome> {
  const input = StartSessionInput.parse(raw);
  const { agent, entity, idempotencyKey, message } = input;

  // 1. This exact start was seen before.
  const [same] = await deps.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.idempotencyKey, idempotencyKey));
  if (same?.sessionId) return { kind: "duplicate", sessionId: same.sessionId, recordId: same.id };
  const [messaged] = await deps.db
    .select({ id: events.id, entityId: events.entityId, payload: events.payload })
    .from(events)
    .where(
      and(eq(events.type, "session.messaged"), sql`${events.payload}->>'idempotencyKey' = ${idempotencyKey}`),
    );
  if (messaged) {
    const p = messaged.payload as { sessionId?: string };
    return { kind: "duplicate", sessionId: p.sessionId ?? null, recordId: messaged.entityId };
  }

  // 2. A live session for this agent and entity (other than our own unfinished row).
  const [live] = await deps.db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.agent, agent),
        eq(agentSessions.entityType, entity.type),
        eq(agentSessions.entityId, entity.id),
        inArray(agentSessions.status, [...LIVE]),
        ne(agentSessions.idempotencyKey, idempotencyKey),
      ),
    );
  if (live) {
    const outcome = await useLive(deps, live, input);
    if (outcome) return outcome;
  }

  // 3. Our row: reuse the one from a failed attempt, or create it.
  let row: Row | undefined = same;
  if (row) {
    [row] = await deps.db
      .update(agentSessions)
      .set({ status: "starting" })
      .where(eq(agentSessions.id, row.id))
      .returning();
  } else {
    try {
      [row] = await deps.db
        .insert(agentSessions)
        .values({ agent, entityType: entity.type, entityId: entity.id, idempotencyKey, status: "starting" })
        .returning();
    } catch (err) {
      const { code, constraint } = pgCode(err);
      if (code === "23505" && constraint === "agent_sessions_idem_uq") {
        const [again] = await deps.db
          .select()
          .from(agentSessions)
          .where(eq(agentSessions.idempotencyKey, idempotencyKey));
        return { kind: "duplicate", sessionId: again?.sessionId ?? null, recordId: again!.id };
      }
      if (code === "23505") {
        throw new AppError(
          "conflict",
          `a live ${agent} session for ${entity.type} ${entity.id} already exists`,
          {
            retryable: true,
          },
        );
      }
      throw err;
    }
  }
  if (!row) throw new AppError("internal", "agent_sessions row vanished");

  // 4. Only the Naive call is compensated: on failure the slot frees, the row stays for the retry.
  let sessionId: string;
  try {
    const agentId = await deps.naive.resolveAgentId(agent);
    ({ sessionId } = await deps.naive.startSession({
      agentId,
      message,
      idempotencyKey,
      metadata: { outrunSessionId: row.id, entityType: entity.type, entityId: entity.id },
    }));
  } catch (err) {
    await deps.db.update(agentSessions).set({ status: "error" }).where(eq(agentSessions.id, row.id));
    await deps.emit({
      actor: "worker",
      type: "session.start_failed",
      entityType: entity.type,
      entityId: entity.id,
      payload: { agent, code: err instanceof AppError ? err.code : "internal" },
    });
    throw err;
  }

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
}

/** Messages a live session, or clears it out of the way. Returns null when a fresh start should follow. */
async function useLive(deps: SessionDeps, live: Row, input: StartSessionInput): Promise<StartOutcome | null> {
  const { agent, entity, idempotencyKey, message } = input;
  if (!live.sessionId) {
    const staleBefore = new Date(Date.now() - SESSION_START_STALE_MINUTES * 60_000);
    if (live.updatedAt > staleBefore) {
      throw new AppError("conflict", `a ${agent} session for ${entity.type} ${entity.id} is still starting`, {
        retryable: true,
      });
    }
    // An attempt that crashed between insert and the Naive call.
    await deps.db.update(agentSessions).set({ status: "error" }).where(eq(agentSessions.id, live.id));
    await deps.emit({
      actor: "worker",
      type: "session.reclaimed",
      entityType: "agent_session",
      entityId: live.id,
      payload: { agent },
    });
    return null;
  }

  try {
    await deps.naive.send(live.sessionId, message, idempotencyKey);
  } catch (err) {
    if (!(err instanceof AppError) || (err.code !== "not_found" && err.code !== "conflict")) throw err;
    const s = await deps.naive.getSession(live.sessionId).catch(() => null);
    if (s && !TERMINAL_NAIVE.has(s.status)) throw err;
    await recordSessionState(deps, live.sessionId, {
      status: s?.status ?? "terminated",
      stopReason: s?.stopReason ?? null,
    });
    return null;
  }
  await deps.emit({
    actor: "worker",
    type: "session.messaged",
    entityType: "agent_session",
    entityId: live.id,
    payload: { agent, sessionId: live.sessionId, entity, idempotencyKey },
  });
  return { kind: "messaged", sessionId: live.sessionId, recordId: live.id };
}

/** Our status for a status Naive reports. */
export function ourStatus(naiveStatus: string): "running" | "idle" | "terminated" {
  if (naiveStatus === "idle") return "idle";
  if (naiveStatus === "running" || naiveStatus === "queued") return "running";
  return "terminated";
}

/**
 * Applies a session state we learned from Naive to our record. A terminated row never comes
 * back, and an update older than the last one applied is skipped, so late or reordered
 * deliveries can't revive a session. Returns the row id when the update applied.
 */
export async function recordSessionState(
  deps: Pick<SessionDeps, "db" | "emit">,
  sessionId: string,
  state: { status: string; stopReason: StopReason | null; consumedUsd?: number },
  at: Date = new Date(),
): Promise<string | null> {
  const status = ourStatus(state.status);
  let rows: { id: string; agent: string }[];
  try {
    rows = await deps.db
      .update(agentSessions)
      .set({
        status,
        stopReason: state.stopReason,
        lastEventAt: at,
        ...(state.consumedUsd !== undefined ? { spendUsd: state.consumedUsd.toFixed(6) } : {}),
      })
      .where(
        and(
          eq(agentSessions.sessionId, sessionId),
          ne(agentSessions.status, "terminated"),
          or(isNull(agentSessions.lastEventAt), lte(agentSessions.lastEventAt, at)),
        ),
      )
      .returning({ id: agentSessions.id, agent: agentSessions.agent });
  } catch (err) {
    // Another live row now holds the slot: this state is stale.
    if (pgCode(err).code === "23505") return null;
    throw err;
  }
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

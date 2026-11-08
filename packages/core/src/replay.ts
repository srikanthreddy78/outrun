/**
 * Replaying a dead job: the dashboard's Replay button and the CEO's outrun.replay_job share this.
 * Only a job that dead-lettered (a `job.dead` event) of a replayable type, at most REPLAY_MAX
 * times, never while the last replay is still queued or after it finished. Each replay enqueues
 * the dead envelope under a fresh key and emits `job.replayed` on the dead job.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { JobEnvelope, type JobEnvelopeInput, JobType } from "../contracts";
import { REPLAY_MAX } from "./constants";
import type { Db } from "./db/client";
import { events } from "./db/schema";
import type { Emit } from "./events";
import { deadLetterName, jobIdFor } from "./queue";

/** Jobs safe to run again: each is idempotent on its key and touches nothing outside on a re-run. */
export const REPLAYABLE_JOBS: ReadonlySet<string> = new Set([
  "scan_domain",
  "start_audit",
  "handle_apify_event",
  "build_kit",
  "deliver_report",
]);

export interface ReplayDeps {
  db: Db;
  emit: Emit;
  enqueue: (job: JobEnvelopeInput) => Promise<{ jobId: string | null }>;
}

type DeadEvent = { id: string; type: JobType; jobId: string; at: Date };

async function deadEvent(db: Db, ref: { eventId: string } | { jobId: string }): Promise<DeadEvent | null> {
  const [e] = await db
    .select({ id: events.id, payload: events.payload, ts: events.ts })
    .from(events)
    .where(
      and(
        eq(events.type, "job.dead"),
        "eventId" in ref ? eq(events.id, ref.eventId) : sql`${events.payload}->>'jobId' = ${ref.jobId}`,
      ),
    )
    .orderBy(desc(events.ts))
    .limit(1);
  if (!e) return null;
  const type = JobType.safeParse(e.payload.job);
  const jobId = e.payload.jobId;
  if (!type.success || typeof jobId !== "string") return null;
  return { id: e.id, type: type.data, jobId, at: e.ts };
}

/** How often a dead job was replayed, and the state of the last replay's job (null if none or gone). */
export async function replayState(db: Db, d: Pick<DeadEvent, "type" | "jobId">) {
  const rows = await db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.type, "job.replayed"), eq(events.entityType, "job"), eq(events.entityId, d.jobId)))
    .orderBy(desc(events.ts));
  const last = rows[0]?.payload as { replayJobId?: string } | undefined;
  let lastState: string | null = null;
  if (last?.replayJobId) {
    const r = await db.execute<{ state: string }>(
      sql`select state::text as state from pgboss.job where name = ${d.type} and id = ${last.replayJobId}::uuid`,
    );
    lastState = r.rows[0]?.state ?? null;
  }
  return { replays: rows.length, lastState };
}

/** Why a dead job may not be replayed now, or null when it may. */
export function replayRefusal(type: string, s: { replays: number; lastState: string | null }): string | null {
  if (!REPLAYABLE_JOBS.has(type)) return `${type} jobs aren't replayable; a person handles them`;
  if (s.replays >= REPLAY_MAX) return `already replayed ${s.replays} times; a person looks at it now`;
  if (s.lastState === "completed") return "the last replay finished; nothing to replay";
  if (s.lastState && ["created", "retry", "active"].includes(s.lastState))
    return "the last replay is still queued or running";
  return null;
}

export async function replayDeadJob(
  deps: ReplayDeps,
  ref: { eventId: string } | { jobId: string },
  actor: string,
): Promise<{ ok: true; type: JobType; replays: number } | { ok: false; reason: string }> {
  const d = await deadEvent(deps.db, ref);
  if (!d) return { ok: false, reason: "no dead job with that id" };
  const state = await replayState(deps.db, d);
  const refusal = replayRefusal(d.type, state);
  if (refusal) return { ok: false, reason: refusal };
  const r = await deps.db.execute<{ data: unknown }>(
    sql`select data from pgboss.job where name = ${deadLetterName(d.type)} and id = ${d.jobId}::uuid`,
  );
  const parsed = JobEnvelope.safeParse(r.rows[0]?.data);
  if (!parsed.success || parsed.data.type !== d.type)
    return { ok: false, reason: "the dead job's payload is no longer kept" };
  // The first replay keeps the dashboard's original key; later ones get their own.
  const n = state.replays + 1;
  const idempotencyKey = n === 1 ? `replay:${d.id}` : `replay:${d.id}:${n}`;
  const queued = await deps.enqueue({ ...parsed.data, idempotencyKey, traceId: `replay-${d.id}` });
  if (!queued.jobId) return { ok: false, reason: "that replay is already queued" };
  await deps.emit({
    actor: actor as never,
    type: "job.replayed",
    entityType: "job",
    entityId: d.jobId,
    payload: { type: d.type, deadEventId: d.id, replayJobId: jobIdFor(d.type, idempotencyKey), replay: n },
  });
  return { ok: true, type: d.type, replays: n };
}

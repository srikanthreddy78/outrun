/**
 * The CEO's brain, all of it in the events ledger (Naive's memory is "coming soon"):
 *
 *   playbook     ceo.lesson events, per client or agency-wide; read back with the lessons of the
 *                most similar clients (ICP keyword and buyer-role overlap) and experiment results
 *   predictions  ceo.prediction says what a decision should do to one metric by a date;
 *                score_predictions computes the actual with clientInsights and emits
 *                ceo.prediction_scored once per prediction
 *   problems     dead jobs, recent alerts, paused clients and sending, stuck sends, in one read
 *   pausing      the CEO pauses a client and resumes only its own pauses, never Outrun's
 *   board memo   ceo.board_memo once per ISO week, emailed to the owner in a fixed template
 *
 * Nothing here moves money, sets a price or deletes data.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { ClientStatus, JobEnvelopeInput, PREDICTION_METRICS } from "../contracts";
import {
  CRON_TZ,
  OUTRUN_CLIENT_ID,
  PLAYBOOK_AGENCY_KEPT,
  PLAYBOOK_OWN_KEPT,
  PLAYBOOK_SIMILAR_CLIENTS,
  PLAYBOOK_SIMILAR_KEPT,
  STUCK_SENDING_MINUTES,
} from "./constants";
import { setPaused } from "./clients";
import type { Db } from "./db/client";
import { clients, events, messages } from "./db/schema";
import { sendPause } from "./email/rules";
import { AppError } from "./errors";
import type { Emit } from "./events";
import { checkHealth } from "./health";
import { clientInsights } from "./insights";
import { REPLAYABLE_JOBS, replayRefusal, replayState } from "./replay";
import { dayIn } from "./time";

const DAY = 86_400_000;
export type PredictionMetric = (typeof PREDICTION_METRICS)[number];

async function clientRow(db: Db, clientId: string) {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) throw new AppError("not_found", `client ${clientId}`);
  return c;
}

// ---------------------------------------------------------------- playbook

export interface Lesson {
  lessonId: string;
  clientId: string | null;
  lesson: string;
  evidence: string;
  tags: string[];
  at: string;
}

export async function recordLesson(
  deps: { db: Db; emit: Emit },
  input: { clientId: string | null; lesson: string; evidence: string; tags: string[] },
  actor: string,
) {
  if (input.clientId) await clientRow(deps.db, input.clientId);
  const lessonId = randomUUID();
  const tags = [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 8);
  await deps.emit({
    actor: actor as never,
    type: "ceo.lesson",
    entityType: input.clientId ? "client" : "system",
    entityId: input.clientId ?? "agency",
    payload: { lessonId, clientId: input.clientId, lesson: input.lesson, evidence: input.evidence, tags },
  });
  return { lessonId };
}

function toLesson(r: { payload: Record<string, unknown>; ts: Date }): Lesson {
  const p = r.payload as Partial<Lesson>;
  return {
    lessonId: String(p.lessonId),
    clientId: p.clientId ?? null,
    lesson: String(p.lesson ?? ""),
    evidence: String(p.evidence ?? ""),
    tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
    at: r.ts.toISOString(),
  };
}

const norm = (s: string) => s.trim().toLowerCase();
const icpOf = (profile: unknown) => {
  const icp = (profile as { icp?: { includeKeywords?: unknown; buyerRoles?: unknown } } | null)?.icp;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").map(norm) : []);
  return { keywords: new Set(list(icp?.includeKeywords)), roles: new Set(list(icp?.buyerRoles)) };
};
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both += 1;
  return both / (a.size + b.size - both);
};

/** 0-1: the mean of the include-keyword and buyer-role overlaps (Jaccard) of two ICPs. */
export function icpSimilarity(a: unknown, b: unknown): number {
  const x = icpOf(a);
  const y = icpOf(b);
  return Math.round(((jaccard(x.keywords, y.keywords) + jaccard(x.roles, y.roles)) / 2) * 1000) / 1000;
}

export async function readPlaybook(db: Db, clientId: string) {
  const c = await clientRow(db, clientId);
  const rows = await db
    .select({ payload: events.payload, ts: events.ts, entityId: events.entityId })
    .from(events)
    .where(eq(events.type, "ceo.lesson"))
    .orderBy(desc(events.ts));
  const byClient = new Map<string, Lesson[]>();
  const agency: Lesson[] = [];
  for (const r of rows) {
    const l = toLesson(r);
    if (!l.clientId) {
      if (agency.length < PLAYBOOK_AGENCY_KEPT) agency.push(l);
      continue;
    }
    const list = byClient.get(l.clientId) ?? [];
    list.push(l);
    byClient.set(l.clientId, list);
  }
  const others = byClient.size
    ? await db
        .select({ id: clients.id, slug: clients.slug, profile: clients.profile })
        .from(clients)
        .where(
          inArray(
            clients.id,
            [...byClient.keys()].filter((id) => id !== c.id),
          ),
        )
    : [];
  const similar = others
    .map((o) => ({ clientId: o.id, slug: o.slug, similarity: icpSimilarity(c.profile, o.profile) }))
    .filter((o) => o.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity || a.slug.localeCompare(b.slug))
    .slice(0, PLAYBOOK_SIMILAR_CLIENTS)
    .map((o) => ({ ...o, lessons: (byClient.get(o.clientId) ?? []).slice(0, PLAYBOOK_SIMILAR_KEPT) }));

  // Experiments land later (experiment.ended {lesson, winner}); none is fine.
  const ended = await db
    .select({
      payload: events.payload,
      ts: events.ts,
      entityType: events.entityType,
      entityId: events.entityId,
    })
    .from(events)
    .where(eq(events.type, "experiment.ended"))
    .orderBy(desc(events.ts))
    .limit(PLAYBOOK_AGENCY_KEPT);
  const experiments = ended
    .map((e) => {
      const p = e.payload as { lesson?: unknown; winner?: unknown; clientId?: unknown };
      const cid = typeof p.clientId === "string" ? p.clientId : e.entityType === "client" ? e.entityId : null;
      return {
        clientId: cid,
        lesson: typeof p.lesson === "string" ? p.lesson.slice(0, 300) : "",
        winner: typeof p.winner === "string" ? p.winner.slice(0, 120) : null,
        at: e.ts.toISOString(),
      };
    })
    .filter(
      (e) =>
        e.lesson &&
        (e.clientId === null || e.clientId === c.id || similar.some((s) => s.clientId === e.clientId)),
    );

  return {
    clientId: c.id,
    own: (byClient.get(c.id) ?? []).slice(0, PLAYBOOK_OWN_KEPT),
    agency,
    similar,
    experiments,
  };
}

// ---------------------------------------------------------------- predictions

export interface Prediction {
  predictionId: string;
  clientId: string;
  decision: string;
  metric: PredictionMetric;
  low: number;
  high: number;
  dueAt: string;
  at: Date;
}

export async function makePrediction(
  deps: { db: Db; emit: Emit; now: () => Date },
  input: {
    clientId: string;
    decision: string;
    metric: PredictionMetric;
    low: number;
    high: number;
    dueDays: number;
  },
  actor: string,
) {
  const c = await clientRow(deps.db, input.clientId);
  const predictionId = randomUUID();
  const dueAt = new Date(deps.now().getTime() + input.dueDays * DAY).toISOString();
  await deps.emit({
    actor: actor as never,
    type: "ceo.prediction",
    entityType: "client",
    entityId: c.id,
    payload: {
      predictionId,
      clientId: c.id,
      decision: input.decision,
      metric: input.metric,
      low: input.low,
      high: input.high,
      dueDays: input.dueDays,
      dueAt,
    },
  });
  return { predictionId, dueAt };
}

async function predictions(db: Db): Promise<Prediction[]> {
  const rows = await db
    .select({ payload: events.payload, ts: events.ts })
    .from(events)
    .where(eq(events.type, "ceo.prediction"))
    .orderBy(desc(events.ts));
  return rows.map((r) => ({ ...(r.payload as unknown as Omit<Prediction, "at">), at: r.ts }));
}

async function scores(db: Db) {
  const rows = await db
    .select({ payload: events.payload })
    .from(events)
    .where(eq(events.type, "ceo.prediction_scored"));
  const out = new Map<string, { actual: number; hit: boolean }>();
  for (const r of rows) {
    const p = r.payload as { predictionId: string; actual: number; hit: boolean };
    if (!out.has(p.predictionId)) out.set(p.predictionId, { actual: Number(p.actual), hit: p.hit === true });
  }
  return out;
}

/** The metric's value, rounded as client_insights rounds rates. */
export const isHit = (p: Pick<Prediction, "low" | "high">, actual: number) =>
  actual >= p.low && actual <= p.high;

/**
 * score_predictions: every due, unscored prediction gets one ceo.prediction_scored with the actual
 * from clientInsights over [made, dueAt]. Safe to run twice: a scored prediction is skipped, and
 * an advisory lock keeps two runs from scoring the same one at once.
 */
export async function scorePredictions(deps: { db: Db; emit: Emit; now: () => Date }) {
  return deps.db.transaction(async (tx) => {
    const lock = await tx.execute<{ ok: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext('score_predictions')) as ok`,
    );
    if (!lock.rows[0]?.ok) return { scored: 0 };
    const now = deps.now();
    const done = await scores(deps.db);
    let scored = 0;
    for (const p of await predictions(deps.db)) {
      if (done.has(p.predictionId) || new Date(p.dueAt) > now) continue;
      const exists = await deps.db.select({ id: clients.id }).from(clients).where(eq(clients.id, p.clientId));
      if (!exists[0]) continue;
      const ins = await clientInsights(deps.db, p.clientId, { since: p.at, until: new Date(p.dueAt) });
      const actual = Number(ins[p.metric]);
      await deps.emit({
        actor: "worker",
        type: "ceo.prediction_scored",
        entityType: "client",
        entityId: p.clientId,
        payload: {
          predictionId: p.predictionId,
          metric: p.metric,
          low: p.low,
          high: p.high,
          actual,
          hit: isHit(p, actual),
        },
      });
      scored += 1;
    }
    return { scored };
  });
}

export async function trackRecord(db: Db) {
  const all = await predictions(db);
  const done = await scores(db);
  const scoredList = all.filter((p) => done.has(p.predictionId));
  const hits = scoredList.filter((p) => done.get(p.predictionId)!.hit).length;
  return {
    made: all.length,
    scored: scoredList.length,
    hits,
    hitRate: scoredList.length ? Math.round((hits / scoredList.length) * 1000) / 1000 : null,
    recent: all.slice(0, 10).map((p) => ({
      predictionId: p.predictionId,
      clientId: p.clientId,
      decision: p.decision,
      metric: p.metric,
      low: p.low,
      high: p.high,
      dueAt: p.dueAt,
      actual: done.get(p.predictionId)?.actual ?? null,
      hit: done.get(p.predictionId)?.hit ?? null,
    })),
  };
}

const METRIC_LABEL: Record<PredictionMetric, string> = {
  replyRate: "reply rate",
  interestRate: "interest rate",
  sent: "emails sent",
  wins: "wins",
};
const fmt = (metric: PredictionMetric, n: number) =>
  metric === "replyRate" || metric === "interestRate" ? `${Math.round(n * 1000) / 10}%` : String(n);
/** "reply rate 8–12%": numbers only, safe for the public page. */
export function predictionRange(metric: PredictionMetric, low: number, high: number): string {
  const pct = metric === "replyRate" || metric === "interestRate";
  const a = pct ? String(Math.round(low * 1000) / 10) : String(low);
  return `${METRIC_LABEL[metric] ?? metric} ${a}–${fmt(metric, high)}`;
}
export const predictionActual = (metric: PredictionMetric, n: number) => fmt(metric, n);

// ---------------------------------------------------------------- problems

const pausedByOf = (actor: string | undefined): "ceo" | "owner" | "system" =>
  actor === "naive:ceo"
    ? "ceo"
    : actor?.startsWith("user:") || actor?.startsWith("client:")
      ? "owner"
      : "system";

async function latestPauseActor(db: Db, clientId: string) {
  const [e] = await db
    .select({ actor: events.actor })
    .from(events)
    .where(
      and(eq(events.type, "client.paused"), eq(events.entityType, "client"), eq(events.entityId, clientId)),
    )
    .orderBy(desc(events.ts))
    .limit(1);
  return e?.actor;
}

/** list_problems, less the per-client attention list (agency.ts adds it from attentionReasons). */
export async function listProblems(deps: { db: Db; now: () => Date }) {
  const { db } = deps;
  const now = deps.now();
  const health = (await checkHealth({ db, demo: false, fakes: [] })).checks;

  const dead = await db
    .select({ payload: events.payload, ts: events.ts })
    .from(events)
    .where(and(eq(events.type, "job.dead"), gte(events.ts, new Date(now.getTime() - 14 * DAY))))
    .orderBy(desc(events.ts))
    .limit(100);
  const seen = new Set<string>();
  const deadJobs = [];
  for (const d of dead) {
    const jobId = d.payload.jobId;
    const type = String(d.payload.job ?? "");
    if (typeof jobId !== "string" || seen.has(jobId)) continue;
    seen.add(jobId);
    const s = await replayState(db, { type: type as never, jobId });
    if (s.lastState === "completed") continue;
    deadJobs.push({
      jobId,
      type,
      at: d.ts.toISOString(),
      replays: s.replays,
      replayable: REPLAYABLE_JOBS.has(type) && replayRefusal(type, s) === null,
    });
    if (deadJobs.length >= 20) break;
  }

  const raised = await db
    .select({ payload: events.payload, ts: events.ts })
    .from(events)
    .where(and(eq(events.type, "alert.raised"), gte(events.ts, new Date(now.getTime() - DAY))))
    .orderBy(desc(events.ts))
    .limit(50);
  const alerts = raised.map((a) => {
    const p = a.payload as { kind?: string; entity?: string; summary?: string };
    return {
      kind: String(p.kind ?? ""),
      entity: String(p.entity ?? ""),
      summary: String(p.summary ?? "").slice(0, 300),
      at: a.ts.toISOString(),
    };
  });

  const rows = await db.select().from(clients).orderBy(clients.createdAt);
  const pausedClients = [];
  const sendingPaused = [];
  for (const c of rows) {
    if (c.status === "paused")
      pausedClients.push({
        clientId: c.id,
        slug: c.slug,
        pausedBy: pausedByOf(await latestPauseActor(db, c.id)),
      });
    const p = await sendPause(db, c.id);
    if (p.paused)
      sendingPaused.push({
        clientId: c.id,
        slug: c.slug,
        reason: p.reason ?? null,
        bounceRate: p.bounceRate,
      });
  }

  const stuck = await db
    .select({ id: messages.id, clientId: messages.clientId, since: messages.updatedAt })
    .from(messages)
    .where(
      and(
        eq(messages.status, "sending"),
        lt(messages.updatedAt, new Date(now.getTime() - STUCK_SENDING_MINUTES * 60_000)),
      ),
    )
    .limit(50);
  const stuckSending = stuck.map((m) => ({
    messageId: m.id,
    clientId: m.clientId,
    since: m.since.toISOString(),
  }));

  return { health, deadJobs, alerts, pausedClients, sendingPaused, stuckSending };
}

// ---------------------------------------------------------------- pausing

type PauseResult = { ok: true; status: ClientStatus } | { ok: false; reason: string };

export async function pauseClient(
  deps: { db: Db; emit: Emit },
  input: { clientId: string; reason: string },
  actor: string,
): Promise<PauseResult> {
  if (input.clientId === OUTRUN_CLIENT_ID)
    return { ok: false, reason: "Outrun's own crew is never paused by the CEO" };
  const c = await clientRow(deps.db, input.clientId);
  // Pausing over someone else's pause would make it look like the CEO's, and let it resume it.
  if (c.status === "paused") return { ok: false, reason: "the client is already paused" };
  const { status } = await setPaused(deps, c.id, true, actor, input.reason);
  return { ok: true, status };
}

export async function resumeClient(
  deps: { db: Db; emit: Emit },
  input: { clientId: string; reason: string },
  actor: string,
): Promise<PauseResult> {
  if (input.clientId === OUTRUN_CLIENT_ID)
    return { ok: false, reason: "Outrun's own crew is never resumed by the CEO" };
  const c = await clientRow(deps.db, input.clientId);
  if (c.status !== "paused") return { ok: false, reason: `the client isn't paused (it is ${c.status})` };
  const by = await latestPauseActor(deps.db, c.id);
  if (by !== actor) {
    const who = pausedByOf(by);
    return {
      ok: false,
      reason:
        who === "owner"
          ? "the owner paused this client; only the owner resumes it. Put it in the brief."
          : "this client was paused automatically (bounces or complaints, or by our code); only the owner resumes it. Put it in the brief.",
    };
  }
  const send = await sendPause(deps.db, c.id);
  if (send.paused)
    return {
      ok: false,
      reason: `sending is paused by ${send.reason === "complaint" ? "a complaint" : "bounces"}; the owner fixes the cause and resumes it`,
    };
  const { status } = await setPaused(deps, c.id, false, actor, input.reason);
  return { ok: true, status };
}

// ---------------------------------------------------------------- board memo

/** ISO week of the agency's calendar day, e.g. "2026-W46". */
export function isoWeek(now: Date): string {
  const [y, m, d] = dayIn(CRON_TZ, now).split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const year = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const memoEntity = (week: string) => `ceo:memo:${week}`;

export async function saveBoardMemo(
  deps: {
    db: Db;
    emit: Emit;
    now: () => Date;
    enqueue: (job: JobEnvelopeInput) => Promise<{ jobId: string | null }>;
  },
  input: { kpis: string; decisions: string; asks: string },
  actor: string,
) {
  const week = isoWeek(deps.now());
  if (await boardMemo(deps.db, week))
    return { saved: false, week, reason: `the memo for ${week} is already written; one per week` };
  await deps.emit({
    actor: actor as never,
    type: "ceo.board_memo",
    entityType: "system",
    entityId: memoEntity(week),
    payload: { week, kpis: input.kpis, decisions: input.decisions, asks: input.asks },
  });
  await deps.enqueue({
    type: "send_ceo_brief",
    payload: { kind: "board_memo", week },
    idempotencyKey: memoEntity(week),
    traceId: randomUUID(),
  });
  return { saved: true, week, reason: null };
}

export async function boardMemo(db: Db, week: string) {
  const [e] = await db
    .select({ payload: events.payload, ts: events.ts })
    .from(events)
    .where(and(eq(events.type, "ceo.board_memo"), eq(events.entityId, memoEntity(week))))
    .orderBy(events.ts)
    .limit(1);
  return e
    ? { ...(e.payload as { week: string; kpis: string; decisions: string; asks: string }), at: e.ts }
    : null;
}

/** The memo email: a fixed template, filled by code, for the owner only. */
export async function boardMemoEmail(db: Db, week: string, appUrl: string) {
  const memo = await boardMemo(db, week);
  if (!memo) return null;
  const t = await trackRecord(db);
  const record =
    t.hitRate === null
      ? `${t.made} prediction(s) made, none scored yet`
      : `${t.hits} of ${t.scored} scored predictions hit (${Math.round(t.hitRate * 100)}%), ${t.made} made`;
  return {
    subject: `[Outrun agency] Board memo for ${week}`,
    text: [
      `Board memo, ${week}`,
      `KPIs\n${memo.kpis}`,
      `Decisions\n${memo.decisions}`,
      `Asks of the owner\n${memo.asks}`,
      `CEO track record\n${record}`,
      `Agency dashboard: ${appUrl}/dashboard/agency`,
    ].join("\n\n"),
  };
}

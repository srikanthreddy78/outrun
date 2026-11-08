/**
 * The experimenter's A/B tests of email angles and the signal scout's signals, read back for the
 * sdr's brief and the orchestrator's plan.
 *
 *   experiments  live in the events ledger: `experiment.started` and `experiment.ended` on the
 *                client. One is active per client: the latest started that hasn't ended.
 *   variantFor   alternates A and B by prospect: the prospect's position among its client's
 *                prospects (created_at, id), which never changes since nothing is deleted.
 *   results      per variant: first emails sent while it ran, prospects that replied or showed
 *                interest (insights.ts' triage attribution), and the reply rate.
 *   signals      facts keyed `signal:<kind>` with a date; fresh within SIGNAL_FRESH_DAYS.
 *
 * Everything is counted by code; nothing here moves money, sets a price or deletes data.
 */
import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { SIGNAL_FRESH_DAYS } from "./constants";
import type { Db } from "./db/client";
import { events, messages, prospects } from "./db/schema";
import { isInterest, isReply, labelledInbound, rate } from "./insights";

const DAY = 86_400_000;

export type VariantKey = "A" | "B";
export interface Experiment {
  experimentId: string;
  hypothesis: string;
  variants: { key: VariantKey; angle: string }[];
  startedAt: Date;
  endedAt: Date | null;
}

/** The client's latest experiment, active or not, or null. */
export async function latestExperiment(db: Db, clientId: string): Promise<Experiment | null> {
  const rows = await db
    .select({ type: events.type, payload: events.payload, ts: events.ts })
    .from(events)
    .where(
      and(
        inArray(events.type, ["experiment.started", "experiment.ended"]),
        eq(events.entityType, "client"),
        eq(events.entityId, clientId),
      ),
    )
    .orderBy(desc(events.ts), desc(events.id))
    .limit(50);
  const started = rows.find((r) => r.type === "experiment.started");
  if (!started) return null;
  const p = started.payload as { experimentId: string; hypothesis: string; variants: Experiment["variants"] };
  const ended = rows.find(
    (r) =>
      r.type === "experiment.ended" &&
      (r.payload as { experimentId?: string }).experimentId === p.experimentId,
  );
  return {
    experimentId: p.experimentId,
    hypothesis: p.hypothesis,
    variants: p.variants,
    startedAt: started.ts,
    endedAt: ended?.ts ?? null,
  };
}

export async function activeExperiment(db: Db, clientId: string): Promise<Experiment | null> {
  const e = await latestExperiment(db, clientId);
  return e && !e.endedAt ? e : null;
}

/** A or B for this prospect: even positions among the client's prospects get A, odd get B. */
export async function variantFor(db: Db, clientId: string, prospectId: string): Promise<VariantKey | null> {
  const r = await db.execute<{ n: number }>(sql`select (select count(*)::int from prospects o
      where o.client_id = p.client_id and (o.created_at, o.id) < (p.created_at, p.id)) as n
    from prospects p where p.id = ${prospectId} and p.client_id = ${clientId}`);
  const row = r.rows[0];
  if (!row) return null;
  return Number(row.n) % 2 === 0 ? "A" : "B";
}

export interface VariantResult {
  key: VariantKey;
  angle: string;
  sent: number;
  replies: number;
  interested: number;
  replyRate: number;
}

/** Per variant: first emails sent while the experiment ran, and who answered them. */
export async function experimentResults(db: Db, clientId: string, e: Experiment): Promise<VariantResult[]> {
  const firsts = await db
    .select({ prospectId: messages.prospectId, variant: messages.variant })
    .from(messages)
    .where(
      and(
        eq(messages.clientId, clientId),
        eq(messages.direction, "outbound"),
        eq(messages.kind, "first"),
        eq(messages.status, "sent"),
        isNotNull(messages.variant),
        gte(messages.createdAt, e.startedAt),
        e.endedAt ? lte(messages.createdAt, e.endedAt) : undefined,
      ),
    );
  const variantOf = new Map<string, VariantKey>();
  for (const f of firsts) if (f.prospectId) variantOf.set(f.prospectId, f.variant as VariantKey);
  const replied = new Set<string>();
  const interested = new Set<string>();
  for (const m of await labelledInbound(db, clientId, e.startedAt)) {
    if (!m.prospectId || !variantOf.has(m.prospectId)) continue;
    if (isReply(m.label)) replied.add(m.prospectId);
    if (isInterest(m.label)) interested.add(m.prospectId);
  }
  return e.variants.map((v) => {
    const ids = [...variantOf].filter(([, k]) => k === v.key).map(([id]) => id);
    const replies = ids.filter((id) => replied.has(id)).length;
    return {
      key: v.key,
      angle: v.angle,
      sent: ids.length,
      replies,
      interested: ids.filter((id) => interested.has(id)).length,
      replyRate: rate(replies, ids.length),
    };
  });
}

/* ---------- Signals ---------- */

export const SIGNAL_KINDS = ["funding", "hiring", "launch", "news"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];
export type StoredFact = { key: string; value: string; sourceUrl: string; date?: string };

/** Fresh: dated within SIGNAL_FRESH_DAYS of now, and not in the future (a day's slack for zones). */
export function isFresh(date: string, now: Date): boolean {
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) && date >= freshSince(now) && t <= now.getTime() + DAY;
}

/** The oldest date (YYYY-MM-DD, UTC) that still counts as fresh. */
const freshSince = (now: Date) =>
  new Date(now.getTime() - SIGNAL_FRESH_DAYS * DAY).toISOString().slice(0, 10);

/** The prospect's newest fresh signal, or null. */
export function freshestSignal(facts: readonly StoredFact[], now: Date) {
  const s = facts
    .filter((f) => f.key.startsWith("signal:") && f.date && isFresh(f.date, now))
    .sort((a, b) => b.date!.localeCompare(a.date!))[0];
  if (!s) return null;
  const kind = s.key.slice("signal:".length) as SignalKind;
  if (!(SIGNAL_KINDS as readonly string[]).includes(kind)) return null;
  return { fact: s, kind, date: s.date! };
}

/** SQL: 1 when a prospect has a fresh signal fact, else 0; plan_day orders by it first. */
export function freshSignalRank(now: Date) {
  const since = freshSince(now);
  return sql<number>`(case when exists (select 1 from jsonb_array_elements(${prospects.facts}) f
    where f->>'key' like 'signal:%' and f->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}$' and f->>'date' >= ${since}) then 1 else 0 end)`;
}

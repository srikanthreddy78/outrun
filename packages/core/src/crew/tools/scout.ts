/**
 * The signal scout's and the experimenter's tools (optional client roles the CEO staffs).
 *
 *   find_signals        one Monid news search for a prospect's company; returns candidate items
 *                       wrapped as untrusted, saves nothing
 *   save_signal         one sourced, dated signal as the fact `signal:<kind>` on a prospect of
 *                       this client's; emits prospect.signal_found
 *   start_experiment    two angles to test; refused while one is active for the client
 *   experiment_results  per variant: sent, replies, interested, reply rate
 *   end_experiment      the winner and the lesson; emits experiment.ended and ceo.lesson
 *
 * Angles only steer wording: check_draft still checks prices, links and citations.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { untrusted } from "../../../contracts";
import type { Db } from "../../db/client";
import { companies, prospects } from "../../db/schema";
import { createEmitter } from "../../events";
import {
  activeExperiment,
  experimentResults,
  isFresh,
  latestExperiment,
  type StoredFact,
  type VariantResult,
} from "../../experiments";
import { AppError } from "../../errors";
import { searchSignals } from "../../integrations/signals";
import type { MonidClient } from "../../integrations/types";
import { defineTool } from "../registry";
import { factCitation } from "./outreach";

export interface ScoutDeps {
  monid: Pick<MonidClient, "run">;
  settings: { demo: boolean };
}

async function prospectOf(db: Db, prospectId: string, clientId: string) {
  const [r] = await db
    .select({ p: prospects, domain: companies.domain, name: companies.name })
    .from(prospects)
    .innerJoin(companies, eq(prospects.companyId, companies.id))
    .where(and(eq(prospects.id, prospectId), eq(prospects.clientId, clientId)));
  if (!r) throw new AppError("not_found", `prospect ${prospectId}`);
  return r;
}

export const findSignals = (deps: ScoutDeps) =>
  defineTool({
    name: "find_signals",
    handler: async ({ prospectId }, ctx) => {
      const r = await prospectOf(ctx.db, prospectId, ctx.clientId);
      if (deps.settings.demo && !r.p.isDemo)
        throw new AppError("forbidden", "demo mode: search only the demo prospect");
      const out = await searchSignals(deps.monid, r.domain);
      await ctx.emit({
        actor: `naive:${ctx.agent}`,
        type: "signals.searched",
        entityType: "prospect",
        entityId: prospectId,
        payload: { items: out.items.length },
        costUsd: out.costUsd,
      });
      return {
        prospectId,
        company: { domain: r.domain, name: r.name ?? r.domain },
        items: out.items.map((i) => ({
          title: untrusted(i.title),
          summary: untrusted(i.summary),
          url: i.url,
          date: i.date,
        })),
      };
    },
  });

export const saveSignal = defineTool({
  name: "save_signal",
  handler: async ({ prospectId, kind, summary, sourceUrl, date }, ctx) => {
    if (!/^https?:\/\//i.test(sourceUrl)) throw new AppError("bad_request", "sourceUrl must be http(s)");
    if (!Number.isFinite(Date.parse(`${date}T00:00:00Z`))) throw new AppError("bad_request", "bad date");
    const now = ctx.now();
    if (Date.parse(`${date}T00:00:00Z`) > now.getTime() + 86_400_000)
      throw new AppError("bad_request", "a signal can't be dated in the future");
    const r = await prospectOf(ctx.db, prospectId, ctx.clientId);
    const key = `signal:${kind}`;
    const fact: StoredFact = { key, value: summary.trim(), sourceUrl, date };
    // One fact per kind: a newer signal of the same kind replaces the older one.
    const old = r.p.facts.find((f) => f.key === key) as StoredFact | undefined;
    if (!old || !old.date || old.date <= date) {
      const facts = [...r.p.facts.filter((f) => f.key !== key), fact];
      await ctx.db
        .update(prospects)
        .set({ facts })
        .where(and(eq(prospects.id, prospectId), eq(prospects.clientId, ctx.clientId)));
    }
    const fresh = isFresh(date, now);
    await ctx.emit({
      actor: `naive:${ctx.agent}`,
      type: "prospect.signal_found",
      entityType: "prospect",
      entityId: prospectId,
      payload: { clientId: ctx.clientId, kind, date, sourceUrl, fresh },
    });
    return { factKey: factCitation(key), fresh };
  },
});

export const startExperiment = defineTool({
  name: "start_experiment",
  handler: async ({ hypothesis, variants }, ctx) => {
    const actor = `naive:${ctx.agent}` as const;
    // A lock per client so two calls can't both start one.
    return ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`experiment:${ctx.clientId}`}))`);
      const db = tx as unknown as Db;
      const active = await activeExperiment(db, ctx.clientId);
      if (active)
        return {
          ok: false as const,
          reason: `experiment ${active.experimentId} is still running since ${active.startedAt.toISOString().slice(0, 10)}; end it first`,
        };
      const experimentId = randomUUID();
      await createEmitter(db)({
        actor,
        type: "experiment.started",
        entityType: "client",
        entityId: ctx.clientId,
        payload: {
          experimentId,
          hypothesis: hypothesis.trim(),
          variants: variants.map((v) => ({ key: v.key, angle: v.angle.trim() })),
        },
      });
      return { ok: true as const, experimentId };
    });
  },
});

export const experimentResultsTool = defineTool({
  name: "experiment_results",
  handler: async (_input, ctx) => {
    const e = await latestExperiment(ctx.db, ctx.clientId);
    if (!e) return { experiment: null };
    return {
      experiment: {
        experimentId: e.experimentId,
        hypothesis: e.hypothesis,
        startedAt: e.startedAt.toISOString(),
        active: !e.endedAt,
        variants: await experimentResults(ctx.db, ctx.clientId, e),
      },
    };
  },
});

/** The numbers behind a lesson, as one line the CEO can quote. */
export const evidenceLine = (rows: readonly VariantResult[]): string =>
  rows
    .map(
      (v) =>
        `${v.key} (${v.angle.slice(0, 80)}): ${v.sent} sent, ${v.replies} replied (${Math.round(v.replyRate * 100)}%), ${v.interested} interested`,
    )
    .join("; ");

export const endExperiment = defineTool({
  name: "end_experiment",
  handler: async ({ winner, lesson }, ctx) => {
    const e = await activeExperiment(ctx.db, ctx.clientId);
    if (!e) throw new AppError("conflict", "no experiment is running; start one first");
    const variants = await experimentResults(ctx.db, ctx.clientId, e);
    const actor = `naive:${ctx.agent}` as const;
    await ctx.emit({
      actor,
      type: "experiment.ended",
      entityType: "client",
      entityId: ctx.clientId,
      payload: { experimentId: e.experimentId, winner, lesson: lesson.trim(), results: variants },
    });
    // The CEO's playbook (record_lesson / read_playbook) reads ceo.lesson.
    await ctx.emit({
      actor,
      type: "ceo.lesson",
      entityType: "client",
      entityId: ctx.clientId,
      payload: {
        clientId: ctx.clientId,
        lesson: lesson.trim(),
        evidence: `${e.hypothesis.slice(0, 200)} Winner: ${winner}. ${evidenceLine(variants)}`,
        tags: ["experiment"],
      },
    });
    return { experimentId: e.experimentId, winner, variants };
  },
});

export const scoutTools = (deps: ScoutDeps) => [
  findSignals(deps),
  saveSignal,
  startExperiment,
  experimentResultsTool,
  endExperiment,
];

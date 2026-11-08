/**
 * outrun.plan_day: the orchestrator's one planning call. Naive's multiagent teams are coming
 * soon, so instead of board cards and handoffs this enqueues one start_session job per unit of
 * today's work and returns at once. Stage to agent:
 *   - `filed`      → researcher, one session per prospect ("Research prospect <id>").
 *   - `researched` → sdr, one session per prospect ("Draft the first email for prospect <id>"),
 *                    no more than today's send cap left. `drafted` and later stages wait on a
 *                    person or a reply, so nothing is planned for them.
 *   - follow-ups due → one sdr session for the batch, before first drafts, sharing the send cap.
 *   - candidates waiting and discovery cap left → one prospector session for the batch.
 * Keys are `plan:<day in CRON_TZ>:<agent>:<entity id>`, so a second run the same day enqueues
 * nothing new. Messages name ids only. In demo mode only the seeded demo prospect is planned
 * and discovery is skipped.
 */
import { and, asc, eq, type SQL } from "drizzle-orm";
import type { AgentName, Entity, ProspectStage } from "../../../contracts";
import { CRON_TZ, OUTRUN_CLIENT_ID } from "../../constants";
import { prospects } from "../../db/schema";
import { clientFocus } from "../../insights";
import { DEMO_FILED_REASON } from "../../seed";
import { CLIENT_CANDIDATES_ENOUGH } from "../../sources/clientSources";
import { dayIn } from "../../time";
import { defineTool } from "../registry";
import { pipelineCounts, type FollowupsDue, type PipelineSettings } from "./pipeline_status";

/** Stable entity ids for the batch sessions. */
export const DISCOVERY_ENTITY: Entity = { type: "system", id: "discovery" };
export const FOLLOWUPS_ENTITY: Entity = { type: "system", id: "followups" };

export function planDay(settings: PipelineSettings, followupsDue: FollowupsDue = async () => 0) {
  return defineTool({
    name: "plan_day",
    handler: async (input, ctx) => {
      const now = ctx.now();
      const day = dayIn(CRON_TZ, now);
      const counts = await pipelineCounts(ctx.db, ctx.clientId, settings, now);
      const limit = input.limitPerAgent;
      const enqueued: { agent: AgentName; prospectId: string | null }[] = [];

      const start = async (agent: AgentName, entity: Entity, message: string) => {
        // Outrun's keys predate clients; another client's carry its id, so days don't collide.
        const scope = ctx.clientId === OUTRUN_CLIENT_ID ? "" : `${ctx.clientId}:`;
        await ctx.enqueue({
          type: "start_session",
          payload: { agent, message, entity, clientId: ctx.clientId },
          idempotencyKey: `plan:${day}:${scope}${agent}:${entity.id}`,
          traceId: ctx.requestId,
        });
        enqueued.push({ agent, prospectId: entity.type === "prospect" ? entity.id : null });
      };

      const demoOnly: SQL | undefined = settings.demo
        ? eq(prospects.filedReason, DEMO_FILED_REASON)
        : undefined;
      const inStage = async (stage: ProspectStage, n: number): Promise<string[]> => {
        if (n <= 0) return [];
        const rows = await ctx.db
          .select({ id: prospects.id })
          .from(prospects)
          .where(and(eq(prospects.clientId, ctx.clientId), eq(prospects.stage, stage), demoOnly))
          .orderBy(asc(prospects.createdAt), asc(prospects.id))
          .limit(n);
        return rows.map((r) => r.id);
      };

      for (const id of await inStage("filed", limit))
        await start("researcher", { type: "prospect", id }, `Research prospect ${id}.`);

      let send = counts.capsLeft.send;
      const due = await followupsDue(ctx);
      if (due > 0 && send > 0) {
        const n = Math.min(due, send);
        await start("sdr", FOLLOWUPS_ENTITY, `Draft up to ${n} of the follow-ups due today.`);
        send -= n;
      }
      // The CEO's focus sets a client's first emails per day; the send cap still binds.
      const focus = ctx.clientId === OUTRUN_CLIENT_ID ? null : await clientFocus(ctx.db, ctx.clientId);
      const firsts = Math.min(focus?.dailyDraftLimit ?? limit, send);
      for (const id of await inStage("researched", firsts))
        await start("sdr", { type: "prospect", id }, `Draft the first email for prospect ${id}.`);

      const discovery = Math.min(counts.candidatesWaiting, counts.capsLeft.discovery);
      if (!settings.demo && discovery > 0)
        await start(
          "prospector",
          DISCOVERY_ENTITY,
          `File up to ${discovery} prospects that fit the ICP from the candidates waiting.`,
        );

      // A client's own sources: search again when its list runs low, once a day.
      if (
        !settings.demo &&
        ctx.clientId !== OUTRUN_CLIENT_ID &&
        counts.candidatesWaiting < CLIENT_CANDIDATES_ENOUGH
      )
        await ctx.enqueue({
          type: "refresh_client_sources",
          payload: { clientId: ctx.clientId },
          idempotencyKey: `client-sources:${day}:${ctx.clientId}`,
          traceId: ctx.requestId,
        });

      return { enqueued, capsLeft: counts.capsLeft };
    },
  });
}

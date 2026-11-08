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
 * Within a stage, prospects with a fresh signal (date within SIGNAL_FRESH_DAYS) come first.
 * Keys are `plan:<day in CRON_TZ>:<agent>:<entity id>`, so a second run the same day enqueues
 * nothing new. Messages name ids only. In demo mode only the seeded demo prospect is planned
 * and discovery is skipped.
 * Sessions start only for roles on the client's crew (clients.crew_roles). A client the CEO
 * staffed an account manager gets one weekly-report session when its last report is a week old.
 */
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { staffedRoles, type AgentName, type Entity, type ProspectStage } from "../../../contracts";
import { latestClientReport } from "../../accountManager";
import {
  CLIENT_REPORT_EVERY_DAYS,
  CRON_TZ,
  OUTRUN_CLIENT_ID,
  SIGNAL_SESSION_PROSPECTS,
} from "../../constants";
import { clients, prospects } from "../../db/schema";
import { freshSignalRank } from "../../experiments";
import { clientFocus } from "../../insights";
import { DEMO_FILED_REASON } from "../../seed";
import { CLIENT_CANDIDATES_ENOUGH } from "../../sources/clientSources";
import { dayIn } from "../../time";
import { defineTool } from "../registry";
import { pipelineCounts, type FollowupsDue, type PipelineSettings } from "./pipeline_status";

/** Stable entity ids for the batch sessions. */
export const DISCOVERY_ENTITY: Entity = { type: "system", id: "discovery" };
export const FOLLOWUPS_ENTITY: Entity = { type: "system", id: "followups" };
export const SIGNALS_ENTITY: Entity = { type: "system", id: "signals" };
export const EXPERIMENT_ENTITY: Entity = { type: "system", id: "experiment" };

export function planDay(settings: PipelineSettings, followupsDue: FollowupsDue = async () => 0) {
  return defineTool({
    name: "plan_day",
    handler: async (input, ctx) => {
      const now = ctx.now();
      const day = dayIn(CRON_TZ, now);
      const counts = await pipelineCounts(ctx.db, ctx.clientId, settings, now);
      const limit = input.limitPerAgent;
      const enqueued: { agent: AgentName; prospectId: string | null }[] = [];
      const [crew] = await ctx.db
        .select({ crewRoles: clients.crewRoles })
        .from(clients)
        .where(eq(clients.id, ctx.clientId));
      const staffed = new Set<string>(staffedRoles(crew?.crewRoles));

      const start = async (agent: AgentName, entity: Entity, message: string) => {
        // Only roles on this client's crew have an agent to start.
        if (!staffed.has(agent)) return;
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
          // A prospect with a fresh signal (the signal scout's) goes first.
          .orderBy(desc(freshSignalRank(now)), asc(prospects.createdAt), asc(prospects.id))
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

      // Roles the CEO staffed on this client's crew get one batch session a day.
      if (!settings.demo && ctx.clientId !== OUTRUN_CLIENT_ID) {
        const [c] = await ctx.db
          .select({ roles: clients.crewRoles })
          .from(clients)
          .where(eq(clients.id, ctx.clientId));
        const roles = new Set(c?.roles ?? []);
        if (roles.has("signal_scout")) {
          // Researched prospects with no fresh signal yet, named by id (a message holds ten).
          const ids = (
            await ctx.db
              .select({ id: prospects.id })
              .from(prospects)
              .where(
                and(
                  eq(prospects.clientId, ctx.clientId),
                  eq(prospects.stage, "researched"),
                  sql`${freshSignalRank(now)} = 0`,
                ),
              )
              .orderBy(asc(prospects.createdAt), asc(prospects.id))
              .limit(Math.min(limit, SIGNAL_SESSION_PROSPECTS))
          ).map((r) => r.id);
          if (ids.length)
            await start("signal_scout", SIGNALS_ENTITY, `Find signals for prospects ${ids.join(", ")}.`);
        }
        if (roles.has("experimenter"))
          await start(
            "experimenter",
            EXPERIMENT_ENTITY,
            "Check the experiment: start one if none runs, or read its results and end it once it has enough sends.",
          );
      }

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

      // A staffed account manager writes the client's weekly report.
      if (ctx.clientId !== OUTRUN_CLIENT_ID && staffed.has("account_manager")) {
        const last = await latestClientReport(ctx.db, ctx.clientId);
        if (!last || now.getTime() - last.at.getTime() >= CLIENT_REPORT_EVERY_DAYS * 86_400_000)
          await start(
            "account_manager",
            { type: "client", id: ctx.clientId },
            "Write this week's report for your client with outrun.client_weekly_report, then answer any open questions from outrun.client_questions.",
          );
      }

      return { enqueued, capsLeft: counts.capsLeft };
    },
  });
}

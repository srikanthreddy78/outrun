import { PROSPECT_STAGES, type ProspectStage } from "../../../contracts";
import { CRON_TZ, OUTRUN_CLIENT_ID } from "../../constants";
import { and, count, eq, gte } from "drizzle-orm";
import type { Db } from "../../db/client";
import { companies, messages, prospects } from "../../db/schema";
import { startOfDayIn } from "../../time";
import { effectiveSendCap, sentToday } from "../../email/rules";
import { defineTool } from "../registry";
import type { ToolContext } from "../types";

export interface PipelineSettings {
  sendDailyCap: number;
  discoveryDailyCap: number;
  demo: boolean;
}

/** Follow-ups due today. SH-8 supplies the real count; until then nothing is due. */
export type FollowupsDue = (ctx: ToolContext) => Promise<number>;

export interface PipelineCounts {
  stages: Record<ProspectStage, number>;
  candidatesWaiting: number;
  capsLeft: { send: number; discovery: number };
  approvalsWaiting: number;
}

/**
 * One client's counts per stage, candidates waiting, today's caps left (days in CRON_TZ) and
 * approvals waiting.
 */
export async function pipelineCounts(
  db: Db,
  clientId: string,
  settings: Pick<PipelineSettings, "sendDailyCap" | "discoveryDailyCap">,
  now: Date,
): Promise<PipelineCounts> {
  const since = startOfDayIn(CRON_TZ, now);
  const stageRows = await db
    .select({ stage: prospects.stage, n: count() })
    .from(prospects)
    .where(eq(prospects.clientId, clientId))
    .groupBy(prospects.stage);
  const stages = Object.fromEntries(PROSPECT_STAGES.map((s) => [s, 0])) as Record<ProspectStage, number>;
  for (const r of stageRows) stages[r.stage] = Number(r.n);

  // Discovered candidates are Outrun's; other clients get their own candidate lists.
  const [candidates] =
    clientId === OUTRUN_CLIENT_ID
      ? await db.select({ n: count() }).from(companies).where(eq(companies.kind, "candidate"))
      : [{ n: 0 }];
  const [filedToday] = await db
    .select({ n: count() })
    .from(prospects)
    .where(and(eq(prospects.clientId, clientId), gte(prospects.createdAt, since)));
  const sent = await sentToday(db, now, clientId);
  const sendCap = await effectiveSendCap(db, settings.sendDailyCap, now, clientId);
  const [waiting] = await db
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.clientId, clientId), eq(messages.status, "awaiting_approval")));

  return {
    stages,
    candidatesWaiting: Number(candidates?.n ?? 0),
    capsLeft: {
      send: Math.max(0, sendCap - sent),
      discovery: Math.max(0, settings.discoveryDailyCap - Number(filedToday?.n ?? 0)),
    },
    approvalsWaiting: Number(waiting?.n ?? 0),
  };
}

export function pipelineStatus(settings: PipelineSettings, followupsDue: FollowupsDue = async () => 0) {
  return defineTool({
    name: "pipeline_status",
    handler: async (_input, ctx) => ({
      ...(await pipelineCounts(ctx.db, ctx.clientId, settings, ctx.now())),
      followupsDue: await followupsDue(ctx),
      demo: settings.demo,
    }),
  });
}

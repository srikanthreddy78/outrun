import { PROSPECT_STAGES, type ProspectStage } from "../../../contracts";
import { CRON_TZ } from "../../constants";
import { and, count, eq, gte, inArray } from "drizzle-orm";
import { companies, messages, prospects } from "../../db/schema";
import { startOfDayIn } from "../../time";
import { defineTool } from "../registry";
import type { ToolContext } from "../types";

export interface PipelineSettings {
  sendDailyCap: number;
  discoveryDailyCap: number;
  demo: boolean;
}

/** Follow-ups due today. SH-8 supplies the real count; until then nothing is due. */
export type FollowupsDue = (ctx: ToolContext) => Promise<number>;

export function pipelineStatus(settings: PipelineSettings, followupsDue: FollowupsDue = async () => 0) {
  return defineTool({
    name: "pipeline_status",
    handler: async (_input, ctx) => {
      const db = ctx.db;
      const since = startOfDayIn(CRON_TZ, ctx.now());
      const stageRows = await db.select({ stage: prospects.stage, n: count() }).from(prospects).groupBy(prospects.stage);
      const stages = Object.fromEntries(PROSPECT_STAGES.map((s) => [s, 0])) as Record<ProspectStage, number>;
      for (const r of stageRows) stages[r.stage] = Number(r.n);

      const [candidates] = await db.select({ n: count() }).from(companies).where(eq(companies.kind, "candidate"));
      const [filedToday] = await db.select({ n: count() }).from(prospects).where(gte(prospects.createdAt, since));
      const [sentToday] = await db
        .select({ n: count() })
        .from(messages)
        .where(
          and(
            eq(messages.direction, "outbound"),
            inArray(messages.kind, ["first", "followup", "reply"]),
            inArray(messages.status, ["approved", "sending", "sent"]),
            gte(messages.updatedAt, since),
          ),
        );
      const [waiting] = await db.select({ n: count() }).from(messages).where(eq(messages.status, "awaiting_approval"));

      return {
        stages,
        candidatesWaiting: Number(candidates?.n ?? 0),
        capsLeft: {
          send: Math.max(0, settings.sendDailyCap - Number(sentToday?.n ?? 0)),
          discovery: Math.max(0, settings.discoveryDailyCap - Number(filedToday?.n ?? 0)),
        },
        approvalsWaiting: Number(waiting?.n ?? 0),
        followupsDue: await followupsDue(ctx),
        demo: settings.demo,
      };
    },
  });
}

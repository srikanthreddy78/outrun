/**
 * send_ceo_brief: emails the CEO's brief for one day to the team, once (keyed `ceo:brief:<day>`),
 * or with `kind: "board_memo"` the week's board memo to the owner (keyed `ceo:memo:<week>`), in a
 * fixed template. Without ALERT_EMAIL both stay on /dashboard/agency only.
 * score_predictions: daily (CRON.score_predictions), scores the CEO's due predictions once each.
 * send_client_report: tells a client's approvers its weekly report is in the portal.
 */
import { sendClientReportNotice } from "@outrun/core/accountManager";
import { boardMemoEmail, scorePredictions } from "@outrun/core/brain";
import { latestBrief } from "@outrun/core/crew/tools/agency";
import type { Handlers } from "@outrun/core/queue";
import type { Runtime } from "@outrun/core/runtime";
import { z } from "zod";

const Payload = z.union([
  z.object({ kind: z.literal("board_memo"), week: z.string().regex(/^\d{4}-W\d{2}$/) }),
  z.object({ kind: z.literal("brief").optional(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);
const ReportPayload = z.object({ clientId: z.uuid(), reportId: z.uuid() });

export function ceoHandlers(rt: Pick<Runtime, "db" | "emit" | "integrations" | "config">): Handlers {
  return {
    send_ceo_brief: async (env) => {
      const p = Payload.parse(env.payload);
      if (p.kind === "board_memo") {
        const mail = await boardMemoEmail(rt.db.db, p.week, rt.config.appUrl);
        if (!mail || !rt.config.alertEmail) return;
        await rt.integrations.sendTransactional({
          to: rt.config.alertEmail,
          subject: mail.subject,
          text: mail.text,
          idempotencyKey: `ceo:memo:${p.week}`,
        });
        await rt.emit({
          actor: "worker",
          type: "ceo.board_memo_sent",
          entityType: "system",
          entityId: `ceo:memo:${p.week}`,
          payload: { week: p.week },
        });
        return;
      }
      const { day } = p;
      const brief = await latestBrief(rt.db.db, day);
      if (!brief || !rt.config.alertEmail) return;
      await rt.integrations.sendTransactional({
        to: rt.config.alertEmail,
        subject: `[Outrun agency] CEO brief for ${day}`,
        text: [brief.summary, `Agency dashboard: ${rt.config.appUrl}/dashboard/agency`].join("\n\n"),
        idempotencyKey: `ceo:brief:${day}`,
      });
      await rt.emit({
        actor: "worker",
        type: "ceo.brief_sent",
        entityType: "system",
        entityId: `ceo:brief:${day}`,
        payload: { day },
      });
    },
    score_predictions: async () => {
      await scorePredictions({ db: rt.db.db, emit: rt.emit, now: () => new Date() });
    },
    /** send_client_report: the fixed "your weekly report is ready" notice to a client's approvers. */
    send_client_report: async (env) => {
      const { clientId, reportId } = ReportPayload.parse(env.payload);
      await sendClientReportNotice(
        {
          db: rt.db.db,
          emit: rt.emit,
          sendTransactional: rt.integrations.sendTransactional,
          appUrl: rt.config.appUrl,
        },
        clientId,
        reportId,
      );
    },
  };
}

/**
 * send_ceo_brief: emails the CEO's brief for one day to the team, once (keyed `ceo:brief:<day>`).
 * Without ALERT_EMAIL the brief stays on /dashboard/agency only.
 */
import { latestBrief } from "@outrun/core/crew/tools/agency";
import type { Handlers } from "@outrun/core/queue";
import type { Runtime } from "@outrun/core/runtime";
import { z } from "zod";

const Payload = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export function ceoHandlers(rt: Pick<Runtime, "db" | "emit" | "integrations" | "config">): Handlers {
  return {
    send_ceo_brief: async (env) => {
      const { day } = Payload.parse(env.payload);
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
  };
}

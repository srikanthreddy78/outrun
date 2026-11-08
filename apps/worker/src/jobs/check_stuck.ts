/** SR-10: check_stuck, every 5 minutes (CRON.check_stuck). Finds stuck work and tells the team. */
import { findAlerts, raiseAlerts } from "@outrun/core/alerts";
import type { Handlers } from "@outrun/core/queue";
import type { Runtime } from "@outrun/core/runtime";

export function checkStuckHandlers(
  rt: Pick<Runtime, "db" | "emit" | "integrations" | "config" | "fakes">,
): Handlers {
  return {
    check_stuck: async () => {
      const alerts = await findAlerts({
        db: rt.db.db,
        // On the fake there's no real webhook to check.
        ...(rt.fakes.includes("naive") ? {} : { naive: rt.integrations.naive }),
        appUrl: rt.config.appUrl,
        llmBudgetUsdDaily: rt.config.settings.llmBudgetUsdDaily,
      });
      await raiseAlerts(
        {
          db: rt.db.db,
          emit: rt.emit,
          sendTransactional: rt.integrations.sendTransactional,
          appUrl: rt.config.appUrl,
          ...(rt.config.alertEmail ? { alertEmail: rt.config.alertEmail } : {}),
        },
        alerts,
      );
    },
  };
}

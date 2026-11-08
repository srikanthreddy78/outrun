/** SH-2 refresh_sources and SH-4 sync_crm. The logic lives in @outrun/core. */
import { runSyncCrm } from "@outrun/core/crm/sync";
import type { Handlers } from "@outrun/core/queue";
import type { Runtime } from "@outrun/core/runtime";
import { runRefreshClientSources } from "@outrun/core/sources/clientSources";
import { runRefreshSources } from "@outrun/core/sources/refresh";
import { z } from "zod";

const CrmPayload = z.object({ prospectId: z.uuid() });
const ClientPayload = z.object({ clientId: z.uuid() });

export function prospectingHandlers(rt: Pick<Runtime, "db" | "emit" | "integrations" | "config">): Handlers {
  return {
    refresh_sources: async () => {
      await runRefreshSources({
        db: rt.db.db,
        emit: rt.emit,
        discover: rt.integrations.discover,
        settings: rt.config.settings,
      });
    },
    refresh_client_sources: async (env) => {
      const { clientId } = ClientPayload.parse(env.payload);
      await runRefreshClientSources(
        { db: rt.db.db, emit: rt.emit, monid: rt.integrations.monid, settings: rt.config.settings },
        clientId,
      );
    },
    sync_crm: async (env) => {
      const { prospectId } = CrmPayload.parse(env.payload);
      await runSyncCrm({ db: rt.db.db, emit: rt.emit, hubspot: rt.integrations.hubspot }, prospectId);
    },
  };
}

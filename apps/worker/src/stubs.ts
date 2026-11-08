/**
 * Stub handlers for every job. Each records a `stub.<job>` event and, when the payload asks
 * for it, enqueues the next job in the loop for the same prospect. Real handlers replace
 * these card by card; `pnpm e2e:loop` keeps proving the chain still runs end to end.
 */
import { JOB_TYPES, type JobType } from "@outrun/core/contracts";
import type { Emit } from "@outrun/core/events";
import type { Handlers, JobHandler, Queue } from "@outrun/core/queue";

/** The order a prospect moves through the loop. Covers all 13 jobs. */
export const LOOP_ORDER: readonly JobType[] = [
  "refresh_sources",
  "scan_domain",
  "sync_crm",
  "start_session",
  "handle_naive_event",
  "send_email",
  "triage_reply",
  "handle_stripe_event",
  "start_audit",
  "handle_apify_event",
  "build_kit",
  "deliver_report",
  "check_stuck",
];

export function stubHandlers(deps: { queue: Pick<Queue, "enqueue">; emit: Emit }): Handlers {
  const out: Handlers = {};
  for (const type of JOB_TYPES) {
    const handler: JobHandler = async (env) => {
      const p = env.payload as { prospectId?: string; chain?: string; forceFail?: boolean };
      if (p.forceFail) throw new Error(`forced failure in ${type}`);
      await deps.emit({
        actor: "worker",
        type: `stub.${type}`,
        entityType: p.prospectId ? "prospect" : "system",
        entityId: p.prospectId ?? type,
        payload: { traceId: env.traceId },
      });
      const next = LOOP_ORDER[LOOP_ORDER.indexOf(type) + 1];
      if (p.chain && next) {
        await deps.queue.enqueue({
          type: next,
          payload: { prospectId: p.prospectId, chain: p.chain },
          idempotencyKey: `${p.chain}:${next}`,
          traceId: env.traceId,
        });
      }
    };
    out[type] = handler;
  }
  return out;
}

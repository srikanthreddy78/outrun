import { z } from "zod";
import type { DbHandle } from "../db/client";
import { transaction } from "../db/client";
import { recordWebhookOnce } from "../events";
import { verifyApifyWebhookHeader } from "../integrations/apify";
import type { Queue } from "../queue";

const Event = z.object({
  eventType: z.enum(["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.TIMED_OUT", "ACTOR.RUN.ABORTED"]),
  resource: z.object({
    id: z.string().min(1),
    status: z.enum(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"]),
    defaultDatasetId: z.string().optional(),
    usageTotalUsd: z.number().finite().nonnegative().nullable().optional(),
  }),
});

export async function handleApifyWebhook(opts: {
  rawBody: string;
  header: string | null;
  secret: string | undefined;
  db: DbHandle;
  queue: Pick<Queue, "enqueue">;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!opts.secret) return { status: 503, body: { error: "not_configured" } };
  if (!verifyApifyWebhookHeader(opts.header ?? undefined, opts.secret))
    return { status: 401, body: { error: "unauthorized" } };
  let raw: unknown;
  try {
    raw = JSON.parse(opts.rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const parsed = Event.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: "invalid_event" } };
  const { eventType, resource } = parsed.data;
  if (eventType !== `ACTOR.RUN.${resource.status === "TIMED-OUT" ? "TIMED_OUT" : resource.status}`)
    return { status: 400, body: { error: "event_status_mismatch" } };
  if (resource.status === "SUCCEEDED" && !resource.defaultDatasetId)
    return { status: 400, body: { error: "missing_dataset" } };
  const accepted = await transaction(opts.db, async (tx) => {
    const first = await recordWebhookOnce(tx.db, "apify", `${resource.id}:${resource.status}`, { eventType });
    if (!first) return false;
    await opts.queue.enqueue(
      {
        type: "handle_apify_event",
        payload: {
          runId: resource.id,
          status: resource.status,
          datasetId: resource.defaultDatasetId ?? null,
          costUsd: resource.usageTotalUsd ?? null,
        },
        idempotencyKey: `apify:${resource.id}:${resource.status}`,
        traceId: `apify-${resource.id}`,
      },
      { tx },
    );
    return true;
  });
  return { status: 200, body: { ok: true, duplicate: !accepted } };
}

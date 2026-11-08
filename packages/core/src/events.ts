import { desc, eq } from "drizzle-orm";
import { EmitInput, type Event } from "../contracts";
import type { Db, TxScope } from "./db/client";
import { events } from "./db/schema";

export type Emit = (input: EmitInput, opts?: { tx?: TxScope }) => Promise<void>;

/** Writes one row to the events ledger, inside the caller's transaction when given. */
export function createEmitter(db: Db): Emit {
  return async (input, opts) => {
    const e = EmitInput.parse(input);
    await (opts?.tx?.db ?? db).insert(events).values({
      actor: e.actor,
      type: e.type,
      entityType: e.entityType,
      entityId: e.entityId,
      payload: e.payload ?? {},
      costUsd: String(e.costUsd ?? 0),
    });
  };
}

/**
 * Records a webhook delivery once. Returns false when this provider id was already seen,
 * which is how every webhook route dedupes.
 */
export async function recordWebhookOnce(
  db: Db,
  provider: "stripe" | "agentmail" | "apify" | "naive",
  deliveryId: string,
  payload: Record<string, unknown> = {},
): Promise<boolean> {
  const rows = await db
    .insert(events)
    .values({
      actor: `provider:${provider}`,
      type: "webhook.received",
      entityType: "system",
      entityId: `${provider}:${deliveryId}`,
      payload,
    })
    .onConflictDoNothing()
    .returning({ id: events.id });
  return rows.length > 0;
}

export async function eventsFor(db: Db, entityId: string): Promise<Event[]> {
  const rows = await db.select().from(events).where(eq(events.entityId, entityId)).orderBy(desc(events.ts));
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts.toISOString(),
    actor: r.actor,
    type: r.type,
    entityType: r.entityType as Event["entityType"],
    entityId: r.entityId,
    payload: r.payload,
    costUsd: Number(r.costUsd),
  }));
}

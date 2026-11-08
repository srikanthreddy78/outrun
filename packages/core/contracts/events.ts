import { z } from "zod";
import { EntityType, Id, IsoDateTime, Usd } from "./common";

/**
 * Who did it. Crew actions are `naive:<agent>`; people are `user:<login>`;
 * code is `worker`, `web` or `system`; providers are `provider:<name>`.
 */
export const Actor = z
  .string()
  .regex(
    /^(worker|web|system|naive:(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?[a-z_]+|user:[\w.@-]+|client:[\w.+@-]+|provider:[a-z_]+)$/,
    "unknown actor form",
  );
export type Actor = z.infer<typeof Actor>;

/** Dotted lowercase, e.g. `prospect.filed`, `llm.call`, `job.dead`. */
export const EventType = z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/, "event type must be dotted lowercase");

export const Event = z.object({
  id: Id,
  ts: IsoDateTime,
  actor: Actor,
  type: EventType,
  entityType: EntityType,
  entityId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  costUsd: Usd.default(0),
});
export type Event = z.infer<typeof Event>;

export const EmitInput = Event.omit({ id: true, ts: true }).partial({ payload: true, costUsd: true });
export type EmitInput = z.input<typeof EmitInput>;

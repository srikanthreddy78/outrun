import { z } from "zod";
import { Entity, Id, IsoDateTime } from "./common";
import { AgentName } from "./crew";

/**
 * Start a Naive session for one agent about one entity.
 * The message names ids only: never email bodies or page text.
 */
export const StartSessionInput = z.object({
  agent: AgentName,
  message: z
    .string()
    .min(1)
    .max(2000)
    .refine((m) => !/@[\w-]+\.[a-z]{2,}/i.test(m), "a session message must name ids, not email addresses"),
  entity: Entity,
  idempotencyKey: z.string().min(1).max(200),
  /** The client whose crew runs it; Outrun's when absent. */
  clientId: Id.optional(),
});
export type StartSessionInput = z.infer<typeof StartSessionInput>;

export const SESSION_STATUSES = ["starting", "running", "idle", "terminated", "error"] as const;
export const SessionStatus = z.enum(SESSION_STATUSES);

/** Naive's stop reasons (https://usenaive.ai/docs/api/sessions.md). */
export const STOP_REASONS = [
  "end_turn",
  "awaiting_input",
  "awaiting_approval",
  "awaiting_answer",
  "awaiting_delegation",
  "budget_paused",
  "context_exhausted",
  "interrupted",
  "max_iterations",
  "error",
] as const;
export const StopReason = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof StopReason>;

export const SessionRecord = z.object({
  id: Id,
  /** Null while the row is still starting. */
  sessionId: z.string().min(1).nullable(),
  agent: AgentName,
  entityType: Entity.shape.type,
  entityId: z.string().min(1),
  status: SessionStatus,
  stopReason: StopReason.nullable(),
  spendUsd: z.number().nonnegative(),
  createdAt: IsoDateTime,
});
export type SessionRecord = z.infer<typeof SessionRecord>;

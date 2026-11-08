import { z } from "zod";
import { IsoDateTime } from "./common";

export const JOB_TYPES = [
  "refresh_sources",
  "scan_domain",
  "growth_rescan",
  "sync_crm",
  "send_email",
  "triage_reply",
  "start_session",
  "start_audit",
  "handle_stripe_event",
  "handle_apify_event",
  "handle_naive_event",
  "build_kit",
  "deliver_report",
  "check_stuck",
  "send_ceo_brief",
] as const;
export const JobType = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof JobType>;

/** Every job travels in this envelope. The idempotency key dedupes enqueues. */
export const JobEnvelope = z.object({
  type: JobType,
  version: z.number().int().positive().default(1),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(200),
  runAfter: IsoDateTime.optional(),
  traceId: z.string().min(1),
});
export type JobEnvelope = z.infer<typeof JobEnvelope>;
export type JobEnvelopeInput = z.input<typeof JobEnvelope>;

import { z } from "zod";

/** Naive signs `<Vetta-Timestamp>.<raw body>` with HMAC-SHA256; header `Vetta-Signature: v1=<hex>`. */
export const NAIVE_SIGNATURE_HEADER = "vetta-signature";
export const NAIVE_TIMESTAMP_HEADER = "vetta-timestamp";
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export const NaiveEnvelope = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  created_at: z.union([z.string(), z.number()]),
  data: z.record(z.string(), z.unknown()),
});
export type NaiveEnvelope = z.infer<typeof NaiveEnvelope>;

/**
 * The Naive event types we subscribe to. Only session.idle, message.completed and
 * budget.exceeded are ever delivered to a webhook; stream-only names (session.running,
 * tool.confirm, tool.confirm.resolved) are accepted at subscribe time but never sent
 * (https://usenaive.ai/docs/capabilities/webhooks.md#event-types). Approval decisions are read
 * from the session's event list on the next session.idle instead.
 */
export const NAIVE_WEBHOOK_EVENTS = ["session.idle", "budget.exceeded"] as const;

/** The provider-native ids we dedupe deliveries on. */
export const DEDUPE_KEY = {
  stripe: "event.id",
  agentmail: "message id",
  apify: "run id",
  naive: "envelope id",
} as const;

export const WebhookProvider = z.enum(["stripe", "agentmail", "apify", "naive"]);
export type WebhookProvider = z.infer<typeof WebhookProvider>;

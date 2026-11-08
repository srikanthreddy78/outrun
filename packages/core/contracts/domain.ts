import { z } from "zod";

export const PRODUCT_KEYS = ["freeScan", "auditKit", "growth"] as const;
export const ProductKey = z.enum(PRODUCT_KEYS);
export type ProductKey = z.infer<typeof ProductKey>;
export const PaidProductKey = z.enum(["auditKit", "growth"]);
export type PaidProductKey = z.infer<typeof PaidProductKey>;

export const COMPANY_KINDS = ["candidate", "prospect"] as const;
export const SOURCES = ["mcp_registry", "glama", "apify", "producthunt", "yc", "manual", "fixture"] as const;
export const Source = z.enum(SOURCES);

export const PROSPECT_STAGES = [
  "filed",
  "researched",
  "drafted",
  "contacted",
  "replied",
  "interested",
  "checkout_sent",
  "won",
  "not_now",
  "lost",
  "unsubscribed",
] as const;
export const ProspectStage = z.enum(PROSPECT_STAGES);
export type ProspectStage = z.infer<typeof ProspectStage>;

export const MESSAGE_STATUSES = [
  "checked",
  "awaiting_approval",
  "approved",
  "sending",
  "sent",
  "rejected",
  "failed",
  "received",
] as const;
export const MessageStatus = z.enum(MESSAGE_STATUSES);
export type MessageStatus = z.infer<typeof MessageStatus>;
export const MessageDirection = z.enum(["outbound", "inbound"]);
export const MessageKind = z.enum(["first", "followup", "reply", "transactional", "inbound"]);
export type MessageKind = z.infer<typeof MessageKind>;

export const ORDER_STATES = [
  "pending",
  "paid",
  "auditing",
  "delivered",
  "failed",
  "canceled",
  "refunded",
] as const;
export const OrderState = z.enum(ORDER_STATES);
export type OrderState = z.infer<typeof OrderState>;

export const OUTCOMES = ["interested", "not_now", "lost"] as const;
export const Outcome = z.enum(OUTCOMES);

/** A readiness check id from MT-2, e.g. `llms_txt`, `robots_ai_rules`. */
export const CheckId = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
export const CheckTier = z.enum(["critical", "important", "nice"]);

export const ScanCheck = z.object({
  id: CheckId,
  tier: CheckTier,
  passed: z.boolean(),
  title: z.string(),
  evidence: z.string(),
  weight: z.number().nonnegative(),
});
export type ScanCheck = z.infer<typeof ScanCheck>;

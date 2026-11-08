/**
 * POST /api/webhooks/stripe, framework-free, the same two steps as the Naive receiver:
 * verify the raw body against the signing secret (current or previous), then record the
 * delivery and enqueue handle_stripe_event in one transaction. Only ids travel in the job,
 * never the customer's email or card details.
 */
import Stripe from "stripe";
import { transaction, type DbHandle } from "../db/client";
import { recordWebhookOnce } from "../events";
import { logger } from "../log";
import type { Queue } from "../queue";
import type { WebhookReply } from "./naive";

export const STRIPE_SIGNATURE_HEADER = "stripe-signature";
/** The event types the worker acts on; anything else is acknowledged and dropped. */
export const STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
  "payment_intent.succeeded",
  "charge.refunded",
  "invoice.paid",
  "customer.subscription.deleted",
] as const;
export type StripeEventType = (typeof STRIPE_EVENTS)[number];

/** What handle_stripe_event receives: the ids it needs and nothing personal. */
export interface StripeJobPayload {
  eventId: string;
  eventType: StripeEventType;
  livemode: boolean;
  objectId: string;
  orderId: string | null;
  paymentIntentId: string | null;
  subscriptionId: string | null;
  /** invoice.paid only: subscription_create for the purchase, subscription_cycle for a renewal. */
  billingReason: string | null;
}

type Headers = { get(name: string): string | null };

export function verifyStripeDelivery(opts: {
  rawBody: string;
  headers: Headers;
  secrets: (string | undefined)[];
}): { reply: WebhookReply } | { event: Stripe.Event } {
  const secrets = opts.secrets.filter((s): s is string => !!s);
  if (!secrets.length) {
    return { reply: { status: 503, body: { error: "no_secret" }, headers: { "retry-after": "60" } } };
  }
  const sig = opts.headers.get(STRIPE_SIGNATURE_HEADER);
  if (!sig) return { reply: { status: 401, body: { error: "missing_signature" } } };
  for (const secret of secrets) {
    try {
      return { event: Stripe.webhooks.constructEvent(opts.rawBody, sig, secret) };
    } catch {
      /* try the next secret */
    }
  }
  logger.warn("stripe webhook rejected: bad signature");
  return { reply: { status: 401, body: { error: "bad_signature" } } };
}

const str = (v: unknown): string | null =>
  typeof v === "string"
    ? v
    : v && typeof v === "object" && "id" in v
      ? String((v as { id: unknown }).id)
      : null;

export function jobPayload(event: Stripe.Event): StripeJobPayload {
  const o = event.data.object as unknown as Record<string, unknown>;
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  const lines = (o.lines as { data?: { metadata?: Record<string, unknown> }[] } | undefined)?.data ?? [];
  const parent = (o.parent as { subscription_details?: { metadata?: Record<string, unknown> } } | undefined)
    ?.subscription_details?.metadata;
  const orderId =
    str(meta.orderId) ??
    str(o.client_reference_id) ??
    str(parent?.orderId) ??
    str(lines.find((l) => l.metadata?.orderId)?.metadata?.orderId);
  const subscription =
    str(o.subscription) ??
    str(
      (o.parent as { subscription_details?: { subscription?: unknown } } | undefined)?.subscription_details
        ?.subscription,
    ) ??
    (event.type.startsWith("customer.subscription.") ? str(o.id) : null);
  return {
    eventId: event.id,
    eventType: event.type as StripeEventType,
    livemode: event.livemode,
    objectId: String(o.id),
    orderId,
    paymentIntentId:
      str(o.payment_intent) ?? (event.type.startsWith("payment_intent.") ? String(o.id) : null),
    subscriptionId: subscription,
    billingReason: str(o.billing_reason),
  };
}

export async function acceptStripeEvent(opts: {
  event: Stripe.Event;
  db: Pick<DbHandle, "pool">;
  queue: Pick<Queue, "enqueue">;
}): Promise<WebhookReply> {
  const { id, type } = opts.event;
  if (!(STRIPE_EVENTS as readonly string[]).includes(type)) {
    return { status: 200, body: { ok: true, ignored: type } };
  }
  const payload = jobPayload(opts.event);
  const first = await transaction(opts.db, async (tx) => {
    const isNew = await recordWebhookOnce(tx.db, "stripe", id, { type });
    if (!isNew) return false;
    await opts.queue.enqueue(
      {
        type: "handle_stripe_event",
        payload: { ...payload },
        idempotencyKey: `stripe:${id}`,
        traceId: `stripe-${id}`,
      },
      { tx },
    );
    return true;
  });
  return first ? { status: 200, body: { ok: true } } : { status: 200, body: { ok: true, duplicate: true } };
}

export async function handleStripeWebhook(opts: {
  rawBody: string;
  headers: Headers;
  secrets: (string | undefined)[];
  db: Pick<DbHandle, "pool">;
  queue: Pick<Queue, "enqueue">;
}): Promise<WebhookReply> {
  const v = verifyStripeDelivery(opts);
  if ("reply" in v) return v.reply;
  return acceptStripeEvent({ event: v.event, db: opts.db, queue: opts.queue });
}

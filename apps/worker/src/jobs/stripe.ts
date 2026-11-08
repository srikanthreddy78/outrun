/**
 * SR-8 and SR-11: what happens after Stripe says money moved.
 *
 * handle_stripe_event
 *   checkout.session.completed / payment_intent.succeeded → order paid, receipt, start_audit
 *   checkout.session.expired → a pending order is canceled
 *   charge.refunded → refunded
 *   invoice.paid for a renewal → that month's Growth cycle (re-audit and an outbound run)
 *   customer.subscription.deleted → recorded; no more invoices means no more cycles
 * start_audit → the order moves to auditing and the auditor gets a session (MT-6 does the rest)
 *
 * Every step is keyed, so a redelivered event or a retried job does nothing twice.
 */
import { PRODUCTS } from "@outrun/core/constants";
import { eq, orders, prospects } from "@outrun/core/db";
import type { Emit } from "@outrun/core/events";
import type { Integrations } from "@outrun/core/integrations";
import { getOrder, transition, type Order } from "@outrun/core/orders";
import type { Handlers, Queue } from "@outrun/core/queue";
import type { Runtime } from "@outrun/core/runtime";
import { startSession } from "@outrun/core/sessions";
import type { StripeJobPayload } from "@outrun/core/webhooks/stripe";
import { z } from "zod";

const StripePayload = z.object({
  eventId: z.string(),
  eventType: z.string(),
  livemode: z.boolean(),
  objectId: z.string(),
  orderId: z.string().uuid().nullable(),
  paymentIntentId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
  billingReason: z.string().nullable().default(null),
});
const AuditPayload = z.object({ orderId: z.string().uuid(), cycle: z.string().min(1).default("initial") });

export type StripeJobDeps = {
  db: Runtime["db"]["db"];
  emit: Emit;
  queue: Pick<Queue, "enqueue">;
  integrations: Pick<Integrations, "naive" | "sendTransactional">;
  appUrl: string;
};

export function stripeHandlers(
  rt: Pick<Runtime, "db" | "emit" | "queue" | "integrations" | "config">,
): Handlers {
  const deps: StripeJobDeps = {
    db: rt.db.db,
    emit: rt.emit,
    queue: rt.queue,
    integrations: rt.integrations,
    appUrl: rt.config.appUrl,
  };
  return {
    handle_stripe_event: async (env) =>
      handleStripeEvent(deps, StripePayload.parse(env.payload) as StripeJobPayload, env.traceId),
    start_audit: async (env) => startAudit(deps, AuditPayload.parse(env.payload), env.traceId),
  };
}

export async function handleStripeEvent(
  deps: StripeJobDeps,
  p: StripeJobPayload,
  traceId: string,
): Promise<void> {
  const order = await orderFor(deps, p);
  if (!order) {
    await deps.emit({
      actor: "provider:stripe",
      type: "stripe.unmatched",
      entityType: "system",
      entityId: p.eventId,
      payload: { eventType: p.eventType },
    });
    return;
  }

  switch (p.eventType) {
    case "checkout.session.completed":
    case "payment_intent.succeeded":
      await markPaid(deps, order, p, traceId);
      return;
    case "checkout.session.expired":
      if (order.state === "pending")
        await transition(deps, order.id, "canceled", { actor: "provider:stripe" });
      return;
    case "charge.refunded":
      if (order.state !== "refunded" && order.state !== "pending") {
        await transition(deps, order.id, "refunded", { actor: "provider:stripe" });
      }
      return;
    case "invoice.paid":
      await growthCycle(deps, order, p, traceId);
      return;
    case "customer.subscription.deleted":
      await deps.emit({
        actor: "provider:stripe",
        type: "order.subscription_ended",
        entityType: "order",
        entityId: order.id,
      });
      return;
  }
}

async function orderFor(deps: StripeJobDeps, p: StripeJobPayload): Promise<Order | undefined> {
  if (p.orderId) return getOrder(deps.db, p.orderId);
  const by = p.paymentIntentId
    ? eq(orders.stripePaymentIntentId, p.paymentIntentId)
    : p.subscriptionId
      ? eq(orders.stripeSubscriptionId, p.subscriptionId)
      : null;
  if (!by) return undefined;
  return (await deps.db.select().from(orders).where(by))[0];
}

async function markPaid(
  deps: StripeJobDeps,
  order: Order,
  p: StripeJobPayload,
  traceId: string,
): Promise<void> {
  if (order.state === "pending") {
    await transition(deps, order.id, "paid", {
      actor: "provider:stripe",
      patch: {
        paidAt: new Date(),
        ...(p.eventType === "checkout.session.completed" ? { stripeCheckoutId: p.objectId } : {}),
        ...(p.paymentIntentId ? { stripePaymentIntentId: p.paymentIntentId } : {}),
        ...(p.subscriptionId ? { stripeSubscriptionId: p.subscriptionId } : {}),
      },
      payload: { eventId: p.eventId, livemode: p.livemode },
    });
  } else {
    // A second report of the same payment (checkout, then its payment intent): fill in ids only.
    const patch = {
      ...(p.subscriptionId && !order.stripeSubscriptionId ? { stripeSubscriptionId: p.subscriptionId } : {}),
      ...(p.paymentIntentId && !order.stripePaymentIntentId
        ? { stripePaymentIntentId: p.paymentIntentId }
        : {}),
    };
    if (Object.keys(patch).length) await deps.db.update(orders).set(patch).where(eq(orders.id, order.id));
    if (order.state !== "paid") return;
  }
  // SH-7: a closer's prospect who paid is won.
  if (order.prospectId) {
    await deps.db.update(prospects).set({ stage: "won" }).where(eq(prospects.id, order.prospectId));
  }
  // The receipt and the audit are keyed on the order, so a repeat report is a no-op.
  const product = PRODUCTS[order.product];
  await deps.integrations.sendTransactional({
    to: order.contactEmail,
    subject: `Outrun receipt: ${product.name} for ${order.domain}`,
    text: [
      `Thanks. Your ${product.name} order for ${order.domain} is paid ($${Number(order.amountUsd)}${
        product.interval === "month" ? " a month" : ""
      }).`,
      "We're starting the audit now and will email the report link when it's ready.",
      `Order status: ${deps.appUrl}/orders/${order.id}`,
      `Order id: ${order.id}`,
    ].join("\n\n"),
    idempotencyKey: `receipt:${order.id}`,
  });
  await deps.queue.enqueue({
    type: "start_audit",
    payload: { orderId: order.id, cycle: "initial" },
    idempotencyKey: `start_audit:${order.id}:initial`,
    traceId,
  });
}

/** SR-11: each paid Growth renewal runs that month's deliverables. The first invoice is the purchase itself. */
async function growthCycle(
  deps: StripeJobDeps,
  order: Order,
  p: StripeJobPayload,
  traceId: string,
): Promise<void> {
  if (order.product !== "growth") return;
  if (p.billingReason !== "subscription_cycle") return;
  if (order.state === "pending" || order.state === "refunded" || order.state === "failed") return;
  const cycle = p.objectId; // the invoice id: one cycle per paid invoice
  const { jobId } = await deps.queue.enqueue({
    type: "start_audit",
    payload: { orderId: order.id, cycle },
    idempotencyKey: `start_audit:${order.id}:${cycle}`,
    traceId,
  });
  if (jobId) {
    await deps.emit({
      actor: "provider:stripe",
      type: "order.renewed",
      entityType: "order",
      entityId: order.id,
      payload: { invoiceId: cycle },
    });
  }
  await deps.queue.enqueue({
    type: "start_session",
    payload: {
      agent: "prospector",
      entity: { type: "order", id: order.id },
      message: `Growth cycle ${cycle} for order ${order.id}: run this month's outbound and registry submissions for the order's domain.`,
    },
    idempotencyKey: `growth:${order.id}:${cycle}:prospector`,
    traceId,
  });
}

export async function startAudit(
  deps: StripeJobDeps,
  p: { orderId: string; cycle: string },
  traceId: string,
): Promise<void> {
  const order = await getOrder(deps.db, p.orderId);
  if (!order) throw new Error(`start_audit: order ${p.orderId} not found`);
  if (!["paid", "auditing", "delivered"].includes(order.state)) {
    await deps.emit({
      actor: "worker",
      type: "audit.skipped",
      entityType: "order",
      entityId: order.id,
      payload: { state: order.state, cycle: p.cycle, traceId },
    });
    return;
  }
  if (order.state !== "auditing")
    await transition(deps, order.id, "auditing", { payload: { cycle: p.cycle } });
  await startSession(
    { db: deps.db, emit: deps.emit, naive: deps.integrations.naive },
    {
      agent: "auditor",
      entity: { type: "order", id: order.id },
      message: `Audit order ${order.id} (${PRODUCTS[order.product].name}, cycle ${p.cycle}) for the domain ${order.domain}. Start the crawl, then save the audit.`,
      idempotencyKey: `audit:${order.id}:${p.cycle}`,
    },
  );
}

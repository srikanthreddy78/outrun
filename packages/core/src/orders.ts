/**
 * Orders: the state machine, creation idempotent on a caller key, and Checkout.
 * Prices come from PRODUCTS only; nothing here takes a price from a caller.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Actor, OrderState, PaidProductKey } from "../contracts";
import { AGENT_PAYMENTS_ENABLED, priceOf } from "./constants";
import type { Db } from "./db/client";
import { orders } from "./db/schema";
import { AppError } from "./errors";
import type { Emit } from "./events";
import type { StripeGateway } from "./integrations/types";

export type Order = typeof orders.$inferSelect;

/** Every legal move. Anything else throws illegal_transition. delivered → auditing is a Growth re-audit. */
export const ORDER_TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  pending: ["paid", "canceled", "failed"],
  paid: ["auditing", "refunded", "failed"],
  auditing: ["delivered", "failed", "refunded"],
  delivered: ["refunded", "auditing"],
  failed: [],
  canceled: [],
  refunded: [],
};

export const canTransition = (from: OrderState, to: OrderState): boolean =>
  ORDER_TRANSITIONS[from].includes(to);

export interface OrderDeps {
  db: Db;
  emit: Emit;
}

/**
 * Moves an order to `to`. Idempotent: an order already in `to` returns { changed: false }.
 * The update is conditional on the state we read, so two workers can't both move it.
 */
export async function transition(
  deps: OrderDeps,
  orderId: string,
  to: OrderState,
  opts: {
    actor?: Actor;
    patch?: Partial<typeof orders.$inferInsert>;
    payload?: Record<string, unknown>;
  } = {},
): Promise<{ order: Order; changed: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [current] = await deps.db.select().from(orders).where(eq(orders.id, orderId));
    if (!current) throw new AppError("not_found", `order ${orderId} not found`);
    if (current.state === to) return { order: current, changed: false };
    if (!canTransition(current.state, to)) {
      throw new AppError("illegal_transition", `order ${orderId}: ${current.state} → ${to} is not allowed`);
    }
    const [row] = await deps.db
      .update(orders)
      .set({ ...opts.patch, state: to, updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), inArray(orders.state, [current.state])))
      .returning();
    if (!row) continue; // moved by someone else between read and write; decide again
    await deps.emit({
      actor: opts.actor ?? "worker",
      type: `order.${to}`,
      entityType: "order",
      entityId: orderId,
      payload: { from: current.state, ...opts.payload },
    });
    return { order: row, changed: true };
  }
  throw new AppError("conflict", `order ${orderId} kept changing; retry`, { retryable: true });
}

export interface CreateOrderInput {
  domain: string;
  product: PaidProductKey;
  contactEmail: string;
  idempotencyKey: string;
  prospectId?: string | null;
  actor?: Actor;
}

/** Creates an order once per idempotency key; a repeat returns the first order. */
export async function createOrder(deps: OrderDeps, input: CreateOrderInput): Promise<Order> {
  const existing = await byKey(deps.db, input.idempotencyKey);
  if (existing) return sameOrder(existing, input);
  const [row] = await deps.db
    .insert(orders)
    .values({
      domain: input.domain,
      product: input.product,
      contactEmail: input.contactEmail,
      idempotencyKey: input.idempotencyKey,
      prospectId: input.prospectId ?? null,
      amountUsd: priceOf(input.product).toFixed(2),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const raced = await byKey(deps.db, input.idempotencyKey);
    if (!raced) throw new AppError("internal", "order insert lost");
    return sameOrder(raced, input);
  }
  await deps.emit({
    actor: input.actor ?? "worker",
    type: "order.created",
    entityType: "order",
    entityId: row.id,
    payload: { product: row.product, amountUsd: Number(row.amountUsd), domain: row.domain },
  });
  return row;
}

const byKey = async (db: Db, key: string): Promise<Order | undefined> =>
  (await db.select().from(orders).where(eq(orders.idempotencyKey, key)))[0];

/** A reused key must describe the same purchase; otherwise the caller gets a conflict, not someone's order. */
function sameOrder(order: Order, input: CreateOrderInput): Order {
  if (order.domain !== input.domain || order.product !== input.product) {
    throw new AppError("conflict", "idempotencyKey was already used for a different order");
  }
  return order;
}

/** Stripe Checkout for a pending order. Stripe dedupes on the order id, so a repeat returns the same session. */
export async function checkoutFor(
  deps: OrderDeps & { stripe: StripeGateway; appUrl: string },
  order: Order,
): Promise<{ checkoutId: string; url: string }> {
  if (order.state !== "pending") {
    throw new AppError("illegal_transition", `order ${order.id} is ${order.state}; nothing to pay`);
  }
  const res = await deps.stripe.createCheckout({
    orderId: order.id,
    product: order.product as PaidProductKey,
    customerEmail: order.contactEmail,
    successUrl: `${deps.appUrl}/orders/${order.id}?paid=1`,
    cancelUrl: `${deps.appUrl}/orders/${order.id}?canceled=1`,
    idempotencyKey: `checkout:${order.id}`,
  });
  if (order.stripeCheckoutId !== res.checkoutId) {
    await deps.db.update(orders).set({ stripeCheckoutId: res.checkoutId }).where(eq(orders.id, order.id));
  }
  return res;
}

/**
 * SR-12: a buyer agent pays a pending one-time order with a Stripe Shared Payment Token. This only
 * submits the payment; the order becomes paid when payment_intent.succeeded arrives, the same path
 * Checkout uses, so the state machine has one way in. The token never reaches the ledger.
 */
export async function payWithSharedToken(
  deps: OrderDeps & { stripe: StripeGateway; agentPayments?: boolean },
  order: Order,
  token: string,
): Promise<{ paymentIntentId: string; status: string }> {
  if (!(deps.agentPayments ?? AGENT_PAYMENTS_ENABLED))
    throw new AppError("not_configured", "agent payments are not enabled; use the checkoutUrl");
  if (!/^spt_[A-Za-z0-9_]{4,200}$/.test(token))
    throw new AppError("bad_request", "not a shared payment token");
  if (order.state !== "pending")
    throw new AppError("illegal_transition", `order ${order.id} is ${order.state}; nothing to pay`);
  const product = order.product as PaidProductKey;
  // One payment per order: a repeated call, even with another token, replays the first PaymentIntent.
  const res = await deps.stripe.payWithSharedToken({
    orderId: order.id,
    product,
    token,
    idempotencyKey: `spt:${order.id}`,
  });
  if (order.stripePaymentIntentId !== res.paymentIntentId) {
    await deps.db
      .update(orders)
      .set({ stripePaymentIntentId: res.paymentIntentId })
      .where(eq(orders.id, order.id));
    await deps.emit({
      actor: "web",
      type: "order.agent_payment_submitted",
      entityType: "order",
      entityId: order.id,
      payload: { paymentIntentId: res.paymentIntentId, status: res.status },
    });
  }
  return res;
}

export async function getOrder(db: Db, orderId: string): Promise<Order | undefined> {
  return (await db.select().from(orders).where(eq(orders.id, orderId)))[0];
}

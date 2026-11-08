import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { AGENT_PAYMENTS_ENABLED } from "./constants";
import { events } from "./db/schema";
import { createEmitter } from "./events";
import { FakeStripe } from "./fakes";
import { createOrder, getOrder, payWithSharedToken, transition } from "./orders";
import { createTempDatabase, type TempDb } from "./testing/db";
import { jobPayload } from "./webhooks/stripe";

describe("agent payments with a Shared Payment Token (SR-12)", () => {
  let t: TempDb;
  let deps: { db: TempDb["db"]; emit: ReturnType<typeof createEmitter> };
  let n = 0;
  const order = (product: "auditKit" | "growth" = "auditKit") =>
    createOrder(deps, {
      domain: "agent.dev",
      product,
      contactEmail: "ops@agent.dev",
      idempotencyKey: `spt-order-${++n}`,
    });

  beforeAll(async () => {
    t = await createTempDatabase();
    deps = { db: t.db, emit: createEmitter(t.db) };
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("is off until Stripe enables it on the account", async () => {
    expect(AGENT_PAYMENTS_ENABLED).toBe(false);
    const stripe = new FakeStripe();
    await expect(
      payWithSharedToken({ ...deps, stripe }, await order(), "spt_test_abcd"),
    ).rejects.toMatchObject({
      code: "not_configured",
    });
    expect(stripe.tokenPayments).toEqual([]);
  });

  it("charges once per order at the PRODUCTS price, even when repeated with another token", async () => {
    const stripe = new FakeStripe();
    const ctx = { ...deps, stripe, agentPayments: true };
    const o = await order();
    const a = await payWithSharedToken(ctx, o, "spt_test_first");
    const b = await payWithSharedToken(ctx, (await getOrder(t.db, o.id))!, "spt_test_second");
    expect(b).toEqual(a);
    expect(stripe.tokenPayments).toEqual([
      { orderId: o.id, product: "auditKit", amountUsd: 499, paymentIntentId: a.paymentIntentId },
    ]);
    expect((await getOrder(t.db, o.id))!.stripePaymentIntentId).toBe(a.paymentIntentId);
    // Submitting doesn't mark it paid; the webhook does.
    expect((await getOrder(t.db, o.id))!.state).toBe("pending");
    const rows = await t.db.select().from(events).where(eq(events.type, "order.agent_payment_submitted"));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.payload)).not.toContain("spt_");
  });

  it("refuses a subscription, a paid order, a malformed token, and passes a decline through", async () => {
    const ctx = { ...deps, stripe: new FakeStripe(), agentPayments: true };
    await expect(payWithSharedToken(ctx, await order("growth"), "spt_test_abcd")).rejects.toMatchObject({
      code: "bad_request",
    });
    const paid = await order();
    await transition(deps, paid.id, "paid");
    await expect(
      payWithSharedToken(ctx, (await getOrder(t.db, paid.id))!, "spt_test_abcd"),
    ).rejects.toMatchObject({ code: "illegal_transition" });
    await expect(payWithSharedToken(ctx, await order(), "pm_card_visa")).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(payWithSharedToken(ctx, await order(), "spt_declined_0001")).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("the succeeded PaymentIntent maps to the order, so the usual webhook path marks it paid", () => {
    const event = {
      id: "evt_spt_1",
      type: "payment_intent.succeeded",
      livemode: false,
      data: {
        object: {
          id: "pi_test_1",
          object: "payment_intent",
          metadata: { orderId: "o-1", product: "auditKit" },
        },
      },
    } as unknown as Stripe.Event;
    expect(jobPayload(event)).toMatchObject({
      eventType: "payment_intent.succeeded",
      orderId: "o-1",
      paymentIntentId: "pi_test_1",
    });
  });
});

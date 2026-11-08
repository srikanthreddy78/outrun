import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobEnvelopeInput } from "@outrun/core/contracts";
import { agentSessions, eq, events, orders } from "@outrun/core/db";
import { createEmitter } from "@outrun/core/events";
import { FakeAgentMail, FakeNaiveClient } from "@outrun/core/fakes";
import { createOrder, getOrder } from "@outrun/core/orders";
import { createTempDatabase, type TempDb } from "@outrun/core/testing/db";
import { acceptStripeEvent, handleStripeWebhook, jobPayload } from "@outrun/core/webhooks/stripe";
import { handleStripeEvent, startAudit, type StripeJobDeps } from "./stripe";
import { realHandlers } from "../worker";
import type { Runtime } from "@outrun/core/runtime";

const SECRET = "whsec_test_current";
const OLD = "whsec_test_previous";

function event(
  type: string,
  object: Record<string, unknown>,
  id = `evt_${Math.random().toString(36).slice(2)}`,
) {
  return {
    id,
    object: "event",
    type,
    livemode: false,
    created: 1,
    api_version: "2025-10-29.clover",
    data: { object },
  } as unknown as Stripe.Event;
}
const signed = (body: string, secret: string) => ({
  get: (h: string) =>
    h === "stripe-signature" ? Stripe.webhooks.generateTestHeaderString({ payload: body, secret }) : null,
});

describe("Stripe jobs", () => {
  let t: TempDb;
  let deps: StripeJobDeps;
  const jobs: (JobEnvelopeInput & { done?: boolean })[] = [];
  const mail = new FakeAgentMail();
  const naive = new FakeNaiveClient();
  /** What the queue does: dedupe on the key. drain() then runs each new job once. */
  const queue = {
    enqueue: async (job: JobEnvelopeInput) => {
      if (jobs.some((j) => j.idempotencyKey === job.idempotencyKey)) return { jobId: null };
      jobs.push(job);
      return { jobId: String(jobs.length) };
    },
  };
  const drain = async () => {
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i]!;
      if (j.done) continue;
      j.done = true;
      if (j.type === "handle_stripe_event") await handleStripeEvent(deps, j.payload as never, "t");
      if (j.type === "start_audit") await startAudit(deps, j.payload as never, "t");
    }
  };

  beforeAll(async () => {
    t = await createTempDatabase();
    deps = {
      db: t.db,
      emit: createEmitter(t.db),
      queue,
      integrations: { naive, sendTransactional: mail.sendTransactional },
      appUrl: "https://outrun.example",
    };
  });
  afterAll(async () => {
    await t?.drop();
  });

  let n = 0;
  const order = (product: "auditKit" | "growth" = "auditKit") => {
    n++;
    return createOrder(deps, {
      domain: `shop${n}.dev`,
      product,
      contactEmail: `owner@shop${n}.dev`,
      idempotencyKey: `k${n}`,
    });
  };
  const db = () => ({ pool: t.pool });

  it("rejects a bad signature, accepts the previous secret during a rotation, and dedupes", async () => {
    const o = await order();
    const body = JSON.stringify(
      event(
        "checkout.session.completed",
        { id: "cs_test_1", metadata: { orderId: o.id }, payment_intent: "pi_1" },
        "evt_sig",
      ),
    );
    const call = (headers: { get(h: string): string | null }, secrets: string[]) =>
      handleStripeWebhook({ rawBody: body, headers, secrets, db: db(), queue });
    expect((await call(signed(body, "whsec_wrong"), [SECRET, OLD])).status).toBe(401);
    expect((await call({ get: () => null }, [SECRET])).status).toBe(401);
    expect((await call(signed(body, OLD), [])).status).toBe(503);
    expect(await call(signed(body, OLD), [SECRET, OLD])).toEqual({ status: 200, body: { ok: true } });
    expect((await call(signed(body, SECRET), [SECRET, OLD])).body).toMatchObject({ duplicate: true });
    const job = jobs.find((j) => j.idempotencyKey === "stripe:evt_sig")!;
    expect(job.payload).toMatchObject({ orderId: o.id, paymentIntentId: "pi_1" });
    expect(JSON.stringify(job.payload)).not.toMatch(/@/);
  });

  it("rolls the dedupe row back when the enqueue fails, so Stripe's retry is processed", async () => {
    const e = event("checkout.session.expired", { id: "cs_x" }, "evt_retry");
    const broken = { enqueue: async () => Promise.reject(new Error("queue down")) };
    await expect(acceptStripeEvent({ event: e, db: db(), queue: broken })).rejects.toThrow();
    expect((await acceptStripeEvent({ event: e, db: db(), queue })).body).toEqual({ ok: true });
  });

  it("starts exactly one audit and sends one receipt for a duplicated completion", async () => {
    const o = await order();
    const completed = (id: string) =>
      jobPayload(
        event(
          "checkout.session.completed",
          { id: "cs_dup", metadata: { orderId: o.id }, payment_intent: "pi_dup" },
          id,
        ),
      );
    const succeeded = jobPayload(
      event("payment_intent.succeeded", { id: "pi_dup", metadata: { orderId: o.id } }),
    );
    for (const p of [completed("evt_a"), completed("evt_b"), succeeded]) {
      await queue.enqueue({
        type: "handle_stripe_event",
        payload: { ...p },
        idempotencyKey: `stripe:${p.eventId}`,
        traceId: "t",
      });
    }
    await drain();
    const row = await getOrder(t.db, o.id);
    expect(row).toMatchObject({
      state: "auditing",
      stripeCheckoutId: "cs_dup",
      stripePaymentIntentId: "pi_dup",
    });
    expect(row!.paidAt).toBeInstanceOf(Date);
    const audits = jobs.filter(
      (j) => j.type === "start_audit" && (j.payload as { orderId: string }).orderId === o.id,
    );
    expect(audits).toHaveLength(1);
    expect(mail.transactional.filter((m) => m.idempotencyKey === `receipt:${o.id}`)).toHaveLength(1);
    const sessions = await t.db.select().from(agentSessions).where(eq(agentSessions.entityId, o.id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ agent: "auditor", entityType: "order" });
    // A second start_audit for the same cycle is a no-op.
    await startAudit(deps, { orderId: o.id, cycle: "initial" }, "t");
    expect(await t.db.select().from(agentSessions).where(eq(agentSessions.entityId, o.id))).toHaveLength(1);
  });

  it("cancels an expired checkout and refunds a refunded charge", async () => {
    const expired = await order();
    await handleStripeEvent(
      deps,
      jobPayload(event("checkout.session.expired", { id: "cs_e", metadata: { orderId: expired.id } })),
      "t",
    );
    expect((await getOrder(t.db, expired.id))!.state).toBe("canceled");

    const paid = await order();
    await handleStripeEvent(
      deps,
      jobPayload(
        event("checkout.session.completed", {
          id: "cs_r",
          metadata: { orderId: paid.id },
          payment_intent: "pi_r",
        }),
      ),
      "t",
    );
    // A refund carries no order metadata; it is matched on the payment intent.
    await handleStripeEvent(
      deps,
      jobPayload(event("charge.refunded", { id: "ch_r", payment_intent: "pi_r" })),
      "t",
    );
    expect((await getOrder(t.db, paid.id))!.state).toBe("refunded");
  });

  it("records an event it can't match instead of failing", async () => {
    await handleStripeEvent(
      deps,
      jobPayload(event("charge.refunded", { id: "ch_none", payment_intent: "pi_none" }, "evt_none")),
      "t",
    );
    const [e] = await t.db.select().from(events).where(eq(events.entityId, "evt_none"));
    expect(e!.type).toBe("stripe.unmatched");
  });

  it("runs one Growth cycle per paid renewal and none for the first invoice", async () => {
    const o = await order("growth");
    await handleStripeEvent(
      deps,
      jobPayload(
        event("checkout.session.completed", {
          id: "cs_g",
          metadata: { orderId: o.id },
          subscription: "sub_g",
        }),
      ),
      "t",
    );
    expect((await getOrder(t.db, o.id))!.stripeSubscriptionId).toBe("sub_g");
    const invoice = (id: string, billing_reason: string) =>
      jobPayload(
        event("invoice.paid", {
          id,
          billing_reason,
          parent: { subscription_details: { subscription: "sub_g" } },
        }),
      );
    await handleStripeEvent(deps, invoice("in_first", "subscription_create"), "t");
    await handleStripeEvent(deps, invoice("in_dec", "subscription_cycle"), "t");
    await handleStripeEvent(deps, invoice("in_dec", "subscription_cycle"), "t");
    const cycles = jobs
      .filter((j) => j.idempotencyKey.startsWith(`start_audit:${o.id}:`))
      .map((j) => j.idempotencyKey);
    expect(cycles).toEqual([`start_audit:${o.id}:initial`, `start_audit:${o.id}:in_dec`]);
    expect(jobs.filter((j) => j.idempotencyKey === `growth:${o.id}:in_dec:prospector`)).toHaveLength(1);
    const renewed = await t.db.select().from(events).where(eq(events.type, "order.renewed"));
    expect(renewed.map((e) => e.entityId)).toEqual([o.id]);
    expect((await t.db.select().from(orders).where(eq(orders.id, o.id)))[0]!.product).toBe("growth");
  });

  it("routes a delivered Growth renewal through the cycle-aware audit handler", async () => {
    const o = await order("growth");
    await t.db.update(orders).set({ state: "delivered", deliveredAt: new Date() }).where(eq(orders.id, o.id));
    const runtime = {
      db: t,
      emit: deps.emit,
      queue,
      integrations: deps.integrations,
      config: { appUrl: deps.appUrl },
    } as unknown as Runtime;
    await realHandlers(runtime).start_audit!(
      { payload: { orderId: o.id, cycle: "in_renewal" }, traceId: "renewal" } as never,
      {} as never,
    );
    expect((await getOrder(t.db, o.id))!.state).toBe("auditing");
    expect(
      naive.calls.some(
        (call) =>
          call.method === "startSession" &&
          (call.args[0] as { idempotencyKey?: string }).idempotencyKey === `audit:${o.id}:in_renewal`,
      ),
    ).toBe(true);
  });
});

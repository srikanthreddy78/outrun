import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ORDER_STATES } from "../contracts";
import { ToolRegistry } from "./crew/registry";
import { createCheckoutLink } from "./crew/tools/create_checkout_link";
import { companies, contacts, events, orders, prospects } from "./db/schema";
import { createEmitter } from "./events";
import { FakeStripe } from "./fakes";
import { canTransition, checkoutFor, createOrder, ORDER_TRANSITIONS, transition } from "./orders";
import { createTempDatabase, type TempDb } from "./testing/db";
import { OUTRUN_CLIENT_ID } from "./constants";

describe("orders", () => {
  let t: TempDb;
  let deps: { db: TempDb["db"]; emit: ReturnType<typeof createEmitter> };
  const stripe = new FakeStripe();
  let n = 0;
  const key = () => `test-order-${++n}`;
  const newOrder = (over: Partial<Parameters<typeof createOrder>[1]> = {}) =>
    createOrder(deps, {
      domain: "acme.dev",
      product: "auditKit",
      contactEmail: "ceo@acme.dev",
      idempotencyKey: key(),
      ...over,
    });

  beforeAll(async () => {
    t = await createTempDatabase();
    deps = { db: t.db, emit: createEmitter(t.db) };
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("covers every state in the transition table", () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ORDER_STATES].sort());
    expect(canTransition("pending", "paid")).toBe(true);
    expect(canTransition("pending", "delivered")).toBe(false);
  });

  it("takes the price from PRODUCTS and creates once per key", async () => {
    const k = key();
    const a = await newOrder({ idempotencyKey: k });
    const b = await newOrder({ idempotencyKey: k });
    expect(b.id).toBe(a.id);
    expect(Number(a.amountUsd)).toBe(499);
    expect(a.state).toBe("pending");
    const created = await t.db.select().from(events).where(eq(events.entityId, a.id));
    expect(created.filter((e) => e.type === "order.created")).toHaveLength(1);
  });

  it("refuses a reused key for a different purchase", async () => {
    const k = key();
    await newOrder({ idempotencyKey: k });
    await expect(newOrder({ idempotencyKey: k, product: "growth" })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("walks the happy path and throws on an illegal move", async () => {
    const o = await newOrder();
    await expect(transition(deps, o.id, "delivered")).rejects.toMatchObject({ code: "illegal_transition" });
    expect((await transition(deps, o.id, "paid")).changed).toBe(true);
    expect((await transition(deps, o.id, "paid")).changed).toBe(false);
    await transition(deps, o.id, "auditing");
    await transition(deps, o.id, "delivered");
    await expect(transition(deps, o.id, "pending")).rejects.toMatchObject({ code: "illegal_transition" });
    const types = (await t.db.select().from(events).where(eq(events.entityId, o.id))).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["order.paid", "order.auditing", "order.delivered"]));
  });

  it("lets only one of two racing moves win", async () => {
    const o = await newOrder();
    const results = await Promise.allSettled([
      transition(deps, o.id, "paid"),
      transition(deps, o.id, "canceled"),
    ]);
    const [row] = await t.db.select().from(orders).where(eq(orders.id, o.id));
    expect(["paid", "canceled"]).toContain(row!.state);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("creates one checkout per order and refuses one for a paid order", async () => {
    const o = await newOrder();
    const ctx = { ...deps, stripe, appUrl: "https://outrun.example" };
    const a = await checkoutFor(ctx, o);
    const b = await checkoutFor(ctx, o);
    expect(b).toEqual(a);
    const [row] = await t.db.select().from(orders).where(eq(orders.id, o.id));
    expect(row!.stripeCheckoutId).toBe(a.checkoutId);
    await transition(deps, o.id, "paid");
    await expect(checkoutFor(ctx, { ...row!, state: "paid" })).rejects.toMatchObject({
      code: "illegal_transition",
    });
  });

  describe("outrun.create_checkout_link", () => {
    const call = (input: unknown) =>
      new ToolRegistry([
        createCheckoutLink({ stripe, emit: deps.emit, appUrl: "https://outrun.example" }),
      ]).call("closer", "create_checkout_link", input, {
        agent: "closer",
        requestId: "r",
        clientId: OUTRUN_CLIENT_ID,
        db: t.db,
        now: () => new Date(),
        enqueue: async () => ({ jobId: null }),
        emit: deps.emit,
      }) as Promise<{ orderId: string; checkoutUrl: string; priceUsd: number }>;

    async function prospect(suppressed = false) {
      const domain = `p${++n}.dev`;
      const [c] = await t.db
        .insert(companies)
        .values({ domain, source: "fixture", kind: "prospect" })
        .returning();
      const [ct] = await t.db
        .insert(contacts)
        .values({
          companyId: c!.id,
          name: "Ann",
          role: "CEO",
          email: `ann@${domain}`,
          sourceUrl: `https://${domain}`,
          suppressed,
        })
        .returning();
      const [p] = await t.db.insert(prospects).values({ companyId: c!.id, contactId: ct!.id }).returning();
      return p!.id;
    }

    it("returns the listed price and the same link when asked twice", async () => {
      const id = await prospect();
      const a = await call({ prospectId: id, product: "auditKit" });
      const b = await call({ prospectId: id, product: "auditKit" });
      expect(a).toEqual(b);
      expect(a.priceUsd).toBe(499);
      expect(a.checkoutUrl).toMatch(/^https:\/\//);
      const [o] = await t.db.select().from(orders).where(eq(orders.id, a.orderId));
      expect(o).toMatchObject({ prospectId: id, product: "auditKit", amountUsd: "499.00" });
    });

    it("refuses a suppressed contact", async () => {
      await expect(call({ prospectId: await prospect(true), product: "auditKit" })).rejects.toMatchObject({
        code: "suppressed",
      });
    });
  });
});

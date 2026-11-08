import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { alertKey, findAlerts, raiseAlerts, type Alert, type AlertDeps } from "./alerts";
import {
  BOUNCE_WINDOW_SENDS,
  STUCK_APPROVAL_HOURS,
  STUCK_JOB_MINUTES,
  STUCK_ORDER_MINUTES,
} from "./constants";
import { events, messages, orders, suppressions } from "./db/schema";
import { createEmitter } from "./events";
import { FakeAgentMail, FakeNaiveClient } from "./fakes";
import { Queue } from "./queue";
import { createTempDatabase, type TempDb } from "./testing/db";

const APP = "https://outrun.example";
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe("alerts (SR-10)", () => {
  let t: TempDb;
  let q: Queue;
  let naive: FakeNaiveClient;
  let deps: AlertDeps;
  const kinds = async (over: Partial<AlertDeps> = {}) =>
    (await findAlerts({ ...deps, ...over })).map((a) => a.kind);

  beforeAll(async () => {
    t = await createTempDatabase();
    q = new Queue({ connectionString: t.url, maxAttempts: 3, emit: createEmitter(t.db) });
    await q.start(); // creates the queues; no handlers, so jobs stay waiting
  });
  afterAll(async () => {
    await q?.stop();
    await t?.drop();
  });
  beforeEach(async () => {
    await t.db.execute(sql`delete from pgboss.job`);
    await t.db.delete(messages);
    await t.db.delete(orders);
    await t.db.delete(suppressions);
    await t.db.delete(events);
    naive = new FakeNaiveClient();
    naive.webhooks.push({
      id: "wh_1",
      url: `${APP}/api/webhooks/naive`,
      enabled: true,
      events: ["session.idle"],
    });
    deps = { db: t.db, naive, appUrl: APP, llmBudgetUsdDaily: null };
  });

  it("is quiet when nothing is wrong", async () => {
    expect(await kinds()).toEqual([]);
  });

  it("stuck_job: a due job still waiting", async () => {
    await q.enqueue({
      type: "scan_domain",
      payload: {},
      idempotencyKey: "late-1",
      traceId: "t",
      runAfter: ago(STUCK_JOB_MINUTES + 5).toISOString(),
    });
    await q.enqueue({ type: "scan_domain", payload: {}, idempotencyKey: "fresh-1", traceId: "t" });
    const alerts = await findAlerts(deps);
    expect(alerts.map((a) => a.kind)).toEqual(["stuck_job"]);
    expect(alerts[0]!.detail).toMatchObject({ queue: "scan_domain", waiting: 1 });
  });

  it("dead_job: a job in a dead-letter queue", async () => {
    await t.db.execute(sql`insert into pgboss.job (name, data) values ('send_email__dead', '{}'::jsonb)`);
    expect(await kinds()).toContain("dead_job");
  });

  it("stuck_order: paid or auditing for too long", async () => {
    await t.db.insert(orders).values([
      {
        domain: "slow.dev",
        contactEmail: "a@slow.dev",
        product: "auditKit",
        amountUsd: "499",
        state: "auditing",
        updatedAt: ago(STUCK_ORDER_MINUTES + 1),
      },
      {
        domain: "ok.dev",
        contactEmail: "a@ok.dev",
        product: "auditKit",
        amountUsd: "499",
        state: "auditing",
      },
      {
        domain: "done.dev",
        contactEmail: "a@done.dev",
        product: "auditKit",
        amountUsd: "499",
        state: "delivered",
        updatedAt: ago(500),
      },
    ]);
    const alerts = (await findAlerts(deps)).filter((a) => a.kind === "stuck_order");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.summary).toContain("slow.dev");
  });

  it("stale_approval: an email waiting a day", async () => {
    const base = { direction: "outbound" as const, kind: "first" as const, subject: "s", body: "b" };
    await t.db.insert(messages).values([
      { ...base, status: "awaiting_approval", updatedAt: ago(STUCK_APPROVAL_HOURS * 60 + 1) },
      { ...base, status: "awaiting_approval" },
    ]);
    const [a] = (await findAlerts(deps)).filter((x) => x.kind === "stale_approval");
    expect(a!.detail).toMatchObject({ waiting: 1 });
  });

  it("budget_stop: a Naive budget stop or a spent LLM budget in the last hour", async () => {
    const emit = createEmitter(t.db);
    await emit({
      actor: "provider:naive",
      type: "alert.naive_budget_exceeded",
      entityType: "agent_session",
      entityId: "ses_1",
      payload: { code: "insufficient_credits", action: "top up Naive credits" },
    });
    await emit({
      actor: "worker",
      type: "llm.budget_exhausted",
      entityType: "system",
      entityId: "triage",
      payload: {},
    });
    const budget = (await findAlerts(deps)).filter((a) => a.kind === "budget_stop");
    expect(budget.map((a) => a.entity).sort()).toEqual(["llm", "naive:ses_1"]);
    expect(budget.find((a) => a.entity === "naive:ses_1")!.action).toBe("top up Naive credits");
  });

  it("webhook_disabled: disabled, missing, or unreadable; skipped on the fake", async () => {
    naive.webhooks[0]!.enabled = false;
    expect(await kinds()).toEqual(["webhook_disabled"]);
    naive.webhooks.length = 0;
    expect(await kinds()).toEqual(["webhook_disabled"]);
    const broken = { listWebhooks: async () => Promise.reject(new Error("naive down")) };
    expect(await kinds({ naive: broken })).toEqual(["webhook_disabled"]);
    expect(await kinds({ naive: undefined })).toEqual([]);
  });

  it("send_paused: bounces over the pause rate in the recent window", async () => {
    const sent = Array.from({ length: BOUNCE_WINDOW_SENDS }, (_, i) => ({
      direction: "outbound" as const,
      kind: "first" as const,
      status: "sent" as const,
      subject: "s",
      body: "b",
      toEmail: `p${i}@x.dev`,
      sentAt: ago(i),
    }));
    await t.db.insert(messages).values(sent);
    await t.db.insert(suppressions).values({ value: "p1@x.dev", kind: "email", reason: "hard_bounce" });
    expect(await kinds()).toEqual([]); // 1 in 50 is 2%, under 3%
    await t.db.insert(suppressions).values({ value: "p2@x.dev", kind: "email", reason: "bounce" });
    expect(await kinds()).toEqual(["send_paused"]);
  });

  it("llm_budget: spend today at 80% of the budget", async () => {
    const emit = createEmitter(t.db);
    await emit({ actor: "worker", type: "llm.call", entityType: "system", entityId: "kit", costUsd: 7.9 });
    expect(await kinds({ llmBudgetUsdDaily: 10 })).toEqual([]);
    await emit({ actor: "worker", type: "llm.call", entityType: "system", entityId: "kit", costUsd: 0.2 });
    expect(await kinds({ llmBudgetUsdDaily: 10 })).toEqual(["llm_budget"]);
    expect(await kinds({ llmBudgetUsdDaily: null })).toEqual([]);
  });

  describe("raiseAlerts", () => {
    const alert: Alert = {
      kind: "stuck_order",
      entity: "o1",
      summary: "Order o1 is stuck",
      action: "Look",
      detail: {},
    };

    it("emails the team once per kind, entity and hour", async () => {
      const mail = new FakeAgentMail();
      const now = new Date("2026-11-07T10:15:00Z");
      const send = (at: Date) =>
        raiseAlerts(
          {
            db: t.db,
            emit: createEmitter(t.db),
            sendTransactional: mail.sendTransactional,
            alertEmail: "team@outrun.example",
            appUrl: APP,
            now: () => at,
          },
          [alert],
        );
      expect((await send(now)).raised).toHaveLength(1);
      expect((await send(new Date("2026-11-07T10:55:00Z"))).raised).toHaveLength(0);
      expect((await send(new Date("2026-11-07T11:01:00Z"))).raised).toHaveLength(1);
      expect(mail.transactional.map((m) => m.idempotencyKey)).toEqual([
        alertKey(alert, now),
        alertKey(alert, new Date("2026-11-07T11:01:00Z")),
      ]);
      expect(mail.transactional[0]).toMatchObject({
        to: "team@outrun.example",
        subject: "[Outrun alert] Order o1 is stuck",
      });
    });

    it("without ALERT_EMAIL, records the alert and sends nothing", async () => {
      const mail = new FakeAgentMail();
      await raiseAlerts(
        { db: t.db, emit: createEmitter(t.db), sendTransactional: mail.sendTransactional, appUrl: APP },
        [alert],
      );
      expect(mail.transactional).toEqual([]);
      const rows = await t.db.select().from(events).where(eq(events.type, "alert.raised"));
      expect(rows).toHaveLength(1);
    });
  });
});

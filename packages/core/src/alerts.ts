/**
 * SR-10: stuck work and stops that need a person. check_stuck runs every 5 minutes, calls
 * findAlerts, and raiseAlerts sends each one to the team at most once an hour.
 *
 *   stuck_job         a due job still waiting after STUCK_JOB_MINUTES
 *   dead_job          a job in a dead-letter queue
 *   stuck_order       an order paid or auditing for over STUCK_ORDER_MINUTES
 *   stale_approval    an email waiting for approval over STUCK_APPROVAL_HOURS
 *   budget_stop       a Naive budget.exceeded, or the in-app LLM budget spent, in the last hour
 *   webhook_disabled  our Naive webhook missing or disabled
 *   send_paused       bounces over BOUNCE_PAUSE_RATE in the last BOUNCE_WINDOW_SENDS sends
 *   llm_budget        in-app LLM spend today at LLM_BUDGET_ALERT_RATIO of the budget
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  BOUNCE_PAUSE_RATE,
  LLM_BUDGET_ALERT_RATIO,
  STUCK_APPROVAL_HOURS,
  STUCK_JOB_MINUTES,
  STUCK_ORDER_MINUTES,
} from "./constants";
import type { Db } from "./db/client";
import { events, messages, orders } from "./db/schema";
import type { Emit } from "./events";
import type { NaiveClient, SendTransactionalFn } from "./integrations/types";
import { spentTodayUsd } from "./llm";
import { sendPause } from "./email/rules";
import { logger } from "./log";

export const ALERT_KINDS = [
  "stuck_job",
  "dead_job",
  "stuck_order",
  "stale_approval",
  "budget_stop",
  "webhook_disabled",
  "send_paused",
  "llm_budget",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface Alert {
  kind: AlertKind;
  /** What it's about (a queue, an order, a message); one alert per kind and entity per hour. */
  entity: string;
  summary: string;
  action: string;
  detail: Record<string, unknown>;
}

export interface AlertDeps {
  db: Db;
  /** Omitted when Naive runs on its fake; the webhook check is then skipped. */
  naive?: Pick<NaiveClient, "listWebhooks">;
  appUrl: string;
  llmBudgetUsdDaily: number | null;
  now?: () => Date;
}

const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000);

export async function findAlerts(deps: AlertDeps): Promise<Alert[]> {
  const now = deps.now?.() ?? new Date();
  const found: Alert[] = [];
  const checks: [string, () => Promise<Alert[]>][] = [
    ["jobs", () => jobAlerts(deps.db, now)],
    ["orders", () => orderAlerts(deps.db, now)],
    ["approvals", () => approvalAlerts(deps.db, now)],
    ["budget", () => budgetAlerts(deps.db, now)],
    ["webhook", () => webhookAlerts(deps)],
    ["bounces", () => bounceAlerts(deps.db)],
    ["llm", () => llmAlerts(deps, now)],
  ];
  // One broken check (a Naive outage, say) must not hide the others; it becomes an alert itself.
  for (const [name, run] of checks) {
    try {
      found.push(...(await run()));
    } catch (err) {
      logger.error({ err, check: name }, "alert check failed");
      if (name === "webhook") {
        found.push({
          kind: "webhook_disabled",
          entity: "naive",
          summary: "Couldn't read the Naive webhook list",
          action: "Check NAIVE_API_KEY and Naive's status; run pnpm naive:sync",
          detail: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }
  return found;
}

async function jobAlerts(db: Db, now: Date): Promise<Alert[]> {
  const out: Alert[] = [];
  const stuck = await db.execute<{ name: string; n: number; oldest: Date }>(sql`
    select name, count(*)::int as n, min(start_after) as oldest from pgboss.job
    where state in ('created', 'retry') and start_after < ${minutesAgo(now, STUCK_JOB_MINUTES)}
      and name not like '%\\_\\_dead'
    group by name`);
  for (const r of stuck.rows) {
    out.push({
      kind: "stuck_job",
      entity: r.name,
      summary: `${r.n} ${r.name} job(s) waiting over ${STUCK_JOB_MINUTES} minutes`,
      action: "Check that the Render worker is running and its logs",
      detail: { queue: r.name, waiting: r.n, oldestDueAt: new Date(r.oldest).toISOString() },
    });
  }
  const dead = await db.execute<{ name: string; n: number }>(sql`
    select name, count(*)::int as n from pgboss.job
    where name like '%\\_\\_dead' and state in ('created', 'retry')
    group by name`);
  for (const r of dead.rows) {
    out.push({
      kind: "dead_job",
      entity: r.name,
      summary: `${r.n} dead job(s) in ${r.name}`,
      action: "Read the job.failed events in the Ops Ledger, fix the cause, then re-enqueue or drop them",
      detail: { queue: r.name, dead: r.n },
    });
  }
  return out;
}

async function orderAlerts(db: Db, now: Date): Promise<Alert[]> {
  const rows = await db
    .select({ id: orders.id, state: orders.state, domain: orders.domain, updatedAt: orders.updatedAt })
    .from(orders)
    .where(
      and(
        inArray(orders.state, ["paid", "auditing"]),
        lt(orders.updatedAt, minutesAgo(now, STUCK_ORDER_MINUTES)),
      ),
    );
  return rows.map((o) => ({
    kind: "stuck_order" as const,
    entity: o.id,
    summary: `Order ${o.id} for ${o.domain} has been ${o.state} since ${o.updatedAt.toISOString()}`,
    action: "Check the auditor session and the build_kit and deliver_report jobs for this order",
    detail: { orderId: o.id, state: o.state, since: o.updatedAt.toISOString() },
  }));
}

async function approvalAlerts(db: Db, now: Date): Promise<Alert[]> {
  const rows = await db
    .select({ id: messages.id, updatedAt: messages.updatedAt })
    .from(messages)
    .where(
      and(
        eq(messages.status, "awaiting_approval"),
        lt(messages.updatedAt, minutesAgo(now, STUCK_APPROVAL_HOURS * 60)),
      ),
    );
  if (!rows.length) return [];
  return [
    {
      kind: "stale_approval",
      entity: "approvals",
      summary: `${rows.length} email(s) waiting for approval over ${STUCK_APPROVAL_HOURS} hours`,
      action: "Approve or deny them in the Naive Studio",
      detail: { messageIds: rows.slice(0, 20).map((r) => r.id), waiting: rows.length },
    },
  ];
}

async function budgetAlerts(db: Db, now: Date): Promise<Alert[]> {
  const rows = await db
    .select({ type: events.type, entityId: events.entityId, payload: events.payload })
    .from(events)
    .where(
      and(
        inArray(events.type, ["alert.naive_budget_exceeded", "llm.budget_exhausted"]),
        gte(events.ts, minutesAgo(now, 60)),
      ),
    )
    .orderBy(desc(events.ts));
  const seen = new Set<string>();
  const out: Alert[] = [];
  for (const r of rows) {
    const naive = r.type === "alert.naive_budget_exceeded";
    const entity = naive ? `naive:${r.entityId}` : "llm";
    if (seen.has(entity)) continue;
    seen.add(entity);
    const p = r.payload as { code?: string; action?: string };
    out.push({
      kind: "budget_stop",
      entity,
      summary: naive
        ? `Naive stopped a session on budget (${p.code ?? "budget"})`
        : "The in-app LLM budget for today is spent",
      action: naive
        ? (p.action ?? "Raise the agent's budget or top up credits")
        : "Raise OUTRUN_LLM_BUDGET_USD_DAILY or wait for tomorrow",
      detail: { source: naive ? "naive" : "llm", entityId: r.entityId, code: p.code ?? null },
    });
  }
  return out;
}

async function webhookAlerts(deps: AlertDeps): Promise<Alert[]> {
  if (!deps.naive) return [];
  const url = `${deps.appUrl}/api/webhooks/naive`;
  const hook = (await deps.naive.listWebhooks()).find((w) => w.url === url);
  if (hook?.enabled) return [];
  return [
    {
      kind: "webhook_disabled",
      entity: "naive",
      summary: hook ? "The Naive webhook is disabled" : `No Naive webhook for ${url}`,
      action: "Run pnpm naive:sync to re-enable it; Naive disables a hook after 10 failed deliveries",
      detail: { url, found: !!hook },
    },
  ];
}

async function bounceAlerts(db: Db): Promise<Alert[]> {
  // The same rule the send job obeys (email/rules.ts), so the alert and the pause agree.
  const p = await sendPause(db);
  if (!p.paused) return [];
  return [
    {
      kind: "send_paused",
      entity: "email",
      summary:
        p.reason === "complaint"
          ? "A recipient complained; outreach is paused"
          : `Bounce rate ${(p.bounceRate * 100).toFixed(1)}% over the last ${p.window} sends; outreach is paused`,
      action: 'Fix the cause (list source, sending domain), then run pnpm email:resume "<why>"',
      detail: { reason: p.reason, rate: p.bounceRate, window: p.window, threshold: BOUNCE_PAUSE_RATE },
    },
  ];
}

async function llmAlerts(deps: AlertDeps, now: Date): Promise<Alert[]> {
  const budget = deps.llmBudgetUsdDaily;
  if (budget === null || budget <= 0) return [];
  const spent = await spentTodayUsd(deps.db, now);
  if (spent < budget * LLM_BUDGET_ALERT_RATIO) return [];
  return [
    {
      kind: "llm_budget",
      entity: "llm",
      summary: `In-app LLM spend today is $${spent.toFixed(2)} of $${budget}`,
      action: "Expect budget_exhausted soon; raise OUTRUN_LLM_BUDGET_USD_DAILY if this is planned",
      detail: { spentUsd: spent, budgetUsd: budget, ratio: LLM_BUDGET_ALERT_RATIO },
    },
  ];
}

export const alertKey = (a: Pick<Alert, "kind" | "entity">, now: Date): string =>
  `alert:${a.kind}:${a.entity}:${now.toISOString().slice(0, 13)}`;

/**
 * Records and emails each alert at most once per kind, entity and hour. Without ALERT_EMAIL the
 * ledger event and a log line are the alert.
 */
export async function raiseAlerts(
  deps: {
    db: Db;
    emit: Emit;
    sendTransactional: SendTransactionalFn;
    alertEmail?: string;
    appUrl: string;
    now?: () => Date;
  },
  alerts: Alert[],
): Promise<{ raised: Alert[]; skipped: number }> {
  const now = deps.now?.() ?? new Date();
  const raised: Alert[] = [];
  for (const a of alerts) {
    const key = alertKey(a, now);
    const [already] = await deps.db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.type, "alert.raised"), eq(events.entityId, key)));
    if (already) continue;
    await deps.emit({
      actor: "worker",
      type: "alert.raised",
      entityType: "system",
      entityId: key,
      payload: { kind: a.kind, entity: a.entity, summary: a.summary, detail: a.detail },
    });
    logger.warn({ kind: a.kind, entity: a.entity }, `alert: ${a.summary}`);
    if (deps.alertEmail) {
      await deps.sendTransactional({
        to: deps.alertEmail,
        subject: `[Outrun alert] ${a.summary}`,
        text: [
          a.summary,
          `What to do: ${a.action}`,
          `Details: ${JSON.stringify(a.detail, null, 2)}`,
          `Ops Ledger: ${deps.appUrl}/dashboard/ledger`,
        ].join("\n\n"),
        idempotencyKey: key,
      });
    }
    raised.push(a);
  }
  return { raised, skipped: alerts.length - raised.length };
}

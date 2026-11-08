import {
  agentSessions,
  desc,
  eq,
  events,
  messages,
  orders,
  prospects,
  scans,
  sql,
} from "@outrun/core/db/query";
import { summarizeStoredTotals } from "@outrun/core/dashboard/views";
import { checkHealth } from "@outrun/core/health";
import { BUDGETS, CLIENT_BUDGETS } from "../../../naive/crew";
import { getRuntime } from "./runtime";

export async function loadDashboardSnapshot() {
  const rt = await getRuntime();
  const db = rt.db.db;
  const [ledgerRows, deadRows, sessionRows, orderRows, approvals, naiveSpend, eventCosts, funnel, health] =
    await Promise.all([
      db.select().from(events).orderBy(desc(events.ts)).limit(100),
      db.select().from(events).where(eq(events.type, "job.dead")).orderBy(desc(events.ts)).limit(20),
      db.select().from(agentSessions).orderBy(desc(agentSessions.createdAt)).limit(50),
      db.select().from(orders).orderBy(desc(orders.createdAt)).limit(50),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(messages)
        .where(eq(messages.status, "awaiting_approval")),
      db.select({ usd: sql<string>`coalesce(sum(${agentSessions.spendUsd}), 0)::text` }).from(agentSessions),
      db.select({ usd: sql<string>`coalesce(sum(${events.costUsd}), 0)::text` }).from(events),
      db.execute<{
        candidates: number;
        scanned: number;
        paid_orders: number;
        delivered_audits: number;
        revenue_usd: string;
      }>(sql`
      select
        (select count(*)::int from ${prospects}) as candidates,
        (select count(distinct domain)::int from ${scans}) as scanned,
        (select count(*)::int from ${orders} where state in ('paid', 'auditing', 'delivered')) as paid_orders,
        (select count(*)::int from ${orders} where state = 'delivered') as delivered_audits,
        (select coalesce(sum(amount_usd), 0)::text from ${orders} where state in ('paid', 'auditing', 'delivered')) as revenue_usd
    `),
      checkHealth({ db, demo: rt.config.settings.demo, fakes: rt.fakes }),
    ]);
  const ledgerEvents = ledgerRows.map((row) => ({
    id: row.id,
    at: row.ts.toISOString(),
    type: row.type,
    actor: row.actor,
    entityId: row.entityId,
    costUsd: Number(row.costUsd),
    payload: row.payload,
  }));
  let queuedJobs: number | null = null;
  try {
    const result = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job where state in ('created', 'retry')`,
    );
    queuedJobs = result.rows[0]?.n ?? 0;
  } catch {
    // The health check identifies an unavailable queue separately.
  }
  const naiveCostUsd = Number(naiveSpend[0]?.usd ?? 0);
  // Session spend is a current snapshot; session ledger events intentionally carry zero cost.
  const totals = funnel.rows[0];
  const summary = summarizeStoredTotals({
    candidates: totals?.candidates ?? 0,
    scanned: totals?.scanned ?? 0,
    paidOrders: totals?.paid_orders ?? 0,
    deliveredAudits: totals?.delivered_audits ?? 0,
    revenueUsd: Number(totals?.revenue_usd ?? 0),
    eventCostUsd: Number(eventCosts[0]?.usd ?? 0),
    naiveCostUsd,
  });
  return {
    summary,
    naiveCostUsd,
    events: ledgerEvents,
    deadJobs: deadRows.map((row) => ({
      id: row.id,
      at: row.ts.toISOString(),
      job: typeof row.payload.job === "string" ? row.payload.job : "unknown",
      jobId: typeof row.payload.jobId === "string" ? row.payload.jobId : null,
    })),
    sessions: sessionRows.map((row) => ({
      ...row,
      spendUsd: Number(row.spendUsd),
      // Outrun's crew has no optional roles; their sessions are other clients', at the client budget.
      budgetUsd:
        (row.agent in BUDGETS
          ? BUDGETS[row.agent as keyof typeof BUDGETS]
          : CLIENT_BUDGETS[row.agent as keyof typeof CLIENT_BUDGETS]
        ).cap_micro_usd / 1_000_000,
    })),
    orders: orderRows,
    approvalsWaiting: approvals[0]?.n ?? 0,
    queuedJobs,
    health,
  };
}

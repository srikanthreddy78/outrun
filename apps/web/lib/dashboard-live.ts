import { agentSessions, desc, eq, events, messages, orders, sql } from "@outrun/core/db";
import { summarizeLedger } from "@outrun/core/dashboard/views";
import { checkHealth } from "@outrun/core/health";
import { BUDGETS } from "../../../naive/crew";
import { getRuntime } from "./runtime";

export async function loadDashboardSnapshot() {
  const rt = await getRuntime();
  const db = rt.db.db;
  const [ledgerRows, sessionRows, orderRows, approvals, naiveSpend, health] = await Promise.all([
    db.select().from(events).orderBy(desc(events.ts)),
    db.select().from(agentSessions).orderBy(desc(agentSessions.createdAt)).limit(50),
    db.select().from(orders).orderBy(desc(orders.createdAt)).limit(50),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.status, "awaiting_approval")),
    db.select({ usd: sql<string>`coalesce(sum(${agentSessions.spendUsd}), 0)::text` }).from(agentSessions),
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
  const summary = summarizeLedger(ledgerEvents, naiveCostUsd);
  return {
    summary,
    naiveCostUsd,
    events: ledgerEvents.slice(0, 100),
    sessions: sessionRows.map((row) => ({
      ...row,
      spendUsd: Number(row.spendUsd),
      budgetUsd: BUDGETS[row.agent].cap_micro_usd / 1_000_000,
    })),
    orders: orderRows,
    approvalsWaiting: approvals[0]?.n ?? 0,
    queuedJobs,
    health,
  };
}

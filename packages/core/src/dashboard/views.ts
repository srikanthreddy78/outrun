export type LedgerEvent = {
  id: string;
  at: string;
  type: string;
  actor: string;
  entityId?: string;
  costUsd?: number;
  payload?: Record<string, unknown>;
};
export type AgentState = {
  name: string;
  status: string;
  stopReason?: string;
  spendUsd: number;
  budgetUsd: number;
};
export type DashboardInput = {
  events: LedgerEvent[];
  agents: AgentState[];
  queuedJobs: number;
  approvalsWaiting: number;
  integrations: Record<string, "healthy" | "degraded" | "offline">;
};
export type DashboardSummary = {
  candidates: number;
  scanned: number;
  paidOrders: number;
  deliveredAudits: number;
  revenueUsd: number;
  costsUsd: number;
  costPerDeliveredAuditUsd: number | null;
};
export function summarizeStoredTotals(input: {
  candidates: number;
  scanned: number;
  paidOrders: number;
  deliveredAudits: number;
  revenueUsd: number;
  eventCostUsd: number;
  naiveCostUsd: number;
}): DashboardSummary {
  const costsUsd = input.eventCostUsd + input.naiveCostUsd;
  return {
    candidates: input.candidates,
    scanned: input.scanned,
    paidOrders: input.paidOrders,
    deliveredAudits: input.deliveredAudits,
    revenueUsd: input.revenueUsd,
    costsUsd,
    costPerDeliveredAuditUsd: input.deliveredAudits ? costsUsd / input.deliveredAudits : null,
  };
}
export function isAllowedTeamAccount(email: string | null | undefined, allowlist: string): boolean {
  if (!email) return false;
  return allowlist
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}
export function summarizeLedger(events: LedgerEvent[], naiveSpendUsd = 0): DashboardSummary {
  const count = (type: string) =>
    new Set(events.filter((event) => event.type === type).map((event) => event.entityId ?? event.id)).size;
  const deliveredAudits = count("report.delivered");
  const costsUsd = events.reduce((sum, event) => sum + (event.costUsd ?? 0), naiveSpendUsd);
  return {
    candidates: count("candidate.discovered"),
    scanned: count("scan.completed"),
    paidOrders: count("order.paid"),
    deliveredAudits,
    revenueUsd: events
      .filter((event) => event.type === "order.paid")
      .reduce((sum, event) => sum + (Number(event.payload?.amountUsd) || 0), 0),
    costsUsd,
    costPerDeliveredAuditUsd: deliveredAudits ? costsUsd / deliveredAudits : null,
  };
}
const esc = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
export function renderDashboard(
  view: "ledger" | "orders" | "agents" | "health",
  input: DashboardInput,
  signedIn: boolean,
): { status: number; headers: Record<string, string>; body: string } {
  if (!signedIn) return { status: 302, headers: { location: "/api/auth/signin" }, body: "" };
  const summary = summarizeLedger(input.events);
  const nav = ["ledger", "orders", "agents", "health"]
    .map((item) => `<a href="/dashboard/${item}">${esc(item)}</a>`)
    .join(" · ");
  const body =
    view === "ledger"
      ? `<h2>Ops Ledger</h2><p>Candidates ${summary.candidates} · Scanned ${summary.scanned} · Paid ${summary.paidOrders} · Delivered ${summary.deliveredAudits}</p><p>Revenue $${summary.revenueUsd.toFixed(2)} · Cost $${summary.costsUsd.toFixed(2)} · Cost per delivered audit ${summary.costPerDeliveredAuditUsd === null ? "—" : `$${summary.costPerDeliveredAuditUsd.toFixed(2)}`}</p><ol>${input.events
          .slice(-50)
          .reverse()
          .map((event) => `<li>${esc(event.at)} ${esc(event.actor)} ${esc(event.type)}</li>`)
          .join("")}</ol>`
      : view === "agents"
        ? `<h2>Agents</h2><ul>${input.agents.map((agent) => `<li>${esc(agent.name)}: ${esc(agent.status)}${agent.stopReason ? ` (${esc(agent.stopReason)})` : ""} · $${agent.spendUsd.toFixed(2)} / $${agent.budgetUsd.toFixed(2)}</li>`).join("")}</ul>`
        : view === "orders"
          ? `<h2>Orders</h2><p>${summary.paidOrders} paid · ${summary.deliveredAudits} delivered</p>`
          : `<h2>Health</h2><p>${input.queuedJobs} queued jobs · ${input.approvalsWaiting} approvals waiting</p><ul>${Object.entries(
              input.integrations,
            )
              .map(([name, state]) => `<li>${esc(name)}: ${esc(state)}</li>`)
              .join("")}</ul>`;
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="2"><title>Outrun Dashboard</title></head><body><header><h1>Outrun Dashboard</h1><nav><a href="/dashboard/approvals">Approvals</a> · ${nav}</nav></header><main>${body}</main></body></html>`,
  };
}

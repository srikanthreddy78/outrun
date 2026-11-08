import { loadDashboardSnapshot } from "../../../lib/dashboard-live";

export default async function LedgerPage() {
  const { summary, events, naiveCostUsd } = await loadDashboardSnapshot();
  return (
    <>
      <h1>Ops Ledger</h1>
      <p>
        Candidates {summary.candidates} · Scanned {summary.scanned} · Paid {summary.paidOrders} · Delivered{" "}
        {summary.deliveredAudits}
      </p>
      <p>
        Revenue ${summary.revenueUsd.toFixed(2)} · Cost ${summary.costsUsd.toFixed(2)} (Naive $
        {naiveCostUsd.toFixed(2)}) · Cost per delivered audit{" "}
        {summary.costPerDeliveredAuditUsd === null ? "—" : `$${summary.costPerDeliveredAuditUsd.toFixed(2)}`}
      </p>
      <h2>Recent events</h2>
      <ol>
        {events.map((event) => (
          <li key={event.id}>
            {event.at} · {event.actor} · {event.type}
            {event.costUsd ? ` · $${event.costUsd.toFixed(4)}` : ""}
          </li>
        ))}
      </ol>
    </>
  );
}

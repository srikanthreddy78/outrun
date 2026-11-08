import { loadDashboardSnapshot } from "../../../lib/dashboard-live";

export default async function HealthPage() {
  const { health, queuedJobs, approvalsWaiting } = await loadDashboardSnapshot();
  return (
    <>
      <h1>Health</h1>
      <p>
        System {health.ok ? "healthy" : "needs attention"} · {queuedJobs ?? "—"} queued jobs ·{" "}
        {approvalsWaiting} approvals waiting.
      </p>
      <ul>
        <li>Database: {health.checks.db ? "ready" : "unavailable"}</li>
        <li>Migrations: {health.checks.migrations ? "ready" : "missing"}</li>
        <li>Queue: {health.checks.queue ? "ready" : "unavailable"}</li>
        <li>Last Naive webhook: {health.lastNaiveWebhookAt ?? "none"}</li>
      </ul>
      <h2>Integrations using fakes</h2>
      <p>{health.fakes.length ? health.fakes.join(", ") : "None"}</p>
    </>
  );
}

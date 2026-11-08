import { loadDashboardSnapshot } from "../../../lib/dashboard-live";
import { replayDeadJob } from "../../../lib/replay-dead-job";
import { REPLAYABLE_JOBS } from "../../../lib/replayable-jobs";

export default async function HealthPage() {
  const { health, queuedJobs, approvalsWaiting, deadJobs } = await loadDashboardSnapshot();
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
      <h2>Dead jobs</h2>
      {deadJobs.length === 0 ? (
        <p>None.</p>
      ) : (
        <ul>
          {deadJobs.map((job) => (
            <li key={job.id}>
              {job.at} · {job.job}
              {job.jobId && REPLAYABLE_JOBS.has(job.job) && (
                <form action={replayDeadJob} style={{ display: "inline", marginLeft: 12 }}>
                  <input type="hidden" name="eventId" value={job.id} />
                  <button type="submit">Replay</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

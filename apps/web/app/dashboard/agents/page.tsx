import { loadDashboardSnapshot } from "../../../lib/dashboard-live";

export default async function AgentsPage() {
  const { sessions } = await loadDashboardSnapshot();
  return (
    <>
      <h1>Agents</h1>
      <p>Recent Naive sessions and recorded spend. Budgets are daily crew caps.</p>
      <div className="team-table-wrap">
        <table className="team-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Entity</th>
              <th>Status</th>
              <th>Stop reason</th>
              <th>Spend</th>
              <th>Daily cap</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id}>
                <td>{session.agent}</td>
                <td>
                  {session.entityType} {session.entityId}
                </td>
                <td>{session.status}</td>
                <td>{session.stopReason ?? "—"}</td>
                <td>${session.spendUsd.toFixed(4)}</td>
                <td>${session.budgetUsd.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sessions.length === 0 && <p>No agent sessions yet.</p>}
    </>
  );
}

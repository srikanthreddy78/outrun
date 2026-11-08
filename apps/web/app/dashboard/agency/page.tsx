import { agencyOverview } from "@outrun/core/crew/tools/agency";
import { getRuntime } from "../../../lib/runtime";

export const dynamic = "force-dynamic";

/** The agency like a company: the CEO's brief on top, then each client and its six agents. */
export default async function AgencyPage() {
  const rt = await getRuntime();
  const { clients, brief } = await agencyOverview(rt.db.db, new Date());
  return (
    <>
      <h1>Agency</h1>
      <p>
        The CEO oversees {clients.length} client{clients.length === 1 ? "" : "s"}, each with its own crew of
        six agents. Numbers cover the last 7 days.
      </p>
      <section>
        <h2>CEO brief</h2>
        {brief ? (
          <>
            <p>
              {brief.day} · saved{" "}
              {new Date(brief.at).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}
            </p>
            <pre className="team-pre">{brief.summary}</pre>
          </>
        ) : (
          <p>No brief yet. The CEO writes one each weekday at 08:30 Los Angeles.</p>
        )}
      </section>
      {clients.map((c) => (
        <section key={c.clientId}>
          <h2>
            {c.name} <small>({c.domain})</small>
          </h2>
          <p>
            Status: {c.status} · profile {c.profileConfirmed ? "confirmed" : "not confirmed"} · sending domain{" "}
            {c.dnsStatus} · sent {c.sent} · replies {c.replies} · won {c.won} · approvals waiting{" "}
            {c.approvalsWaiting}
          </p>
          {c.attention.length > 0 && (
            <ul>
              {c.attention.map((a) => (
                <li key={a}>Needs attention: {a}</li>
              ))}
            </ul>
          )}
          <div className="team-table-wrap">
            <table className="team-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Naive agent</th>
                  <th>Sessions</th>
                  <th>Failed</th>
                  <th>Last run</th>
                  <th>Spend</th>
                </tr>
              </thead>
              <tbody>
                {c.crew.map((m) => (
                  <tr key={m.naiveAgent}>
                    <td>{m.role}</td>
                    <td>{m.naiveAgent}</td>
                    <td>{m.sessions}</td>
                    <td>{m.failed}</td>
                    <td>
                      {m.lastSessionAt
                        ? new Date(m.lastSessionAt).toISOString().slice(0, 16).replace("T", " ")
                        : "—"}
                    </td>
                    <td>${m.spendUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}

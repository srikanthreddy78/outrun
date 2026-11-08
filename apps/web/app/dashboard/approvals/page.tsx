import { desc, eq, messages } from "@outrun/core/db/query";
import { getRuntime } from "../../../lib/runtime";

export default async function ApprovalsPage() {
  const rt = await getRuntime();
  const pending = await rt.db.db
    .select({
      id: messages.id,
      subject: messages.subject,
      toEmail: messages.toEmail,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.status, "awaiting_approval"))
    .orderBy(desc(messages.createdAt))
    .limit(50);

  return (
    <>
      <h1>Approvals</h1>
      <p>Messages waiting for a team review.</p>
      {pending.length === 0 ? (
        <p>No messages are waiting.</p>
      ) : (
        <div className="team-table-wrap">
          <table className="team-table">
            <thead>
              <tr>
                <th>Subject</th>
                <th>Recipient</th>
                <th>Queued</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((message) => (
                <tr key={message.id}>
                  <td>{message.subject || "(No subject)"}</td>
                  <td>{message.toEmail ?? "—"}</td>
                  <td>{message.createdAt.toISOString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

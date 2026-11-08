import { desc, eq, messages } from "@outrun/core/db/query";
import { decideApprovals } from "../../../lib/approvals";
import { getRuntime } from "../../../lib/runtime";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const rt = await getRuntime();
  const pending = await rt.db.db
    .select({
      id: messages.id,
      kind: messages.kind,
      subject: messages.subject,
      body: messages.body,
      toEmail: messages.toEmail,
      cited: messages.citedCheckIds,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.status, "awaiting_approval"))
    .orderBy(desc(messages.createdAt))
    .limit(50);

  return (
    <>
      <h1>Approvals</h1>
      <p>
        Every email an agent writes waits here (and in the Naive Studio) for a person. Approve or reject one
        or many; Naive enforces the decision. The unsubscribe line is added when it sends.
      </p>
      {pending.length === 0 ? (
        <p>No messages are waiting.</p>
      ) : (
        <form action={decideApprovals}>
          {pending.map((m) => (
            <article key={m.id} className="team-card" style={{ marginBottom: "1rem" }}>
              <label style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
                <input type="checkbox" name="ids" value={m.id} defaultChecked={pending.length === 1} />
                <strong>{m.subject || "(No subject)"}</strong>
              </label>
              <p>
                To {m.toEmail ?? "—"} · {m.kind} · queued {m.createdAt.toISOString()}
              </p>
              <p>Cites: {m.cited.length ? m.cited.join(", ") : "none"}</p>
              <pre style={{ whiteSpace: "pre-wrap" }}>{m.body}</pre>
            </article>
          ))}
          <label>
            Reason (optional, sent to the agent on a rejection)
            <input type="text" name="reason" maxLength={500} style={{ width: "100%" }} />
          </label>
          <p style={{ display: "flex", gap: "0.5rem" }}>
            <button type="submit" name="decision" value="allow">
              Approve selected
            </button>
            <button type="submit" name="decision" value="deny">
              Reject selected
            </button>
          </p>
        </form>
      )}
    </>
  );
}

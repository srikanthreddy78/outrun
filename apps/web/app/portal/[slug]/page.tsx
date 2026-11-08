import { notFound, redirect } from "next/navigation";
import { config } from "@outrun/core";
import { clientQuestions, latestClientReport } from "@outrun/core/accountManager";
import { CLIENT_QUESTION_MAX_CHARS } from "@outrun/core/constants";
import { staffedRoles } from "@outrun/core/contracts";
import { pipelineCounts } from "@outrun/core/crew/tools/pipeline_status";
import { and, clients, desc, eq, messages } from "@outrun/core/db/query";
import { portalClients } from "@outrun/core/portal";
import { portalAskAction, portalDecideAction, signOutAction } from "../../../lib/portal";
import { portalEmail } from "../../../lib/portal-session";
import { getRuntime } from "../../../lib/runtime";

export const dynamic = "force-dynamic";

type Profile = {
  summary?: string;
  icp?: { description?: string; buyerRoles?: string[] };
  offer?: { pitch?: string; callToActionUrl?: string; prices?: { label: string; amount: string }[] };
  sender?: { name?: string; title?: string; postalAddress?: string };
  tone?: string;
};

const ASKED: Record<string, string> = {
  account_manager: "Thanks. Your account manager will answer here.",
  ceo: "Thanks. Your agency will see it and answer here.",
  limit: "That's the most questions for today; ask again tomorrow.",
  invalid: `Write a question of up to ${CLIENT_QUESTION_MAX_CHARS} characters.`,
};

/**
 * One client's portal: its held emails to approve, its weekly report and questions to its
 * account manager, its pipeline, profile and email setup.
 */
export default async function ClientPortal({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ asked?: string }>;
}) {
  const { slug } = await params;
  const { asked } = await searchParams;
  const email = await portalEmail();
  if (!email) redirect("/portal");
  const rt = await getRuntime();
  const mine = await portalClients(rt.db.db, email);
  const allowed = mine.find((c) => c.slug === slug);
  // Not this approver's client: the same answer as no such client.
  if (!allowed) notFound();
  const [c] = await rt.db.db.select().from(clients).where(eq(clients.id, allowed.id));
  if (!c) notFound();

  const pending = await rt.db.db
    .select({
      id: messages.id,
      kind: messages.kind,
      subject: messages.subject,
      body: messages.body,
      toEmail: messages.toEmail,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.clientId, c.id), eq(messages.status, "awaiting_approval")))
    .orderBy(desc(messages.createdAt))
    .limit(50);
  const recent = await rt.db.db
    .select({
      subject: messages.subject,
      toEmail: messages.toEmail,
      direction: messages.direction,
      at: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.clientId, c.id), eq(messages.status, "sent")))
    .orderBy(desc(messages.createdAt))
    .limit(10);
  const counts = await pipelineCounts(rt.db.db, c.id, config().settings, new Date());
  const latest = await latestClientReport(rt.db.db, c.id);
  const questions = await clientQuestions(rt.db.db, c.id, 10);
  const hasAm = staffedRoles(c.crewRoles).includes("account_manager");
  const p = c.profile as Profile;

  return (
    <main style={{ maxWidth: "52rem", margin: "2rem auto", padding: "0 1rem" }}>
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "1rem 0" }}
      >
        <span>
          {c.name} · signed in as {email}
          {mine.length > 1 && (
            <>
              {" "}
              · <a href="/portal">switch client</a>
            </>
          )}
        </span>
        <form action={signOutAction}>
          <button type="submit">Sign out</button>
        </form>
      </div>

      <h1>Emails waiting for you</h1>
      <p>
        Your agents wrote these. Nothing is sent until you approve it; a rejection reason goes back to the
        agent.
      </p>
      {pending.length === 0 ? (
        <p>Nothing is waiting.</p>
      ) : (
        <form action={portalDecideAction}>
          <input type="hidden" name="slug" value={c.slug} />
          {pending.map((m) => (
            <article
              key={m.id}
              style={{ border: "1px solid #ccc", borderRadius: 8, padding: "0.75rem", marginBottom: "1rem" }}
            >
              <label style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
                <input type="checkbox" name="ids" value={m.id} defaultChecked={pending.length === 1} />
                <strong>{m.subject || "(No subject)"}</strong>
              </label>
              <p>
                To {m.toEmail ?? "—"} · {m.kind} · {m.createdAt.toISOString().slice(0, 16).replace("T", " ")}
              </p>
              <pre style={{ whiteSpace: "pre-wrap" }}>{m.body}</pre>
            </article>
          ))}
          <label>
            Reason (optional; sent to the agent on a rejection)
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

      <h2>Your weekly report</h2>
      {latest ? (
        <section>
          <p>
            Week to {latest.report.day}: {latest.report.sent} emails sent · {latest.report.replies} replies ·{" "}
            {latest.report.won} won · {latest.report.approvalsWaiting} waiting for you
          </p>
          {latest.report.goal && (
            <p>
              Goal: {latest.report.goal.current} of {latest.report.goal.target} {latest.report.goal.metric} by{" "}
              {latest.report.goal.by} ·{" "}
              {latest.report.goal.met ? "met" : latest.report.goal.onTrack ? "on track" : "behind"}
            </p>
          )}
          {latest.report.note && <p style={{ whiteSpace: "pre-wrap" }}>{latest.report.note}</p>}
        </section>
      ) : (
        <p>No report yet.</p>
      )}

      <h2>Ask your account manager</h2>
      {asked && ASKED[asked] && <p>{ASKED[asked]}</p>}
      <form action={portalAskAction}>
        <input type="hidden" name="slug" value={c.slug} />
        <textarea
          name="question"
          required
          maxLength={CLIENT_QUESTION_MAX_CHARS}
          rows={3}
          style={{ width: "100%" }}
          aria-label="Your question"
        />
        <button type="submit">Ask</button>
      </form>
      {!hasAm && <p>Your agency reads these and answers here.</p>}
      {questions.length > 0 && (
        <ul>
          {questions.map((q) => (
            <li key={q.questionId}>
              <p style={{ whiteSpace: "pre-wrap" }}>
                <strong>You asked:</strong> {q.question}
              </p>
              <p style={{ whiteSpace: "pre-wrap" }}>
                {q.answer ? (
                  <>
                    <strong>Answer:</strong> {q.answer.text}
                  </>
                ) : (
                  "Waiting for an answer."
                )}
              </p>
            </li>
          ))}
        </ul>
      )}

      <h2>Pipeline</h2>
      <p>
        {Object.entries(counts.stages)
          .filter(([, n]) => n > 0)
          .map(([s, n]) => `${s} ${n}`)
          .join(" · ") || "No prospects yet."}{" "}
        · {counts.candidatesWaiting} companies found and not yet reviewed · {counts.capsLeft.send} sends left
        today
      </p>
      {recent.length > 0 && (
        <ul>
          {recent.map((m, i) => (
            <li key={i}>
              {m.at.toISOString().slice(0, 10)} · {m.subject} → {m.toEmail}
            </li>
          ))}
        </ul>
      )}

      <h2>Your profile</h2>
      {c.profileConfirmedAt ? (
        <dl>
          <dt>What you sell</dt>
          <dd>{p.summary}</dd>
          <dt>Who we look for</dt>
          <dd>
            {p.icp?.description} ({(p.icp?.buyerRoles ?? []).join(", ")})
          </dd>
          <dt>The offer</dt>
          <dd>
            {p.offer?.pitch} → {p.offer?.callToActionUrl}
          </dd>
          <dt>Prices we may quote</dt>
          <dd>{(p.offer?.prices ?? []).map((x) => `${x.label}: ${x.amount}`).join(", ") || "none"}</dd>
          <dt>Signed as</dt>
          <dd>
            {p.sender?.name}
            {p.sender?.title ? `, ${p.sender.title}` : ""} · {p.sender?.postalAddress}
          </dd>
        </dl>
      ) : (
        <p>Your profile is being drafted and checked. Your agency will confirm it with you.</p>
      )}
      <p>To change anything here, reply to your agency.</p>

      <h2>Email setup</h2>
      <p>
        Sending from {c.sendingDomain ?? c.domain}: <strong>{c.dnsStatus}</strong>
        {c.agentmailInboxId ? ` (inbox ${c.agentmailInboxId})` : ""}.
      </p>
      {c.dnsRecords.length > 0 && c.dnsStatus !== "verified" && (
        <>
          <p>Add these records at your DNS host. We check again every 15 minutes.</p>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Name</th>
                <th>Value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {c.dnsRecords.map((r) => (
                <tr key={`${r.type}:${r.name}:${r.value}`}>
                  <td>{r.type}</td>
                  <td>{r.name}</td>
                  <td style={{ wordBreak: "break-all" }}>
                    {r.priority !== undefined ? `${r.priority} ` : ""}
                    {r.value}
                  </td>
                  <td>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}

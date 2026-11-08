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
import { Masthead } from "../ui";

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
  const crew = staffedRoles(c.crewRoles);
  const prospects = Object.values(counts.stages).reduce((a, n) => a + n, 0);
  const stages = Object.entries(counts.stages).filter(([, n]) => n > 0);

  return (
    <>
      <Masthead>
        <span className="p-mast__email">
          {email}
          {mine.length > 1 && (
            <>
              {" "}
              · <a href="/portal">switch client</a>
            </>
          )}
        </span>
        <form action={signOutAction}>
          <button type="submit" className="p-btn p-btn--small">
            Sign out
          </button>
        </form>
      </Masthead>

      <main className="p-main">
        <p className="p-kicker">Client portal · {c.name}</p>
        <h1 className="p-h1">
          {c.name}&apos;s growth crew
          <em>is on it.</em>
        </h1>
        <p className="p-lede">
          {pending.length > 0
            ? `${pending.length} ${pending.length === 1 ? "email is" : "emails are"} waiting for your approval. Nothing is sent until you approve it.`
            : "Your agents are researching and drafting. Nothing is sent until you approve it."}
        </p>

        <div className="p-stats">
          <div className={pending.length > 0 ? "p-stat p-stat--hot" : "p-stat"}>
            <b>{pending.length}</b>
            <span>Waiting for you</span>
          </div>
          <div className="p-stat">
            <b>{prospects}</b>
            <span>Prospects</span>
          </div>
          <div className="p-stat">
            <b>{recent.length}</b>
            <span>Recently sent</span>
          </div>
          <div className="p-stat">
            <b>{counts.capsLeft.send}</b>
            <span>Sends left today</span>
          </div>
        </div>

        <section className="p-section">
          <p className="p-kicker">Your crew</p>
          <h2 className="p-h2">{crew.length} agents working for you</h2>
          <ul className="p-crew">
            {crew.map((r) => (
              <li key={r}>{r.replace(/_/g, " ")}</li>
            ))}
          </ul>
        </section>

        <section className="p-section">
          <p className="p-kicker">Approvals</p>
          <h2 className="p-h2">Emails waiting for you</h2>
          <p className="p-muted">
            Your agents wrote these. Nothing is sent until you approve it; a rejection reason goes back to the
            agent.
          </p>
          {pending.length === 0 ? (
            <p className="p-note">Nothing is waiting right now.</p>
          ) : (
            <form action={portalDecideAction}>
              <input type="hidden" name="slug" value={c.slug} />
              {pending.map((m) => (
                <article key={m.id} className="p-card">
                  <label className="p-card__head">
                    <input type="checkbox" name="ids" value={m.id} defaultChecked={pending.length === 1} />
                    <span className="p-card__subject">{m.subject || "(No subject)"}</span>
                  </label>
                  <p className="p-card__meta">
                    To {m.toEmail ?? "—"} · {m.kind} ·{" "}
                    {m.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </p>
                  <pre>{m.body}</pre>
                </article>
              ))}
              <div className="p-decide">
                <label className="p-field">
                  Reason (optional; sent to the agent on a rejection)
                  <input type="text" name="reason" maxLength={500} />
                </label>
                <div className="p-actions">
                  <button type="submit" name="decision" value="allow" className="p-btn">
                    Approve selected <span aria-hidden="true">&rarr;</span>
                  </button>
                  <button type="submit" name="decision" value="deny" className="p-btn p-btn--ghost">
                    Reject selected
                  </button>
                </div>
              </div>
            </form>
          )}
        </section>

        <section className="p-section">
          <p className="p-kicker">Weekly report</p>
          <h2 className="p-h2">How it&apos;s going</h2>
          {latest ? (
            <>
              <p className="p-lede">
                Week to {latest.report.day}: {latest.report.sent} emails sent · {latest.report.replies}{" "}
                replies · {latest.report.won} won · {latest.report.approvalsWaiting} waiting for you
              </p>
              {latest.report.goal && (
                <p className="p-note">
                  Goal: {latest.report.goal.current} of {latest.report.goal.target}{" "}
                  {latest.report.goal.metric} by {latest.report.goal.by} ·{" "}
                  {latest.report.goal.met ? "met" : latest.report.goal.onTrack ? "on track" : "behind"}
                </p>
              )}
              {latest.report.note && <p style={{ whiteSpace: "pre-wrap" }}>{latest.report.note}</p>}
            </>
          ) : (
            <p className="p-muted">Your first report arrives after your crew&apos;s first week.</p>
          )}
        </section>

        <section className="p-section">
          <p className="p-kicker">Questions</p>
          <h2 className="p-h2">Ask your account manager</h2>
          {asked && ASKED[asked] && <p className="p-note">{ASKED[asked]}</p>}
          <form action={portalAskAction} className="p-ask">
            <input type="hidden" name="slug" value={c.slug} />
            <textarea
              name="question"
              required
              maxLength={CLIENT_QUESTION_MAX_CHARS}
              rows={3}
              aria-label="Your question"
              placeholder="Which companies are you reaching out to this week?"
            />
            <button type="submit" className="p-btn">
              Ask <span aria-hidden="true">&rarr;</span>
            </button>
          </form>
          {!hasAm && <p className="p-muted">Your agency reads these and answers here.</p>}
          {questions.length > 0 && (
            <ul className="p-list">
              {questions.map((q) => (
                <li key={q.questionId}>
                  <p>
                    <span className="p-tag">You asked</span> {q.question}
                  </p>
                  <p>
                    {q.answer ? (
                      <>
                        <span className="p-tag">Answer</span> {q.answer.text}
                      </>
                    ) : (
                      <span className="p-muted">Waiting for an answer.</span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="p-section">
          <p className="p-kicker">Pipeline</p>
          <h2 className="p-h2">Who we&apos;re reaching</h2>
          <p>
            {stages.map(([st, n]) => `${st} ${n}`).join(" · ") || "No prospects yet."} ·{" "}
            {counts.candidatesWaiting} companies found and not yet reviewed
          </p>
          {recent.length > 0 && (
            <ul className="p-list">
              {recent.map((m, i) => (
                <li key={i}>
                  <span className="p-tag">{m.at.toISOString().slice(0, 10)}</span> {m.subject} → {m.toEmail}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="p-section">
          <p className="p-kicker">Profile</p>
          <h2 className="p-h2">What we sell for you</h2>
          {c.profileConfirmedAt ? (
            <dl className="p-profile">
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
            <p className="p-note">
              Your researcher is drafting your profile now. Your agency will confirm it with you.
            </p>
          )}
          <p className="p-muted">To change anything here, reply to your agency.</p>
        </section>

        <section className="p-section">
          <p className="p-kicker">Email setup</p>
          <h2 className="p-h2">Sending domain</h2>
          <p>
            Sending from {c.sendingDomain ?? c.domain}{" "}
            <span className={c.dnsStatus === "verified" ? "p-pill p-pill--ok" : "p-pill p-pill--wait"}>
              {c.dnsStatus === "none"
                ? "not set up"
                : c.dnsStatus === "verified"
                  ? "verified"
                  : "waiting for DNS"}
            </span>
            {c.agentmailInboxId ? ` · inbox ${c.agentmailInboxId}` : ""}
          </p>
          {c.dnsRecords.length > 0 && c.dnsStatus !== "verified" && (
            <>
              <p className="p-muted">Add these records at your DNS host. We check again every 15 minutes.</p>
              <div className="p-table-wrap">
                <table className="p-table">
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
              </div>
            </>
          )}
        </section>
      </main>
    </>
  );
}

import { SELF_SERVE_DAILY_CAP } from "@outrun/core/constants";
import { hireAction } from "../../lib/hire";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Hire Outrun",
  description: "A free trial of Outrun's agency: a crew of six AI agents that runs your outbound.",
};

/** Self-serve signup: a free trial of the agency, no payment. Agents can call hire_agency instead. */
export default async function Hire({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  return (
    <main style={{ maxWidth: "34rem", margin: "3rem auto", padding: "0 1rem" }}>
      <h1>Hire Outrun</h1>
      <p>
        Outrun gives your company its own crew of six AI agents: they find companies that fit, research them,
        and write cited outbound emails for you. Free trial, no card.
      </p>
      <ol>
        <li>Sign in with the link we email you; that starts your crew.</li>
        <li>Your crew reads your site and drafts your profile: who you sell to, your offer and prices.</li>
        <li>Our owner checks that profile before anything is written for you.</li>
        <li>You approve every email in your portal before it is sent, from your own domain.</li>
      </ol>
      {q.hired && (
        <p role="status">
          You&apos;re in. Check your inbox and sign in with the link to your <a href="/portal">portal</a>;
          your crew starts as soon as you do.
        </p>
      )}
      {q.known && (
        <p role="status">
          That domain is already a client. Approvers can sign in at <a href="/portal">the portal</a>.
        </p>
      )}
      {q.error && <p role="alert">{q.error}</p>}
      {!q.hired && (
        <form action={hireAction} style={{ display: "grid", gap: "0.75rem" }}>
          <label>
            Company name
            <input name="companyName" required maxLength={80} style={{ width: "100%" }} />
          </label>
          <label>
            Website domain
            <input
              name="domain"
              required
              maxLength={253}
              placeholder="acme.dev"
              pattern="[A-Za-z0-9.\-]+\.[A-Za-z]{2,63}"
              style={{ width: "100%" }}
            />
          </label>
          <label>
            Your work email (at that domain); you approve every email
            <input type="email" name="approverEmail" required maxLength={254} style={{ width: "100%" }} />
          </label>
          <button type="submit">Start the free trial</button>
        </form>
      )}
      <p style={{ fontSize: "0.85em", opacity: 0.75 }}>
        We take {SELF_SERVE_DAILY_CAP} new clients a day. Agents can hire us too: <code>hire_agency</code> on
        our MCP server and A2A endpoint (see <a href="/llms.txt">llms.txt</a>).
      </p>
    </main>
  );
}

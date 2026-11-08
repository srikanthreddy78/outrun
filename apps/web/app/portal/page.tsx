import { redirect } from "next/navigation";
import { portalClients } from "@outrun/core/portal";
import { requestLinkAction, signOutAction } from "../../lib/portal";
import { portalEmail } from "../../lib/portal-session";
import { getRuntime } from "../../lib/runtime";
import { Masthead } from "./ui";

export const dynamic = "force-dynamic";

/** Client portal: sign in by email link, then pick the client you approve for. */
export default async function PortalHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const q = await searchParams;
  const email = await portalEmail();
  if (!email)
    return (
      <>
        <Masthead />
        <main className="p-main p-main--narrow">
          <p className="p-kicker">Client portal</p>
          <h1 className="p-h1">
            Your crew,
            <em>your call.</em>
          </h1>
          <p className="p-lede">Review and approve the outreach your agents wrote for you.</p>
          {q.sent && (
            <p className="p-note">
              If that address can approve for a client, a sign-in link is on its way. It works once, for 15
              minutes.
            </p>
          )}
          {q.expired && <p className="p-note">That link is expired or already used. Ask for a new one.</p>}
          <form action={requestLinkAction} className="p-ask" style={{ marginTop: "2rem" }}>
            <label className="p-field" style={{ width: "100%" }}>
              Work email
              <input type="email" name="email" required maxLength={254} />
            </label>
            <button type="submit" className="p-btn">
              Email me a sign-in link <span aria-hidden="true">&rarr;</span>
            </button>
          </form>
        </main>
      </>
    );
  const rt = await getRuntime();
  const mine = await portalClients(rt.db.db, email);
  if (mine.length === 1) redirect(`/portal/${mine[0]!.slug}`);
  return (
    <>
      <Masthead>
        <span className="p-mast__email">{email}</span>
        <form action={signOutAction}>
          <button type="submit" className="p-btn p-btn--small">
            Sign out
          </button>
        </form>
      </Masthead>
      <main className="p-main p-main--narrow">
        <p className="p-kicker">Client portal</p>
        <h1 className="p-h1">Pick a client</h1>
        {mine.length === 0 ? (
          <p className="p-note">This address doesn&apos;t approve for any client any more.</p>
        ) : (
          <ul className="p-list">
            {mine.map((c) => (
              <li key={c.id}>
                <a href={`/portal/${c.slug}`}>{c.name}</a> <span className="p-tag">{c.status}</span>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

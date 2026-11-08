import { redirect } from "next/navigation";
import { portalClients } from "@outrun/core/portal";
import { requestLinkAction, signOutAction } from "../../lib/portal";
import { portalEmail } from "../../lib/portal-session";
import { getRuntime } from "../../lib/runtime";

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
      <main style={{ maxWidth: "32rem", margin: "3rem auto", padding: "0 1rem" }}>
        <h1>Client portal</h1>
        <p>Review and approve the outreach your agents wrote for you.</p>
        {q.sent && (
          <p>
            If that address can approve for a client, a sign-in link is on its way. It works once, for 15
            minutes.
          </p>
        )}
        {q.expired && <p>That link is expired or already used. Ask for a new one.</p>}
        <form action={requestLinkAction} style={{ display: "grid", gap: "0.5rem" }}>
          <label>
            Work email
            <input type="email" name="email" required maxLength={254} style={{ width: "100%" }} />
          </label>
          <button type="submit">Email me a sign-in link</button>
        </form>
      </main>
    );
  const rt = await getRuntime();
  const mine = await portalClients(rt.db.db, email);
  if (mine.length === 1) redirect(`/portal/${mine[0]!.slug}`);
  return (
    <main style={{ maxWidth: "40rem", margin: "3rem auto", padding: "0 1rem" }}>
      <h1>Client portal</h1>
      <p>Signed in as {email}.</p>
      {mine.length === 0 ? (
        <p>This address doesn&apos;t approve for any client any more.</p>
      ) : (
        <ul>
          {mine.map((c) => (
            <li key={c.id}>
              <a href={`/portal/${c.slug}`}>{c.name}</a> ({c.status})
            </li>
          ))}
        </ul>
      )}
      <form action={signOutAction}>
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}

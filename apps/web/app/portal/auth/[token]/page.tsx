import { signInAction } from "../../../../lib/portal";

export const dynamic = "force-dynamic";

/**
 * The emailed link lands here. Signing in is a button (a POST), not the page load, so a mail
 * scanner opening the link doesn't use it up.
 */
export default async function PortalAuth({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main style={{ maxWidth: "32rem", margin: "3rem auto", padding: "0 1rem" }}>
      <h1>Sign in to the client portal</h1>
      <form action={signInAction}>
        <input type="hidden" name="token" value={token} />
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}

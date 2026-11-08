import { signInAction } from "../../../../lib/portal";
import { Masthead } from "../../ui";

export const dynamic = "force-dynamic";

/**
 * The emailed link lands here. Signing in is a button (a POST), not the page load, so a mail
 * scanner opening the link doesn't use it up.
 */
export default async function PortalAuth({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <>
      <Masthead />
      <main className="p-main p-main--narrow">
        <p className="p-kicker">Client portal</p>
        <h1 className="p-h1">
          Meet your
          <em>growth crew.</em>
        </h1>
        <p className="p-lede">
          Sign in to see the agents working for you, and approve every email before it goes out.
        </p>
        <form action={signInAction} style={{ marginTop: "2rem" }}>
          <input type="hidden" name="token" value={token} />
          <button type="submit" className="p-btn">
            Sign in <span aria-hidden="true">&rarr;</span>
          </button>
        </form>
      </main>
    </>
  );
}

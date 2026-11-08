/**
 * The unsubscribe link in every outreach email. Opening it changes nothing (link scanners open
 * links); the page submits its own form once on load, and the button works without JavaScript.
 */
export const dynamic = "force-dynamic";

export default async function UnsubscribePage(props: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { token } = await props.params;
  const { done } = await props.searchParams;
  if (done) {
    return (
      <main className="container" style={{ padding: "4rem 1rem", maxWidth: 560 }}>
        <h1>You&apos;re unsubscribed</h1>
        <p>Outrun won&apos;t email you again. Sorry for the bother.</p>
      </main>
    );
  }
  const action = `/api/unsubscribe/${encodeURIComponent(token)}`;
  return (
    <main className="container" style={{ padding: "4rem 1rem", maxWidth: 560 }}>
      <h1>Unsubscribe</h1>
      <p>Stop all email from Outrun to this address.</p>
      <form id="unsubscribe" method="post" action={action}>
        <input type="hidden" name="from" value="page" />
        <button type="submit">Unsubscribe</button>
      </form>
      <script
        dangerouslySetInnerHTML={{
          __html: "document.getElementById('unsubscribe').submit();",
        }}
      />
    </main>
  );
}

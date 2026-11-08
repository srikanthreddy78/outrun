/**
 * One-click unsubscribe. Every outreach email ends with a link to `/u/<token>`; the token is an
 * HMAC of the address, so it never shows the address in the URL and can't be guessed.
 *
 * Opening the link unsubscribes in one click: the page submits itself as a POST on load. The
 * GET alone changes nothing, so mail scanners that prefetch links (they don't run scripts) can't
 * unsubscribe anyone by accident.
 */
import { createHmac } from "node:crypto";

export const tokenFor = (secret: string, email: string): string =>
  createHmac("sha256", secret)
    .update(`aga.unsubscribe.v1:${email.trim().toLowerCase()}`)
    .digest("base64url")
    .slice(0, 32);

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function footer(unsubscribeUrl: string, mailingAddress: string | null): string {
  const lines = ["", "--", `Not interested? Unsubscribe in one click: ${unsubscribeUrl}`];
  if (mailingAddress !== null) lines.push(mailingAddress);
  return lines.join("\n");
}

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 15vh auto; padding: 0 1rem; }
  button { font: inherit; padding: .6rem 1.2rem; border-radius: .5rem; border: 1px solid; cursor: pointer; }
</style>
</head>
<body>
${body}
</body>
</html>`;

export function confirmPage(token: string): string {
  return page(
    "Unsubscribe",
    `<h1>Unsubscribing…</h1>
<form id="unsubscribe" method="post" action="/u/${token}">
  <noscript><p>Press the button to stop all emails from us.</p></noscript>
  <button type="submit">Unsubscribe</button>
</form>
<script>document.getElementById("unsubscribe").submit();</script>`,
  );
}

export function donePage(): string {
  return page(
    "Unsubscribed",
    `<h1>You're unsubscribed</h1>
<p>You won't get any more emails from us.</p>`,
  );
}

export function unknownPage(): string {
  return page(
    "Link not recognized",
    `<h1>Link not recognized</h1>
<p>This unsubscribe link isn't valid. Reply to the email with "unsubscribe" and we'll remove you.</p>`,
  );
}

# Team dashboard sign-in

Create a GitHub OAuth app with its callback URL set to `https://<host>/api/auth/callback/github` (use `http://localhost:3000/api/auth/callback/github` for local development). Configure `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, and a comma-separated `AUTH_GITHUB_ALLOWLIST` in the web app environment. Keep the values out of git.

The sign-in callback requests `user:email`, reads GitHub's authenticated email list, and admits only a verified primary address on the allowlist. Dashboard pages check the allowlist again on every request, so removing an address revokes dashboard access for existing sessions. If the allowlist or GitHub email lookup is unavailable, sign-in fails closed.

The dashboard shell links to Approvals, Ledger, Orders, Agents, and Health. The data pages are placeholders until their event-backed views land. Approvals is owned by Shane.

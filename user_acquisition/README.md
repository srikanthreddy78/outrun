# User acquisition

Outrun's outreach email, run entirely on Naive. `naive up` provisions everything in `naive.config.ts`.

## What's deployed

| Resource                | What it does                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Identity `outrun`       | The persona outreach is sent from. Its inbox is `hello@<domain>`.                                                                    |
| Inbox `hello@`          | Owned by `inbox-triage`; every email that arrives wakes that agent.                                                                  |
| App `outreach`          | The crew's MCP tools (`outreach.*`), the one-click unsubscribe page at `/u/<token>`, and the suppression list in the app's Postgres. |
| Agent `outreach-sender` | Sends one email per request: `outreach.prepare_email`, then `email.send`, which waits for a person's approval.                       |
| Agent `inbox-triage`    | Handles every inbound email: suppresses unsubscribes, bounces and complaints, logs replies. Never sends.                             |
| Schedule `15 */2 * * *` | Inbox sweep every two hours, for anything that didn't wake the agent.                                                                |

## How sending works

1. `outreach.prepare_email` refuses a suppressed address and returns the final body with
   `Not interested? Unsubscribe in one click: https://<app>/u/<token>` appended.
2. The sender calls `email.send` with exactly that text. It's held at `ask`, so it waits on an
   approval in the Studio, or `pnpm naive session confirm --session <ses_> --tool-call <tc_> --allow`.

Opening the unsubscribe link submits the page as a POST on load, which adds the address to the
suppression list. A plain GET changes nothing, so link scanners can't unsubscribe anyone.

## How inbound mail is checked

- **Wake:** the inbox belongs to `inbox-triage`, so each arriving email starts a session on it.
- **Sweep:** every two hours the schedule reads the last three hours with `email.read`.
- `outreach.record_inbound` is called first for each message and answers `first_time: false`
  when it was already handled, so a wake and a sweep never act twice.

## Commands

This is the `@outrun/user-acquisition` package in the repo's pnpm workspace. Install from the repo
root; the API key and the optional `OUTREACH_*` settings are read from the root `.env` (see the
root `.env.example`).

```sh
pnpm install                                   # from the repo root
pnpm --filter @outrun/user-acquisition naive:dry-run  # build, then preview
pnpm --filter @outrun/user-acquisition naive:up       # build, then apply
pnpm --filter @outrun/user-acquisition naive session create --agent outreach-sender --identity outrun --message "..."
```

This is its own Naive project (`user-acquisition`), separate from the team crew that the root
`naive.config.ts` declares (project `outrun`), but in the same Naive organization.

## Landing page

`landing_page/` is the static site for heyoutrun.com, deployed as the Naive app `landing`. Its
copy follows `wiki/PRODUCT.md`.

## Moving the inbox to a bought domain

Buy or connect it in Naive, then apply with `OUTREACH_MAIL_DOMAIN=<domain>` set. That creates
`hello@<domain>` on the same identity.

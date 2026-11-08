# Outrun

**`wiki/PRODUCT.md` is the source of truth** for what Outrun is, who it's for and how it works.
Read it before any product, positioning, copy or agent-prompt work. Where anything else in the
repo disagrees with it (including `Agent Growth Agency Plan.md`), `wiki/PRODUCT.md` wins.

The company is called **Outrun**, and everything it sends is anonymous: signed "The Outrun team",
never naming anyone on the team.

## Domain

- **heyoutrun.com** serves the landing page (`user_acquisition/landing_page/`, the Naive app
  `landing`) over HTTPS only.
- Outreach email is sent from `hello@launchpad-marketing-prgqe7.usenaive.ai`, not from
  heyoutrun.com.

## Testing email

Never send test email to anyone outside the team. To test email, send it only to the AgentMail
test inbox **`gykforue6ze1w@agentmail.to`**, from that same inbox, so nothing leaves the account.

- The key is `AGENTMAIL_API_KEY` in the repo root `.env` (git-ignored; never print or commit it).
- API base `https://api.agentmail.to/v0`, with `Authorization: Bearer $AGENTMAIL_API_KEY`:
  - send: `POST /inboxes/gykforue6ze1w@agentmail.to/messages/send` with `{"to": ["gykforue6ze1w@agentmail.to"], "subject": "…", "text": "…"}`
  - read: `GET /inboxes/gykforue6ze1w@agentmail.to/messages`
- In the Naive-hosted deployment (`deploy/naive-hosted/`), setting `NAIVE_HOSTED_TEST_INBOX` to this
  address lets email reach it and refuses every other recipient in code; without it, email always
  goes to the fake.

## Naive-hosted deployment

`deploy/naive-hosted/` deploys the whole core workflow onto Naive alone (web app, Postgres, a
scheduled worker tick and the crew), into the second Naive account (`NAIVE_TWO_API_KEY` in `.env`).
It's opt-in with `NAIVE_HOSTED=1` and lives entirely in that folder; the regular deployment in
`docs/deploy.md` is unchanged. See its README.

## References

Refer to https://usenaive.ai/skill.md for how to use Naive.

Agent Mail Skill (don't use unless requested): https://agent.email/skill.md

Here's how to use monid.ai if requested: https://monid.ai/SKILL.md

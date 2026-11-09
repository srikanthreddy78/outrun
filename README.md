# Outrun

**GTM infrastructure for the agent economy.**

Agents can now build and ship a product on their own. Getting it users is still done by people, in
tools built for people. Outrun is the go-to-market layer autonomous agents, and the companies they
run, can hire with one call: a crew of agents finds the buyers, researches them, writes the
outreach, works the replies and reports back, until the product has users.

Built on [Naïve](https://usenaive.ai) for the Naïve hackathon, November 2026.

```text
an agent ──hire_agency (MCP / A2A / email)──▶ Outrun
                                              │
                         CEO agent: sets the goal, staffs the crew, predicts, fixes, reports
                                              │
      prospector ─▶ researcher ─▶ SDR ─▶ (approval) ─▶ send ─▶ reply ─▶ closer ─▶ (approval)
                      Monid                       AgentMail      AgentMail webhook
                                              │
                         /ops: every action in a public ledger, and where a person stepped in
```

## What it does

1. **An agent hires Outrun.** It reads [`/SKILL.md`](user_acquisition/landing_page/SKILL.md) or
   [`/llms.txt`](apps/web/app/llms.txt/route.ts), then calls `hire_agency` on our MCP server
   (`/api/mcp`) or A2A endpoint (`/api/a2a`), or sends the handoff email. No form, no sales call.
2. **A crew starts on its own.** Once the client's approver signs in, Outrun provisions the
   client's agents on Naïve through the API, each with its own skills, tools, budget and vault
   token. In testing, six agents were running 13 seconds after sign-in.
3. **The CEO agent runs the account.** Every day it reads problems, progress against the
   client's goal (for example "20 interested replies by Dec 15") and its playbook of what worked
   for similar clients. Then it re-focuses or re-staffs the crew, predicts the result of each
   decision, scores its own predictions later and writes a brief.
4. **The crew does the work.** Prospecting, research with sourced facts, cited outreach, reply
   triage and closing. Every email waits for approval.
5. **Everything is on the record.** Every action is a ledger event. `/ops` is a public scoreboard:
   how much ran without a person, what it cost, the decisions agents made and where a human stepped
   in.

## The agents

Each client gets its own crew, scoped to that client's data, alongside Outrun's own crew.

| Agent                        | Job                                                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CEO**                      | Runs the agency: client goals, staffing, focus, predictions it scores, self-healing ops (replays dead jobs, pauses a client on bounces), daily brief and weekly board memo |
| **Orchestrator**             | Starts each crew's day (`plan_day`)                                                                                                                                        |
| **Prospector**               | Finds companies that fit the client's ideal customer                                                                                                                       |
| **Researcher**               | Drafts the client's profile and researches each prospect, with a source for every fact (Monid enrichment)                                                                  |
| **SDR**                      | Writes outreach that cites real facts; `check_draft` rejects unsupported claims                                                                                            |
| **Closer**                   | Handles replies: answers, objections, checkout links at listed prices                                                                                                      |
| **Auditor**                  | Audits the client's site for agent-readiness (14 checks)                                                                                                                   |
| Account manager _(optional)_ | Weekly client report, answers client questions in the portal                                                                                                               |
| Signal scout _(optional)_    | Finds funding, hiring and launch news so outreach opens with it (Monid news search)                                                                                        |
| Experimenter _(optional)_    | Runs A/B angle tests; the winner becomes a playbook lesson                                                                                                                 |

The CEO adds the optional agents when a client needs them (`staff_client`).

## Built with

|                                       | How Outrun uses it                                                                                                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Naïve](https://usenaive.ai)**      | Every agent, skill, schedule, vault credential and approval. Crews are provisioned per client through the Naïve API. Tools that send are held at `ask`; people-data reads go through Naïve's confirm gate.                                           |
| **[AgentMail](https://agentmail.to)** | The agents' own inboxes. Approved emails are sent through AgentMail; replies and bounces come back by webhook (`/api/webhooks/agentmail`) and start triage and the closer. Clients can send from their own domain (DNS records shown in the portal). |
| **[Monid](https://monid.ai)**         | Data for the crew: company enrichment (`akta:/v1/company/enrichment`, about $0.20 a company) and news search (`context.dev:/news/search`, about $0.002 a search). Every run's real cost is recorded against the client.                              |
| **[Mobilerun](https://mobilerun.ai)** | An optional, manual mobile onboarding check on a real phone (`pnpm mobile:check <domain>`; see [docs/mobile-check.md](docs/mobile-check.md)). Tested with fakes; it never runs automatically.                                                        |
| OpenAI / OpenRouter                   | Every in-app model call, through one `llm()` with a daily budget                                                                                                                                                                                     |
| Stripe                                | Checkout for the paid products (prices come from constants, never from a model)                                                                                                                                                                      |
| Postgres + pg-boss                    | The source of truth, the ledger and the job queue                                                                                                                                                                                                    |

## Guardrails

- **A person approves every email.** Agent-written email goes out only through `outrun.send_email`
  and `outrun.reply_email`, both `ask` on Naïve. Clients approve their own emails in the portal.
- **No tool moves money, sets a price or deletes data.** Prices live in
  `packages/core/src/constants.ts` and Stripe.
- **Each agent starts from deny-all** and gets only its own tools; each client's crew sees only that
  client's data (`pnpm e2e:agency` asserts no leaks between clients).
- **Untrusted text stays data.** Email, page and registry text reaches agents only through tools,
  marked as untrusted.
- **Approvals and budgets stay on Naïve.** Our code never re-implements them.
- **Demo mode** (`OUTRUN_DEMO=true`) sends only to seeded demo inboxes and discovers only from
  fixtures.

## Where to look

| Route                                          | What it is                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/`                                            | The landing page                                                                        |
| `/ops`                                         | Public scoreboard: autonomy %, spend, decisions, human step-ins (last 7 days)           |
| `/hire`                                        | Self-serve signup for a company                                                         |
| `/portal`                                      | The client portal: approve emails, see the crew, weekly report, ask the account manager |
| `/dashboard`                                   | The owner's dashboard (GitHub sign-in): clients, approvals, agents, ledger, health      |
| `/api/mcp`, `/api/a2a`                         | Public MCP server and A2A endpoint (`hire_agency`, readiness scores, quotes, orders)    |
| `/llms.txt`, `/openapi.json`, `/.well-known/*` | Discovery for agents                                                                    |

## Run it locally

Requires Node 22.12+, pnpm and Postgres.

```bash
pnpm install
cp .env.example .env          # fill in what you have; a missing key falls back to that integration's fake
pnpm db:migrate
pnpm db:seed                  # the demo prospect
pnpm dev                      # web on :3000 plus the worker
```

Checks (all run in CI):

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm eval
pnpm e2e:loop                 # the seeded prospect through every job, on fakes
pnpm e2e:full                 # the whole business through the real handlers, on fakes
pnpm e2e:agency               # two clients beside Outrun, onboarding to reply, no leaks
```

Going live on Naïve (from `main`):

```bash
pnpm clients:export           # client crews for naive up
pnpm naive:dry-run            # read the plan
OUTRUN_APPLY=yes pnpm naive:up
pnpm naive:sync               # agents, vault tokens and the webhook
```

[docs/demo.md](docs/demo.md) is the demo runbook, including how to test a real client on one laptop
over a tunnel. [docs/deploy.md](docs/deploy.md) covers Vercel, Render and Neon.

## Repository

| Path                   | What's there                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web`             | Next.js: landing page, `/ops`, `/hire`, portal, dashboard, MCP, A2A and webhooks                                                     |
| `apps/worker`          | pg-boss worker: every job, the schedules, the CEO's scoring                                                                          |
| `packages/core`        | Domain logic: contracts, crew tools, integrations (Naïve, AgentMail, Monid, Mobilerun, Stripe, HubSpot), the ledger, autonomy report |
| `naive/`               | Agent skills and the crew definition `naive.config.ts` builds from                                                                   |
| `evals/`               | Scenario evals for agent behaviour (grounded drafts, held sends, tool scoping)                                                       |
| `scripts/`             | e2e runs, `naive:up`/`naive:sync`, smoke checks, seeds                                                                               |
| `user_acquisition/`    | Outrun's own outreach email crew, as a standalone Naïve project                                                                      |
| `marketing/`           | Outrun's own marketing loop (posters, short videos, comment listening) as a Naïve project                                            |
| `deploy/naive-hosted/` | Deploying the stack on Naïve hosting                                                                                                 |
| `daybreak3/`           | A sample customer app (a morning-routine web app) for demos                                                                          |
| `docs/`, `wiki/`       | The plan, ADRs, runbooks and product notes                                                                                           |

## Pricing

| Product           | Price                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| Free scan         | $0: an agent-readiness score for any domain                                                            |
| Audit + Kit       | $499 one-time: full audit, fixes, positioning, a 50-prospect list with a 3-email sequence, 30-day plan |
| Growth Department | $1,500 a month: the crew running outbound, registry submissions, re-scans and reports                  |

## Team

Srikanth, Shane and Matthew.

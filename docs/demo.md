# Demo day runbook (Nov 8)

Hacking stops at 11:00, demos at 13:00. Judges ask: what did the agents deliver, what did they
decide, and where did a person step in. `/ops` answers all three from the ledger.

## 1. Merge (Srikanth, in this order)

#26 → #27 → … → #37 → #38 → #39 (crew roles) → #40 (CEO brain) → #41 (staffing, goals,
account manager) → #42 (signal scout, experimenter).
Each is stacked on the one before. After each merge, GitHub retargets the next PR to `main`.
`naive up` runs only from `main`, so the merges come first.

## 2. Deploy (docs/deploy.md has the detail)

1. Neon: create the project; put `DATABASE_URL` and `DATABASE_URL_UNPOOLED` in Vercel and Render.
2. Render: Blueprint from `render.yaml` (the worker runs migrations before each deploy).
3. Vercel: Root Directory `apps/web`. Env as in deploy.md, plus `OUTRUN_DEMO=true`.
4. `CREW_TOKEN_SECRET`: generate once (`openssl rand -hex 32`), the same value in Vercel,
   Render and your local `.env`. `APP_URL` is the Vercel https origin, also in `.env`.
5. `NAIVE_API_KEY` on Render needs scopes `agents:write` and `admin` for self-serve crews
   (agents and vault credentials). Without them a signup ends in `client.crew_pending` and
   the fallback is `pnpm clients:export && naive up`.

## 3. Naive (from main)

    pnpm naive:dry-run                  # read the plan
    OUTRUN_APPLY=yes pnpm naive:up      # read the apply report, not the exit code
    pnpm naive:sync                     # agents, vault tokens, webhook
    CREW_TOKEN_SECRET=… pnpm smoke https://<app>

## 4. Seed real activity (team inboxes only)

- `OUTRUN_DEMO=true` keeps every send to the demo inbox.
- Add one client on `/dashboard/clients` (a teammate's company and domain), start profiling,
  confirm the profile.
- Self-serve: a teammate signs a second company up at `/hire` with an email at its domain,
  then signs in from the link. That starts its six agents on Naive.
- One small Hunter run is approved (5–10 results); report its cost.
- `/hire` takes 3 new clients a day and 3 per IP an hour; rehearsal signups count. An unverified
  signup stops counting after an hour, and anyone at that domain can claim it.
- `/ops` counts only real ledger events: `pnpm db:seed` adds none, and a client shows there only
  after its profile is confirmed.

## 5. The 3-minute demo: a client signs up and the CEO runs it until it gets users

1. `/ops` on the projector: the autonomy %, the split between agents, system and humans, spend,
   and the CEO's track record (predictions made, scored, hit rate). Every number is a ledger event.
2. `/hire`: a company hires the agency itself (or an outside agent calls `hire_agency` over MCP
   or A2A). After the sign-in its six core agents appear on Naive, with no one on our side.
3. The goal: the researcher drafts the profile with a goal ("20 interested replies by Dec 15"),
   and the owner confirms it. That is the one human step before work starts.
4. The CEO's day (`naive/skills/ceo.md`):
   - `list_problems`, then it fixes what it may: it replays a dead job, or pauses a client on
     bounces. It never lifts an owner's pause.
   - `client_insights` and `client_goal` against the goal, then `read_playbook`, with lessons from
     similar clients.
   - Its decisions: `set_client_focus`, and `staff_client` to add an account manager, a signal
     scout or an experimenter as the client needs them. Each new agent appears on Naive.
   - `make_prediction` for each decision. `score_predictions` grades it later.
   - The brief, and on Mondays the board memo.
5. The new crew members:
   - The signal scout finds funding or hiring news, so the SDR opens with it.
   - The experimenter runs an A/B angle test. Its lesson goes into the CEO's playbook.
   - The account manager writes the weekly report and answers the client's questions in the
     portal.
6. The portal: the client approves a cited email that goes out from its own domain, reads its
   report, and asks its account manager a question.
7. Goal met: `mark_goal_met` puts the crew in maintenance, and the account manager tells the client.
8. Back to `/ops`: the decisions feed (staffing, predictions and their scores, replays, lessons)
   and "Where a human stepped in".

## 6. Testing on a real client (before or without Vercel and Render)

This runs the whole stack from one laptop, on an https tunnel, against the real Naive. A missing
key falls back to that integration's fake, so add only the keys for what you want to be real.

1. Merge the stack to `main` (step 1); `naive up` runs only from `main`.
2. `.env` (never commit it). Keys you paste yourself:
   - `CREW_TOKEN_SECRET`: `openssl rand -hex 32`, the same value wherever the app runs.
   - `NAIVE_API_KEY` with `agents:write` and `admin`.
   - `OPENAI_API_KEY` or `OPENROUTER_API_KEY` for llm().
   - `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID` and `AGENTMAIL_WEBHOOK_SECRET` for real email.
   - `MONID_API_KEY` for the scout and enrichment (about $0.002 a signal search, $0.20 an enrichment).
   - `ALERT_EMAIL` for the brief and memo, set to the team inbox.
   - `OUTRUN_DEMO=true` keeps every send to the demo inbox. Set it to `false` only for the client's
     own approved sends, once the client has agreed.
3. `ngrok http 3000`. Put the https origin in `APP_URL`.
4. `pnpm db:migrate`, then `pnpm dev` (web plus worker).
5. `pnpm naive:dry-run` and read the plan. Then `OUTRUN_APPLY=yes pnpm naive:up` and `pnpm naive:sync`.
   naive:sync sets the webhook to the tunnel URL.
6. `CREW_TOKEN_SECRET=… pnpm smoke $APP_URL`.
7. The client:
   - It signs up at `$APP_URL/hire` with an email at its own domain, and signs in from the link.
     That provisions its crew.
   - The owner confirms its profile and goal on `/dashboard/clients`.
   - The client adds the DNS records shown in the portal for its sending domain.
8. Watch `/ops`, `/dashboard/agency` and the Naive console. A tunnel URL changes on every restart,
   so after one, update `APP_URL` and rerun `pnpm naive:up` and `pnpm naive:sync`.

## Where a person is still needed, by design

- The owner confirms each client's profile (prices and offer are never set by an agent).
- The client approves each email before it is sent.
- The owner accepts or rejects the CEO's ICP proposals.
- Only the owner lifts a pause the owner made, or one caused by bounces or complaints.
  Everything else, from finding prospects to triaging replies and starting each client's day,
  is the agents and the worker.

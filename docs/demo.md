# Demo day runbook (Nov 8)

Hacking stops at 11:00, demos at 13:00. Judges ask: what did the agents deliver, what did they
decide, and where did a person step in. `/ops` answers all three from the ledger.

## 1. Merge (Srikanth, in this order)

#26 → #27 → #28 → #29 → #30 → #31 → #32 → #33 → #34 → #35 → #36 → #37 (→ this PR).
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

## 5. The 3-minute demo

1. `/ops` on the projector: the autonomy %, the split between agents, system and humans, and
   spend. Every number is a ledger event.
2. `/hire`: a company hires the agency itself (or an outside agent calls `hire_agency` over
   MCP or A2A). After the sign-in, its crew of six appears on Naive with no one on our side.
3. The CEO: its brief, its `set_client_focus` decision, and a `propose_profile_change` with
   numbers. The owner accepts it on `/dashboard/clients`; that is one human step-in on `/ops`.
4. The portal: the client's approver approves a cited email that goes out from the client's own
   domain. That is the other kind of step-in: the client, not us.
5. Back to `/ops`: decisions feed (filed, researched, triaged, self-corrected drafts, CEO kicks),
   and "Where a human stepped in".

## Where a person is still needed, by design

- The owner confirms each client's profile (prices and offer are never set by an agent).
- The client approves each email before it is sent.
- The owner accepts or rejects the CEO's ICP proposals.
Everything else, from finding prospects to triaging replies and starting each client's day,
is the agents and the worker.

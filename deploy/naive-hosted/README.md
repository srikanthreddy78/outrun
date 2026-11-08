# Naive-hosted deployment

Deploys Outrun's core workflow entirely on Naive: no Vercel, Render or Neon accounts. It's
opt-in and separate from the regular deployment in `docs/deploy.md`, which is unchanged.

```sh
NAIVE_HOSTED=1 node deploy/naive-hosted/deploy.mjs all      # first deploy, end to end
NAIVE_HOSTED=1 node deploy/naive-hosted/deploy.mjs up       # redeploy the app after code changes
NAIVE_HOSTED=1 node deploy/naive-hosted/deploy.mjs admin status
```

The Naive key is `NAIVE_HOSTED_API_KEY`, or `NAIVE_TWO_API_KEY` from the root `.env`. The script
refuses the primary account's key and any organization other than the one it first deployed into.

## What it deploys

| Piece                  | Regular deployment       | Naive-hosted                                                                                                                       |
| ---------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Web app (`apps/web`)   | Vercel                   | Naive `fullstack` app `outrun-hosted` (project `outrun-hosted`)                                                                    |
| Postgres               | Neon                     | The app's managed Postgres                                                                                                         |
| Worker (`apps/worker`) | Always-on Render process | `hosted-ticker` agent, every 5 minutes, calls the app's `tick` tool, which runs the same worker for ~30 seconds inside one request |
| Crew                   | Root `naive.config.ts`   | The same root config, applied with `APP_URL` = the hosted app                                                                      |

## How it stays separate

- Everything is in this folder. The pnpm workspace, root `tsconfig.json` and `vitest.config.ts`
  don't include it, and nothing in `apps/`, `packages/`, `naive/`, `scripts/` or the root
  `naive.config.ts` changes.
- `deploy.mjs build` assembles a standalone copy of `apps/web` with `packages/core` and
  `apps/worker` vendored in under `.build/` (git-ignored, deleted after each deploy). Changes for
  Naive are applied to that copy only, and each fails loudly if the repo file has changed shape:
  - `createIntegrations` is wrapped (`integrations-wrapper.ts`): an integration without a key uses
    its fake instead of failing boot, and email is the fake unless `NAIVE_HOSTED_TEST_INBOX` is set,
    in which case only that address may receive mail.
  - Database pools are small (Naive's pooler allows 15 clients in session mode).
  - `naive/crew.ts` is copied in, and the migrations folder is a fixed path.
- `overlay/` adds files that exist only in the hosted build: the Next config, a startup hook
  that makes the database URL work with node-postgres, `/api/hosted/admin` (migrate, seed, tick,
  status, start) and `/api/hosted/mcp` (the ticker's `tick` tool).
- Generated secrets (crew token secret, admin token, auth secret, webhook secret) live in
  `.state.json` here (git-ignored, mode 0600) and are never printed.

## Testing without sending anything

`OUTRUN_DEMO=true` is always on: the crew only works the seeded demo prospect. With
`NAIVE_HOSTED_TEST_INBOX=gykforue6ze1w@agentmail.to`, the seeded prospect's inbox is that address
and the only one mail may reach; see "Testing email" in `AGENTS.md`.

`pnpm smoke <app url>` passes except two checks that are expected to fail here: fakes are in use,
and the Stripe webhook has no secret.

## Known Naive behaviour

Naive holds MCP tool calls it judges may read personal data (`read_people`) for approval even when
the agent's policy is `allow`, for example `outrun.plan_day`, `outrun.get_brief` and
`outrun.enrich_company`. Someone has to approve them in the Studio, or the run waits.

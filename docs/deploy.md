# Deploying Outrun

Srikanth runs these steps. Each one is outward-facing, so it waits for a go. Keys go only
into Vercel env, Render env and the Naive vault, never into git, prompts or chat.

## 1. Neon

- Create the project, a `prod` branch, and one `dev-<name>` branch per person.
- Take the pooled and unpooled connection strings: `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.
- Run `pnpm db:migrate` against prod.
- Run `pnpm db:seed --domain <teammate domain> --name "<company>" --contact "<name>" --inbox <teammate inbox>`.
- Check point-in-time restore in the Neon console.

## 2. Vercel (web, both MCP servers, webhooks)

- Import the repo with Root Directory `apps/web`. `apps/web/vercel.json` sets the install and build commands.
- Production env: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `APP_URL` (https), `NAIVE_API_KEY`,
  `NAIVE_WEBHOOK_SECRET`, `CREW_TOKEN_SECRET`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `STRIPE_SECRET_KEY` (test mode while `OUTRUN_DEMO=true`), `STRIPE_WEBHOOK_SECRET`,
  `AGENTMAIL_*`, `HUBSPOT_ACCESS_TOKEN`, `APIFY_*`, `AUTH_*` and `OUTRUN_DEMO=true`.
- Hobby is non-commercial only. Move to Pro before live Stripe.

## 3. Render (worker)

- New Blueprint from `render.yaml`, which gives one starter background worker and runs migrations before each deploy.
- Fill in the `sync: false` secrets when Render asks for them.

## 4. Stripe

- With a test key in `.env`, run `pnpm stripe:sync --dry-run`, then `pnpm stripe:sync`. It creates both
  products and their prices under the lookup keys `outrun_auditKit` and `outrun_growth` from `PRODUCTS`.
  A live key needs `--live` and Srikanth's go.
- Add a webhook endpoint at `https://<app>/api/webhooks/stripe` for `checkout.session.completed`,
  `checkout.session.expired`, `payment_intent.succeeded`, `charge.refunded`, `invoice.paid` and
  `customer.subscription.deleted`. Put its signing secret in Vercel as `STRIPE_WEBHOOK_SECRET`.
- To rotate the secret, move the old value to `STRIPE_WEBHOOK_SECRET_PREVIOUS`, roll the endpoint's
  secret in Stripe, set the new one, then clear the previous one after a day.
- Locally: `stripe listen --forward-to localhost:3000/api/webhooks/stripe` and `stripe trigger checkout.session.completed`.

## 5. Naive

- Run `pnpm naive:dry-run` and read the plan.
- `OUTRUN_APPLY=yes pnpm naive:up` runs only from `main`. Read the apply report, not the exit code.
- `pnpm naive:sync` sets up agents, the roster check and the webhook. The webhook secret lands in `.naive/webhook-secret`. Copy it into Vercel as `NAIVE_WEBHOOK_SECRET`, then delete the file.

## 6. Check

- Run `CREW_TOKEN_SECRET=… pnpm smoke https://<app>`. It must be green, with no fakes and the webhook secret set.
- With a go, start one real orchestrator session that calls `outrun.ping`. The `tool.called` event shows up in the ledger.
- The team appears on the Studio's Orchestrator page and accepts a goal.

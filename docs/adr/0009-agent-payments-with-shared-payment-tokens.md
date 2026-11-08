# 0009. Agent payments with Stripe Shared Payment Tokens, behind a constant

- Status: accepted (built, off)
- Date: 2026-11-07
- Follows: 0006

## Decision

A buyer agent can pay for an Audit + Kit with a Stripe Shared Payment Token (SPT), the scoped grant
an agent issues to our Stripe profile. We create and confirm a PaymentIntent with
`payment_method_data[shared_payment_granted_token]` on the `2026-09-30.preview` API version, at the
PRODUCTS price, keyed `spt:<orderId>`, with `orderId` in its metadata. The order becomes paid when
`payment_intent.succeeded` arrives, the same webhook path Checkout uses, so the order state machine
has one way in.

It sits behind `AGENT_PAYMENTS_ENABLED` (false), because the account must first:

- accept the agentic commerce seller terms and have a Stripe profile (Dashboard), and
- be in a supported country (US, CA and most of Europe).

Growth stays on Checkout: a recurring SPT needs `usage_limits.recurring_interval` and off-session
charges, which we'd only take on once a buyer agent asks for it.

Exposing the token on `buy_audit` adds an optional `sharedPaymentToken` to `PUBLIC_TOOLS`, a contract
change, so it is a separate PR that all three approve.

## Consequences

- Solves: an agent with an SPT pays without a browser or a person.
- Worsens: a preview API version on one call, and a second way to pay to watch in the ledger.
- The token never reaches the ledger; `order.agent_payment_submitted` carries the PaymentIntent id.

## Test before turning it on

1. In a sandbox, mint a token with
   `POST /v1/test_helpers/shared_payment/granted_tokens` (`payment_method=pm_card_visa`,
   `usage_limits[currency]=usd`, `usage_limits[max_amount]=49900`, `usage_limits[expires_at]=…`).
2. Pay a pending order with it and watch the webhook mark it paid and start the audit.
3. Live: `npx @stripe/link-cli spend-request create --credential-type shared_payment_token` against
   our profile, for a small amount, on the team's go.

## Revisit when

Stripe enables SPTs on the account, or a buyer agent pays another way (machine payments, x402).

# 0006. Stripe Checkout first, agent payments second

- Status: accepted
- Date: 2026-11-07
- Source: docs/plan.md, Decisions #6

## Decision

Stripe Checkout first, for humans and agents; agent payments (Shared Payment Tokens or machine payments) second

## Consequences

- Solves: Works today with no special access
- Worsens: Two payment paths later

## Revisit when

A buyer agent can pay without a browser, and does

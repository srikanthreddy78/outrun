# 0005. Postgres is the source of truth, HubSpot a one-way mirror

- Status: accepted
- Date: 2026-11-07
- Source: docs/plan.md, Decisions #5

## Decision

Postgres is the source of truth; HubSpot is a one-way mirror

## Consequences

- Solves: State and idempotency stay in our DB; a HubSpot outage doesn't stop the loop
- Worsens: Sync code to maintain

## Revisit when

People start working deals in HubSpot: two-way sync

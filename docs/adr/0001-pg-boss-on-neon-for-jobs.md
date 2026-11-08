# 0001. pg-boss on Neon for jobs

- Status: accepted
- Date: 2026-11-07
- Source: docs/plan.md, Decisions #1

## Decision

pg-boss on Neon for every deterministic job: retries with backoff, cron, dedup keys, dead-letter

## Consequences

- Solves: No hand-rolled queue and no extra service; jobs enqueue in the same DB transaction
- Worsens: Polling load on Postgres

## Revisit when

Over \~50 jobs/s, or 3+ consumers: move to SQS

# 0004. Render worker plus Vercel web

- Status: accepted
- Date: 2026-11-07
- Source: docs/plan.md, Decisions #4

## Decision

Render worker for jobs and cron; Vercel for pages, MCP servers and webhooks

## Consequences

- Solves: No serverless time limits on jobs; webhook routes stay fast
- Worsens: One more deploy; a single worker is a single point of failure (leased jobs resume)

## Revisit when

Spiky load, or the move to AWS

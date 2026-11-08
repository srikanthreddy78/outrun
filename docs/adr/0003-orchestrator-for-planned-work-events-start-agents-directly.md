# 0003. Orchestrator for planned work, events start agents directly

- Status: accepted
- Date: 2026-11-07
- Source: docs/plan.md, Decisions #3

## Decision

Planned work goes through the Orchestrator; events start one agent directly (a reply starts the closer, a payment starts the auditor)

## Consequences

- Solves: Events are handled quickly and cheaply, and the Orchestrator still sees every outcome through `outrun.pipeline_status`
- Worsens: Two entry points to reason about

## Revisit when

The Orchestrator needs to reprioritize events as they happen

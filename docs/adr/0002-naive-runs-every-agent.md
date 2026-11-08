# 0002. Naive runs every agent

- Status: accepted
- Date: 2026-11-07
- Source: docs/plan.md, Decisions #2

## Decision

Naive runs every agent; our app is their system of record and their tool server

## Consequences

- Solves: Required for the hackathon; budgets, approvals, schedules, the audit log and model routing come built in, so we build no agent runtime
- Worsens: Agent output varies from run to run and spends Naive credits; tools must sit at a public HTTPS URL

## Revisit when

A step must give the same output every time: make it a job or an in-app `llm()` call

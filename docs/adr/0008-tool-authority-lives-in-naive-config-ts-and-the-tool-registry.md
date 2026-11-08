# 0008. Tool authority lives in naive.config.ts and the tool registry

- Status: accepted
- Date: 2026-11-07
- Source: docs/plan.md, Decisions #8

## Decision

Tool authority lives in two committed places: `naive.config.ts` says who may call each tool and what needs approval (Naive enforces it), and the tool registry says what each tool may do (our server enforces it)

## Consequences

- Solves: Least privilege at both ends; nobody widens an agent's reach without a reviewed PR
- Worsens: Two lists to keep in step; `naive.config.test.ts` fails when they drift

## Revisit when

Naive ships custom function tools

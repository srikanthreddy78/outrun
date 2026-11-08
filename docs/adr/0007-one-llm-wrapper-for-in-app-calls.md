# 0007. One llm() wrapper for in-app calls

- Status: accepted
- Date: 2026-11-07
- Source: docs/plan.md, Decisions #7

## Decision

One `llm()` wrapper for in-app calls only (reply triage, Kit writing): OpenAI gpt-5.5 for smart work, OpenRouter for bulk and fallback

## Consequences

- Solves: Cheap, testable calls stay out of agent sessions; cost per audit is measurable
- Worsens: One wrapper to maintain

## Revisit when

Naive's model routing does these calls for less

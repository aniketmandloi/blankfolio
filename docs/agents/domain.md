# Domain docs

This repo uses a single-context layout:

- CONTEXT.md at the repo root: domain concepts and glossary.
- docs/adr/: architecture decision records.

## Before exploring

Read CONTEXT.md and ADRs relevant to the area being explored.

If these files are absent, proceed silently. Domain documentation
is created lazily by the domain-modeling skill as terms and decisions
are resolved.

## Vocabulary

Use the glossary's terms in issue titles, proposals, hypotheses,
and tests. If a needed concept is missing, reconsider the terminology
or note the gap for domain-modeling.

## ADR conflicts

When a proposal contradicts an existing ADR, identify that ADR
and explain why its decision should be reconsidered.

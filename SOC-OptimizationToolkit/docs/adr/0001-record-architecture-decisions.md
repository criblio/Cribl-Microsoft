# 1. Record architecture decisions

Date: 2026-06-22

## Status

Accepted

## Context

SOC-OptimizationToolkit is a greenfield consolidation of a large, previously undocumented codebase
(two trees, ~75k LOC, no architecture docs, no recorded decisions). The decisions that shape it —
the language, the layering, how the old code is migrated, how the Cribl client is owned — are
exactly the things a future engineer or an AI agent will need to understand before making a change,
and exactly the things that are expensive to reverse. We need a durable, reviewable decision log
that lives with the code.

## Decision

We record architecture decisions as Architecture Decision Records (ADRs) in the style described by
Michael Nygard.

- ADRs live in `docs/adr/` as numbered Markdown files: `NNNN-title-in-kebab-case.md`.
- Each ADR has the sections: Title, Date, Status, Context, Decision, Consequences.
- Status is one of: Proposed, Accepted, Deprecated, Superseded (with a link to the superseding ADR).
- ADRs are immutable once Accepted: we do not rewrite history. To change a decision, we add a new
  ADR that supersedes the old one.
- A decision is significant enough to warrant an ADR if it affects structure, dependencies, the
  build, the test strategy, the migration sequence, or a public contract.

## Consequences

- The "why" behind the structure is auditable and survives staff turnover and context resets.
- There is a small per-decision authoring cost, accepted deliberately.
- `CONTEXT.md` links to the ADRs rather than restating them, so the rationale has one home.

# Model-Assisted Mapping Improvement (Fable 5)

Status: CORRECTED 2026-07-08. The original version of this document planned a
RUNTIME LLM integration (an LlmAssist port calling the Anthropic API from the
app). That was a misreading of the intent and was built, then fully reverted -
THE APP MUST NOT USE OR CALL AN LLM.

## The actual intent

Use the Fable 5 model at DEVELOPMENT time - as the engineer working on this
repo - to improve the DETERMINISTIC DCR-to-sample-field mapping: better alias
knowledge, better matching heuristics, better type handling, all expressed as
pure, tested code in `@soc/core`. The app stays fully deterministic and
offline-capable; the model's knowledge enters the product only as reviewed,
pinned source code.

## Where the mapping intelligence lives

- `packages/core/src/domain/field-matcher/` - the 6-phase matcher that
  resolves each sampled source field against the destination table schema
  (exact, alias, fuzzy, ... -> keep/rename/coerce/drop/overflow).
- Its alias knowledge base - the curated source-name -> destination-column
  pairs (e.g. `src` -> `SourceIP`) that phase 2 consumes.
- `packages/core/src/domain/gap-analysis/` - the DCR-vs-Cribl split and the
  per-table GapReport the mapping review renders.

## Improvement approach (dev-time, iterative)

1. Take a real solution's samples (e.g. PAN-OS TRAFFIC/THREAT) and inspect
   which fields land in overflow/unmatched in the gap analysis.
2. Encode the missing vendor knowledge as deterministic rules: expanded alias
   tables (CEF keys, PAN-OS CSV headers, common syslog fields ->
   CommonSecurityLog / SecurityEvent / Syslog columns), normalization tweaks
   (case/underscore/prefix folding), and type-aware tie-breaking.
3. Pin every addition with characterization tests so vendor knowledge cannot
   regress silently.
4. Repeat per vendor as solutions are exercised live.

Nothing in this flow ships a network call, a key, or a prompt.

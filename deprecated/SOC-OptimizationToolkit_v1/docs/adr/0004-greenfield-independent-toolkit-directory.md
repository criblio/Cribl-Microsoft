# 4. Greenfield, independent toolkit directory

Date: 2026-06-22

## Status

Accepted

## Context

We are consolidating two mature, working trees into one product. There is a spectrum of how the new
work can relate to the old code: edit it in place; relocate/copy it into a new structure; or build a
new structure fresh and migrate logic into it. The owner wants the new solution to be **completely
independent of the old directory structure**, housed in **one new top-level directory at the repo
root**, so that success is a clean cut-over and failure is a single folder deleted — with no
entanglement that makes either outcome messy.

## Decision

All new work lives in one new top-level directory at the repo root: `SOC-OptimizationToolkit/`. It is
built **greenfield** and is **self-contained from day one** with no runtime dependency on the rest of
the repository.

- Capabilities are **ported by reimplementation, file by file**, copying logic FROM the existing
  `Cribl-Microsoft_IntegrationSolution/` and `Azure/` trees as the behavioral reference. Nothing is
  bulk-moved or bulk-copied into the new tree, and there is no `legacy/` folder inside it.
- The existing trees are **never modified** by work in this directory. They remain the running
  product and the behavioral reference.
- The new tree's `packages/core/assets/` does take copies of pure data (the ~100 ARM templates),
  since those are language-agnostic assets, not logic.
- The old trees are retired only at **promotion**, once this tree reaches parity (see
  [roadmap.md](../roadmap.md) Phase 6).

## Consequences

- The new tree can be evaluated, built, and tested in isolation; deleting it leaves the repository
  exactly as it was.
- During the build-out the old app stays the fallback (see
  [ADR 0006](0006-strangler-fig-with-old-app-as-fallback.md)), so there is no flag day.
- The cost is duplicated logic during the transition (old and new implementations coexist) and the
  risk of the two trees drifting. We mitigate drift by freezing the old tree as a read-only reference
  and pinning behavior with characterization tests at the moment of porting (see
  [testing-strategy.md](../testing-strategy.md)).
- "Port file by file" is deliberately not "transliterate": where the legacy code shells PowerShell
  (e.g. the Azure deploy path), the new implementation is net-new against the Azure SDK with the
  PowerShell as the behavioral spec.

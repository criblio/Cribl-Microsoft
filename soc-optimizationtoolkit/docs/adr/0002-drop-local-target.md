# ADR 0002: Drop the local target; ship the Cribl-hosted app only

Date: 2026-08-17
Status: Accepted
Supersedes, in part: ADR 0001 (dual-target architecture)

## Context

ADR 0001 committed to two deployment targets from one shared codebase, so that
customer-managed (on-prem) Cribl customers would not be excluded. Both shells
shipped: apps/cribl-app in the Cloud, apps/local-app as a zero-runtime-dependency
Node host serving the same @soc/ui screens through six local adapters (Phase 1
exit, 2026-07-03).

What changed is not the reasoning in ADR 0001 - it is what the work since has
actually gone into. Every feature since the walking skeleton has been driven,
demonstrated and validated against the Cloud shell. The local host kept
building, but it was carried, not used: it was still running in the background
from an earlier session when this decision was executed, on a config file that
had gone stale.

The standing "parity gates legacy archival" rule made that carrying cost
permanent and load-bearing - it blocked archival of the legacy tree on a target
nobody was exercising.

## Decision

Ship ONE target: apps/cribl-app on Cribl.Cloud. Remove apps/local-app and the
`npm run local` script.

What this decision does NOT do:

- It does not collapse the port seam. @soc/core still talks to ports and
  @soc/ui still consumes them through PortsContext. That seam is why this
  removal touched no screen and no use-case - deleting the second shell was 31
  files and four comments, not a refactor. Keep it that way; it is what makes a
  second target cheap again if one is ever wanted.
- It does not remove the wizard's target chooser or leader-connect step. Those
  stay, dormant, because they are the only asset that would onboard a
  customer-managed leader if Cribl Apps ever run off Cloud. cribl-app passes
  initialTarget "cribl-hosted" with lockTarget, so neither is reachable today.
- It does not rewrite the dated decision records in feature-catalog.md,
  porting-plan.md or roadmap.md. Those explain WHY two targets were planned and
  what was learned; erasing them invites re-litigating a settled question.
  Forward-looking gates and future units WERE corrected - an instruction that
  still tells a future reader to build for both shells is a defect, not history.

## Consequences

- On-prem Cribl customers are not served by this toolkit. That is the real cost
  of this decision and it should be stated plainly rather than discovered: the
  air-gapped story reverts to the Cloud-target answer in feature-catalog.md
  (generate and download artifacts on the connected side, carry them across).
- The parity gate is retired. Legacy archival now depends on Cloud-shell
  coverage alone.
- The local host's outbound allowlist leaves the external-surface rule;
  proxies.yml/policies.yml remain the only declarations.
- apps/local-app/config/ and apps/local-app/data/ were gitignored local state,
  never committed. They were MOVED (not deleted) to
  ~/.soc-toolkit-local-app-retired/ because config/local-config.json held a live
  Azure client secret. That secret was already flagged for rotation and this
  decision does not change that - rotate it.

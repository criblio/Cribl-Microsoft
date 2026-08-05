# Capability model: retiring app modes

Status: PLAN. Decision taken 2026-08-05; no code moved yet.

## The decision

Retire the four app modes (`full`, `azure-only`, `cribl-only`, `air-gapped`).
The app always runs in what is today "full" mode. What an operator can actually
do is derived from an **audit of the Azure App registration's real permissions**
(and the equivalent Cribl capabilities), and the navigation adapts to that audit.

Two rules stated by the user, both binding:

1. **The menu calls out what you can and cannot do - it does not hide it.** An
   operator who declines every permission is still in "Full" mode. They see the
   whole product and are told, per item, what is unavailable and why.
2. **Every blocked action falls back to "download the thing you'd need someone
   else to run."** This is the general pattern, not a DCR special case.

## Why this is mostly rewiring

The modes were always a **proxy for capability**. This replaces the proxy with
the real measurement. Three pieces already exist and must not be rebuilt.

**The audit exists.** `usecases/permission-preflight` performs effective-action
checks and reports GRANTED/MISSING per action, at exactly the granularity the
menu needs: Create/update DCRs, Create custom tables, Deploy ARM templates, List
Data Collection Rules, Read Log Analytics workspace, List workspace tables, plus
the Cribl side (manage packs, destinations, sources, routes). Today it is
informational only - it reports access and gates nothing.

**The ARM fallback exists.** `templateOnly` already performs zero ARM writes,
collects every request body, and delivers them as one deterministic JSON artifact
through the `ArtifactSink` port. It is currently forced on by MODE (azure-only
forces it, because no live Cribl connection exists). The change is to force it
from a permission verdict instead.

**The change-request fallback exists.** `domain/change-request` generates
paste-ready tickets - `appRegistrationRequest`, `roleAssignmentRequest`,
`resourceCreationRequest` - rendered by `ChangeRequestBlock`. Today they are
triggered by hand.

So the work is: measure, then route each gated action to one of three outcomes -
do it, download the artifact, or generate the request.

## The model

### Capability

One capability per thing the product can attempt, named for the ACTION rather
than the role that grants it (role names are decoration; effective-action checks
are the truth - the preflight already says so).

Azure: `dcr.write`, `table.write`, `arm.deploy`, `dcr.read`, `workspace.read`,
`table.read`, `role.assign`. Cribl: `pack.manage`, `destination.manage`,
`source.manage`, `route.manage`.

### CapabilityVerdict

`granted` | `denied` | `unknown`. `unknown` is load-bearing and must never
collapse into `denied`: "we have not measured" and "we measured and you cannot"
are different facts, and this codebase does not render the first as the second
(see the `informational` section status and the readiness-pill rules for the
same discipline applied elsewhere).

### CapabilitySet

The audit result, plus `auditedAt` and the connection identity it was measured
against. Cached per connection - a different App registration is a different
answer.

## What replaces each mode contract

| Today | Becomes |
| --- | --- |
| `AppMode` union + `appMode` KV entry | Deleted. No persisted mode. |
| `hasAzure(mode)` / `hasCribl(mode)` | `can(capabilities, "dcr.write")` etc. |
| `AppRoute.requires: 'none'\|'azure'\|'cribl'\|'both'` | `requires: Capability[]` |
| `filterNavItems(mode, routes)` - hides items | `annotateNavItems(capabilities, routes)` - returns every item with an availability verdict and a reason |
| `ModeSelect` + `EMPTY_MODE_RECORD` + Reconfigure | Deleted. Reconfigure becomes "re-run the permission audit". |
| SetupWizard Mode step, `recommendMode`, `modeCards`, `WizardShape.mode` | Deleted. The wizard ends on the audit result instead of a mode choice. |
| `JourneyFacts.mode`, mode-filtered `deriveJourney` arcs | Arc stages filtered by capability. |
| `integrate-arc` section `requires` | Same `Capability[]` shape. |
| `canDeploy` / `canDeployContentPath` | Gain a capability dimension: the deploy is offered only when `dcr.write` is granted, and otherwise offers the artifact. |

`filterNavItems` disappearing is the substantive change: the frame currently
hides what the mode cannot use, and the new rule is the opposite.

## Fallback per blocked action

Every gated action has a defined "someone else runs this" output. Nothing may be
merely disabled.

| Blocked capability | Fallback |
| --- | --- |
| `dcr.write` | Download the DCR ARM request bodies (the existing `templateOnly` artifact) |
| `table.write` | Download the custom-table ARM PUT bodies |
| `arm.deploy` | Download the assembled ARM template |
| `role.assign` | Generate the role-assignment change request (`roleAssignmentRequest`) plus the `az` CLI command already produced today |
| identity absent entirely | Generate the app-registration change request (`appRegistrationRequest`) - already inline in the wizard's Azure step |
| Cribl `pack.manage` | Download the built `.crbl` for manual upload |

The read capabilities (`dcr.read`, `workspace.read`, `table.read`) have no
fallback: without them, discovery genuinely cannot run, and the honest UI is to
say so rather than invent an offline substitute.

## Open decisions

These are not settled and must be before code moves.

**1. Pre-audit state.** What does the menu show before any audit has run - on
first launch, with no credentials? `unknown` everywhere is honest and matches the
codebase's no-false-ok rule, but reads worse than "connect Azure to unlock
these". This decides the default of every menu item, so it is the first to
settle.

**2. Audit staleness.** Permissions change server-side. Cache per connection and
re-run on demand, or re-audit every launch? There is a proxy request-budget cost
either way (the platform allows ~100 req/min shared with the status pollers).

**3. Cribl symmetry.** Once `cribl-only` and `air-gapped` disappear, does the
Cribl side get identical annotate-don't-hide treatment? The preflight already
measures it, so the data exists; the question is whether the rule is universal.

## Sequencing

1. **Capability domain in core** - the taxonomy, `CapabilitySet`, `can()`, and
   the mapping from preflight results to capabilities. Pure, fully tested, no UI.
2. **Audit lifecycle** - when it runs, where it is cached, how it invalidates on
   connection switch. Settles open decisions 1 and 2.
3. **Nav annotation** - `annotateNavItems` plus the frame rendering. Replaces
   `filterNavItems`. This is where the visible behaviour changes.
4. **Fallback routing** - each blocked action wired to its artifact per the table
   above.
5. **Mode removal** - delete `AppMode`, `ModeSelect`, the wizard Mode step, and
   the persistence. Last, so every consumer has already moved.

Steps 1-2 are safe to land while modes still exist; the model can be computed and
displayed before it gates anything.

## Test strategy

The mode contracts are pinned across many tests, and **those pins are the
specification**. Each one must be read and deliberately re-pinned against the
capability model rather than deleted to make a suite pass. Known pin sites:
`frame-state`, `stepper-state`, `journey-state`, `integrate-arc`,
`first-run-wizard`, `setup-wizard-state`.

Two invariants worth pinning early:

- No route is ever hidden by capability. Every route appears; only its
  availability annotation changes.
- `unknown` never renders as `denied`, and a blocked action always names its
  fallback artifact.

## Scope

Roughly 14 non-test files couple to `AppMode` / `filterNavItems` / `hasAzure` /
`hasCribl`, across `packages/core`, `packages/ui`, and both shells.

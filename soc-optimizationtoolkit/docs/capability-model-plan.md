# Capability model: retiring app modes

Status: IMPLEMENTED. Decision taken 2026-08-05; all five steps shipped
2026-08-06 (see `backlog.md` section 1, which is the accurate record). Modes are
gone: `AppMode`, `ModeSelect`, `filterNavItems` and the wizard's Mode step no
longer exist, and the nav annotates rather than filters.

Two follow-ons from the plan are NOT built, and this doc is the only place that
says so:

- **Rule 2 - "every blocked action falls back to a downloadable artifact" - is
  not clickable.** `FallbackNotice` has exactly one production render site
  (`screens/preflight/rbac-preflight-panel.tsx`) and it is rendered WITHOUT
  `onProduce`, so no button appears. Every `onProduce` in the repo is in a test.
- **The audit's age has no home and there is no manual re-check**; neither has a
  production consumer.

Also unmodelled: Resource Graph, subscriptions, resource groups and Cribl worker
groups have no capability in the 11-item taxonomy. Backlog section 6 records
that extending the taxonomy is ONE piece of work serving three separate items -
do that rather than reusing a neighbouring capability.

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
3. **The audit informs and offers - it never forbids.** A `denied` verdict
   annotates the item and offers the fallback artifact, but the action stays
   attemptable. Azure's own 403 is the real gate. This is the most consequential
   rule in the model: it makes a stale or wrong audit an inconvenience rather
   than a blocker, and it is why the caching strategy below can be relaxed.

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

## Decisions taken 2026-08-06

**1. Pre-audit state: derive it from identity, do not pick one default.**

The original framing was wrong - it treated this as one choice trading honesty
against usability. There are TWO pre-audit states and they deserve different
copy:

- **No identity configured** (no tenant, no client id): we KNOW nothing Azure
  can work. "Connect Azure to enable" is a fact about the connection, not a
  claim about permissions, so there is no honesty problem.
- **Identity present, audit not yet run**: genuinely `unknown`, and says so.

This mirrors `JourneyFacts`, which already separates `identityPresent` from
`secretLive: 'live' | 'unknown' | 'missing'` - the codebase already distinguishes
"absent" from "not yet proven". Capabilities inherit that discipline.

**2. Audit staleness: cache per connection, refresh on events.**

Re-audit on connection switch, scope commit, and secret re-entry. Surface the
audit's age and offer a manual refresh. Do NOT re-audit every launch - that taxes
the shared ~100 req/min proxy budget every session for something that changes
rarely. This is only safe because of rule 3 above: a stale audit cannot block
work, so the cost of being slightly out of date is an annotation, not a wall.

**3. Cribl symmetry: yes, identical treatment.**

The Cribl side gets the same annotate-don't-hide rule, the same four-value
verdict, and the same fallback obligation. Without it, the operators who used to
live in `cribl-only` and `air-gapped` lose their honest signal entirely when
those modes disappear. The preflight already measures Cribl capabilities (manage
packs, destinations, sources, routes), so no new probing is needed.

One asymmetry to absorb: in the cloud shell Cribl capability is granted by the
platform via `policies.yml`, whereas the local shell connects out to a leader.
So the MEASUREMENT source differs per shell while the PRESENTATION is identical -
exactly how `criblDeploymentType` and the platform-link poll are already handled.
`CapabilityContext.criblReachable` is the seam: each shell supplies it from what
it already knows, and nothing downstream needs to care which shell it is.

All plan decisions are now settled. Step 1 (the capability domain) shipped in
56e909f; steps 2-5 are unblocked.

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

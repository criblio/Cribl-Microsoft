# Backlog

Carried forward from the session ending 2026-08-06 (last commit `4eb4c57`).
Each item states enough context to be picked up cold. Ordered by priority within
each group.

## 1. Capability model - steps 2 to 5

Design is settled. See [capability-model-plan.md](capability-model-plan.md);
every open decision in it is now closed. Step 1 (the pure domain) shipped in
`56e909f` and nothing consumes it yet.

**Step 2 - audit lifecycle.** Where a `CapabilitySet` is cached, and when it
refreshes. Decided: cache per connection, re-audit on connection switch, scope
commit, and secret re-entry; surface the audit's age with a manual refresh; do
NOT re-audit every launch. Blocked on nothing.

**Prerequisite for step 2 - preflight mapping.** Deliberately deferred in step 1:
mapping `usecases/permission-preflight` results onto the `Capability` values. It
needs that usecase's result shape, which is why it was left as a clean seam
rather than guessed. Mechanical once the shape is in hand. Do this first.

**Step 3 - nav annotation.** `annotateNavItems(capabilities, routes)` replacing
`filterNavItems(mode, routes)`, and `AppRoute.requires` becoming
`Capability[]`. This is where behavior visibly changes: today the frame HIDES
what the mode cannot use, and the new rule is the opposite - every route
appears, annotated with what is unavailable and why. Highest-risk step.

**Step 4 - fallback routing.** Each blocked action wired to its downloadable
artifact per the plan's table. Most of the machinery exists: `templateOnly`
already collects ARM request bodies into one artifact, and `domain/change-request`
already generates paste-ready tickets. They are currently triggered by mode or by
hand; the work is triggering them from a permission verdict.

**Step 5 - mode removal.** Delete `AppMode`, `ModeSelect`, the `appMode` KV
entry, the SetupWizard Mode step, `recommendMode`/`modeCards`, and the
`hasAzure`/`hasCribl` predicates. Last, so every consumer has already moved.

**Test note that applies to all of the above.** The mode contracts are pinned
across at least six state modules (`frame-state`, `stepper-state`,
`journey-state`, `integrate-arc`, `first-run-wizard`, `setup-wizard-state`), and
**those pins are the specification**. Each must be read and deliberately
re-pinned against the capability model, never deleted to make a suite pass.

## 2. Verification gaps

**First-run wizard as a genuine first run.** The reordered cloud wizard
(GitHub-first, no target/upload steps, change-request generator inline) was only
ever seen via a temporarily forced branch in `App.tsx`, not by actually
onboarding. Everything else from the session has been confirmed on screen.

**The bug-triage workflow has never run.** `.github/workflows/bug-triage.yml`
fires daily at 07:00 UTC or on demand. First execution creates three labels
(`triage/tracker`, `triage/approved`, `triage/rejected`) and opens the tracker
issue. A read-only dry run - fetch and render without writing - is worth doing
first to see the output before anything is created in the repo.

## 3. Release hygiene

**Release drift will recur.** Nothing ties `release/` to source changes;
`npm run package` is manual. The committed artifact silently fell five days and
four commits behind before anyone noticed. Cheapest fix that does not need write
access to a protected branch: a CI check that warns when `soc-optimizationtoolkit/**`
source changed without a version bump since the last packaged release.

**1.3.0 is already behind.** It predates the "Start over" removal (`a8b7ba1`),
the pack-embedded breaker fix (`7890f6c`), and the capability domain
(`56e909f`). Next package should be at least 1.3.1.

## 4. Copy and UX

**"reset when the solution changes" understates deletion.** The Sample Data
helper text says the sample, mapping and coverage sections "reset" when the
solution changes. They are DELETED - `handleSolutionChange` removes every tagged
sample from the store. The deletion is correct and intended (samples are
solution-scoped); the wording is what misleads. Saying "are deleted" would match
the behavior.

**Nested scrolling on tall pages.** The 558-row solution list scrolls inside a
scrolling page inside the app iframe. `overscroll-behavior: contain` stops the
wheel chaining at the list's end, but the three-level nesting remains.

## 5. Diagram fidelity

**Inline breaker rulesets are not named.** The spec's
`EventBreakerExistingOrNewExisting` carries `existingRule` - the ruleset name -
for sources that pick one inline (the REST-collector pattern). The current
classification reads `breakerRulesets`, which is what `/system/inputs` returns
today, so an inline reference shows as "Default selection" rather than naming
the rule. Worth surfacing.

**`InputRest` has no schema** under that name in the vendored OpenAPI spec, so
the REST collector is modelled elsewhere - likely `InputCollection` with a
collector conf. Pin this down before relying on collector breaker classification.

**Re-derive `BREAKER_CONFIGURABLE_INPUT_TYPES` when the spec is re-vendored.**
It is the 19 `Input*` schemas carrying a breaker property, out of 68, extracted
from `packages/core/assets/cribl-openapi.json`. Derived, not hand-written - do
not edit it by hand.

## 6. Explicitly not doing

**Live capture.** `POST /system/capture` supports `level` 0-3 (before
pre-processing pipeline / before Routes / before post-processing pipeline /
before Destination), which would map onto diagram nodes for a before/after view.
Deferred by decision on 2026-08-05: it returns real customer data, and
everything else this app does is config-level. Note there is no capture level
before event breaking, so it could never show the before/after of that stage.
Revisit only with a deliberate decision about display, retention, and whether
anything is written to the KV store.

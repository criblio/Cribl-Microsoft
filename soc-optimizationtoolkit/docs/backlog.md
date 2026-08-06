# Backlog

Carried forward from the session ending 2026-08-06 (last commit `4eb4c57`).
Each item states enough context to be picked up cold. Ordered by priority within
each group.

## 1. Capability model - steps 2 to 5

Design is settled. See [capability-model-plan.md](capability-model-plan.md);
every open decision in it is now closed. Step 1 (the pure domain) shipped in
`56e909f` and nothing consumes it yet.

**Step 2 - audit lifecycle. DONE (2026-08-06).** The pure policy
(`domain/capabilities/audit-lifecycle` - the audit key, the trigger rules, age
reporting with no time-based expiry), the persistence codec, the
`usecases/capability-audit` orchestration, the `useCapabilityAudit` hook, and
both shells mounting it. The audit key IS a `CapabilitySet`'s `connectionId`, so
`isSetForConnection` stays the single invalidation rule. The preflight panel
feeds the same cache rather than measuring beside it.

Verified in the live preview against real Azure: 10 capabilities measured (three
writes from effective actions, three reads from probes, four Cribl), with
`role.assign` correctly absent because the existing-rg path never checks it. A
page load costs one cache read and no Azure requests.

Two defects that only the live run exposed, both fixed - worth knowing because
the same shapes will recur in steps 3-5:

- **Auditing before the store hydrates poisons the cache.** The key from an
  empty config is a different key, so the result cached under it, and on the
  next launch the unhydrated audit overwrote the cache before the hydrated one
  could use it. The cache never hit. Hence the hook's `ready` gate - any future
  consumer reading capabilities during hydration needs the same discipline.
- **`secret-entry` must come from the operator path only.** It was fired from
  `handleSecretSaved`, which also runs when the one-shot session probe merely
  confirms an already-stored secret - so it re-measured every launch under a
  different trigger name. It now fires from `connectAzure`.

Deliberately not done: surfacing the audit's age. It belongs with the first
surface that DISPLAYS capabilities (step 3's nav annotation); on the preflight
panel, which re-measures on arrival, it would only ever read "just now".

**Prerequisite for step 2 - preflight mapping. DONE (2026-08-06).**
`usecases/permission-preflight/capability-mapping.ts` projects a
`PermissionReport` onto a `CapabilitySet`. Three rules decide every verdict and
are pinned by tests: writes come only from effective actions (no probe can ever
grant one - the Reader-not-deployable pin restated in capability terms); reads
come from probes first, since a 2xx GET outranks the RBAC evaluation and a 403
does too; and only measurements are recorded, so an unread permissions API
contributes nothing rather than passing its conservative `granted:false` checks
through as `denied`. It lives in `usecases/` because the dependency only points
one way. Step 2 is now unblocked with nothing outstanding.

**Step 3 - nav annotation. DONE (2026-08-06).** `annotateNavItems` replaces
`filterNavItems`, `AppRoute.requires` is `Capability[]`, and the frame renders
every route with a flag and a reason. Nothing is hidden and nothing is disabled -
a denied route stays clickable, pinned by DOM tests over the frame (which had no
direct coverage before this).

Per-route capabilities live in ONE shared `ROUTE_CAPABILITIES` map rather than in
each shell's route table, so the two shells cannot disagree about what an
operator can do. Two routes deliberately depart from their old coarse value, and
both are worth remembering:

- **`preflight` was `azure`, now `[]`.** It is the screen that RUNS the audit, so
  gating it on permissions is circular - an operator whose audit says "no access"
  would find the one screen that could correct that finding flagged unavailable.
- **`eventhub-discovery` was `azure`, now `[]`** - see the taxonomy gap below.

**Taxonomy gap: Resource Graph reads.** Event Hub discovery reads through Azure
Resource Graph, and the settled 11-capability taxonomy has nothing covering it.
Mapping it onto `workspace.read` or `dcr.read` would MISREPORT what was checked,
so the route is unconstrained and the screen keeps reporting its own errors. Two
honest options when someone picks this up: add a `resourcegraph.read` capability
(and a preflight probe for it), or accept that discovery-only surfaces stay
unannotated. Do not quietly reuse a neighbouring capability.

**Not yet done in step 3:** the audit's AGE and a manual re-check still have no
home. The nav was the intended surface for it, and annotating individual items
turned out to be the wrong place for a global "checked 5 minutes ago" line - it
belongs in the frame footer or the connection bar, next to the existing
secret/target/platform-link chips.

**Step 4 - fallback routing.** Each blocked action wired to its downloadable
artifact per the plan's table. Most of the machinery exists: `templateOnly`
already collects ARM request bodies into one artifact, and `domain/change-request`
already generates paste-ready tickets. They are currently triggered by mode or by
hand; the work is triggering them from a permission verdict.

**Step 5 - mode removal. PART 1 DONE (2026-08-06).** The journey no longer
branches on mode: `JourneyFacts.mode` gone, `choose-mode` gone as a stage, the
arc never pruned, chips always rendered. Four pins assert the opposite of what
they used to and say so at the assertion.

**Remaining, in dependency order.** Each slice must span core + ui + shells to
keep the tree compiling - that is what makes them slices rather than one sweep.

1. **`first-run-wizard` + the UI setup wizard.** Attempted and REVERTED rather
   than left half-done; the findings are worth keeping:
   - Core is the easy half: delete the mode auto-selection matrix
     (`MODE_REQUIREMENTS`, `recommendMode`, `modeCards`, `MODE_COPY`,
     `WIZARD_MODE_ORDER`, `ModeCard`), drop `"mode"` from `WizardStepId` and
     `WizardPhase`, drop `WizardShape.mode`, and make both connect steps always
     show. Their skippability is what makes that safe.
   - `wizardViews` places the preflight view *before* the mode step today. With
     mode gone the natural anchor is LAST, which also reads better: verify
     access, then Get Started.
   - `deriveGetStarted` loses two of its three conditions - reaching the final
     view becomes the whole gate. `GET_STARTED_NO_MODE_REASON` and
     `GET_STARTED_MODE_UNAVAILABLE_REASON` go with them.
   - The long tail is `setup-wizard-state.test.ts`, which pins view LISTS
     containing `"mode"`, plus `setup-wizard.tsx`'s mode step render and
     `ModeCardGrid`.
2. **Frame + Settings.** `ModeSelect`, the mode chip, `MODE_LABELS`/
   `MODE_OPTIONS`, `resolveFramePhase`'s `mode-select` phase, and Settings'
   Reconfigure (it currently writes an empty mode record).
3. **Shells.** The `appMode` KV entry and the `mode` prop threaded into
   `AppFrame`.
4. **Delete `domain/app-mode`** last, including the already-dead
   `filterNavItems`.

**Test note that applies to all of the above.** The mode contracts are pinned
across at least six state modules (`frame-state`, `stepper-state`,
`journey-state`, `integrate-arc`, `first-run-wizard`, `setup-wizard-state`), and
**those pins are the specification**. Each must be read and deliberately
re-pinned against the capability model, never deleted to make a suite pass.

## 2. Workspace table inventory for gap analysis

**Requested 2026-08-06.** Inventory the Log Analytics workspace's tables when the
identity has the permission to read them, and let the operator filter and select
ANY table to run the DCR gap analysis against. Today the gap analysis works from
the solution/sample path (`schemaReport.destSchema`); there is no way to point it
at an arbitrary existing table.

The ARM call already exists - and is already thrown away. `permission-preflight`
issues a `tables-list` GET against
`{workspace}/tables` as its `table.read` PROBE, but reads only the status code
and discards the body. The work is a real listing usecase that keeps the
response, paginated through the existing `listAllPages`/`requestUrl` helpers the
DCR inventory already uses.

This is the first natural consumer of the capability model, and a good test of
whether the model is right:

- Gate on `table.read` (and `workspace.read` for the workspace itself). Both are
  already measured by the audit that shipped in step 2.
- `denied` must NOT hide the picker - per plan rule 3 it stays attemptable, and
  Azure's 403 is the real gate.
- These are READ capabilities, and the plan is explicit that reads have NO
  fallback artifact: without them discovery genuinely cannot run, and the honest
  UI says so rather than inventing an offline substitute. So this feature has no
  "download the thing someone else runs" path - the annotation IS the answer.

Worth settling when picking it up: whether the selected table's live schema
replaces the derived `destSchema` outright or is reconciled against it, since the
derived-schema path exists precisely for tables that do not materialize until a
connector is enabled.

## 3. Verification gaps

**First-run wizard as a genuine first run. VERIFIED 2026-08-06.** Walked end to
end from clean state in the cloud shell on the dev server - AUA, Connect
(GitHub-first), the optional Connect Azure sub-step with the change-request
generator inline, the permission check, Mode, then into the app frame. It matches
what was described from the forced branch; no forced branch was needed.

One copy mismatch seen while walking it: the header promises four phases
("connect GitHub content, connect Azure, verify access, then pick an operating
mode") while the stepper shows two, Connect and Mode, with the other three as
sub-steps inside Connect. Not wrong, but the header sets up a count the stepper
does not show.

**The bug-triage workflow has never run.** `.github/workflows/bug-triage.yml`
fires daily at 07:00 UTC or on demand. First execution creates three labels
(`triage/tracker`, `triage/approved`, `triage/rejected`) and opens the tracker
issue. A read-only dry run - fetch and render without writing - is worth doing
first to see the output before anything is created in the repo.

## 4. Release hygiene

**Release drift will recur.** Nothing ties `release/` to source changes;
`npm run package` is manual. The committed artifact silently fell five days and
four commits behind before anyone noticed. Cheapest fix that does not need write
access to a protected branch: a CI check that warns when `soc-optimizationtoolkit/**`
source changed without a version bump since the last packaged release.

**1.3.0 is already behind.** It predates the "Start over" removal (`a8b7ba1`),
the pack-embedded breaker fix (`7890f6c`), and the capability domain
(`56e909f`). Next package should be at least 1.3.1.

**The drift is worse than the committed artifact suggests (seen 2026-08-06).**
The app INSTALLED in the Crib.Cloud Lab workspace is **1.2.212** - a whole minor
version behind the 1.3.0 in `package.json`, which is itself behind main. So there
are two independent lags: repo source ahead of the packaged release, and the
packaged release ahead of what is actually installed. Anyone opening the
installed app is running none of the recent work; it is only reachable through
Live Preview, which serves the dev server rather than the installed artifact.
Whatever CI check gets built for the first lag says nothing about the second -
installed version is only observable from the workspace's Apps list.

## 5. Copy and UX

**"reset when the solution changes" understates deletion.** The Sample Data
helper text says the sample, mapping and coverage sections "reset" when the
solution changes. They are DELETED - `handleSolutionChange` removes every tagged
sample from the store. The deletion is correct and intended (samples are
solution-scoped); the wording is what misleads. Saying "are deleted" would match
the behavior.

**Nested scrolling on tall pages.** The 558-row solution list scrolls inside a
scrolling page inside the app iframe. `overscroll-behavior: contain` stops the
wheel chaining at the list's end, but the three-level nesting remains.

## 6. Diagram fidelity

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

## 7. Explicitly not doing

**Live capture.** `POST /system/capture` supports `level` 0-3 (before
pre-processing pipeline / before Routes / before post-processing pipeline /
before Destination), which would map onto diagram nodes for a before/after view.
Deferred by decision on 2026-08-05: it returns real customer data, and
everything else this app does is config-level. Note there is no capture level
before event breaking, so it could never show the before/after of that stage.
Revisit only with a deliberate decision about display, retention, and whether
anything is written to the KV store.

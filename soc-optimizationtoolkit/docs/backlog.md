# Backlog

Updated 2026-08-06 (branch `feature/capability-preflight-mapping`). Each item
states enough context to be picked up cold. Ordered by priority within each
group.

## 1. Capability model - COMPLETE, with two follow-ons

All five plan steps have shipped. See
[capability-model-plan.md](capability-model-plan.md). App modes are gone; what an
operator can do is measured by a permission audit and annotated, never hidden.

Two things remain, both carried below: step 4 has no UI, and the audit's age has
no home. Neither blocks anything.

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

**Step 4 - fallback routing. DONE (2026-08-06).**
`domain/capabilities/fallback-routing` resolves the tension the plan left: it
says to force the artifact "from a permission verdict", while rule 3 says the
audit never forbids. UNREACHABLE forces (there is nowhere to send the request -
and this is what the old `!hasCribl(mode)` check actually meant); DENIED only
OFFERS, so the live attempt survives a stale or wrong audit. `unknown` routes
live. `mustProduceArtifacts` now drives `forcedTemplateOnly` in both shells.

The fallback catalog is data, keyed by a typed `kind` so the routing is a switch
the compiler checks. Read capabilities map to NOTHING deliberately - without live
read access discovery cannot run and no artifact substitutes for it.

`FallbackNotice` renders the offer, placed on the permission-check panel - the
one screen that already enumerates what the identity cannot do, so the reading
order is "what you cannot do" then "what to do about it". Styled and worded as an
OFFER, not an error, with a test pinning the absence of alert semantics: the live
control stays available, so a notice that read like a failure would talk people
out of work that might succeed.

Three cases correctly produce nothing: an unresolved check, an UNKNOWN verdict
(not a denial - verified live, where broken Cribl auth produced unknowns and no
offers), and a denied READ (no artifact exists by design).

**Follow-on:** the offer is only on the permission panel. Placing it beside the
ACTIONS themselves - Integrate's deploy, Batch Deploy, DCR Automation - is a
product call about surface area, and each needs its own `onProduce`. One prop
away in any of them.

**Step 5 - mode removal. DONE (2026-08-06).** `AppMode`, `APP_MODES`,
`hasAzure`/`hasCribl`, `NavRequirement`, `filterNavItems`, `ModeSelect`, the mode
chip, `MODE_LABELS`/`MODE_OPTIONS` and the persisted `appMode` entry are all
gone. `domain/app-mode` became `domain/app-setup`: the acceptance record only
ever lived there, and a module named app-mode with no modes in it is exactly the
stale naming an audit should flag.

**Mode was doing a second job**, and this was the non-obvious part. A null mode
meant "not yet chosen", which the shells read as "not yet SET UP" - so deleting
modes would have deleted the signal that decides wizard-or-app. That job now has
its own name (`SetupRecord`), the same tolerant-and-total parse as its
neighbours, and the same Reconfigure contract (`{}` reopens the wizard).

`resolveFramePhase` keeps its ORDER; only step 4 is renamed `mode-select` ->
`setup`, and `ready` stops carrying a mode.

**One-time migration, confirmed live.** An install with an old `appMode` entry
and no `setupComplete` lands in the wizard ONCE. Only the flag resets -
connections, tokens, committed target and secret all survive, and the next reload
goes straight to the app. Correct, non-destructive, and worth a release note,
because it will happen to every existing install.

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

**Core DONE (2026-08-10).** `usecases/workspace-tables`: `listWorkspaceTables`
keeps the body the preflight probe discards, and `fetchWorkspaceTableSchema`
returns the selected table's live columns as `DestField[]`.

**Decisions taken, both by the user:**

- **The live schema REPLACES the derived `destSchema`** - not reconciled. Once a
  real table is named, ARM is the better authority; blending would produce a
  schema matching neither source. The derived path still exists for tables that
  do not materialize until a connector is enabled.
- **Selecting a table RE-RUNS the gap analysis**, and the old results go STALE
  while the new run loads - they are not cleared. Reuse the Review screen's
  existing staleness-marker pattern (a visible stale notice over the previous
  result) rather than inventing a second idiom. The results must not simply
  persist unmarked: every mapping, coverage and overflow verdict in them was
  computed against a different destination.

**What remains: the UI.** Two pieces:

1. **The picker**, gated on `table.read` - and this is the first real test of the
   capability model inside a feature rather than in the nav. A `denied` verdict
   must ANNOTATE, never hide the picker, and reads have no fallback artifact, so
   the annotation is the whole answer with nothing to offer beside it.
2. **The re-run wiring** - where the picker sits relative to the Sample Data and
   Gap Analysis sections, and the stale-then-replace transition above.

## 3. Override DeviceVendor and DeviceProduct

**Requested 2026-08-10.** Let the operator override the `DeviceVendor` and
`DeviceProduct` values rather than taking whatever the sample carries.

Why it matters: these two are the CEF header fields Sentinel content keys off.
Analytic rules filter on them by literal string - the repo's own test corpus is
full of `CommonSecurityLog | where DeviceVendor == "Palo Alto Networks"` and
`=~ "ZScaler"` - so a vendor string that does not match what the rules expect
means the rules never fire, however complete the rest of the mapping is. The
operator often knows the value the content expects; the sample cannot.

Where they are handled today (all reads, no override anywhere):

- `domain/pack-assembly/sample-file.ts` `reconstructCefLine` builds the CEF
  header positionally from `evt.DeviceVendor` / `evt.DeviceProduct`, and
  RETURNS NULL when DeviceVendor is falsy - so an override may also be what
  makes reconstruction possible for a sample that currently cannot produce a
  CEF line at all.
- `domain/field-matcher/knowledge-bases.ts` lists them as CEF standard header
  fields with only identity aliases, so the field matcher maps them but never
  rewrites them.
- `domain/coverage-analysis` extracts them from rule KQL as discriminators -
  which is the other half of this: coverage already KNOWS which vendor strings
  the selected solution's rules require.

Worth settling when picking it up:

- **Where the override lives.** Per-sample (it is a property of the data) or
  per-solution/run (it is a property of the destination the content expects)?
  The coverage side argues for the latter - the required value is a fact about
  the rules, not the sample.
- **Whether coverage can SUGGEST the value.** It already extracts the literals
  the rules compare against, so "your sample says X, this solution's rules
  expect Y" is derivable rather than typed. That is the version worth building;
  a free-text box is the fallback.
- **Whether the override reaches the pack.** An override that only affects
  analysis would leave deployed data still carrying the wrong vendor, so the
  value has to flow into the generated pipeline, not just the gap report.

## 4. Verification gaps

**First-run wizard as a genuine first run. VERIFIED 2026-08-06, twice.** Walked
end to end from clean state in the cloud shell (dev server), and again in the
LIVE PREVIEW after mode removal - the second walk doubled as the migration test.
No forced branch needed either time.

The copy mismatch found on the first walk PERSISTS in a smaller form: the header
lists three phases ("connect GitHub content, connect Azure, verify access") while
the stepper shows one, Connect, with the rest as sub-steps inside it. The Mode
phase it used to promise is gone, so the gap narrowed from 4-vs-2 to 3-vs-1, but
the header still sets up a count the stepper does not show. Either drop the
enumeration from the header or promote the sub-steps.

**Annotated nav states - `unchecked` VERIFIED LIVE 2026-08-06, two remain.**
Seen in the LOCAL shell, which has an Azure identity but an empty
`cribl.auth.token`, so its Cribl probes fail: Sentinel Integration and Pack
Maintenance both carry the `unchecked` pill while DCR Automation and Labs (which
need only granted Azure capabilities) carry none. Tooltip reads "Not checked yet
- run the permission check to see if this will work.", the button is not
disabled, and clicking it opens the screen - rule 3 on screen.

The honesty rule held where it matters: the failed Cribl probes returned HTTP
500, which is not a 401/403, so the panel reported all four capabilities UNKNOWN
rather than missing, and the nav flagged `unchecked` rather than `no access`.

`no access` and `not connected` are still test-only. `no access` needs a
measured denial (an identity with reduced RBAC); `not connected` needs a
connection with no identity at all - a new empty connection profile in the cloud
shell would produce it, at the cost of a throwaway profile in the KV store.

**Local shell in a browser - VERIFIED 2026-08-06.** `npm run local`, host on
:4600. AUA, the two-phase wizard (Target -> Connect, no Mode step), the
permission check as the final view, Get Started, and into the frame. This shell
had never been run in a browser at all, and the mode removal touched its gate
flow.

## 5. Release hygiene

**Release drift will recur.** Nothing ties `release/` to source changes;
`npm run package` is manual. The committed artifact silently fell five days and
four commits behind before anyone noticed. Cheapest fix that does not need write
access to a protected branch: a CI check that warns when `soc-optimizationtoolkit/**`
source changed without a version bump since the last packaged release.

**1.4.0 PACKAGED 2026-08-06.** `release/soc-optimizationtoolkit-1.4.0.tgz`,
with [release-notes.md](release-notes.md) started as an accumulating file. Minor
rather than patch deliberately: removing operating modes is a visible feature
removal, and every existing install sees the setup wizard once.

Two things learned while packaging, worth knowing next time:

- `npm run package -- --minor` from the workspace root SILENTLY drops the flag
  and produces a patch bump. The flag does not survive the
  `--workspace apps/cribl-app` indirection. Run
  `node scripts/package.mjs --version X.Y.Z` from `apps/cribl-app` instead, and
  check the version it prints.
- The script's own archive verification caught a truncated 8 KB tgz on its first
  attempt and retried - it exists because this has gone wrong before. Confirm the
  artifact is ~500 KB and that `static/assets` holds the real JS/CSS before
  trusting a package.

**Still installed: 1.2.212.** Packaging does not deploy. The lab workspace runs
the installed app, not `release/`, so this work stays invisible there until
someone uploads the new tgz through the Apps page.

## 6. Copy and UX

**"reset when the solution changes" understates deletion.** The Sample Data
helper text says the sample, mapping and coverage sections "reset" when the
solution changes. They are DELETED - `handleSolutionChange` removes every tagged
sample from the store. The deletion is correct and intended (samples are
solution-scoped); the wording is what misleads. Saying "are deleted" would match
the behavior.

**Nested scrolling on tall pages.** The 558-row solution list scrolls inside a
scrolling page inside the app iframe. `overscroll-behavior: contain` stops the
wheel chaining at the list's end, but the three-level nesting remains.

## 7. Diagram fidelity

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

## 8. Explicitly not doing

**Live capture.** `POST /system/capture` supports `level` 0-3 (before
pre-processing pipeline / before Routes / before post-processing pipeline /
before Destination), which would map onto diagram nodes for a before/after view.
Deferred by decision on 2026-08-05: it returns real customer data, and
everything else this app does is config-level. Note there is no capture level
before event breaking, so it could never show the before/after of that stage.
Revisit only with a deliberate decision about display, retention, and whether
anything is written to the KV store.

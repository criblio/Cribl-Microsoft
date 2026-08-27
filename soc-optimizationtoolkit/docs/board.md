# Board

Status: Living - the Kanban index over backlog.md: epics, stories, and the order to take them in.

The succinct Kanban view: nine epics, the stories under them, and the order to
take them in. Created 2026-08-26.

**This file does not replace `backlog.md`.** The backlog stays the detailed
record - the reasoning, the measurements, the rejected alternatives. This file
is the index over it: what is a unit of work, what state it is in, and what it
depends on. Every story cites where its detail lives. When the two disagree,
`backlog.md` wins on detail and this file wins on sequencing.

Reliability order for the whole docs tree is unchanged: `release-notes.md`
(what shipped), `backlog.md` (what is open), `adr/` (what was decided).

## This file is the board

There is also a rendered Kanban view at
https://claude.ai/code/artifact/6a0412f8-6c7e-4ba1-932b-dbf52540ce0f - filterable
by epic, easier to scan, and **a snapshot**. It does not read this file, so it is
only as current as the last time someone republished it. Recorded here because a
URL that lives in a chat log is a URL that is gone after a reboot.

**This file is the one that is true.** It is in git, on a branch, pushed - so it
survives a workstation dying mid-thought, which the rendered view's source does
not. When the two disagree, this file wins and the view needs republishing.

Keeping it fresh is enforced twice: `check-docs-drift.mjs` holds its structure
(no duplicate story ids, no undeclared epic, no epic that quietly emptied out),
and a Stop hook counts commits since this file last changed and asks for an
update once enough have piled up. Neither can tell whether a card is in the right
column - that judgement stays with whoever moves it.

## Columns

| Column | Meaning |
|---|---|
| **Now** | In flight, or the next thing to pick up. Nothing blocks it. |
| **Next** | Settled and unblocked, sequenced behind Now. |
| **Later** | Settled, but gated on something in Now or Next. |
| **Needs a decision** | Blocked on a call, not on effort. Cheap to build once answered. |

A story sits in "Needs a decision" only when the work genuinely cannot start.
A story with an open sub-question but an obvious first slice belongs in a work
column with the question noted.

## Epics

| Key | Epic | Why it exists |
|---|---|---|
| `REL` | Ship what is built | The packaged tarball trails `main`, and the lab trails the tarball |
| `FX` | Effect-identity defects | One confirmed live defect class, three instances |
| `CAP` | Capability taxonomy extension | The single upstream blocker for three other epics |
| `HON` | Inventory and diagnostic honesty | Measured gaps where the app reports a confident wrong answer |
| `AZR` | Azure native source onboarding | The largest unstarted block (backlog item 6) |
| `WIN` | Windows event analysis | Backlog item 5; Sentinel-side and Lake-side halves |
| `PK` | Pack maintenance parity | Includes a silent data-loss defect |
| `VND` | Vendor field definitions | Positional CSV naming, reaching past ~18 vendors |
| `DBT` | Debt, spec grounding, verification | Copy fixes, unverified claims, retired docs |
| `D` | Open decisions | Blocked on a call, not on effort; each is cheap once answered |

---

## Now

> **Updated 2026-08-27.** Move 1 of the roadmap is DONE: PRs #128, #129, #130
> and #131 are all merged, `main` is at `714a66c`, and the full gate is green on
> it (4,470 tests, lint, typecheck, docs-drift). Move 2 (CAP) is promoted here.
>
> The shipped cards left this column rather than sitting in it marked done - a
> board that keeps its trophies stops showing what is next. What they were and
> why is in the merge commits; the epic note below keeps the one lesson worth
> carrying.

### REL - Ship what is built

- **REL-2** Record the 2026-08-25 live verification in the release notes.
  The 1.12.0 entry ends "has NOT done: run against a real workspace", which was
  true of that release. No later entry records the run, so a reader working
  newest-first still concludes ADR-0003 is unverified. *chore, SETTLED.
  Size: one entry.*
- **REL-3** Rotate the Azure client secret from the retired local-app config.
  `~/.soc-toolkit-local-app-retired/config/local-config.json` holds a live
  secret. Flagged for rotation by `adr/0002-drop-local-target.md:57-62` and
  still outstanding. *chore, SETTLED. Security. Size: minutes.*
- **REL-4** Cut and package a release. Now the most overdue card on the board:
  the tarball in `release/` predates four merged PRs, and the lab workspace is
  further behind still. `npm run package` performs the bump; do not hand-bump.
  For the current number run `npm run check-release --workspace apps/cribl-app`
  - do not copy it into this file. The epics table used to carry a hand-typed
  "21 commits sit unreleased"; it read 25 four days later, which is the whole
  reason that check exists.

### FX - Effect-identity defects

SHIPPED 2026-08-26/27, all three instances: the capture filter (#129), the
canvas arrangement and the mapping-review drop branch (#131).

The lesson worth keeping, because it is what made all three findable: an effect
keyed on a value whose identity moves for reasons unrelated to the state it
resets. Safe reference `lake-panel.tsx:198-204` (primitive key); guard
precedents `integrate-screen.tsx:398-410` and `azure-resources-section.tsx:259-262`.
Two of the three fixes also extracted the decision to a pure function
(`shouldReloadEdits`, `autoDropPlan`) - which is what made the third one's
asymmetry visible at a glance.

- **FX-4** Sweep for the class rather than the instances. THREE confirmed from
  one reading; nothing says the fourth is not there. `useEffect` keyed on a memo,
  a callback, or an inline object/array prop, whose body resets state the
  operator owns. Safe reference: `lake-panel.tsx:198-204` (primitive key).
  Guard precedents: `integrate-screen.tsx:398-410`,
  `azure-resources-section.tsx:259-262`. *chore. UNDECIDED whether this is a
  one-off sweep or a lint rule - oxlint has no exhaustive-deps equivalent, and a
  custom rule is a bigger commitment than the three fixes were.*

### CAP - Capability taxonomy extension

Build this ONCE. `backlog.md:806-808` says so explicitly - it serves three
separate backlog items and doing it per-surface means building it three times.
Today the taxonomy is 11 capabilities (`capabilities.ts:22-36`). Every addition
needs a real probe or the step-2 mapping rule drops it, since that rule records
only measurements. No probe ever grants a write.

- **CAP-1** Add `resourcegraph.read` and its probe. The gap recorded in backlog
  items 1 and 4 and again under 6d. `backlog.md:74-82`, `:321-329`, `:786-808`.
- **CAP-2** Add policy assignment and remediation capabilities plus probes
  (`Microsoft.Authorization`, `Microsoft.PolicyInsights`). Gates AZR-4.
- **CAP-3** Add managed-identity creation plus probe. Gates AZR-4.
- **CAP-4** Add Sentinel incident read (Microsoft Sentinel Reader). Modelled
  nowhere - `azure-permissions.ts:239,244` knows only the Contributor actions.
  Gates AZR-7.
- **CAP-5** Add the two Graph scopes (`Organization.Read.All`,
  `SecurityEvents.Read.All`) plus probes. Gates AZR-6.
- **CAP-6** Make the four unmeasured listers measurable - subscriptions,
  resource groups, Resource Graph, Cribl worker groups. They render
  `unmeasuredInventoryMessage` today, which `backlog.md:321-329` calls "honest,
  but inert". Depends on CAP-1.

Already measured, do not re-add: Event Hub namespace creation is `arm.deploy`;
every Cribl-side write is `source.manage`.

---

## Next

### HON - Inventory and diagnostic honesty

Rule 3 holds throughout: annotate, never hide, never disable. Denied reads map
to nothing - no artifact substitutes for read access.

- **HON-1** Wire `emptyTableListMessage` into the picker screen. The last of
  the three pure decisions still owed its wiring. `backlog.md:303-306`.
- **HON-2** Honour the scope rule at the remaining lister call sites. A verdict
  is evidence only about the scope it was measured at, and that includes
  off-scope denials. `emptyInventoryMessage` now requires a scope argument, so
  the compiler prompts each new call site. `backlog.md:308-319`.
- **HON-3** Surface `droppedColumns` and `unknownTypeColumns` in the UI.
  The diagnostics already exist and reach nobody - repo-wide the only consumers
  are two test files. Already propagated through `dcr-request.ts`, so this is a
  rendering job, not plumbing. `adr/0004:87-88`, named there as the strongest
  argument for doing it next.
- **HON-4** Tell operators that DCRs deployed before the guid fix still lose
  fields. `update-dcr` regenerates the declaration so an update fixes it, but
  nothing sweeps and nothing warns. Pairs with HON-3. `adr/0004:107-112`.
- **HON-5** Warn a CSV vendor's operator before the preview that the pack can
  never route automatically. Both route discriminators return early for CSV by
  construction, so every CSV log type placeholders even when its values name
  their log types perfectly. The format-aware hint shipped in 1.11.11; the
  earlier warning did not. `backlog.md:1063-1065`.
- **HON-6** Give the audit's AGE a home and add a manual re-check.
  The nav was tried and was the wrong surface. Two candidates remain: the frame
  footer, or the connection bar beside the existing chips. `backlog.md:84-88`.
> **HON-8 and HON-9 SHIPPED, PR #134 merged 2026-08-27**, both verified in the live product
> against the lab workspace, not just in tests. HON-8 was a claim ledger that
> outlived the run that made it: the loader marked its key loaded before
> awaiting, the cleanup cancelled the run so its answer was discarded, and the
> claim stayed - so the next run skipped a fetch nobody was waiting for. HON-9
> was `extractDiscriminatorValues` taking the quoted text out of
> `Activity == "{activities}"` verbatim.
>
> One thing worth carrying: the HON-8 fix has a SECOND half - a cancelled run
> must stop working, not merely stop setting state - that resisted three
> attempts at a unit pin and is verified only live. It is called out in
> `azure-targeting-screen.dom.test.tsx` so nobody deletes it on the strength of
> a green suite. FX-4's sweep should treat it as a known-unpinned guard.

- **HON-7** Make the fallback offer reachable beside the actions.
  `FallbackNotice` renders without `onProduce` in production, so the capability
  model's "every blocked action falls back to a downloadable artifact" rule has
  no button. Targets: Integrate deploy, Batch Deploy, DCR Automation. Must stay
  worded as an offer, not an error - there is a pin on the absence of alert
  semantics. `backlog.md:113-116`.

---

## Later

### AZR - Azure native source onboarding

Backlog item 6, `backlog.md:443-819`. One section per collection mechanism,
each carrying per-source checkboxes. Legacy source is
`deprecated/Azure/Azure-LogCollection/` (~13,200 lines, production, v5.1.0).

Two cross-cutting gates block real work and are not sub-items:

- **AZR-S1 (spike)** Verify whether XDR streaming and the Sentinel incidents
  API are complementary or alternatives. Streaming carries alert-grain tables;
  path B returns the incident object with triage state. Settle before building
  either AZR-6 or AZR-7 - presenting A as a replacement loses triage state
  silently, presenting them as unrelated builds two overlapping feeds without
  telling anyone. `backlog.md:679-703`.
- **AZR-S2 (spike)** Decide whether the app creates Cribl sources over the API.
  Every `/system/inputs` reference in the codebase is a read; Event Hub
  Discovery ends at a JSON download
  (`eventhub-discovery-screen.tsx:503-515`). The write-side plumbing exists
  (`guided-deploy/wire-source.ts`, `secret-provisioning.ts`) but a
  `POST /system/inputs` applier is net-new. This decision constrains AZR-2,
  AZR-4, AZR-6 and AZR-8, so make it once, early, on the smallest surface.

Then, in order:

- **AZR-0** Port `resource-coverage.json` to the app KV store as the selection
  model. The checkbox model exists as a file - port it, do not invent one. Its
  `method` values ARE the section keys. Keep the tier/profile sub-selections
  and the `notSupported` block verbatim. Precedes every sub-item.
  `backlog.md:476-482`.
- **AZR-1** Establish the additive-only contract. Checkboxes only ever deploy;
  unticking removes from the desired selection and does nothing to Azure;
  teardown is a separate, separately-confirmed Remove action. No checkbox may
  destroy anything - pin that with a test. The UI must distinguish "not
  selected" from "not deployed". `backlog.md:771-784`.
- **AZR-2** TRACER BULLET: Entra ID tenant diagnostics, one category group.
  One ARM PUT to `microsoft.aadiam/diagnosticSettings`, catalogued as porting
  nearly one-to-one. Checkbox grain is the category, with Standard (9) and
  HighVolume (15) as presets, and the non-interactive sign-in volume warning at
  its own checkbox rather than in a footnote. Requires an Entra directory-role
  precondition, which the ARM RBAC evaluator provably cannot measure - a real
  finding this slice surfaces early. Non-negotiable: state the `_CL` divergence
  and UEBA consequence at the moment a sign-in category is ticked. Resolve the
  LOG-07 drift (a SecurityOnly profile that `resource-coverage.json` omits).
  `backlog.md:536-553`.
- **AZR-3** Defender for Cloud continuous export. Per subscription, a
  `Microsoft.Security/automations` resource. Detects which of 12 paid plans are
  enabled and never enables one - keep that property. `backlog.md:554-559`.
- **AZR-8** Blob-only sources as visible unavailable rows. vNet and NSG Flow
  Logs have no Event Hub path; the blob path already exists end to end. The
  `notSupported` block is a feature of the legacy config, not an omission.
  Smallest sub-item by a wide margin. `backlog.md:705-721`.
- **AZR-9** Link the AMA plus DCR path to the app's own DCR Automation and
  Integrate routes rather than duplicating them. Natural place to surface WIN.
  `backlog.md:723-735`.
- **AZR-4** Azure Policy initiatives - the bulk of the platform. Built-in Audit
  or AllLogs (one or the other), eight community tiers with a per-service
  expander, plus Activity Log, AKS and PostgreSQLFlexible as visible checkboxes
  because the bundled initiative excludes them silently. DeployIfNotExists
  fires only for new resources, so bulk remediation is mandatory. Compliance
  data lags 15-30 minutes, so a fresh deployment reads as non-compliant and the
  UI has to say why rather than look broken. No policy modelling exists in the
  repo today. `backlog.md:484-534`.
- **AZR-5** Diagnostic-settings cleanup, preview only. Enumerate exactly what
  would be removed, grouped by resource type and target namespace, and stop.
  No delete capability in the GUI in this pass. `backlog.md:522-534`.
- **AZR-6** Defender XDR guided worklist. Licence check then usage probe -
  a licence held is not a product in use. The checkboxes here are a worklist,
  not a deployment: Microsoft exposes no configuration API for XDR streaming,
  so the last step is a portal visit, forever. Tables absent from the Streaming
  API show greyed with the reason. `backlog.md:561-620`.
- **AZR-7** Sentinel incidents via a Cribl REST collector. Filter on
  `lastModifiedTimeUtc`, not `createdTimeUtc` - filtering on creation misses
  every update to an open incident. Repeat deliveries are correct; dedupe
  downstream on incident GUID plus `lastModifiedTimeUtc`. Build on
  `lab-cribl.ts:149`. `backlog.md:622-677`.
- **AZR-10** Dataflow diagrams, one per category. Do not build a new diagram
  implementation - the renderer and layout exist and the work is data, new
  entries in `architecture-patterns.ts`. Draw the manual portal step in AZR-6
  as a step, and draw AZR-7 flowing the other way. Trail each section by one.
  `backlog.md:737-767`.
- **AZR-11** Make the prerequisite ordering explicit. Nearly every section
  needs an Event Hub namespace first, and the policy sections need Policy
  Contributor plus User Access Administrator at MG scope. `backlog.md:810-814`.
- **AZR-12** Check `eventhub-discovery` for overlap before building a second
  Event Hub surface. `backlog.md:816-818`.

### WIN - Windows event analysis

Backlog item 5. Two goals related only by subject; keep them separable, because
one is Sentinel-side and one is Lake-side and either could ship alone.

- **WIN-1** The screen shell and route, opting in to `table.read`. New route
  ids fail toward reachable, so this must opt in. A denial annotates and never
  hides - and unusually, the DCR-template path means the screen still does real
  work under a denial. Say so on the screen. `backlog.md:338-344`, `:403-410`.
- **WIN-2** Derive the enrichment catalog, ranked by content reference.
  Derive it; do not write it from memory. Four in-tree sources, and the formula
  is (schema columns) minus (what the raw event carries), ranked by how much
  content references each. The ranking is what makes this a screen rather than
  a documentation page. Show unreferenced fields AS unreferenced - dropping
  them turns a measured zero into an unmeasured absence. `backlog.md:345-401`.
- **WIN-3** Produce SecurityEvent and WindowsEvent as two separate catalogs and
  let them differ. `backlog.md:398-401`.

### PK - Pack maintenance parity

- **PK-1** Detect packs modified in the Cribl UI before overwriting them.
  The data-loss one. Maintenance rebuilds from our stored definition and
  installs over the deployed pack, silently discarding any route filter,
  pipeline function, lookup row or destination an operator changed since.
  Needs a three-way comparison, per worker group, because the answer differs
  per group. Build on `deployedGroups` and `installedPackVersions`.
  Answer early: how much of a deployed pack can the API actually return? If the
  readback is lossy, the honest surface names the files it can see - an unknown
  must not render as a zero. `backlog.md:1169-1205`.
- **PK-2** Bring the new sample analysis into maintenance. An operator
  maintaining a pack today edits it through a strictly weaker view than the one
  they built it with - maintenance cannot tell them a mapping is now dropping
  161 fields. Reuse `triageOverflow`, `matchFields`, `resolveSampleRouting` and
  `createLiveTableSchemaCatalog`; a second mapping verdict computed a second way
  is the duplicated-decision failure this codebase keeps finding.
  `backlog.md:1137-1167`. See also the two decisions under VND/decisions below.

### VND - Vendor field definitions

- **VND-3** Measure the column-order shortfall instead of hedging about it.
  Found live 2026-08-27: THREAT arrived with 38 fields and was named from the
  bundled 120-column PAN order; TRAFFIC, 41 against 115. Positional naming maps
  field[i] to name[i], so a feed missing any middle column mis-names everything
  after it, silently. The copy says "check the values beside each name before
  applying", which is a hedge where the app already holds the number. *bug,
  UNDECIDED whether a large shortfall should warn or block. `backlog.md` 13c.*
- **VND-1** Let the operator name the vendor. Today the vendor comes from
  `detectVendorIdentity(solutionName)`, so anything outside
  `KNOWN_VENDOR_IDENTITIES` stores nothing - honest, but it caps the feature at
  about eighteen vendors. Needs a UI seam that was deliberately not built.
  `vendor-field-definition-plan.md:209-214`.

### DBT - Debt, spec grounding, verification

Small and mostly independent. Good filler between larger stories.

- **DBT-1** Pin how the REST collector is modelled in the vendored spec.
  `InputRest` has no schema under that name; it is likely `InputCollection`
  with a collector conf. Blocks AZR-7 and WIN-5. `backlog.md:975-977`.
- **DBT-2** Add the guid cast to the live-verification suite. The fix shipped
  in 1.12.1 without ever being observed against live Azure, and `toguid()`
  returns null silently on malformed input - so a wrong cast fails the same
  quiet way the drop did. The suite ran live on 2026-08-25 and carries no guid
  row. `adr/0004:118-124`.
- **DBT-3** Reconcile the Entra `Kind:Direct` copy with what has been measured.
  `architecture-patterns.ts:422,426` states flatly that native Entra tables do
  not accept Kind:Direct DCRs, with no snapshot date and no hedge, while the
  plan doc that is its only source still calls it unverified. Either measure it
  or carry the caveat.
- **DBT-4** Name inline breaker rulesets instead of showing "Default
  selection". The spec's `EventBreakerExistingOrNewExisting` carries
  `existingRule`. `backlog.md:968-973`.
- **DBT-5** Produce live evidence for the `no access` and `not connected` nav
  states. Both are still test-only. ADR-0002 removed the cheapest way to
  produce them, so each now costs a throwaway KV profile.
  `backlog.md:846-849`.
- **DBT-6** Exercise the `_raw`-absent branch with a non-Lake sample. The Lake
  write path adds `_raw`, so no Lake-sourced bench can reach that branch -
  it needs a paste or an upload. `zscaler-lake-lab.md:167-179`.
- **DBT-7** Confirm the `eventsPerSec` 2x multiplier against worker config.
  Inferred as the worker-process count from a hard changepoint, not confirmed.
  `zscaler-lake-lab.md:225-238`.
- **DBT-8** Correct the external datagen research note. The recorded "verified
  create call" returns HTTP 200 and produces no sample file; a datagen bound to
  it emits nothing while reporting health Green. The correct shape is
  `POST /api/v1/m/{group}/system/samples` with a `context.events` array, and it
  is not in the OpenAPI spec. `zscaler-lake-lab.md:104-131`.
- **DBT-9** Say "are deleted" instead of "reset" in the Sample Data helper
  text. The deletion is correct and intended; the wording is what misleads.
  One string. `backlog.md:955-960`.
- **DBT-10** Reconcile the field matcher's target list with the generator's
  output. Lower urgency after ADR-0004 - the two now agree about guid columns,
  which removed the only known instance. `adr/0004:89-91`.
- **DBT-11** Archive three retired docs rather than keep patching them:
  `ux-flow-plan.md` (its plan shipped, its standing gate is retired),
  `legacy-flow-analysis.md` (its one decision was adopted 2026-07-04),
  `ui-refinement-reference.md` (it points at a path now under `deprecated/`).
  `porting-plan.md` is the borderline one - patched for now, next in line if
  the annotation load keeps growing.
- **DBT-12** Re-derive `BREAKER_CONFIGURABLE_INPUT_TYPES` whenever the spec is
  re-vendored. Recurring, conditional. It is derived, not hand-written - do not
  edit it by hand. `backlog.md:979-982`.
- **DBT-14** Stop the solution list swallowing the mouse wheel.
  Found live 2026-08-27: with the pointer over the list, the wheel moves neither
  the list nor the page - the pointer must leave the list before anything
  scrolls. Five of eight results were reachable. This is the reproduction the old
  nested-scrolling question never had, which is what turns it from an annoyance
  into a bug. *bug, SETTLED. `backlog.md` item 13d.*
- **DBT-15** Give every solution row a delivery-fit badge, or say why not.
  "Palo Alto Cortex XDR" renders none while all seven of its siblings do. Blank
  reads as neither "not measured" nor "does not apply" - the absent-versus-zero
  distinction the inventory standard exists to protect. *bug, SETTLED.
  `backlog.md` item 13e.*
- **DBT-13** Decide whether the Claude hooks should travel with the repo.
  `.gitignore` matches `*claude*` unanchored, so all of `.claude/` is ignored -
  including `hooks/`, which now holds the architecture-audit cadence, the
  docs-drift check and the board-freshness check. None of them exist in a fresh
  clone, so every enforcement that matters has to be duplicated in CI. That is
  the right belt-and-braces split today and a silent single point of failure the
  moment a second person works here. *chore, UNDECIDED. Related to the
  unanchored-pattern problem already fixed once in 1.12.1.*
  **Evidence, 2026-08-27:** the architecture-audit hook was counting every
  commit, so a batch of merges tripped it and then a release commit tripped it
  again - two audits opened on nothing having changed. It now counts only
  commits touching source, and that correction exists on ONE machine. A fresh
  clone gets the version that cries wolf, and an audit that always fires is one
  people learn to wave through.

### REL - Release, continued

- **REL-5** Upload the current package to the lab workspace. Packaging does not
  deploy - the lab runs the installed app, so this work stays invisible there
  until someone uploads the tgz through the Apps page. The lab is on 1.2.212.
  `backlog.md:949-951`.
- **REL-6** Clear the external queue. Issue #47 was fixed on 2026-08-24 by PRs
  #120 and #121 and never closed. PR #26 diagnosed the guid issue correctly and
  is credited in the 1.12.1 notes, but its own edit to `AWSCloudTrail.json`
  appears unapplied - verify, then merge or close with credit. PR #25 targets
  paths that all moved to `deprecated/` and is unmergeable. The bug-triage
  tracker (#84) counts itself as one of its own two pending items.

---

## Needs a decision

Each of these is cheap to build and blocked only on a call.

- **D-1** `HON-6` placement: frame footer, or connection bar beside the
  existing secret/target/platform-link chips? Excluded already: the nav (tried,
  wrong surface) and the preflight panel (re-measures on arrival, so it would
  only ever read "just now").
- **D-2** `HON-7` surface area: which of Integrate deploy, Batch Deploy and DCR
  Automation get the fallback offer, and does each own its `onProduce`? One
  prop away in any of them.
- **D-3** How do capabilities reach the roughly eight listing screens -
  keep prop-drilling from the shell, or carry them in `PortsContext` beside
  `config`? One seam change against updating every `PortsProvider` call site.
  Cheap now, less so later; at eight listers this is the duplication that
  drifts. `backlog.md:331-336`.
- **D-4** `WIN` scope: does the enrichment catalog only report, or does it also
  produce pipeline enrichment functions? Reporting first is a legitimate slice,
  but a catalog that only affects analysis leaves deployed data still missing
  the fields. `backlog.md:390-397`.
- **D-5** `WIN-5` JSON or Parquet for the Cribl Lake copy. The choice is
  already live and made silently - `lab-cribl.ts` carries Parquet chunk
  settings and nothing presents the tradeoff. The answer must be MEASURED
  against how Federated Search actually executes, not reasoned from general
  Parquet knowledge, because being specific to Cribl's engine is the entire
  value. Schema stability is the sharp dimension: the Windows tables are wide
  and sparse, Parquet is columnar and typed. `backlog.md:412-441`.
- **D-6** `PK-2` source of truth: does maintenance re-analyse, or read a stored
  analysis? Re-analysing needs the original samples, which the pack carries but
  which may no longer represent live traffic; a stored verdict is cheap and
  goes stale silently. A third option - re-analyse against the LIVE table
  schema and show what changed since the pack was built - is probably the
  honest one, and is the same fetch the picker already makes.
  `backlog.md:1137-1167`.
- **D-7** `VND-2` Does a persisted column order need a version or a captured-on
  date, so a firmware change can be reasoned about later rather than silently
  disagreeing with a future bundled update? The only genuinely open question
  left in that plan. `vendor-field-definition-plan.md:222-224`.
- **D-8** `AZR` Resource Graph change tracking - offer it at all? Recorded
  under `notSupported` as query-only with no streaming path. If offered, it is
  a second scheduled collector, and it lands on the same Resource Graph gap
  CAP-1 closes. `backlog.md:629-633`.
> **D-9 became DBT-14 on 2026-08-27.** It asked what to do about three-level
> nested scrolling and had no fix proposed, because nobody had reproduced the
> harm. Driving PaloAlto did: the wheel over the solution list moves nothing at
> all. That is not a question any more, so it left this column.
- **D-10** `DBT` Setup wizard header promises three phases while the stepper
  shows one. Either drop the enumeration from the header, or promote the
  sub-steps. Measured on two live walkthroughs 2026-08-06.
  `backlog.md:826-832`.
- **D-11** `AZR-5` per-table successor for deprecated guid columns
  (`AwsRequestId` to `AwsRequestId_`). Explicitly out of scope for ADR-0004 as
  a per-table content decision. Matters because CloudTrail's `requestID` is
  frequently not a UUID, so `toguid()` returns null and drops it silently.
  `adr/0004:82-86`.

---

## Declined - do not re-litigate

Recorded so they are not re-opened. Each has a decision date and a reason.

- Live capture for before/after diagram views (2026-08-05). It returns real
  customer data, and everything else this app does is config-level. There is
  also no capture level before event breaking, so it could never show that
  stage. Revisit only with a deliberate decision about display, retention and
  whether anything is written to the KV store.
- `labSubscriptionHash` 16-bit width (2026-08-12). No change. Revisit only if
  lab provisioning ever needs idempotency across many subscriptions.
- Pruning `release/` to the latest tgz only (2026-07-30, user directive). Do
  not re-litigate by quietly restoring files after packaging. GitHub Releases
  is the answer if older versions must stay reachable.
- Hand-bumping the version before packaging. `npm run package` IS the bump.
- PAN-OS `AUTH` column order. Palo Alto publishes no log type called AUTH, so
  there is nothing to transcribe, and inferring one would mislabel every column
  after the first mistake. It still parses positionally and is still offered
  the dialog.
- Zscaler tunnel Phase 2 and Sample record types. Same principle: no
  vendor-published source to transcribe, and minting one would put a fabricated
  vendor token in the data.
- Removing the dormant wizard target chooser and leader-connect step. They stay
  because they are the only asset that would onboard a customer-managed leader
  if Cribl Apps ever run off Cloud. `adr/0002:33-38`.

---

## Roadmap

Four moves, in order. Each is a coherent unit; none depends on a later one.

**1. Land what exists (REL-1 to REL-3, FX-1 to FX-3).**
Days. Open the PR, fix the three effect-identity defects, record the live
verification, rotate the secret. This closes the gap between what is built and
what is claimed, and FX-1 belongs with REL-1 because it is the other half of
the same commit.

**2. Extend the taxonomy once (CAP).**
The single highest-leverage item on the board. It is the stated blocker for
three separate backlog items, and building it per-surface means building it
three times. Nothing in AZR can honestly gate until this exists.

**3. Close the honesty gaps (HON).**
Seven stories, all small, all measured, all the same shape: the app currently
reports a confident wrong answer or an inert hedge. HON-3 and HON-4 pair; the
ADR names HON-3 as the strongest argument for what to do next.

**4. Open the Azure onboarding epic with a tracer bullet (AZR-S1, AZR-S2,
AZR-0, AZR-1, AZR-2).**
Answer the two spikes, port the selection model, establish the additive-only
contract, then ship the Entra slice end to end. Not AZR-4 first: it is the bulk
of the value and therefore the wrong opening move, stacking management-group
scope, managed-identity creation, two RBAC grants with propagation delays, a
44-policy catalog, a lagging compliance query and a mandatory remediation
engine - six independent failure modes with no precedent in the codebase.

WIN, PK and VND are independent of all four and can be pulled in whenever
appetite favours them. PK-1 is a live data-loss defect and should not sit
behind the whole of AZR - promote it the moment the Cribl API readback question
is answerable.

## Not on the board, but true

Two live-Azure unknowns from the 2026-07-02 native-onboarding plan remain
unvalidated, and nothing since answers either: whether native Entra tables
accept a `Kind:Direct` DCR inbound stream at all, and whether a workspace will
register a `functionAlias` equal to a native table name. They gate the
destination half - `features/content-preserving-native-reroute.md`, still
Proposed, no code - not this board. AZR-2 can ship without either answer. What
it cannot do is pretend the question is settled, which is what DBT-3 is about.

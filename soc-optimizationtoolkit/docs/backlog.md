# Backlog

Status: Living - the open work, newest decisions first. The most honest document in the repo.

Updated 2026-08-12 (branch `feature/capability-preflight-mapping`). Each item
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
both shells mounting it. <!--drift-ok--> The audit key IS a `CapabilitySet`'s `connectionId`, so
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
so the route is unconstrained and the screen keeps reporting its own errors.

**SETTLED 2026-08-12 (user decision, recorded in 6h): add `resourcegraph.read`
plus a preflight probe for it.** The same question came up three times - here,
in item 4's unmeasured listers, and across item 6 - and it is answered once:
extend the taxonomy rather than reusing a neighbouring capability or leaving
surfaces unmeasured. Do the extension as ONE piece of work serving all three.

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
live. `mustProduceArtifacts` now drives `forcedTemplateOnly` in both shells. <!--drift-ok-->

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

**COMPLETE 2026-08-17.** Both UI pieces shipped:

1. `TablePickerSection` - loads the workspace tables, filters by name, and hands
   the caller the picked table WITH its live schema. The three capability rules
   are pinned by DOM tests rather than left to comments, because rule 1 can only
   fail visually: a `disabled` added in good faith would satisfy every state
   test while removing the attempt the model deliberately preserves. Mutation
   check - gating Load on the verdict fails 7 pins, including one asserting the
   listing was attempted at all.
2. The re-run wiring, via a new `createLiveTableSchemaCatalog` core tier that
   REPLACES the derived schema for the picked table and delegates every other
   table to the fallback. Layered exactly like `createSolutionSchemaCatalog`, so
   the tiers compose. An EMPTY live schema is still an override - a provisioned
   but unmaterialized table really has no columns, and falling back there would
   analyse against the derived schema while the UI claims the live table is in
   use. The stale notice renders over the previous results and clears when a run
   completes.

**The tier was composed in the wrong place, and it took three weeks to notice
(DBT-50, fixed 2026-08-31).** The mapping review nested the live tier UNDER both
repo tiers - the KQL-validation schemas and the solution's connector-ARM tables
- so for any table the Sentinel repo defines the ARM read fired, was awaited,
was stored, and was never reached by resolution. The decision above was
implemented correctly in the tier and lost in the composition, which nothing
pinned because the order lived inline in a React callback.

Two fixes were defensible and they are not equivalent: promote the live tier, or
keep the order and correct the documents that promise live wins. Promotion is
right. The decision recorded above already named the loser side of the
comparison - a blend would mix "columns as the solution declares them" with
columns "as the workspace actually has them", which is a claim about
live-versus-solution-declared, not just live-versus-sample-derived. The
apparently contradictory claim, `kql-validation-schema-catalog.ts` saying it
"resolves FIRST", enumerates the three tiers it beats and does not mention the
live tier because on 2026-07-14 it did not exist; there was never a decision
that the repo outranks live, only an order nobody composed. And the two tiers
answer different questions: the repo says what a solution's rules were written
against, while the live tier only ever holds a table an operator PICKED from
their own workspace, which is what will actually accept the data.

The order now lives in `domain/field-matcher/schema-ladder.ts` with pins on each
step, because an order that only exists as an expression is one nothing can
protect. The offline note on the card does not survive contact: the ARM read is
triggered by an explicit table pick, not by opening the screen, and the workspace
table LISTING already contacts Azure on scope commit either way.

**Promoting the tier exposed a second defect: it did not honour the column
contract its siblings honour.** A `SchemaCatalog` does not answer "what columns
does this table have"; it answers "what columns may a DCR DECLARE for this
table". The three repo/bundled tiers all strip the 18 Azure-managed names -
TenantId, Type, `_ResourceId` and the rest - because Azure populates them
itself. The live tier is fed raw ARM, which reports exactly those names in a
native table's `standardColumns`, and it stripped nothing. That was harmless
only while the tier was composed innermost and never answered; promoting it to
the top made it reachable. Measured on the pin: 21 columns in, 3 out, 18
dropped - and for a table whose columns are ALL managed, 18 in and 0 out, which
reduces to the tier's existing empty-override state rather than falling through
to a repo tier.

**A CORRECTION, recorded rather than quietly dropped, because the wrong version
is the one that made the fix sound impressive.** The fix round said in six
places - three module headers, a test header, this section and a commit message
- that the unstripped tier would have added up to 18 spurious columns *to every
generated DCR*. That is FALSE, and re-review measured it: `buildDcrColumnSet`
re-strips the managed names for a native table, so they could never reach a DCR
that way; and the only route by which a catalog schema reaches a DCR at all is
`customSchema`, which `onboard-batch` and `onboard-table` both ignore for a
table that already exists - and a table in the live tier's map is by
construction one the operator picked from the workspace listing, so it exists.

The claim was borrowing credibility from the genuinely measured 21-to-3 pin
sitting next to it, which is precisely the failure rule 3 names.

**The real harm is subtler and is why the fix still stands.** The managed names
enter `GapReport.destSchema`, `destFieldCount`, the mapping table's dest-column
dropdown, overflow triage and the rule-coverage union. So an operator can map a
source field onto a column Azure owns - `Type`, `SourceSystem`, `RowKey` - the
pack emits it, and the DCR then drops it SILENTLY. The data loss is real; it
happens one step further on than the first telling said.

Reordering tiers is only safe because they answer the same question, so the
strip is now ONE mechanism rather than a fourth copy of the predicate. The list
was already shared; the FILTER was not - three tiers each built their own
`new Set(DCR_SCHEMA_SYSTEM_COLUMNS)` and wrote their own test for it, which is
how a fourth tier came to have neither. `domain/field-matcher/system-columns.ts`
now owns the list and the two predicate shapes, and all four tiers read it.

**The composition pin was not enough, and the review proved it.** Severing the
wiring that feeds the ladder (`live,` -> `live: {},` in the mapping review's
`createSchemaLadder` call) reinstated DBT-50 in full while all 1299 UI tests
passed - a composition that is never handed its input still composes perfectly,
so a pin on the ladder cannot see it. `mapping-review-live-schema.dom.test.tsx`
now pins the SEAM instead: it drives a real table pick through the rendered
screen and reads the report that comes out. Mutation check - that exact severing
fails all three of its pins.

Superseded planning notes follow.

**What remained: the UI.** Two pieces:

1. **The picker**, gated on `table.read` - and this is the first real test of the
   capability model inside a feature rather than in the nav. A `denied` verdict
   must ANNOTATE, never hide the picker, and reads have no fallback artifact, so
   the annotation is the whole answer with nothing to offer beside it.
2. **The re-run wiring** - where the picker sits relative to the Sample Data and
   Gap Analysis sections, and the stale-then-replace transition above.

## 3. Override DeviceVendor and DeviceProduct

**Requested 2026-08-10. CORE DONE.** `domain/cef-identity` derives what a
solution's rules expect from the discriminators coverage already extracts,
classifies the sample against them, and applies an override. Three pins worth
keeping: wrong CASING is its own status (the corpus mixes `==` and `=~`), an
unconstrained field NEVER gets a suggestion (inventing one manufactures a
problem), and a blank override means "leave it" not "clear it" (an empty
DeviceVendor makes reconstructCefLine return null).

**COMPLETE - the "still owed" work shipped and this entry was stale until
2026-08-17.** Both halves are in:

- Surfaced beside the gap report: `IdentityBlock` and `IdentityMismatchBlock`
  render inside each mapping-review card (mapping-review-section.tsx), including
  the "Vendor identity does not match this solution's rules" case with its
  one-click correction. Confirmed on screen against a live Zscaler analysis.
- Carried into the GENERATED PIPELINE: `buildCefIdentityOverrideFn` in
  pipeline-conf.ts pushes an override function into the emitted pipeline, placed
  right after CEF extraction so the reduction rules see the corrected value. Its
  comment records why, in this entry's own words - an override that only changed
  the analysis would leave deployed data carrying the wrong vendor.

Original request and the reasoning behind it:

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

## 4. Unverified empty inventories report "none" (BUG)

**Reported 2026-08-10. Reported instance and three more FIXED; two open
questions below.** See [inventory-standard.md](inventory-standard.md), which is
BINDING for every inventory scenario.

With insufficient RBAC the app reported "No workspaces found - create one
below". That is a confident wrong answer, and the harmful kind: it invites the
operator to create a workspace that may already exist and that they simply
cannot see.

**The trap, and why this is not error handling.** Azure ARM list operations
return `200 OK` with an empty `value` array when RBAC filters the caller out.
There is no error to catch - a caller with no access and a caller looking at a
genuinely empty subscription get byte-identical responses. `listAllPages` does
throw on non-2xx, correctly, and it does not help here. The distinction is not
in the response at all; it has to come from a permission check.

**The fix is available.** The capability audit already measures `workspace.read`,
`table.read` and `dcr.read`. An empty result is only a zero when the matching
capability is GRANTED; denied means "cannot list", and unknown means "cannot
confirm" - three answers, never collapsed into one.

**Applied so far (2026-08-10):** the reported workspace instance, the
subscription and resource-group pickers beside it, the DCR inventory, and the
table listing's pure decision (`emptyTableListMessage` - the picker screen owes
the wiring). Shared helper:
`packages/ui/src/capabilities/empty-inventory.ts`.

**The rule the first fix missed, worth knowing before touching another lister.**
A verdict is evidence ONLY about the scope it was measured at. `runAzurePreflight`
evaluates ONE ARM scope built from the COMMITTED target, and the screens that
list are the screens that BROWSE - Azure targeting exists to look at other
subscriptions, the DCR inventory says in its own hint that it browses other
resource groups. Reusing the committed verdict there reproduces the bug one
scope over with a permission check as cover, which is worse than no check.
`emptyInventoryMessage` now REQUIRES a scope argument so the next call site has
to decide. Off-scope is unmeasured, and that includes off-scope DENIALS.

Do NOT hide or gate these surfaces while fixing them - rule 3 still holds, the
list stays loadable, and reads have no fallback artifact.

**Open question 1: the unmeasured listers. SETTLED 2026-08-12 (user decision,
recorded in 6h): add the capabilities plus their probes.** Subscriptions,
resource groups, Resource Graph (Event Hub discovery) and Cribl worker groups
have NO capability in the 11-item taxonomy, so they currently take
`unmeasuredInventoryMessage` - honest, but inert, hedging without pointing at a
permission check that could settle it. The taxonomy gets extended rather than
leaving them unmeasured or reusing a neighbouring capability. Note this is the
same extension item 1 needs and item 6 needs: ONE piece of work, not three, and
each new capability needs a real probe or it contributes nothing.

**Open question 2: prop-drilling.** `capabilities`/`capabilityContext` are
threaded from the shell into each screen that lists (Integrate ->
AzureTargeting, DcrInventoryPanel so far). At ~8 listers that is the duplication
that drifts. The alternative is carrying them in `PortsContext` beside `config`,
which every screen already reads - one seam change against updating every
`PortsProvider` call site. Cheap now, less so later.

> CORRECTED 2026-08-26 (docs-drift check): this question was written while there
> were two shells and priced accordingly. ADR-0002 left one, so the cost of the
> alternative is HALF what this entry claimed - which is exactly the kind of
> stale number that decides a question wrongly without anyone noticing it moved.

## 5. Windows Event analysis screen

**Requested 2026-08-12.** A new menu item covering Windows event data
specifically. Two goals, related only by subject - keep them separable when
picking this up, because the first is Sentinel-side and the second is Lake-side,
and either could ship without the other.

### 5a. Catalog the Microsoft proprietary enrichments

Catalog what Microsoft ADDS to a Windows event on its way into `SecurityEvent`
and `WindowsEvent`, and which of those additions Sentinel content actually
depends on.

Why it matters: this is the native-onboarding content-preservation problem
([features/content-preserving-native-reroute.md](features/content-preserving-native-reroute.md)) on
the busiest table pair in Sentinel. When Microsoft's own agent ships a Windows
event, the row that lands in `SecurityEvent` carries fields the raw EventLog
record never had - the agent parses `EventData` into named columns, splits
account and domain strings out, and stamps its own provenance. Send the same
event through Cribl into a Kind:Direct DCR and those fields are absent unless the
pipeline reconstructs them. Rules, workbooks, hunting queries and UEBA reference
them BY NAME, so a missing enrichment fails exactly the way a wrong
`DeviceVendor` does in item 3: the mapping looks complete and the content
silently never fires.

**Derive the catalog; do not write it from memory.** The field list IS the
deliverable, and a hand-typed one would be both stale and unciteable. Four
sources are already in the tree:

- **What the table holds** - `usecases/workspace-tables`
  `fetchWorkspaceTableSchema` (item 2, core DONE) returns a live table's columns
  as `DestField[]`. ARM is the authority once a workspace is connected.
- **What a DCR will ACCEPT** - the stream declarations in
  `deprecated/Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables/DataCollectionRules(NoDCE)/SecurityEvent.json`
  and `WindowsEvent.json`. This is the offline fallback when no workspace is
  connected, and it is the sharper of the two for this question: a column the DCR
  stream does not declare cannot be populated from Cribl at all, whatever the
  table holds.
- **What the raw event carries** - the sample path, through the existing tagged
  sample acquisition. This is the left-hand side of the diff.
- **What the content REFERENCES** - `coverage-analysis/extract-kql-fields`
  `extractKqlFields` already pulls field references out of rule KQL, and
  `content-requirements` already reasons over them.

The catalog is then (schema columns) minus (what the raw event carries), RANKED
by how much content references each one. The ranking is the point, and it is what
makes this a screen rather than a documentation page: an enrichment nothing
queries needs no reconstruction, while one that forty rules key off is a
deployment blocker. Show the unreferenced fields as unreferenced rather than
omitting them - "nothing uses this" is a finding, and dropping them silently
turns a measured zero into an unmeasured absence, which is item 4 in a new place.

**Worth settling when picking it up:**

- **Does the screen only report, or does it produce?** The end state matching
  item 3's "still owed" note is an enrichment that reaches the GENERATED
  PIPELINE - a function that reconstructs `Account` from the raw fields, say.
  Reporting first is a legitimate slice; just do not let it become the finished
  state, because a catalog that only affects analysis leaves deployed data still
  missing the fields.
- **`SecurityEvent` and `WindowsEvent` are not one problem.** One is the curated
  security-audit set, the other the general-channel table, and their enrichment
  sets will differ with them. Produce both catalogs and let them differ rather
  than assuming one covers the pair.

**Capability gating.** A new route id is available-by-default -
`packages/ui/src/frame/route-capabilities.ts` fails toward reachable - so this
one must opt IN to `table.read`, which the audit already measures. Per rule 3 a
denial ANNOTATES and never hides. Note the unusual shape for a read capability:
the DCR-template path means the screen still does real work under a denial, which
is worth saying ON the screen, since item 2 established that reads normally have
no fallback. If it lists anything, [inventory-standard.md](inventory-standard.md)
is binding.

### 5b. JSON vs Parquet for the Cribl Lake copy

Analyze which format serves data destined for Cribl Lake and queried through
Cribl Federated Search, and put the answer where the operator makes the choice.

The choice is already live in the product and made silently. Source wiring
(GUI-16 in [feature-catalog.md](feature-catalog.md)) optionally creates a Cribl
Lake dataset and a full-fidelity passthru route to `cribl_lake:{dataset}`, and
the lab configs in `domain/labs/lab-cribl.ts` already carry `parquetChunkSizeMB`
and `parquetChunkDownloadTimeout`. Nothing presents the tradeoff or lets it be
reasoned about.

**Verify against Cribl's own docs and API before encoding any of it.** The
dimensions are known - search-time column pruning and predicate pushdown,
compression and storage cost, write-side cost and latency in Stream, and schema
stability, which is the sharp one here because the Windows tables are wide and
sparse while Parquet is columnar and typed. What is NOT known well enough to
encode is how Federated Search actually EXECUTES against each format. Pin that
down the way item 10 says to pin down `InputRest`; do not ship a recommendation
derived from general Parquet knowledge, because the entire value of this is that
it is specific to Cribl's engine. The `cribl-api` skill and the vendored spec at
`packages/core/assets/cribl-openapi.json` are the starting points for what the
dataset and destination expose as format options.

**Why this sits on a WINDOWS screen** rather than being a general Lake setting:
Windows events are the volume case that makes the question worth asking, and the
schema-stability dimension is answerable only against a specific, known-wide
event shape - a general answer would have to hedge on the variable that decides
it. If the analysis turns out to be format-general, promoting it later is cheap;
starting general risks advice too vague to act on.

## 6. Azure Native Source Onboarding menu item

**Requested 2026-08-12; renamed and restructured the same day (user direction).**
Was "Azure Policy". The item holds ONE SECTION PER COLLECTION MECHANISM, and each
section carries per-source CHECKBOXES so the operator picks exactly what to
onboard. Sections 6a-6f below are those categories, researched from the legacy
implementation rather than assembled from memory.

**Name collision - RESOLVED 2026-08-12 (user decision), already applied.** The
plan doc that held this name since 2026-07-02 was renamed to
[features/content-preserving-native-reroute.md](features/content-preserving-native-reroute.md),
which describes its actual subject; the menu item takes the name. References in
`roadmap.md` and `porting-plan.md` were updated, and the doc carries a rename
banner pointing here.

The two remain halves of one flow and must keep cross-referencing: that plan is
the DESTINATION half - keeping Sentinel content working once a native source is
rerouted (`_CL` divergence, UEBA, function aliases) - while this menu item is the
SOURCE half, turning on the Azure-side export so data reaches Cribl at all. They
meet at the Event Hub, and the coupling is concrete rather than thematic:
**ticking the Entra ID box in 6b is exactly what triggers the
content-preservation problem that plan exists to solve.** A build of 6b that
ignores it will silently break Entra content.

**The port has never happened.** Confirmed - this surface exists in
`soc-optimizationtoolkit/` only as catalog entries, with no screen, route or
usecase. The legacy source is `deprecated/Azure/Azure-LogCollection/` (~13,200
lines, production, v5.1.0), catalogued as LOG-01 through LOG-15 plus V1-20 in
[feature-catalog.md](feature-catalog.md). Read those entries before designing -
they are a detailed census of a working implementation, and they already record
the traps.

**The checkbox model exists as a file - port it, do not invent one.**
`deprecated/Azure/Azure-LogCollection/core/resource-coverage.json` is the legacy
single toggle file and its shape is nearly what was asked for: sources grouped by
`method`, each with an `enabled` flag, plus tiers and profiles wherever a source
has sub-selections. Its `method` values ARE the section keys -
`built-in-policy`, `custom-initiative`, `script`, `guided-portal`, `none`. LOG-02
already specifies it porting to the app KV store. Keep two things verbatim: the
tier/profile sub-selections, and the `notSupported` block (see 6e).

**BUILT 2026-08-28 as AZR-0** - `domain/coverage-model`, in two halves that
change for different reasons: `coverage-catalog` is what CAN be ticked (fixed,
ported, shipped in code) and `coverage-selection` is what IS ticked (persisted
to the KV store under `azure-coverage-selection`). What ticking MEANS stays in
`onboarding-selection`, AZR-1's additive-only contract, which this feeds through
`selectedItemIds`.

The port is PINNED AGAINST ITS SOURCE. The tests read the real
`resource-coverage.json` off disk and compare field by field - description,
note, method, resourceCount, the community tier details, the Entra profiles, the
`notSupported` block and the XDR unsupported-tables list. Mutation-checked: a
one-word paraphrase of a description fails, and deleting a ported source fails a
separate completeness pin that walks the legacy file looking for anything the
catalog missed. If the legacy file is ever deleted the pins fail LOUDLY rather
than skipping, with a message saying to remove the "ported not invented" claim
along with them - a provenance claim must not outlive its evidence.

**The legacy file covers four of the six sections, and nothing here pretends
otherwise.** 6a (`built-in-policy` + `custom-initiative`), 6b (`script`), 6c
(`guided-portal`) and 6e (the `notSupported` block) all port. **6d pull
collectors and 6f agent-based have NO entry** - the legacy tool did not do them,
and the only trace is `vmGuestLogs` under `notSupported` pointing at the separate
DCR-Automation solution. They are not stubbed, because an empty section would
report coverage the port cannot back. AZR-7 and AZR-9 are the cards that add
them.

Decoding is deliberately defensive and REPORTS what it drops. A KV value
outlives the code that wrote it, so a stored id the catalog no longer has is
dropped and named rather than discarded silently - silence there would leave an
operator's box unticked while, under the additive-only contract, the thing is
still deployed in Azure. A corrupt or absent value decodes to the defaults, but
a deliberately EMPTY selection stays empty: "onboard nothing" is a real choice
and must not be quietly overwritten with four re-ticked sources.

Not done here: the screen, the KV adapter binding (a shell concern), and the
prerequisite ordering noted at the end of 6h.

### 6a. Azure Policy - diagnostic settings to Event Hub

The bulk of the platform. Policy assigns diagnostic settings across a management
group, resources emit to Event Hub, Cribl reads the hub.

- **Built-in initiative** (LOG-04). Microsoft's Audit initiative
  (`1020d527-...`, 69 resource types) or AllLogs (`85175a36-...`, 140 types).
  One checkbox plus a choice between the two rather than two checkboxes - they
  overlap, and ticking both is not a coherent request.
- **Community initiative** (LOG-05). 44 resource types fetched from
  Azure/Community-Policy and bundled into one custom initiative. Eight tiers,
  which is the natural checkbox grain: **Storage** (Blob/File/Queue/Table
  services, Storage Accounts), **Security** (Firewall, NSG, Application Gateway,
  ExpressRoute, Virtual Network), **Data** (CosmosDB, Data Factory, MySQL,
  PostgreSQL, MariaDB, Synapse Analytics/Spark/SQL, Data Explorer, Databricks,
  Analysis Services, Time Series Insights), **Compute** (App Service, Function
  App, Batch, Machine Learning, Application Insights, Autoscale, DevCenter),
  **Integration** (Logic Apps, Logic Apps ISE, Event Grid topic and system topic,
  Relay), **Networking** (Load Balancer, Traffic Manager, CDN Endpoint), **AVD**
  (Host Pool, Application Group, Workspace, Scaling Plan), **Other** (Recovery
  Services Vault, Azure API for FHIR, Power BI Embedded). Per-service checkboxes
  are available too - `CommunityPolicyMetadata` maps each service to its resource
  type - so the right shape is tier checkboxes with a per-service expander.
- **Supplemental** (LOG-06). The Activity Log, which is subscription-level and
  CANNOT live in a resource-type initiative, plus AKS and PostgreSQLFlexible,
  which the bundled initiative deliberately EXCLUDES (incompatible
  `resourceLocation` Array type). Those two exclusions are the classic silent
  gap - an operator ticking "Security" reasonably assumes AKS came with it - so
  they need to be visible checkboxes, not a footnote.

Mechanics shared by all three, all already recorded in the census: every
assignment needs a user-assigned managed identity plus Monitoring Contributor at
MG scope and Event Hubs Data Owner on the namespace; **DeployIfNotExists fires
automatically only for NEW resources**, which makes bulk remediation (LOG-14)
mandatory rather than a nicety; and compliance data lags 15-30 minutes, so a
freshly deployed selection reads as non-compliant and the UI has to say why
rather than look broken.

**Cleanup (LOG-15) - DECIDED 2026-08-12 (user): PREVIEW-ONLY FIRST.** The legacy
path removes matching diagnostic settings across every subscription under a
management group, behind a typed `DELETE`. The port ships the useful half and
none of the blast radius: enumerate and display exactly what WOULD be removed,
grouped by resource type and target namespace, and stop there. **No delete
capability in the GUI in this pass.** Extend later only if the preview proves the
need - and if it is ever extended, the typed confirmation comes with it rather
than being redesigned into an ordinary button.

Note this makes the preview a genuinely useful standalone tool: policy
assignments recreate settings after removal, so knowing what exists and what
would be affected is most of the value an operator needs before dropping to the
legacy script to act.

### 6b. Direct ARM configuration - script, no policy

Sources configured by a direct ARM PUT rather than through policy. Both carry
`needs-proxy` (the easiest verdicts in the census) and both already exist as raw
REST calls, so they port close to one-to-one.

- **Entra ID tenant diagnostics** (LOG-07). One tenant-level setting on
  `microsoft.aadiam`. Checkbox grain is the CATEGORY, with the legacy profiles as
  presets: **Standard** (9 - AuditLogs, SignInLogs, ServicePrincipal and
  ManagedIdentity sign-ins, ProvisioningLogs, RiskyUsers, UserRiskEvents,
  RiskyServicePrincipals, ServicePrincipalRiskEvents) and **HighVolume** (15 -
  adds NonInteractiveUserSignInLogs, ADFSSignInLogs, NetworkAccessTrafficLogs,
  EnrichedOffice365AuditLogs, MicrosoftGraphActivityLogs). **Non-interactive
  sign-ins are 5-10x the volume of the rest** and that warning belongs at the
  checkbox, not in a footnote. Requires Entra Security or Global Admin - surface
  it as a precondition check. Drift to resolve while porting: LOG-07 documents a
  third profile, SecurityOnly (6 categories), that `resource-coverage.json`
  `_profileOptions` omits. (The HighVolume enumeration above listed five
  additions for a count of 15; the script adds SIX - `RemoteNetworkHealthLogs`
  was missing from the prose. Corrected 2026-08-28 while building AZR-2; the
  count was right, so only the list was misleading.)

**BUILT 2026-08-28 as AZR-2, the tracer bullet** - `domain/entra-diagnostics`.
One tenant-level ARM PUT to `microsoft.aadiam/diagnosticSettings` at
api-version 2017-04-01, ported close to one-to-one as LOG-07 predicted.

**The drift is resolved in favour of the SCRIPT**, which is the thing that
actually ran: all three profiles ship, with members taken verbatim from
`$SecurityLogCategories` (6), `$StandardLogCategories` (9) and
`$HighVolumeLogCategories` (15). The tests read the legacy `.ps1` off disk and
compare, the same provenance approach AZR-0 used. The coverage catalog keeps
offering the two profiles it always did, because changing what an existing
stored selection MEANS is a separate act from making a third preset available.

**The two consequences ride their categories.** The 5-10x warning sits on
`NonInteractiveUserSignInLogs` itself, and only two of fifteen categories carry
a volume warning at all - pinned, so it cannot drift upward one
sympathetic-looking category at a time until the warning is noise. The UEBA
consequence names the TABLE per category rather than warning vaguely about
sign-ins: exactly four categories are UEBA-bound (`AuditLogs`, `SigninLogs`,
`AADServicePrincipalSignInLogs`, `AADManagedIdentitySignInLogs`), and
`NonInteractiveUserSignInLogs` is deliberately NOT one of them. That last point
has its own pin, because it is the plausible-sounding fabrication: it is the
loudest sign-in category, so it reads as though it ought to carry the warning,
and a claim that survives on sounding right is the kind this repo keeps having
to unpick.

**THE FINDING THIS SLICE SURFACED, as AZR-2 predicted it would.** Writing the
setting needs an Entra DIRECTORY role - Security Administrator or Global
Administrator. The permission preflight reads Azure RBAC effective actions from
`Microsoft.Authorization/permissions` at an ARM scope. Entra directory roles are
not ARM role assignments; they appear in no scope's response and cannot be
derived from one. This is not a coverage gap a new capability entry would close.

So it is modelled as UNMEASURABLE, not unmeasured, and the distinction is the
whole point: "unmeasured" invites someone to add a probe, while
"unmeasurable by this evaluator" points at Microsoft Graph - the `GraphDirectory`
port, which today lists service principals only. Reporting it as an ordinary
unchecked capability would be a preflight returning green for something it never
examined, which is item 4's confident-wrong-answer shape. The honest consequence
is that this deploy cannot be gated on a measured capability: it states the
requirement, attempts the PUT, and reports an authorization failure faithfully.

One tension worth recording because it looks like a contradiction and is not:
the PUT sends EVERY category with `enabled` reflecting the selection, including
`enabled: false` for unticked ones. The setting is a full replacement, so a
category omitted from `logs` keeps whatever it had - sending only the ticked
ones could never turn anything off, and an unticked category would keep flowing
while the UI showed it as off. AZR-1's additive-only contract governs what a
CHECKBOX may DESTROY; writing `enabled: false` into a setting that already
exists destroys nothing, and nothing here deletes the setting.

Not built: the screen, and the Event Hub namespace this points at (LOG-03,
which most sections need first - see the prerequisite ordering note in 6h).
- **Defender for Cloud continuous export** (LOG-08). Per subscription, a
  `Microsoft.Security/automations` resource streaming Security Alerts, with
  Recommendations, Secure Score and Regulatory Compliance as three more
  checkboxes. It detects which of 12 paid plans are enabled and **never enables
  one** - keep that property and show the plan report, because the alternative is
  a tool that silently starts billing.

### 6c. Defender XDR export - guided portal

Checkbox grain is the TABLE, grouped by product, with the export tiers as
presets. Both catalogs are pure data in `resource-coverage.json` and port as-is:

- **Products**: Defender for Endpoint (DeviceEvents, DeviceInfo,
  DeviceLogonEvents, DeviceNetworkEvents, DeviceProcessEvents, DeviceFileEvents,
  DeviceRegistryEvents, DeviceImageLoadEvents, DeviceFileCertificateInfo,
  DeviceNetworkInfo), Defender for Identity (IdentityLogonEvents,
  IdentityQueryEvents, IdentityDirectoryEvents), Defender for Office 365
  (EmailEvents, EmailAttachmentInfo, EmailUrlInfo, EmailPostDeliveryEvents),
  Defender for Cloud Apps (CloudAppEvents), and XDR unified alerts (AlertInfo,
  AlertEvidence, UrlClickEvents).
- **Tier presets**: T1 essential (AlertInfo, AlertEvidence, DeviceProcessEvents,
  DeviceNetworkEvents, DeviceLogonEvents, IdentityLogonEvents, EmailEvents), T2
  recommended, T3 situational.
- **Volume warnings ride specific checkboxes**, not the tier: DeviceImageLoadEvents
  is ~100+ GB/day per 1K endpoints, IdentityQueryEvents is high-volume noise from
  normal AD operations. These are the two the legacy tool calls out by name.
- **Not available in the Streaming API at all**: BehaviorEntities, BehaviorInfo,
  and the TVM (vulnerability/software inventory) tables. Show them as
  unavailable with the reason rather than omitting them - see 6e.

**Path A (RECOMMENDED) for alert data.** Defender XDR streams to an Event Hub and
Cribl reads it with an Event Hub source - PUSH, not poll, which is the whole
reason it ranks ahead of 6d for alerts: no 5-minute schedule, no latency floor to
explain, and no repeat-delivery dedupe rule for an operator to get wrong.

This is LOG-09, from
`deprecated/Azure/Azure-LogCollection/core/Deploy-DefenderXDRStreaming.ps1` - the
same legacy subsystem as the policy scripts, which is what makes this section a
peer of 6a rather than a bolt-on. Read LOG-09 before designing. What carries
over:

- **Validate licences first** via Graph `subscribedSkus` against embedded SKU
  lists, per product (MDE/MDI/MDO/MDCA). Then PROBE actual usage - onboarded MDE
  machines, MDI sensors, recent incidents via `security/incidents` - because a
  licence held is not a product in use, and streaming a product nobody runs
  produces an empty hub and a support ticket. This probe is what should DISABLE
  or annotate the product's checkboxes, which is the capability model's
  annotate-never-hide rule applied to licensing.
- **Create a dedicated XDR Event Hub namespace** (`cribl-xdr-{subId8}` in the
  multi-region shape).
- **Create the Cribl Event Hub source directly** through the Cribl API rather
  than exporting `xdr-streaming-config.json` for someone to import by hand. This
  is LOG-09's own portability note and it is the right call.

**The irreducible constraint: Microsoft exposes NO configuration API for XDR
streaming.** The final step happens in the Defender portal, by hand. Any port
keeps it. So "recommended" does NOT mean "more automatable" - the app can
validate, provision the namespace, and create the Cribl source, but it must then
hand over a guided checklist with the exact Resource ID and copy buttons. This
also means the CHECKBOXES IN THIS SECTION ARE A WORKLIST, not a deployment: what
they produce is the operator's portal to-do list. Design that seam deliberately
instead of discovering it late; a wizard implying it finished the job when a
portal visit is still owed is the same category of confident wrong answer as
item 4.

Graph access needs a `graph.microsoft.com` proxy domain with
`Organization.Read.All` and `SecurityEvents.Read.All`.

### 6d. Pull collectors - no push path exists

Sources with no Azure-side export to turn on at all: Cribl has to go and fetch
them. Nothing in this section deploys anything into Azure, which makes it the odd
section out - the checkboxes here create CRIBL config, not Azure config.

- **Sentinel incidents** - path B below.
- **Resource Graph change tracking** - `resource-coverage.json` records it under
  `notSupported` as query-only with no streaming path, alternative "scheduled
  Azure Resource Graph queries". If it is offered at all it is a second scheduled
  collector, and it lands on the same unmeasured-Resource-Graph capability gap
  already recorded in items 1 and 4.

**Path B (SECONDARY) for incident data - the incidents API via a Cribl REST
Collector**

Pull Sentinel incidents with a Cribl REST/API Endpoint Collector. The request as
given, and it is a specification rather than a sketch - each point below is a
default that is wrong:

```
GET https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/providers/
    Microsoft.OperationalInsights/workspaces/{ws}/providers/Microsoft.SecurityInsights/
    incidents?api-version=2025-09-01
    &$filter=properties/lastModifiedTimeUtc ge {earliest}
    &$orderby=properties/lastModifiedTimeUtc asc&$top=1000
```

- **Auth**: app registration + client credentials against
  `https://management.azure.com/.default`, role **Microsoft Sentinel Reader**
  scoped to the workspace. The collector's OAuth login handles token refresh -
  do not build token handling beside it.
- **Paginate on `nextLink`** (`$skipToken`).
- **Filter on `lastModifiedTimeUtc`, NOT `createdTimeUtc`.** This is the one that
  silently produces a plausible wrong answer: filtering on creation misses every
  UPDATE to an already-open incident, so the collector reports steady state while
  all triage activity stays invisible.
- **Corollary - repeat deliveries are expected and correct.** The same incident
  arrives again on every modification, so dedupe DOWNSTREAM on `name` (the
  incident GUID) + `lastModifiedTimeUtc`. A pipeline that treats repeats as
  duplicates-to-drop would discard exactly the updates that filtering on
  lastModified exists to catch.
- **Schedule every 5 minutes.** That is the latency floor, and it should be
  stated as such wherever the schedule is presented rather than left as a number
  someone tunes without knowing what it costs.

**What already exists to build on.** `domain/labs/lab-cribl.ts`
`buildLabFlowLogCollector` is a working precedent for GENERATING a scheduled
collector: a `type: "collection"` job carrying `schedule.cronSchedule`,
`run.timeRangeType: "relative"` with `earliest`/`latest`, and a `collector.conf`
with `authType: "clientSecret"`. The incident collector is that shape with a REST
conf instead of a blob one, and the relative window is how `{earliest}` gets
filled. Heed item 10's warning that `InputRest` has no schema under that name in
the vendored spec - collectors are modelled as collection jobs, which is what
this precedent already builds, so pin the conf against
`packages/core/assets/cribl-openapi.json` instead of hand-writing it.

#### 6c and 6d are probably COMPLEMENTARY, not alternatives - verify this first

This is the question that decides how the two are presented, and it should be
settled before either is built. Our own catalog describes XDR streaming as
carrying **alerts** (LOG-09: "MDE/MDI/MDO/MDCA/XDR alerts"), while path B returns
the Sentinel **incident** object - severity, classification, owner, incident
number, the triage state a SOC actually works. Those are different things at
different grains, and if the streaming export carries no incident-level object
then path A cannot replace path B for incident data no matter how it is ranked.

Verify against the APIs rather than reasoning it out: does the XDR streaming
export carry an incident-grain table, or only alert-grain ones? If only alerts,
then the honest presentation is "alerts via A, incidents via B", both offered,
and the recommendation applies to the ALERT half only. Getting this wrong in
either direction is costly - presenting A as a replacement loses incident triage
state silently, presenting them as unrelated makes an operator build two
overlapping feeds without being told they overlap.

Also worth checking while in there: the incidents API returns an incident that
REFERENCES its alerts rather than embedding their detail, with alerts and
entities as separate sub-resources. A SOC consuming incidents downstream usually
wants the entities, and discovering that after path B ships means a second
collector and a join. Microsoft Graph `security/incidents` - which LOG-09 already
calls for its usage probe - is a third shape worth pricing while answering this,
though it is not one of the two paths requested.

### 6e. Blob-only sources - cannot reach Event Hub

**vNet Flow Logs** and **NSG Flow Logs** write to a Storage Account and have no
Event Hub path at all. The mechanism is a Cribl Azure Blob source, and the repo
already has the working shape: `vnet-flow-collection` in the architecture
patterns, the legacy `Azure/dev/vNetFlowLogDiscovery`, and `blob-collector` /
`buildLabBlobCollectorSource` in `domain/labs/lab-cribl.ts`.

**The `notSupported` block is a FEATURE of the legacy config, not an omission -
port it as such.** `resource-coverage.json` lists four things that cannot stream
to Event Hub and names the alternative for each: vNet Flow Logs and NSG Flow Logs
(blob source), Resource Graph change tracking (scheduled query), and VM guest OS
logs (AMA + DCR, see 6f). An operator who ticks through every section and cannot
find flow logs concludes the tool missed them; a greyed row reading "Storage
Account only - use the Blob source, here" answers the question instead. This is
the same honesty rule as item 4: the absence of a source must be stated with its
reason, never left as silence.

### 6f. Agent-based - AMA plus DCR

**VM guest OS logs** (SecurityEvent, WindowsEvent, Syslog) reach Sentinel through
the Azure Monitor Agent and a Data Collection Rule, not through diagnostic
settings or policy. `resource-coverage.json` files this under `notSupported` with
the alternative "use the DCR-Automation solution" - and in this codebase that is
not a foreign tool, it is the app's OWN `dcr-automation` and `integrate` routes,
plus the `windows-ama-direct` and `direct-dcr` architecture patterns.

So this section should LINK rather than duplicate, and it is the natural place to
surface item 5: the Windows Event analysis screen catalogs exactly what the agent
adds on this path, which is the question an operator ticking this box is about to
hit.

### 6g. Dataflow diagrams, one per category

**Requested 2026-08-12.** The Dataflow page gains a diagram per category above,
so each section can show what its mechanism actually looks like end to end.

**Do not build a new diagram implementation.** The house standard is this repo's
own `packages/ui/src/screens/architecture/`, and both the renderer and the
layout already exist. The work is DATA: new entries in
`domain/architecture-patterns/architecture-patterns.ts` (27 patterns today),
following the existing node/tier vocabulary, plus presets in
`ARCHITECTURE_PRESETS` where a category deserves a one-click story. The pure
snapshot-to-graph rule holds - no fetch, no React, no `Date`/`Math.random` in the
builder, so routing stays unit-testable.

Partial coverage already exists and should be extended rather than duplicated:
`event-hub-fanin`, `entra-reroute` (Entra, content-preserving), the
`azure-platform-fanin` preset ("platform diagnostics and Entra ID exports stream
into Event Hubs"), `vnet-flow-collection`, `blob-collector`, `windows-ama-direct`
and `direct-dcr`. What has no diagram today: the POLICY mechanism itself (6a -
assignment at MG scope, DeployIfNotExists, the managed identity, remediation for
pre-existing resources), Defender for Cloud continuous export (6b), Defender XDR
streaming with its manual portal step (6c), and the pull collectors (6d).

Two things worth drawing honestly, because they are where a generic
"everything flows to the hub" picture would mislead:

- **The manual portal step in 6c.** The diagram should show it as a step, not
  imply an automated edge that does not exist.
- **6d flows the other way.** Every other category is Azure pushing to a hub;
  the pull collectors are Cribl reaching into Azure on a schedule. A diagram set
  that draws them all left-to-right identically teaches the wrong model.

### 6h. Shared concerns

**Unchecking - DECIDED 2026-08-12 (user): ADDITIVE-ONLY, with a separate Remove
action.** Checkboxes only ever DEPLOY. Unticking a box removes it from the
desired selection and does nothing to Azure; teardown lives in an explicit,
separately-confirmed Remove action. **No checkbox in this item may ever destroy
anything**, which is the property to pin with a test.

This matches how the legacy tool already split the work - deployment flags and
`-RemoveAssignments` / `-RemoveSetting` / `-RemoveExport` / `-RemoveNamespaces` /
`-RemoveInitiative` were always distinct invocations, never a toggle. Two
consequences to design for: the UI must distinguish "not selected" from "not
deployed" (they are different states now, and conflating them is item 4's
confident-wrong-answer shape again), and there is no undo path via the
checkboxes, so the Remove action needs to be discoverable enough that people do
not go looking for one.

**BUILT 2026-08-28 as AZR-1** - `domain/onboarding-selection`, ahead of the
checkbox screen rather than after it, so no UI ever existed without the rule.
`deployPlan(desired, deployed)` is deliberately HALF a diff: it adds what is
selected and not yet there, and reports everything already deployed as either
`unchanged` or `leftInPlace`. Unticking moves an item to `leftInPlace` and
nothing else.

The contract is carried by the TYPE first. `DeployPlan` has no removal field, so
a removal is not something the deploy path declines to emit - it is something it
cannot express. Adding one requires editing the interface, which `tsc` catches
(TS2353, confirmed by trying it) and a pin catches after that. Teardown lives in
`removalPlan(request, deployed)`, which takes the ids explicitly plus
`confirmed: true`; an empty list is refused as "remove nothing" rather than read
as a wildcard, which is the usual shape of this bug.

The four states are named once, in `itemState`: `unselected`, `pending`,
`deployed`, `deployed-unselected`. The last is the one the decision exists to
keep visible - it is what unticking produces, it is still emitting into the
workspace, and rendering it as `unselected` is the data-loss bug wearing a
checkbox. Pinned exhaustively over all 64 (desired, deployed) pairs of a 3-item
universe, which for a set-membership rule is a proof rather than a sample.

Two things here are still NOT built: the discoverability of the Remove action,
which is a screen concern and has no screen yet, and the prerequisite ordering
noted at the end of this section, which nothing addresses.

**Capability gating - DECIDED 2026-08-12 (user): ADD THE CAPABILITIES AND THEIR
PROBES.** This settles the open question carried in items 1 and 4 as well - it
was the same question three times, and the answer is the same one. Extend the
taxonomy past 11 rather than reusing neighbouring capabilities or leaving
surfaces unmeasured.

What this item needs added: policy assignment and remediation
(`Microsoft.Authorization`, `Microsoft.PolicyInsights`), managed-identity
creation, Sentinel incident read (Microsoft Sentinel Reader is modelled nowhere -
`domain/azure-permissions` knows only the CONTRIBUTOR actions `alertRules/write`
and `onboardingStates/write` used by content install), Graph scopes for licence
validation (`Organization.Read.All`, `SecurityEvents.Read.All`), and Resource
Graph - which is the capability items 1 and 4 already wanted for Event Hub
discovery and the unmeasured listers. Already measured and reusable: Event Hub
namespace creation is `arm.deploy`; every Cribl-side write here, Event Hub source
or REST collector, is `source.manage`.

Each new capability needs a preflight PROBE, not just a name - an unprobed
capability contributes nothing per the step-2 mapping rule (only measurements are
recorded). The existing rules carry over unchanged: writes come only from
effective actions, reads prefer probe results, and rule 3 holds throughout -
annotate, never hide, never disable. Do this work ONCE, as a taxonomy extension
serving all three items, rather than three times per surface.

**Cribl source creation - DECIDED 2026-08-28 (user): WRITE WHEN CONNECTED,
EXPORT WHEN NOT.** AZR-S2, which constrained 6a, 6b, 6c and 6e. The app creates
the Event Hub / Blob source over the Cribl API when it has a workspace to write
to, and falls back to generated config the operator imports when it does not.

Not a new stance - the SAME convention `secret-provisioning` already settled on
2026-07-03: one convention, two delivery paths, connected writes through the
Cribl API and air-gapped emits an artifact with a placeholder to fill in by
hand. Choosing it here means the onboarding sections behave the way the deploy
path already behaves, instead of the codebase carrying a third opinion about
what to do when there is no Cribl to talk to.

It also refuses the two halves of the false choice. Pure export leaves 6a, 6b,
6c and 6e each ending at a manual import step, which backlog.md#6c already calls
the wrong call and LOG-09's portability note argues against. Pure API makes an
air-gapped install impossible, and air-gap is a shipped path with its own export
module, not a hypothetical.

What it commits to building: a `POST /system/inputs` applier gated on
`source.manage`, which is net-new - every `/system/inputs` reference in the
codebase today is a read, and Event Hub Discovery ends at a JSON download
(`eventhub-discovery-screen.tsx`). The write-side plumbing it can lean on
already exists in `usecases/guided-deploy/wire-source.ts` and
`secret-provisioning.ts`.

The connectedness test must be the SAME one the rest of the app uses, not a new
probe: two answers to "is there a Cribl here" is the duplicated-decision shape
the capability model was built to end.

**Prerequisite ordering is real and mostly implicit.** Nearly every section needs
an Event Hub namespace (LOG-03) to exist first, and the policy sections need
Policy Contributor plus User Access Administrator at MG scope. LOG-02's
"Deploy All" ran the components in a fixed order for this reason. Checkboxes
scattered across six sections lose that ordering unless it is made explicit.

**`eventhub-discovery` already exists** as a screen and knows how to find Event
Hubs; several sections here create one and wire a source to it. Check for overlap
before building a second Event Hub surface beside it.

## 7. Verification gaps

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

**Local shell in a browser - VERIFIED 2026-08-06.** `npm run local`, <!--drift-ok--> host on
:4600. AUA, the two-phase wizard (Target -> Connect, no Mode step), the
permission check as the final view, Get Started, and into the frame. This shell
had never been run in a browser at all, and the mode removal touched its gate
flow.

> RETIRED 2026-08-17 (ADR-0002): the local shell is gone and `npm run local` <!--drift-ok--> no
> longer exists, so neither this walk nor the `unchecked` nav-state observation
> above can be reproduced as written. The nav-state evidence still stands - the
> annotated states live in shared @soc/ui code, not in the removed shell - but
> the CHEAPEST way to produce an Azure-identity-without-Cribl-token state went
> with it. Reproducing `unchecked` in the cloud shell now costs a throwaway
> connection profile in KV, the same cost already noted above for
> `not connected`.

**`labSubscriptionHash` is 16 bits - DECIDED 2026-08-12, no change.** It takes 4
hex chars of a 32-bit FNV-1a to disambiguate Azure resource names per
subscription, so the space is 65,536 and a birthday collision arrives around 300
subscriptions. Reviewed while fixing the pack sample-id collision, which came
from the same family of defect, and deliberately left alone for two reasons: it
slices the HIGH nibbles, which FNV avalanches well (the sample-id bug came from
consuming the LOW bits mod 62 across six correlated hashes), and a collision
surfaces as an Azure name conflict at deploy - loud, not silent. Revisit only if
lab provisioning ever needs to be idempotent across many subscriptions, where a
name clash would stop being a visible failure and start being a silent reuse.

## 8. Release hygiene

**Release drift is CHECKED as of 2026-08-24.**
`apps/cribl-app/scripts/check-release-drift.mjs`, run by CI on every PR touching
`soc-optimizationtoolkit/**`. It reads the packaged tarball's version and holds
four claims to it - `package.json`, the single tarball in `release/`, a
`## X.Y.Z` section in [release-notes.md](release-notes.md), and the
"**X.Y.Z IS CURRENT**" line further down this entry - failing when any of them
names a different version. A FIFTH claim holds `package-lock.json` to
`package.json`'s version rather than to the tarball's, because npm copies that
field into the lock verbatim: the lock is a statement ABOUT the manifest, and the
manifest is already held to the tarball by the first claim, so the two chain
rather than opening a second front. Comparing the lock to the tarball instead
would report a hand-bump twice - once as the bump, once as a lock that faithfully
recorded it.

That pointer read "the 'IS CURRENT' line directly below" until 2026-09-03, by
which point it was directing readers past four intervening paragraphs - this note
among them. It was already loose when committed, with one paragraph in between,
and each addition to this entry moved it further. The first draft of this
correction quoted the exact line distance; writing it moved the line and made the
number wrong, which settled the wording: name the line by its SHAPE, count
nothing. That is the same reason the script matches on the shape rather than on a
version.

**Running it locally.** `npm run check-release` from `soc-optimizationtoolkit`
works, as does the longer `npm run check-release --workspace apps/cribl-app` -
which is what CI runs - and a bare `npm run check-release` from `apps/cribl-app`.

The short form only became true on 2026-09-03, and the ten days before that are
the point. Alone among its siblings (`check-board`, `check-docs`,
`check-listings`, `check-schema-asset`, `check-board-freshness`), `check-release`
was never forwarded in the root `package.json`, so the plain command exited 1
with "Missing script". This entry had been telling readers to run it that way
since the check was written on 2026-08-24 - the original sentence said the check
was run "by CI ... and by `npm run check-release` locally". The instruction was
wrong the day it was written and stood uncorrected for ten days with no card
against it. The failure was LOUD - an npm "Missing script" error, not a silent
pass - so this is not a case of a gate quietly reporting green. What it cost is
that the pre-push check was simply unavailable to anyone who followed the
instruction: they either knew to add the workspace flag or found out from CI
instead. Fixed under [[DBT-90]] by adding the forward; the sibling list above is
what made it obvious, since every other check that HAS an npm script had a
forward too.

That qualifier was doing real work, and the case it pointed at is now closed.
**`apps/cribl-app/scripts/check-classnames.mjs` ([[DBT-39]], added 2026-08-31) was
wired on 2026-09-04 under [[DBT-100]].** It is forwarded in BOTH manifests - a
`check-classnames` script in `apps/cribl-app/package.json` and a forward in the
root `soc-optimizationtoolkit/package.json` - and it runs in CI as the step
"Check class names", between "Check schema asset" and "Test" in
`.github/workflows/soc-toolkit-ci.yml`. All three invocation forms were measured
on 2026-09-04 and all three exit 0: `npm run check-classnames` from
`soc-optimizationtoolkit`, the same command from `apps/cribl-app`, and the
`--workspace apps/cribl-app` form CI uses. A repo grep for `check-classnames`
(`git grep -l`) now returns EIGHT tracked files: the workflow, both manifests, the
script AND its test file, this document, and `board.json` with its rendered
`board.md`. The script is in that list only because the same change that wired it
up added a "HOW IT RUNS" note naming the npm script; before that it never wrote
its own name, which is why this document was the first place a grep could land,
and why
the state of the check has to be stated here accurately rather than left to be
inferred from a commit.

**The prose that stood here until 2026-09-04 was false line by line, and it
predicted so itself.** It said there was no npm script and no CI step; both now
exist. It said a repo grep found the file in exactly two files; the answer is
seven. It said running it exits 1 reporting 36 findings; it exits 0. That
paragraph had congratulated itself for being self-checking - "a claim about the
whole repo that the claim itself falsifies is the same defect as the rest of this
section" - and the trap it named is the one it fell into: a measured count written
into prose is true for exactly as long as nobody changes the thing measured. The
lesson worth keeping is not "count fewer things", it is that a document whose
claims are checkable by grep needs a reader to actually run the grep before
trusting the paragraph, and that [[DBT-88]]'s idea - a gate that reads a claim out
of prose and tests it - is the only thing that makes such a sentence durable.

**THE 36 DID NOT GET FIXED; THE QUESTION CHANGED, AND THAT IS THE SUBSTANCE OF
DBT-100.** The old count asked "does this class NAME resolve to a rule?" and
answered 36 times, asserting of each that the element renders bare. Measured
against the tree, that assertion was false for most of them: they name an element
that a DIFFERENT class on the same element already styles, so nothing rendered
bare and there was nothing to fix. Worse, the advice attached to it ("delete it")
would have broken the suite - several of the names are live test selectors, and
`numbered-section.dom.test.tsx` asserts `className === "numbered-section-body"` by
string equality. Asking it per ELEMENT instead - a name with no rule is a defect
only when nothing else on that element carries one - gives FOURTEEN bare elements
on the tree of 2026-09-04, measured with an empty baseline. Twenty-nine names
still resolve to nothing and are reported as an ungated note, because the element
they sit on is styled by a sibling. The narrowing was calibrated against the tree
at `864facb^`, where the `.identity-mismatch-block` defect is live: it yields 17
error elements there and still names all three `identity-mismatch` classes, so it
did not narrow past the defect it exists to catch.

**What is recorded, and what is still open.** The fourteen are held in
`UNDECIDED_BARE` in the script, as THIRTEEN path-plus-name entries - the two
numbers differ because `gap-overflow-triage` is bare at two separate lines of
`overflow-triage-block.tsx`. Both are stated because the first version of this
wiring stated only "13", in the CI comment and in the script header, and claimed
the gate would fail on the fourteenth: the fourteenth already existed and passed,
because an entry keyed on path and name with no line and no count absorbs any
number of elements sharing that name in that file. Each entry now carries an exact
count, so a further bare element under a recorded name FAILS the step, and a count
left higher than the truth fails it too - an entry larger than the residue is a
slot held open for the next one. NONE OF THE FOURTEEN HAS BEEN SHOWN TO BE A
DEFECT and none has been shown to be harmless; four sit on an `a`, a `tr`, a `td`
and a `details`, all of which pick up user-agent styling or an ancestor selector
this check cannot model. Deciding them needs the design intent of each screen's
owner, and NO CARD OWNS THAT YET.

So DBT-39's own four names - `pack-card`, `pack-card-head`, `dcr-progress-line`,
`identity-row-editable` - were deleted in the SAME commit that added the script,
and the rest were LEFT STANDING rather than accrued afterwards. What went unfixed
for four days was the RECURRENCE that card called "THE REAL FIX": the check was
written and then wired to nothing, so it reported to nobody. [[DBT-61]] had named
the trap on the day the script landed, citing it directly - "reports 36
pre-existing findings and therefore cannot be wired into CI until they are
triaged. A gate that starts red never becomes a gate." That diagnosis was right
about the danger and wrong about the only way out: the third option, taken here,
is to record the residue by name with a count and gate everything else, so the
gate starts green without anything being declared clean. It was a level worse than
what the `check-release` case above describes - that was a working check behind a
missing forward, this was a check nobody could invoke by name at all.

NOTHING GUARDS THIS. No gate reads a command out of prose and tries it, so a
document naming a script that does not exist stays green. That is the same family
as [[DBT-88]] - prose about this check decaying with nothing failing - but it is
NOT the check DBT-88 scopes. DBT-88 proposes pinning the claim COUNT and the list
of held files, both derivable from the script; a command is a different fact,
checkable by extracting `npm run X` from the docs and asserting X resolves. The
hard half is knowing which directory the surrounding prose means - `npm run
check-release` is correct from two directories and wrong from the third - which
is why that is filed as [[DBT-101]] rather than settled in this paragraph. That
card now has a second unpinned command to cover: this section documents
`npm run check-classnames` as well, and deleting either forward would leave every
gate green while both documented commands exit 1.

**The lock claim was added 2026-09-02, and it costs a manual step.** The lock was
found recording 1.11.5 while `package.json` said 1.12.3. The argument against
checking a GENERATED file was taken seriously first - a claim on one fails
whenever somebody forgets to regenerate it, which is how a check gets bypassed
rather than obeyed - and it lost on THREE measurements, the same three the
script's header numbers, in the same order. (1) The drift window is one moment,
the release commit, because `package.mjs` writes the version and never invokes
npm, while ordinary dependency work already forces an `npm install`. (2) It does
not self-correct: the lock sat at 1.11.5 across FOURTEEN subsequent releases,
1.11.6 through 1.12.3, before an agent noticed it by accident. (3) The damage is
exactly the damage this check exists for and no more - `npm ci` accepts the
mismatch (measured on npm 11.4.2 - exit 0, lock untouched) and the lock never
ships inside the tgz, so nothing breaks except that a tracked file states a
version that is not the version. The full argument is in the script's header.
The cost, stated rather than buried: THREE of the five claims are now kept true
by hand where two were. The root fix is `package.mjs` regenerating the lock as it
already writes `package.json` and `release/`, at which point this claim guards an
automated fact instead of a chore; until that lands, the packaging procedure
below carries the step.

**Unreleased source WARNS and never fails**, which is the one rule to keep if
this is ever rewritten: a feature branch normally carries source the last package
does not, so failing there would mean packaging on every branch to stay green,
which is how a check gets disabled rather than obeyed. When git cannot count -
a shallow clone has no history - the run says so rather than printing the clean
line a measured zero would print, because this repo's own inventory standard
applies to its tooling too. The pins live beside it in
`check-release-drift.test.mjs`, and the pure half takes facts so the cases can be
stated without a repo, a git history or a tarball.

**1.12.6 IS CURRENT (2026-09-04).**
`release/soc-optimizationtoolkit-1.12.3.tgz` - a pack rebuild now REPLACES
rather than merges, so it no longer inherits the previous build's orphaned
pipelines, on top of 1.12.2's working Cribl Lake sample source, 1.12.1's
guid-column cast (ADR-0004) and 1.12.0's ADR-0003 in full.
Release notes in [release-notes.md](release-notes.md), started as an accumulating
file at 1.4.0 and now current through 1.12.3.

Both version claims in the two lines above were STALE until 2026-09-03: they
named the 1.12.1 tarball and 1.12.1 notes while `release/` held 1.12.3 and the
notes ran to 1.12.3. The check above stayed green throughout, because it reads
the "IS CURRENT" number and nothing else on these lines - so the entry warning
that hand-maintained version claims decay was itself carrying two decayed ones.
Widening the check to the tarball FILENAME named here would have caught it.

Note for anyone running 1.12.0: it does NOT contain the guid fix. Any DCR
deployed from it still drops guid-typed columns, and the affected table columns
stay null with no error raised. Upgrade before deploying.

THREE TIMES, and that is why the check above exists. This line said "1.5.4 IS
CURRENT" until 2026-08-17, by which point the app was at 1.11.11 - six minor
versions and about a week of work later. It was corrected to 1.11.11 that day,
the 2026-08-18 architecture audit found it stale AGAIN at three patch versions
behind inside a single audit window, and it was stale a third time by 1.12.0.
The release notes had likewise stopped at 1.9.0 and were written forward to
1.11.14 in one pass.

That is the entry becoming its own best evidence three times over: a
hand-maintained version claim decays exactly as fast as the automated one it
warns about, and nothing tells anyone. This entry's own instruction was to treat
a third correction as proof the check should have been built instead - so the
third correction built it.

**DO NOT HAND-BUMP THE VERSION BEFORE PACKAGING.** `npm run package` IS the
bump: `scripts/package.mjs:73` increments the patch itself (`--minor`, `--major`
and `--version X.Y.Z` override it). Editing `package.json` first and then
running package double-bumps - done 2026-08-18 while shipping 1.11.15, which
landed on 1.11.16 and had to be rolled back. Nothing warns; the tgz name is the
only place the doubled number shows up, and `release/` gets pruned to it, so the
wrong version becomes the shipped one quietly. Bump by running the script.

**AFTER `npm run package`, RUN `npm install --package-lock-only` AND COMMIT THE
ONE-LINE LOCK CHANGE.** `package.mjs` bumps `apps/cribl-app/package.json` and
writes the tgz but never invokes npm, so without this step every release commit
leaves `package-lock.json` naming the PREVIOUS version and `check-release` red.
That check runs in CI on every PR touching `soc-optimizationtoolkit/**`, so the
consequence is a blocked PR, not a local nuisance. Measured 2026-09-02 in an
isolated sandbox mirroring the layout: a faithful 1.12.3 -> 1.12.4 release with
the lock left as npm left it exits 1 with "package-lock.json records the app at
1.12.3 but package.json says 1.12.4"; running the command turns the same tree
green. Run it from `soc-optimizationtoolkit` or from `apps/cribl-app` - npm walks
up to the workspace root either way, also measured - and prefer
`--package-lock-only` over a bare `npm install` because it is the minimal command
that fixes this and only this. NOT because the bare form rewrites the lock: in
the same sandbox, seeded at manifest 1.12.4 / lock 1.12.3, the two commands wrote
a BYTE-IDENTICAL lock - same sha256, and the same SINGLE changed line, the
`apps/cribl-app` version field: one deletion and one insertion, which is the
one-line change the heading above asks you to commit. Re-measured 2026-09-03 on
npm 11.4.2 / node 24.4.1, from both directories. The difference is
`node_modules`, which the bare form resolves and installs and
`--package-lock-only` never creates. This step disappears when `package.mjs`
regenerates the lock itself.

**`release/` HOLDS EXACTLY THE LATEST TGZ** - a user directive from 2026-07-30,
enforced by `package.mjs`, which prunes older tarballs on every run. Publishing
1.5.2 through 1.5.4 the prune was worked around three times (restoring the older
tarballs on the reasoning that pruning breaks download links already handed out)
before being corrected. If keeping older versions reachable does matter, GitHub
Releases is the answer, not tarballs in the tree - do not re-litigate it by
quietly restoring files after packaging.

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

## 9. Copy and UX

**"reset when the solution changes" understates deletion.** The Sample Data
helper text says the sample, mapping and coverage sections "reset" when the
solution changes. They are DELETED - `handleSolutionChange` removes every tagged
sample from the store. The deletion is correct and intended (samples are
solution-scoped); the wording is what misleads. Saying "are deleted" would match
the behavior.

**Nested scrolling on tall pages.** The 558-row solution list scrolls inside a
scrolling page inside the app iframe. `overscroll-behavior: contain` stops the
wheel chaining at the list's end, but the three-level nesting remains.

## 10. Diagram fidelity

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

## 11. Explicitly not doing

### Clearing a solution deletes its samples, and that is accepted - 2026-09-03

`DBT-72`. Clearing a solution removes every tagged sample for it, and because the
browse list is hidden while a solution is selected, **Clear is the only way to
reach another solution**. So every solution switch destroys the samples acquired
for the previous one.

Asked directly, the product owner said they do not care if the samples are
silently deleted when a solution is cleared. **The behaviour stays.** Nothing in
the code changed; this is a decision, not a fix, and a later reader should not
mistake the closed card for repaired behaviour.

**Why this is worth writing down rather than just closing.** Two implementation
rounds were built and refuted, and then a three-way design panel returned
`readyToBuild: false`. All of that work went into making sample ownership durable
enough to survive a switch:

- **Round 1** (`5849e34`) put ownership in a React ref. Refuted: a page reload
  after a Clear handed one solution's samples to a *different* solution - a
  cross-solution contamination path that did not exist before the change.
- **Round 2** (`4751254`) put ownership on `TaggedSample`, where the samples
  already are. The right shape, and refuted for a narrower reason: two ordinary
  intake writes erase the field.
- The **design panel** then picked per-solution store scoping as the only
  approach closing all four known failure modes, and flagged an unmeasured
  upgrade path - under scoping, every existing operator's samples go
  unattributed on first read.

Every one of those attempts rests on a premise nobody had checked with the owner:
*that the samples are expensive to lose*. They are not. They are re-acquirable,
and re-acquiring them is cheaper than the third key generation, per-solution
index, cloud adapter, fake store and rename-path changes that scoping costs.

**The lesson is the ordering, not the outcome.** Two refuted rounds bought a
well-measured price for a problem the owner does not have. The question "how much
is this data worth to you" was answerable in one sentence at any point and was
never asked. Design panels and adversarial review are good at *how* and cannot
tell you *whether*.

**What is kept.** `DBT-9`'s copy naming Clearing as the destructive act stays,
and is now doing the whole job rather than standing in for a fix that never came.
The deletion is deliberate, so warning about it is the entire mitigation.

**What would reopen this** - stated so the decision is falsifiable rather than
permanent: an operator losing work they cannot cheaply re-acquire. If sample
acquisition ever becomes slow, rate-limited, or manual, the premise fails and the
trap is back. **An uploaded file with no source to re-read is already that case**,
and is the most likely route to reopening it.

**Downstream.** `DBT-28` was blocked solely because the SIEM pivot would add a
second, unwarned door onto this trap. That objection is gone and the dependency
is removed - but two review findings from its first attempt are untouched by this
decision, because neither is about sample deletion: it resurrected the 2026-07-08
Clear-selection regression through a new door, and it shipped a comment and an
operator-visible sentence that both asserted the opposite of what the code did.
It also can no longer inherit `solutionSwitchEffects` as a justification, since
DBT-72 closes without building it.

### Two refactor branches deleted unmerged - 2026-08-31

`refactor/channel-manifest` and `refactor/pack-builder-decomp` were deleted
without merging. Both targeted the Electron GUI - which lives at
`deprecated/Cribl-Microsoft_IntegrationSolution/` since the 2026-07-13
deprecation, and which these June branches still address at its old top-level
location - and both sat 778 commits behind main. Merging either would have
resurrected files at a path that no longer exists.

Recorded here because they held REAL WORK that is not represented anywhere else,
and a deleted branch stops being findable:

- `refactor/channel-manifest` @ `0ef40db73cc531897b27654ef7374a583db37e12`
  (2 commits, 2026-06-17) - drove both transports from a single handler
  registry, with a channel-parity guard test.
- `refactor/pack-builder-decomp` @ `d9dd53ce6fe8fff3f4d1a4e40290ddc94e55dddc`
  (8 commits, 2026-06-20) - extracted `FieldMappingEngine` from `field-matcher`
  and `yaml-builder` from `pack-builder`, added injectable seams and a scaffold
  golden test.

The decompositions are the part worth remembering, not the code: the current
toolkit has its own pack assembly, and if it ever grows the same tangle, someone
already tried a shape for it. `git show <sha>` still resolves these while GitHub
retains unreferenced objects; after that they are gone.


**Live capture.** `POST /system/capture` supports `level` 0-3 (before
pre-processing pipeline / before Routes / before post-processing pipeline /
before Destination), which would map onto diagram nodes for a before/after view.
Deferred by decision on 2026-08-05: it returns real customer data, and
everything else this app does is config-level. Note there is no capture level
before event breaking, so it could never show the before/after of that stage.
Revisit only with a deliberate decision about display, retention, and whether
anything is written to the KV store.

## 12. Open questions from the 2026-08-17 architecture audit

**Rule-file caps disagreed between the two screens that read rules - RESOLVED
2026-08-17, raised and shared.** Rule coverage read up to 150 analytic-rule
YAMLs per solution; SIEM migration read 40. The core constant carried the
comment "matches rule-coverage's cap", which was never true - the 40 matched
rule-coverage's UNRELATED parser cap, also 40. The consequence was user-visible
and unexplained: a solution with more than 40 rules was covered in full by one
screen and truncated by the other, so the same solution reported different
coverage depending on where you looked.

Decision (user): raise SIEM migration to 150. Implemented as ONE shared
`RULE_FILE_CAP` in the sentinel-content domain rather than a second 150,
because two constants holding the same number is exactly how the divergence
started. Pinned in core, so changing it breaks a test and has to be re-pinned
deliberately.

Accepted cost: up to 150 content-port reads for one solution on the migration
path, against the 100 req/min proxy budget - which is plausibly why the 40 was
there. Bounded and cached per solution, and a migration analysis that silently
ignores three quarters of a large solution's rules is the worse failure. If the
budget bites in practice, the fix is a progress-reporting read loop, not a
quieter cap.

**`unreachableLogTypes` can no longer report anything - RESOLVED 2026-08-17.**
See the route-yml module header: the placeholder ladder superseded it, and it is
now retained as an invariant assertion rather than a user-facing warning.

**Bare CSS classes - SWEPT AND CLOSED 2026-08-17, no code change.** A class-name
sweep after the route-filter suggestions block shipped unstyled found 54
candidates: class names used in TSX with no rule in any stylesheet. Triaged to
21 "bare" (every class on the element undefined) and 34 "modifier" (base styled,
variant does nothing).

Two were real and were fixed in 1.11.6 - `.link-button` rendered as a full chrome
button, and `.identity-mismatch-block/-row/-applied` had no container or row
layout while their `.identity-block` siblings did.

Of the rest: five were SCANNER ARTIFACTS (`ok`, `failed`, `running`, `idle`,
`error` are literals inside a `status status-${...}` interpolation, and
`status-ok` etc. are defined). The remaining twelve were checked ON SCREEN and
all render correctly - they are grouping wrappers whose children carry the
styling, or semantic elements (`<a>`, table rows) the browser styles anyway.
Two of them, `content-install` and `numbered-section-body`, are used as TEST
SELECTORS, so they are structural hooks rather than dead names.

Deliberately NOT "fixed": adding rules to wrappers that never needed them is
churn that looks like progress, and deleting the names would break two test
files. Recorded here so the sweep is not re-run and re-triaged from scratch.
The script shape that found it: extract every className literal, diff against
the selectors the stylesheets define, then classify by whether the element has
ANY styled class - the count alone is meaningless.

**CSV route derivation - VALIDATED 2026-08-17, one defect found and fixed.**
Both discriminators return early for CSV (data rows are positional; at route
time the event is unparsed and the field name never appears in `_raw`), so
EVERY CSV log type in a multi-log-type pack placeholders by construction, even
when its values name their log types perfectly. Verified against the planner:
three CSV log types named Allowed/Blocked/Audit with matching values all
produced `__UNSET__` filters and zero unreachable routes.

That is correct, and it means the write-a-filter hint is the ONLY routing
guidance a CSV vendor's operator ever gets - which is where the defect was. It
offered `event_type === 'dns'`, a parsed-field test that cannot work at route
time for exactly the reason the discriminators bail. Now format-aware: CSV gets
a `_raw`-based example plus a line explaining why a field test is undefined
there.

Open follow-up: the placeholder filter itself (`__UNSET__ === 'x'`) is equally
unmatched for CSV, which is fine, but nothing yet tells the operator that a CSV
pack can never route automatically BEFORE they reach the preview.

**"Deploy" vs "Deploy everything" - DONE 2026-08-18.** The run button relabelled
itself: `contentEngaged ? "Deploy everything" : "Deploy"`. One button that
renames itself with the state of the page reads as two different actions, and an
operator cannot tell whether they are looking at a second control or the same
one armed differently. User direction: **just say "Deploy"**.

`contentEngaged` still decides what the run DOES (it gates the pack build inside
`runDeployEverything`, and the disabled-reason ladder) - it simply no longer
decides what the button is CALLED. The InfoTip beside it already spells out the
whole ordered sequence, which is the honest place for "everything" to be
described rather than compressed into a label that changes underneath you.

No pin was lost: nothing asserted either label. The internal name
`runDeployEverything` is left alone deliberately - it describes the handler's
scope accurately, and renaming it would touch the disabled-reason chain for no
user-visible gain.

## The workspace table listing lost its panel - DONE 2026-08-18

**User question, and it was the right one:** "why are we reloading any tables if
there needs to be a per log analysis because each log type needs a different
table? what is the use for this top section to list out tables at all?"

None. `TablePickerSection` was built as a PICKER - list the workspace's tables,
choose ONE for the whole analysis. When the choice became per log type (1.11.13)
the picking moved onto the mapping-review cards and the panel kept its entire UI
while losing its job: a filter box, an ~842-row list and a count line that
nobody selected from. Its own header said so out loud - "IT LOADS; IT DOES NOT
SELECT" - which is a section documenting its own obsolescence.

**What stayed, and why it is not per log type.** The workspace's table inventory
is ONE FACT: 842 tables exist regardless of how many log types are being
analysed. What is per log type is the CHOICE over that fact. So the fetch remains
one shared call above the cards rather than N identical ones, but it is now
`useWorkspaceTables` - a hook with no surface. On success it renders nothing; the
tables appearing in the dropdowns are the only evidence worth showing.

**A degraded listing is one line in the mapping review's existing routing-notes
block**, which already carries this exact class of fact (unreadable connectors,
broken EventsToTableMapping - something reduced where log types can go, said out
loud rather than swallowed). It names the consequence, not just the error: the
selectors fall back to the solution's tables plus the common natives. The retry
lives there and nowhere else, because the listing is deliberately NOT
re-attempted automatically - one 403 would otherwise become a request storm.

**The three capability rules all survive, two of them now structurally:**

1. A denied verdict never removes the attempt. There is no button to disable and
   no panel to hide - the listing is unconditional - so the rule holds by
   construction. Still pinned, because "structural" is a claim about code that
   can be edited. The `enabled` gate is on the WORKSPACE, not the verdict, and
   there is a pin asserting that distinction so the two do not get confused.
2. Reads have no fallback artifact: the note offers a retry and nothing else.
3. An empty listing is only a zero once the read was verified -
   `emptyTableListMessage` still decides it, and is the last of the three still
   expressed as a pure decision.

**Deleted, not deprecated:** `TablePickerSection` and its DOM test,
`filterTables`, `tableCountLabel`, `deriveTablePickerAccess` and
`TablePickerAccess`, plus nine now-orphaned CSS rules. The access predicate went
because it predicted what the load would do; auto-load means the real answer
arrives in the same second, and a prediction that disagreed with the outcome
would have been two answers to one question. `.table-picker-note` was renamed
`.analysis-stale-note` - it dresses the stale-results notice and never dressed
the panel, and a class named after a deleted component is the next audit's stale
reference.

All fourteen behavioural pins moved to `use-workspace-tables.dom.test.tsx`
intact; what was lost is the rendering they used to reach through, not the rules.

## Pack maintenance: bring in the new sample analysis

**OPEN - user request 2026-08-18.** Pack maintenance
(`pack-inventory-screen.tsx`, the `maintainId` panel) reconstructs a pack's
mapping table from its STORED definition, lets the operator edit dispositions and
targets, and rebuilds the next version in place. It predates everything the
analysis side has learned since: per-log-type destination tables, live workspace
schemas replacing derived ones, overflow triage naming the fields that do not
fit, the pairing warning, route-filter derivation and placeholders, and the CEF
identity override.

So an operator maintaining a pack today edits it through a strictly weaker view
than the one they built it with. The obvious symptom: maintenance cannot tell
them a mapping is now dropping 161 fields, because the triage that knows it only
runs in the gap-analysis path.

What this needs deciding before it is built:

- **Does maintenance re-analyse, or read a stored analysis?** Re-analysing needs
  the original samples, which the pack carries (`PackVendorSample`) but which may
  no longer represent live traffic. Reading a stored verdict is cheap and goes
  stale silently. A third option - re-analyse against the LIVE table schema and
  show what changed since the pack was built - is probably the honest one, and is
  the same fetch the picker already makes.
- **The schema may have moved under the pack.** A destination table gains columns;
  fields that overflowed at build time may now have a home. That is a genuine
  reason to rebuild, and nothing surfaces it.
- Reuse, do not restate: `triageOverflow`, `matchFields`, `resolveSampleRouting`
  and `createLiveTableSchemaCatalog` are all already pure and callable from here.
  A second mapping verdict computed a second way is the duplicated-decision
  failure this codebase keeps finding.

## Pack maintenance: detect packs modified in the Cribl UI before overwriting them

**OPEN - user request 2026-08-18. The data-loss one.** Maintenance rebuilds the
next version from OUR stored definition and installs it over the deployed pack.
Anything an operator changed in the Cribl UI since the app deployed it - a route
filter, a pipeline function, a lookup row, an added destination - is silently
overwritten. They will not be asked, and they will not be told.

The comparison has to be three-way, not two:

1. **What the app originally deployed** - the stored `definition` for that pack
   version in the pack store. This is the baseline, and it is the piece that makes
   the diff meaningful: without it, "deployed differs from what we would build
   next" cannot distinguish a change the operator made from a change WE are about
   to make.
2. **What is deployed now**, fetched per worker group.
3. **What the rebuild would produce.**

A field that differs between 1 and 2 is the operator's edit and must be preserved
or at minimum surfaced. A field that differs between 1 and 3 is our intended
update. A field that differs in both is a genuine conflict and is the only case
that should stop and ask.

**PER WORKER GROUP, because the answer differs per group.** The pack can be
deployed to many, and they diverge independently - one group hand-tuned, another
untouched, a third still on an older version. `deployedGroups` and
`installedPackVersions` (domain/pack-assembly/install.ts) already model exactly
this shape, `Array<{group, packs}>`, and already take truth from the live API
response rather than a persisted flag. Build on those rather than a new listing.
The maintenance panel should name which groups diverge and how, not report a
single verdict for a pack that is in three different states.

Open question worth answering early: how much of a deployed pack can the Cribl
API actually return for comparison? If the readback is lossy, the honest surface
is "these groups differ from what we deployed, in these files we can see" rather
than a confident clean bill - the same rule as the inventory standard. An unknown
must not render as a zero.

## Sample browser: REMOVED (ADR-0003) - ALL PHASES 0-5 DONE, VERIFIED LIVE 2026-08-25

**Executed 2026-08-19/20 on `feature/log-type-recommendation`.** The browser and
its whole acquisition domain are deleted; the `LogTypeRecommendation` panel
replaces it. To continue, open ONE document:
[sample-acquisition-plan.md](sample-acquisition-plan.md) - it carries inline
`[SUPERSEDED]` markers where reality diverged from it, and
[sample-acquisition-phase0.md](sample-acquisition-phase0.md) has the API
findings. [ADR 0003](adr/0003-remove-sample-browser.md) is the durable decision
record and is background, not a prerequisite.

**Where it stands:** Phases 0-3 done. **Phase 4 is done, BOTH paths** (core and
UI). Capture: `domain/capture-filter`, `captureSamples`, `CapturePanel` - compose
the filter, run one bounded `POST /system/capture`, split by log type, PREVIEW,
and tag nothing without a click. Lake query: `queryLakeSamples`, `LakePanel`.
**Phase 5 (volume findings) is done (2026-08-23)** - the Lake counts reach the
recommendation, entries and the unreferenced set carry a volume and rank by it,
with no threshold and no flagged finding by decision.

> **[SUPERSEDED 2026-08-25 - BOTH halves of the paragraph below are now false.]**
> This ran against a real workspace and it is packaged. The original text is kept
> because its "if wrong" framing is what made the run worth doing.

~~**What has NOT happened: none of this has run against a real workspace.** Every
platform belief behind Phases 3-5 is pinned against `FakeCriblClient` only; the
suite that settles them is `packages/core/src/testing/live-verify.test.ts` and it
skips without `CRIBL_LIVE_BASE`/`CRIBL_LIVE_TOKEN`. The 2026-08-20 attempt was
blocked on an expired token and an idle lab - generate traffic first, or rows 1,
2 and 4 stay inconclusive. Nor is any of it packaged: the app is still 1.11.15
and every ADR-0003 commit is unreleased.~~

**IT HAS NOW RUN. All eight platform beliefs are SETTLED (2026-08-25)** against
the lab workspace `main-busy-yonath-kz1bxn7`, Stream group `DatacenterEast`,
Lake dataset `winevt_plwindows`. Rows 1-7 CONFIRMED; row 8 answered the other
way - **Cribl TOLERATES a filter referencing an undeclared field**, so the
`typeof` guards in `capture-filter.ts` are insurance rather than load-bearing.
The guards stay; what was wrong was the module's stated model, not the code. The
full verdict table, and what each row actually observed, is in the plan's
"Needs live verification" section.

**And it is packaged.** ADR-0003 shipped in full in 1.12.0; **1.12.1 is current**
(see the release entry above). The "still 1.11.15, everything unreleased" claim
was true when written on 2026-08-23 and stopped being true the next day.

**The run's real yield was defects, not confirmations.** Four PRODUCT defects,
all silent, the first three each enough on their own to stop the Lake path: the
job status was read at the top level when it lives at `items[0].status` in the
`{items,count}` envelope, so every job reported "still pending"; no clock was
injected into the poll loop, so twenty polls fired inside ~4s and only an EMPTY
dataset could finish in time; `data_source` was missing from
`DISCRIMINATOR_FIELDS`, so the lab's one security-shaped dataset reported no log
types at all - for 789K events already split by Windows channel; and the
"preferred" query route was never a query route (below), which orphaned a job per
query and showed operators a platform error under a success headline. Plus seven
HARNESS defects, four of which had been returning confident wrong answers rather
than failing (row 1 could never have passed - it read `__inputId` off the payload
strings, after the envelope carrying `__inputId` had been discarded). A green run
of a lying harness is worse than a red one, because nobody investigates it.

**Two platform facts worth keeping out of the plan's depths:** a capture runs ON
a worker, so `POST /system/capture` against a group with no connected workers
returns `400 {"message":"No worker nodes are connected to this worker group."}`;
and `GET /search/query` is **not** a synchronous route - it creates a job and
returns `{isFinished:false, job:{id,status:"queued"}}`. The phase 0 doc's
"Synchronous? Yes" row is corrected there. That route has been DELETED from
`queryLakeSamples` and its `/m/:gid/search/query` grant withdrawn from
`policies.yml`: preferring it cost an ORPHANED job on every Lake query (two per
operator flow) and put its raw platform error under a SUCCESS headline in the
Lake panel, while buying nothing - both doors cost create + poll + read. With
only the proven lifecycle left, an empty answer is now believed rather than
re-confirmed with a second job.

Phase 4's first correctness trap is recorded in the plan and shipped as a
warning: a capture request has NO source field, so the source is an `__inputId`
clause inside the filter, and an operator deleting that clause silently widens
the capture to every source in the group.

**The plan's capture filter was not built as written, deliberately.** It
specifies a comma anchor (`/,TRAFFIC,/i`), but the operator picks a SOURCE, not
a format, so a comma anchor against a pipe-delimited CEF vendor matches nothing -
the same zero-events failure the anchor exists to prevent. The shipped predicate
anchors on the SET of delimiters this app's parsers use, excluding `/` so a URL
path cannot match. Marked `[SUPERSEDED]` inline in the plan's Phase 4.

**The log-type recommendation now has THREE tiers of evidence,** not just
analytic rules: `detection` (a shipped rule filters on it), `workbook` (a shipped
workbook queries it - real, weaker), and `vendor` (the vendor documents the
feed). The third answers a solution shipping few or no detections, which the
content-derived tiers structurally cannot. The tier is on every row because
collapsing them would tell an operator their solution requires data it has never
mentioned.

**The vendor tier is now BOTH halves (corrected 2026-08-23).** It has a
hand-curated half (13 vendors, each cited to vendor documentation) and a
generated half mined from elastic/integrations. The generated half shipped empty
at first, and this entry said so; commit df3ad5e ran
`node scripts/generate-vendor-packs.mjs --bulk <elastic-integrations-checkout>`
and the catalog now carries 157 generated packs (197 KB). The hand packs still
WIN the per-value dedupe, and the breadth pin still guards all thirteen. Re-run
the miner only to refresh against a newer elastic/integrations checkout.

**A parsing defect found and fixed along the way:** a syslog-prefixed PAN-OS
upload used to parse to ZERO events - detection called it syslog and
`parseSyslog` cannot match a PAN-OS body. It was pinned as a KNOWN GAP first
(fixing it means touching the detector every vendor depends on) and then fixed
the same day: detection recognises the PAN-OS positional fingerprint via
`isPanosFormat` ahead of the syslog check, characterized first across both modes
and every format. Full record in the phase 0 doc, 0.3.

The Browse Samples modal is being removed <!--drift-ok--> and replaced by a log-type
recommendation derived from the operator's own environment.

Short version of why: `scoreFileName` (repo-samples.ts:278) is the whole
selection mechanism, and it scores the FILENAME against vendor-name keywords -
it never opens the file. "This sample belongs to this solution" means "its
filename contains part of the vendor name". The one content check,
`detectPreIngested`, only ever rejects; nothing confirms a sample fits. The
operator gets many files per vendor, most wrong for their solution, with no way
to tell which.

A smarter fit check was designed and rejected - it is real work to make a
browser trustworthy that should not exist. Samples now come from the operator,
deliberately named, via three paths: Cribl Search over a Lake/federated dataset
(complete log types + volumes), filtered capture from a Cribl source (bounded,
with vendor-derived filter suggestions), or manual upload (needs no Cribl
integration).

> **[SUPERSEDED - TWO modes, not three paths]** (user direction 2026-08-19)
> Search is not a separate surface, it is HOW a Lake dataset is queried - the
> same datasets appear in both listings, verified live. The operator is asked one
> question first: query a Lake dataset, or capture from a live source. Manual
> upload is not a mode; it is the permanently-available intake below. Reasoning
> in the plan's Phase 3.

**The trap for whoever executes this:** `splitSamplesByLogType`
(sample-acquisition/splitting.ts:64) must SURVIVE the deletion. It separates a
mixed stream by discriminator, it is load-bearing for capture and for mixed
uploads, and its only current caller is `precedence.ts` on the browse path - so
deleting the sample-acquisition domain as a unit silently removes it. Two more
capabilities need salvaging first: CEF/LEEF raw-line preservation
(repo-samples.ts:400,428,486) and `consolidateByTableRouting` (:505).

> **[SUPERSEDED - one salvage was real, the other was dead code]** The splitter
> survived, rehomed to `domain/sample-parsing` as `splitSamplesByLogType` with
> `browseSampleId` renamed `splitSampleId`. Raw-line preservation turned out to
> be a LIVE defect on the intake path rather than a browse-path risk, so it was
> fixed in `parseSampleContent` and every intake path benefits.
> `consolidateByTableRouting` had never executed - both callers pass two
> arguments, so its `eventToTable` branch is unreachable - and was deleted as a
> capability the app did not have. Phase 0 doc, 0.3.

## 13. PaloAlto end-to-end walkthrough - LIVE, 2026-08-27

Driven against the live workspace through the `__local__` live preview, so the
code under test was `main` at `714a66c`, not the 1.2.212 build installed in the
workspace. Connection reported `secret: live (verified)`, target
`law-jpederson-eastus @ rg-jpederson-QuickstartLab`, `platform link: ok`.

Journey: Sentinel Integration -> `PaloAlto-PAN-OS` -> capture from
`paloaltorfc5424` (datagen, group DatacenterEast) -> commit -> DCR gap analysis.
Captured 9 events in 2 log types, format detected `csv`: THREAT (5), TRAFFIC (4).

**What worked, recorded so nobody re-opens it.** The capture path ran end to end
against a real source. The commit reported `Added 2 samples from this capture.`
and the summary SURVIVED - `51d272d` confirmed live. The filter recomposed
correctly afterwards, dropping THREAT and TRAFFIC from the alternation now that
they are provided. Vendor identity resolved `DeviceVendor = Palo Alto Networks`
and `DeviceProduct = PAN-OS` with known-value chips. The pairing warning fired on
TRAFFIC: "Most of this sample has no CommonSecurityLog equivalent (13 of 16
overflow fields)". Vendor-derived log types (CONFIG, DECRYPTION, GLOBALPROTECT,
HIPMATCH, SYSTEM, USERID) were correctly NOT ticked and annotated "documented by
the vendor, not required by this solution". The DISABLED source was annotated as
such in the picker. Deploy stayed gated on mapping approval.

### 13a. Azure targeting never finishes its initial load (HON-8)

Arriving at Select Azure Resources, the panel showed `Checking Azure
permissions...` and `Loading subscriptions...` and stayed there - observed over
40 seconds, no timeout, no error, no verdict. Clicking **Refresh from Azure**
resolved both in about a second: `Connected - 1 subscription(s) visible.`,
subscription `Pay-As-You-Go`.

Network tracking was armed BEFORE the refresh and captured no ARM request in
flight during the stuck period; after the refresh, three appeared and all
returned 200 (`/subscriptions`, `/workspaces`, `/resourcegroups`). So the
credentials and the proxy were fine the whole time. Whether the initial fetch was
never issued or issued and its result dropped is not settled here - what is
settled is that the panel sits in a permanent in-progress state and only a manual
refresh clears it.

This is the inventory standard's own rule turned inside out. The standard forbids
rendering an unmeasured state as a measured one; a spinner that never resolves is
the worse variant, because it reads as progress rather than as absence, and the
operator has no reason to suspect a button would fix it.

### 13b. Workbook parameter placeholders are offered as log types (HON-9)

`PaloAlto-PAN-OS` recommends fifteen content-derived log types, two of which are
not log types at all: `{activities}` and `{EventClass}`. Their evidence column
reads "a shipped workbook queries it - 1 item", so they come from workbook KQL
where `{...}` is Sentinel's parameter-substitution syntax. The extractor is
taking the literal token.

Three consequences, in increasing order of harm:

1. They are listed for the operator to provide, and cannot be.
2. They are pre-ticked in the capture picker and compiled into the live filter,
   regex-escaped: `...|wildfire-virus|\{activities\}|\{EventClass\}|end|url)...`
   No PAN-OS event can contain those literals, so the alternations are dead.
3. They are counted in "N log types referenced by this solution's detections
   still have no sample". It read 15 before the capture and 13 after; the
   achievable floor is 11, so that warning can never be satisfied.

The sharp one is what happens if a placeholder is ever satisfied. The panel's own
copy says each tagged log type becomes its own route and pipeline pair - so a
sample tagged `{activities}` would put a route named for a template token into a
deployed pack.

`end` and `url` in the same list are NOT defects: both are genuine PAN-OS
subtypes (traffic end, threat url).

### 13c. Positional CSV naming applies a 120-column order to a 38-field event (VND-3)

THREAT: 5 events, 38 fields, "Bundled Palo Alto Networks THREAT column order
(120 columns)". TRAFFIC: 41 fields against a 115-column order. Positional naming
maps field[i] to name[i], so a feed that omits any middle column mis-names every
column after it, silently.

The copy hedges - "check the values beside each name before applying" - but
nothing MEASURES the discrepancy. A hedge is not a measurement, and 38-of-120 is
a number the app already has and could show. Worth deciding whether a large
shortfall should warn rather than hedge.

**DECIDED 2026-08-28 (user): WARN ABOVE A THRESHOLD, Apply stays enabled.** The
measured shortfall replaces the hedge, and a large one warns visibly - but the
button is never disabled.

Blocking was the tempting answer and is the wrong one here. The rest of the app
is pinned to the capability model's **annotate, never hide, never disable** rule,
and a short feed can be legitimately named once the order is edited - so a block
would stop real work to prevent a mistake the warning already makes obvious. It
would also be the only place in the product that disables a control on a
heuristic, which is how an exception becomes a precedent.

The threshold is a product decision, not a measurement, so it is stated rather
than derived: warn when the bundled order exceeds the event's field count by
more than a quarter. The two live cases both trip it - THREAT at 38-of-120 and
TRAFFIC at 41-of-115 are both under half - and an order matching its feed
closely does not.

**Column-order provenance - DECIDED 2026-08-28 (user): STORE NEITHER a version
nor a captured-on date.** D-7, the last open question in
`vendor-field-definition-plan.md`. A persisted order keeps vendor, logType,
columns and overrides, and nothing else.

The harm it would have guarded against is already handled: `resolveColumnOrder`
re-derives the override notice against the CURRENT bundled order, so a later
divergence surfaces at the moment it matters rather than being reconstructed
from a stamp. A date would say when the capture happened but not which firmware
produced it - the question actually being asked - and a version has nowhere to
come from: neither the sample nor the CSV-header dialog supplies one, so it
means asking the operator for something they frequently do not know, and a field
the operator guesses at is worse than a field that is absent.

### 13d. The solution list swallows the mouse wheel (DBT-14)

With the pointer over the solution list, wheel scrolling moves neither the list
nor the page. The pointer has to be moved outside the list before the page will
scroll at all. Eight results were visible and five were reachable. This is the
concrete reproduction the old open question about nested scrolling never had.

### 13e. One solution renders no delivery-fit badge (DBT-15) - FIXED 2026-08-31, REWORKED after review 2026-09-01

In the eight `Palo` results, "Palo Alto Cortex XDR" carries no fit badge while
all seven siblings carry one (Legacy, Supported, or Recommended). Blank is
ambiguous between "not measured" and "does not apply", which is the same
absent-versus-zero distinction the inventory standard exists to protect.

**The cause was the datum, not the rendering.** The badge column works: the row
was blank because `lookupSolutionIngestion("Palo Alto Cortex XDR")` returns
null, and the JSX rendered the badge behind `ingestion !== null &&`. The shipped
map is generated by `scripts/generate-ingestion-classification.mjs`, which
`continue`s past any solution whose folder yields no Data Connector JSON
(`files.length === 0`) or none that parse (`classes.length === 0`) - so the
asset holds 436 entries and the index holds more, and every solution in the
difference rendered nothing. `Palo Alto Cortex XDR CCP` and `Palo Alto Cortex
Xpanse CCF` ARE in the map, which is what made one row in a family of eight look
like a rendering failure. The card's later note that AbuseIPDB and Acronis Cyber
Protect Cloud do the same on the unfiltered list is the same absence, and was
the clue that this was data rather than DOM.

**Why the fix is a state of its own rather than a default tier.** The obvious repair
is to fall back to `classifySolutionIngestion([])`, which answers `legacy` for
an empty connector list, and every row would then carry a badge. That trades a
blank for a lie: it states a measured verdict - "not a native Logs Ingestion
target" - about connectors nobody read. A missing entry conflates three
different facts (the solution ships no connector, its JSON did not parse, or it
was added upstream after the asset was generated) and the map cannot tell them
apart. So `deliveryFitBadge` in
`packages/core/src/domain/sentinel-content/delivery-fit-badge.ts` maps the
absent case to `unmeasured` / "Not measured", with a tooltip that says what is
missing and explicitly that it is not a claim of poor fit. Same discipline as
`emptyInventoryMessage`: "not measured" is its own answer and does not collapse
into either of the others.

**The first attempt half-fixed it, and the review caught both halves
(2026-09-01).** It is worth recording what a same-day adversarial read found,
because both findings are failure modes this project keeps producing.

*Finding 1 - the pinned half was not the whole fix.* The list row was pinned in
a DOM test; the SELECTED-SOLUTION CARD was not, because no test in the ui suite
ever selected a solution. The reviewer reverted just the card's branch to the
defect shape (`badge.measured ? <span/> : null`) and the entire ui suite stayed
green. The attempt's own commit message reported a mutation-check that covered
only the row while reading as though it covered the fix. The lesson is not
"write more pins" - it is that a mutation-check is evidence only about the line
it mutated, and a fix with two call sites needs two of them.

*Finding 2 - the tooltip stated something the same screen disproved.* The
attempt gave the card a ROW's badge, and a row's tooltip ends "its connectors
are classified live when the solution is selected". On the card the solution IS
selected and the classification HAS run, so with the fetch complete and no
connector files found, the app reported "Not measured" about a measurement it
had just taken and promised as future work something already in the past. That
is the absent-versus-zero confusion inverted: the original defect reported
nothing for an unknown; this reported an unknown for a measured zero.

**So the derivation now takes EVIDENCE, and the paragraph this replaces was
wrong.** The attempt argued that "an empty listing is an unknown, not a zero"
and refused to read anything from a zero-length connector listing. That is the
right rule for an ARM list - RBAC returns `200 OK` with an empty `value`, so an
unverified empty really is unknown - and the wrong rule here. The GitHub
contents adapter REJECTS on 401/403 and resolves `[]` only for a directory it
successfully read, so a completed listing of no connector files is a zero
somebody looked at. Refusing to say so is the second finding.

`deliveryFitBadge(shipped, evidence)` is now one derivation consumed by both
call sites, over the phases that actually exist: `not-fetched` (every browse
row - "Not measured", and the only state that may promise a look on selection),
`fetching` ("Measuring..."), `fetch-failed` ("Not measured", naming the failure
and offering a retry rather than a loop), and `fetched` - which splits into a
live tier, "Not measured" when files were found but none could be parsed, and
`no-connector` when the listing completed with none. `no-connector` carries
`measured: true` and a tooltip that opens "Measured:".

Two ordering rules, both with reasons rather than preferences. A shipped tier
beats a live one, because the generator reads every connector file while the
live decode caps at the first few and can under-report the best tier. But a
completed EMPTY listing beats the shipped tier, because a shipped entry exists
only where the generator read at least one connector file - so an empty listing
does not merely disagree with it, it falsifies its premise, and letting the
shipped tier win would also print "Recommended" directly above the card's own
"0 connector files".

## 14. Overflow serialize missing from the generated pipeline - REPORTED 2026-08-27

**Reported, not yet reproduced.** Field reports say the additional-extension
field is not actually created in the pipeline inside the pack the app builds.
For a CommonSecurityLog destination that is `AdditionalExtensions`, the catch-all
that carries every source field with no column of its own. If it is missing, the
pack ships and the unmapped fields are silently gone - the same shape as the guid
defect (ADR 0004): a successful deploy, no error, and data that never arrives.

Filed before investigating, deliberately. The first version of this session's
response was to open the code and start reading, which is how a report becomes an
undocumented fix nobody can find later.

### What the code says, before any live check

`pipeline-conf.ts:717` gates the whole serialize function on:

```
const hasOverflow = overflowConfig?.enabled && overflowConfig.sourceFields.length > 0;
```

and `match-fields.ts:366-372` builds that config as:

```
enabled: overflow.length > 0 && overflowFieldExists,
sourceFields: overflow.map((o) => o.sourceName),
```

where `overflowFieldExists` is whether the DESTINATION schema actually contains
the overflow column (`match-fields.ts:271-273`). So there are three ways to reach
"no serialize function", and they are not equally benign:

1. Nothing overflowed - correct, and the function should be absent.
2. Fields overflowed but the destination schema has no overflow column -
   `match-fields.ts:355` already pushes a warning for this, so it should be
   visible rather than silent.
3. Fields overflowed, the column exists, and the function is still missing -
   that would be the regression.

Telling those apart is the whole job. A missing function is only a defect in
case 3, and case 2 is a schema problem wearing a generator problem's clothes.

### Suspects worth eliminating

Recent work that touches what counts as overflow, in rough order of proximity:
the drop-unneeded-fields policy (a field marked `drop` is deliberately excluded
from the catch-all, `pipeline-conf.ts:740`), the positional CSV column naming
(field names arrive differently), and the live-schema fetch (whether the fetched
CommonSecurityLog schema carries `AdditionalExtensions` at all).

### How it will be verified

End to end in the live preview against the lab workspace: Zscaler solution,
samples pulled from Cribl Lake through the app's own query path (which also
exercises the 1.12.2 Lake work on data this session created), gap analysis, then
read the generated pipeline in Pipeline preview and check for the `serialize`
function with `dstField: AdditionalExtensions`. Whatever is found gets recorded
here, including "could not reproduce" - a report that turns out to be a schema
problem is worth the same write-up as one that turns out to be a generator bug.

### 14a. NOT REPRODUCED on the CEF path - verified live 2026-08-27

Driven end to end in the live preview: Zscaler Internet Access, samples pulled
from the `zscaler_cef` Lake dataset through the app's own query path (4 log types
found and volume-ranked, 200 events fetched, 4 samples committed), gap analysis
run, all 4 mappings approved, pipeline preview read.

**The serialize function is generated.** For every log type the pipeline carries
eight functions in order, and number seven is
`serialize / overflow / "Serialize unmapped fields into AdditionalExtensions as
JSON"`. All four log types overflowed (8, 3, 10 and 10 fields) into a
CommonSecurityLog destination that does carry the column.

**The preview is not an approximation, which was the next thing to doubt.** Both
the preview (`pipeline-preview-state.ts:45`) and the pack build
(`pack-assembly/scaffold.ts:257`) call the SAME `generatePipelineConfForPlan`.
There is no second generator that could disagree, so "correct in the preview,
missing in the pack" is not a state this code can reach.

### 14b. What is left, and the likeliest explanation

Two of the three original paths remain, and neither is a generator bug:

**The drop policy can empty the catch-all.** A field marked `drop` is
deliberately excluded from the serialize (`pipeline-conf.ts:740`, a 2026-07-13
live fix - dropped fields were being serialized and shipped anyway). If the
unused-field policy drops every field that would have overflowed, `overflow`
reaches zero, `enabled` goes false, and the function is correctly absent. This
run could not hit it: the analysis reported "preserving all (content parses the
catch-all opaquely)", so nothing was droppable. A solution whose content does NOT
parse the catch-all opaquely, with the policy set to drop, is the case to try.

**The destination schema may lack the column.** `enabled` also requires
`overflowFieldExists` (`match-fields.ts:271`). A destination without an overflow
column produces no serialize - and already raises a warning
(`match-fields.ts:355`), so it should be visible rather than silent.

**What to ask the reporter**, rather than guessing further: which solution and
destination table, whether "Drop unneeded fields" was on, and whether the gap
analysis showed a non-zero Overflow count for the log type in question. That last
number decides it - a zero Overflow with no serialize is correct behaviour, and
a non-zero Overflow with no serialize is the defect.

Worth noting even if this closes as not-a-bug: nothing tells an operator WHY the
catch-all is absent. "No serialize because nothing overflowed" and "no serialize
because the column is missing" are different facts, and the pipeline preview
shows neither - it just has one fewer function than it might.


### 14c. Closed on the DEPLOYED PACK, not the preview - verified live 2026-08-27

14a read the pipeline preview and argued from shared code that the pack could not
differ. That argument is sound but it is still an argument; the report is about
"the pack that gets created", so the pack is what had to be opened. It now has
been.

Built end to end through the app and installed into Cribl by the app's own
upload path (`PUT` then `POST /m/{group}/packs`), then read back in the Cribl UI:

- Source: 4 log types pulled live from the `zscaler_cef` Lake dataset - 200
  events fetched, stored as 50 / 26 / 19 / 17, every one detected as CEF.
- Destination `CommonSecurityLog`. Gap analysis reported **Overflow 8** for
  `zscalernss-tunnel` (6 unmappable, 2 outranked), and "Unused fields: preserving
  all", so the drop policy was not in play. A NON-ZERO overflow is precisely the
  condition that must emit the function.
- Result: pack `ms-sentinel-zscaler-internet` **v1.0.6** in worker group
  `default`, 8 routes and 8 pipelines, sample files carrying the same 50/26/19/17
  counts - which is how the pack was confirmed to be this run's and not an older
  artifact.

In each of the four transform pipelines, function group `(7) Overflow Collection`
holds an enabled `Serialize`: type JSON Object, description "Serialize unmapped
fields into AdditionalExtensions as JSON", **Destination field
`AdditionalExtensions`**, and a Fields-to-serialize exclusion list running from
`!_*` through every mapped CommonSecurityLog column, ending `!AdditionalExtensions`
then `*`. That is the catch-all shape: exclude what is mapped, sweep the rest.

**The report does not reproduce.** The question for the reporter is unchanged and
is now the only thing that can settle it: what Overflow count did their gap
analysis show. Zero with no serialize is correct; non-zero with no serialize is
the defect, and this run could not produce it.

### 14d. Two defects the pack review turned up on the way

Neither is what was reported; both were found by opening the artifact.

**Rebuilt packs accumulate broken pipeline entries** (board `GEN-2`). Alongside
the 8 correct pipelines, the pack lists a dozen-plus nameless entries at 0
functions, each hovering to "Missing pipeline configuration" - leftovers from
earlier builds of the same pack name whose `conf.yml` no longer ships and which
the overwrite does not remove. Every rebuild adds more, so a pack gets worse the
more it is maintained, and a stale entry looks exactly like a pipeline the build
failed to write. This is distinct from `PK-1`, which is about packs a HUMAN
edited.

**A pack cannot say what built it** (board `GEN-3`). Establishing that v1.0.6 was
this run's output took a git-log check and a sample-count comparison, because the
manifest carries no toolkit version - `author` is a constant and `version` only
counts rebuilds. Every future report about "the pack" pays that cost again.

### 14e. Method note - the stale app that nearly produced a false finding

The first pass drove `/apps/a/soc-optimizationtoolkit`, the INSTALLED app, and
found the Cribl Lake sample picker completely absent - which would have been
filed as a serious defect. It was not one. The installed app is v1.11.2 against
`main`'s 1.12.2, and predates the picker; the source at
`samples/sample-source-picker.tsx:95` renders its label unconditionally, so
"component present in source, absent on screen" was the tell that the running
build was not the source. The live preview at `/apps/a/__local__` showed the
picker immediately.

Two things made this cheap to get wrong: the dev server on :5173 had been running
since the previous evening, so it also predated today's commits, and the app's
own footer version is the only visible difference between the two shells. Recorded
as `REL-5` evidence. **Check the footer version before believing a UI finding.**

### 14f. The orphaned pipelines, root-caused and fixed - 2026-08-27

14d filed this as a defect found on the way. It is now closed, and the diagnosis
is worth keeping because the obvious explanation was wrong.

**The hypothesis that failed.** The natural reading was that the app generates
pipelines for log types the solution needs but which have no sample - the run
did acknowledge "8 log types referenced by this solution's detections still have
no sample" immediately before building. It is wrong, and one control settles it:
`ms-sentinel-cloudflare` v1.0.0 has never been rebuilt and is spotless (1
transform, 1 reduction, 4 stock pipelines, zero orphans) despite its solution
having plenty of unsampled log types. The generator writes exactly two pipelines
per TAGGED table (`scaffold.ts:254-263`), which is why 4 log types produced 8
routes and 8 pipelines, exactly as the UI predicted.

**What the orphans actually track is a LOG-TYPE RENAME between builds** - not
the rebuild itself. That correction came from checking the two packs in
`AzureManaged` before deleting them, which is the only reason it was caught:
both are rebuilt AND clean, because their log types never moved.

| Pack | Group | Version | Log types changed? | Orphans |
|---|---|---|---|---|
| `ms-sentinel-cloudflare` | default | 1.0.0 | never rebuilt | 0 |
| `ms-sentinel` | AzureManaged | 1.0.1 | no | 0 |
| `ms-sentinel-zscaler-internet` | AzureManaged | 1.0.3 | no | 0 |
| `ms-sentinel` (Gigamon) | default | 1.0.3 | yes | 4 |
| `ms-sentinel-zscaler-internet` | default | 1.0.6 | yes | 12+ |

The `AzureManaged` Zscaler pack kept `ALLOWED` / `CAUTIONED` / `firewall-BLOCKED`
and friends across its rebuilds, so each merge overwrote the same ids. The
`default` one moved to `zscalernss-*` names when its samples were re-pulled from
Lake, and stranded the entire previous set. Re-deriving log types from a fresh
sample set is the ordinary way to rename them, so this is a common path, not an
exotic one.

**The mechanism.** Overwriting an installed pack took rung 3 of the conflict
ladder, `PATCH /packs/{id}` - Cribl's "Upgrade a Pack" - and an upgrade MERGES
the archive over what is already there. The rung returned on success
(`install-pack.ts:113-121`), so the DELETE+POST replace below it only ran when
the PATCH itself failed. Pipeline directory ids are derived from the operator's
free-text log type (`pipelineSuffix`, `naming.ts:94-103`), so a rename between
builds - `ZIA DNS` one time, `zscalernss-dns` the next - produces a disjoint set
of ids. The previous set is no longer in the archive, the merge does not remove
it, and Cribl lists each survivor as a nameless pipeline at 0 functions reading
"Missing pipeline configuration". Nothing in the repo ever enumerated or pruned
what was already installed; the archive is only ever a snapshot of the current
build.

Worth naming plainly: **the UI had been promising a replace all along** -
"Building will overwrite it there" (`integrate-screen.tsx:1941`) - while the
code performed a merge. The defect was a gap between a button's promise and its
implementation, not a generator bug, which is why reading the generator (14a)
could never have found it.

**The fix (shipped in 1.12.3).** Rungs 3 and 4 swapped: an overwrite now DELETEs
the existing pack and re-POSTs, so the old tree goes with it. The upgrade is
kept for the single case that needs it - the 2026-07-13 lesson, a pack whose
pipelines are referenced by routes outside it cannot be deleted - and that path
now reports itself through a new `onNote` channel rather than passing as a clean
overwrite, because it still leaves earlier pipelines behind. `onNote` exists
because the return value cannot express a successful-but-degraded install, which
is the silent-success shape this codebase keeps getting bitten by.

**Pins.** Four added. Disabling the replace branch kills three of them, so they
are load-bearing rather than decorative. The existing pin *"escalates a conflict
to the PATCH upgrade and stops there on success"* had encoded this defect AS
INTENDED BEHAVIOUR, asserting `deletedIds === []`; it was re-pointed at the
delete-refused fallback rather than deleted, so the case it really guards still
has a pin.

**Lab state.** Both damaged packs were deleted from worker group `default`:
`ms-sentinel-zscaler-internet` v1.0.6 and `ms-sentinel` (Gigamon) v1.0.3. The
three remaining toolkit packs were each opened and verified clean, so nothing
else needed removing - `ms-sentinel-cloudflare` v1.0.0 in `default`, and
`ms-sentinel` v1.0.1 plus `ms-sentinel-zscaler-internet` v1.0.3 in
`AzureManaged`. An earlier note here claimed those last two carried the same
damage; that was inference from their version numbers, and opening them
disproved it. The fix stops NEW leftovers; it does not clean up existing ones,
because the replace only happens on the next rebuild of each pack.

## 15. Custom table authoring on DCR Automation - TBL-5 DECIDED 2026-08-31

**The user's ask, three parts:** create Log Analytics custom tables (validating
the name is not already taken, then naming fields and assigning types);
inventory existing tables and create DCRs from one; and if the app has not been
granted permission to create Azure resources, still offer a downloadable ARM
template for the DCR.

**One of the three was already on the board, and saying so was the useful part
of picking this up.** HON-7 is the rule that every blocked action falls back to
a downloadable artifact, and it already names DCR Automation as a target;
HON-8 is the engine, `buildDeploymentPreview` - roughly 700 lines with its own
tests and no caller anywhere in `packages/ui` or `apps/cribl-app`; and Batch
already ships the behaviour under `templateOnly`, forced on in azure-only mode.
The mechanism is not missing, it is unreached. TBL-4 therefore adds only what is
genuinely new - the two NEW surfaces carrying the offer, gated on the MEASURED
capability so the option appears before something 403s rather than after - and
says to do HON-7 first or it will be rebuilt.

**What was genuinely missing.** Every existing schema source CONSUMES a schema
somebody else authored: a bundled `VENDOR_SCHEMAS` entry, a pasted JSON file, or
a table that already exists. An operator with a new log source and no schema
file has no path through the screen at all. That is TBL-1. And nothing anywhere
compares a proposed table name against what the workspace holds -
`validateCustomTableSchema` checks the name's SHAPE (the `_CL` suffix) and
`avoidNameCollision` is for DCR names - which matters because the tables PUT is
an UPSERT, exactly like the DCR PUT that `avoidNameCollision` exists to guard.
Authoring over a taken name does not fail; it redefines a live table's schema,
and the first symptom is somebody else's data not arriving. That is TBL-2.

### The decision: one "Tables" tab, not two tabs and not a fold-in

DCR Automation already carries three tabs and Inventory is the landing one. The
three options were two new tabs (`Tables` and `New table`), one `Tables` tab
with creation as an action on it, or folding both into the Single table panel.

**Chosen: one `Tables` tab.** The two asks are one journey - look at what
exists, and if what you need is not there, author it - and this is the only
option that renders them as one. Two tabs would make `Tables` and `New table`
read as siblings when one is really an action on the other. Folding into Single
was the smallest diff but Single is already the densest panel on the screen.

The chosen layout also settles a question TBL-3 had left open: a table that
already has a DCR SAYS SO on its row. The data is one `listDcrInventory` call
away, and an operator building a duplicate is the thing this panel should
prevent.

### This is NOT a revival of `TablePickerSection`

Worth stating plainly, because the next audit will otherwise read TBL-3 as
re-adding something deliberately deleted. `TablePickerSection` was removed on
2026-08-18 (see "The workspace table listing lost its panel" above) and the
reasoning was sound: it was built as a PICKER - list the workspace's tables,
choose ONE for the whole analysis - and when the choice became per log type the
picking moved onto the mapping-review cards, leaving a filter box and an
~842-row list nobody selected from. Its own header said "IT LOADS; IT DOES NOT
SELECT".

The new panel has the job that one lost. It is an operational inventory with an
ACTION on every row, standing to tables exactly as the Inventory tab stands to
DCRs. Reviving the old component would be wrong; building this is not.

Two of that deletion's lessons carry straight over. The listing does NOT
auto-load - it loads on a button, because one 403 would otherwise become a
request storm - and `emptyTableListMessage` remains the decision for when an
empty list is a real zero, rather than a second copy of that rule.

### Status

TBL-1's decision layer is committed (`manual-schema-state.ts`, a fourth `manual`
source wired into `custom-schema-state`, 21 pins, mutation-checked). The editor
component, TBL-2's name check and TBL-3's panel are open.

## 16. D-2 answered: all three surfaces own their fallback offer - 2026-08-31

**The question.** HON-7 exists because `FallbackNotice` renders without
`onProduce` in production, so the capability model's rule - every blocked
action falls back to a downloadable artifact - has no button. D-2 asked which
of Integrate deploy, Batch Deploy and DCR Automation get it, and who owns
`onProduce`.

**Chosen: all three, each wiring its own producer.** The rule is stated for
every blocked action, so a version that reaches one screen leaves it still only
partly true - which is the condition HON-7 was filed to end, not to narrow.
TBL-4 also needs it on the two new Tables-tab surfaces, and a per-screen
producer is the only shape that extends to them without a fourth convention.

**The objection the runner-up raised, and why it is not fatal.** Option 2
argued that for the pack and ARM kinds this is "a button that cannot really
produce the artifact on the spot", because those come from a RUN - a
template-only batch, a pack build - while the change-request kinds are
generated inline from data the app already holds.

That is true, and the codebase already answers it. `isInlineArtifact`
(`fallback-notice-state.ts:46`) draws exactly that line, and `fallbackHint`
already says "Produced by a run that makes no live changes" for the run kinds.
So the two options were never really opposed: they disagree only about what
`onProduce` MEANS. It means the screen owns WHAT HAPPENS when the offer is
taken - which for an inline kind is generating bytes, and for a run kind is
starting or pointing at that run. Nothing has to pretend.

**What that binds for HON-7.** Each of the three screens passes `onProduce`.
The producer consults `isInlineArtifact` to decide whether it generates or
hands off; it never fabricates a run-kind artifact inline. The existing pin on
the ABSENCE of alert semantics stays - this is an offer, not an error - and
the fallback stays visible-but-explained rather than hidden, per the capability
rule that a denied verdict annotates and never removes the attempt.

**What it does not settle.** Whether the two TBL-4 surfaces produce the same
ARM artifact as Integrate's export or a narrower one. That is TBL-4's own
question and is left to it.

## 17. DBT-62 answered: convert the remaining listings now - 2026-08-31

**The question.** DBT-61 made the empty-as-zero bug a compile error for the
four ARM listers by returning `Listing<T>` instead of an array. DBT-62 asked
whether to extend that to the listings it did not cover - Cribl packs and
worker groups, the Graph directory read, the lab inventory.

**Chosen: convert now.** The recommendation on the card was the opposite -
"wait until one actually misreads" - and it was wrong. Scoping the conversion
turned up `lab-inventory-panel.tsx:137` rendering **"No running labs found in
this subscription."** off an empty `listLabs`, which reads resource groups
through `listAllPages` and therefore answers `200 []` for an RBAC-filtered
subscription. That is DBT-64, and it had been shipping.

**Why the recommendation failed, and it is not that the odds were misjudged.**
"Wait for a defect" quietly assumes a defect will announce itself. This class
does not. The whole reason `docs/inventory-standard.md` exists is that an
unverified empty renders as a confident, plausible sentence - "No running labs
found in this subscription." looks exactly like the truth, and the operator has
no way to tell. HON-2, DBT-43 and DBT-44 were all found by someone going
looking, never by the misread surfacing on its own. A waiting strategy is only
sound where the failure is loud.

**The sharper finding: DBT-61 claimed four ARM listers and there were five.**
`listLabs` was missed because the sweep followed the inventory screens and Labs
reads as provisioning. This is worth more than the bug it hid. The type removed
the mistake everywhere it was applied; choosing where to apply it stayed a
hand-built list, and that is the step that failed. Converting the remainder is
not tidiness - it is removing the last place where coverage depends on someone
having remembered a call site.

**What is NOT converted, by the same rule read the other way.**
`acquireAnalyticRules` and `acquireSolutionWorkbooks` read files out of the
repo; `listDeprecatedContentHubSolutions` returns a `Set` used as a lookup.
None has an ambiguous empty. Wrapping them would teach the codebase that
`Listing` means "any list", and a type that marks everything marks nothing.

## 18. Nine decisions settled - the answers were recorded, the reasoning was not

**What this section is.** Nine cards carried a `chosen` value and stayed
`undecided`, some of them for weeks. Answering records the pick and nothing
else - the reasoning has to land here before a card settles, because a decision
without its rejected alternatives is the thing this repo keeps having to
reconstruct. Nobody wrote them up, so the picks sat as ticked boxes with no
argument behind them, and three of them read on the board as questions still
blocking work that had in fact been answered.

Nothing below is new judgement. Each pick was already made, and each card
already stated its alternatives; this is the argument transcribed out of the
card and into the place that settles it. Where the card's own text is the best
statement of the reason, it is used.

### 18a. D-1 - the freshness indicator goes in the connection bar

**Chosen: `connection-bar`,** beside the existing secret / target /
platform-link chips, over a frame footer.

The card had already eliminated the two other candidates for reasons that also
argue for this one: the nav was tried and is the wrong surface, and the
preflight panel re-measures on arrival so its answer would only ever read "just
now". What HON-6 reports is the AGE of a measurement, and age is only meaningful
next to the thing measured. The connection bar already carries the other facts
about the live connection, so freshness joins its own family rather than
starting a second status surface in the footer.

### 18b. D-3 - capabilities travel in PortsContext

**Chosen: `ports-context`,** over continuing to prop-drill from the shell.

One seam change against eight call sites that must each be kept in step. The
card's own framing is the argument: at eight listers this is the duplication
that drifts. It is also the shape this codebase has repeatedly had to correct -
the capability model exists because app modes were a second, drifting proxy for
permissions, and `ROUTE_CAPABILITIES` is shared for exactly this reason.
Prop-drilling is cheap now and less so later, and "later" here is already
visible.

### 18c. D-4 - the WIN enrichment catalog produces, it does not only report

**Chosen: `produce-in-scope`,** over report-only and over report-first-with-a-
follow-on.

`backlog.md#5a` states the objection to reporting alone: it leaves deployed data
still missing the fields, so the catalog improves analysis while nothing
reconstructs `Account` in the pipeline. The runner-up - ship reporting, record
producing as required - is the same destination with a gap in the middle, and
the source's own phrasing ("a legitimate slice; just do not let it become the
finished state") is a warning about exactly how that gap persists.

The deciding fact is precedent rather than preference:
`buildCefIdentityOverrideFn` (`pipeline-conf.ts:132`) was added because an
override that only changed the analysis would leave deployed data carrying the
wrong vendor. That is the same failure, already met and already answered once.

### 18d. D-6 - pack maintenance re-analyses against the LIVE table schema

**Chosen: `live-schema`,** over re-analysing the pack's stored samples and over
reading a stored analysis.

A stored analysis is cheap and goes stale silently, which is the disqualifying
half - a maintenance screen whose whole purpose is detecting drift cannot be
built on a source that drifts without saying so. Re-analysing the pack's own
samples is honest but answers the wrong question: those samples may no longer
represent live traffic, so it reports what the pack was built from rather than
what changed since. The live schema shows what actually changed, and it costs
nothing extra because it is the same fetch the picker already makes.

### 18e. D-8 - Resource Graph change tracking ships as a scheduled collector

**Chosen: `scheduled-collector`,** over omitting it and over showing it as an
unavailable row.

Omission is what `backlog.md#6e` argues against directly: an operator who ticks
through every section and never sees it concludes the tool missed it. The
unavailable row is honest and cheap, but it states an absence for a capability
that is not actually absent - Resource Graph is query-only, which is a reason to
*schedule* queries rather than a reason there is no path. The card names the
alternative in its own `notSupported` text, "scheduled Azure Resource Graph
queries", so building that is following the record rather than departing from
it.

This is the most work of the three and it lands on the unmeasured Resource Graph
capability that CAP-1 closes, which is the real sequencing constraint: CAP-1
first, or this ships against a permission nothing has measured.

### 18f. D-10 - the setup wizard stepper grows to match its header

**Chosen: `promote-substeps`,** over dropping the enumeration from the header.

Both options remove the contradiction; they differ in which side they believe.
The header promises three phases and the stepper shows one, and the header is
the one describing what setup actually involves - dropping the enumeration would
make the screen consistent by making it less informative, hiding structure the
operator has to traverse either way.

### 18g. D-11 - deprecated guid columns route to their `_` successor, per table

**Chosen: `per-table-successor`,** over leaving it at the ADR-0004 cast.

The cast alone is correct for well-formed UUIDs and CloudTrail's `requestID`
frequently is not one, so `toguid()` returns null and the value drops silently -
which is the same quiet failure ADR-0004 was written to end, reappearing one
layer down. Mapping `AwsRequestId` to `AwsRequestId_` keeps the value.

**The constraint is as load-bearing as the choice.** ADR-0004 calls this "a real
improvement" but insists it is a per-table CONTENT decision, not a
schema-mapping rule. It must NOT become a new RULE 2b clause - a general rule
would rewrite column names in tables where the successor does not exist. The
bundled catalog already carries both columns for AWSCloudTrail, so the content
this needs is present.

### 18h. FX-4 - sweep the effect-identity class by hand, once

**Chosen: `one-off-sweep`,** over authoring a custom lint rule.

The rule would be a permanent guard, and the sweep explicitly is not - nothing
stops a fourth instance being written next week. It still wins on cost of
ownership: `.oxlintrc.json` enables only `react/rules-of-hooks` and oxlint has
no `exhaustive-deps` equivalent, so this means AUTHORING and maintaining a rule
rather than switching one on. Three fixes do not justify becoming the
maintainer of a lint rule.

Worth reading beside [[DBT-61]], which went the other way on a similar question
and shows where the line is. There, a text checker was built, measured against
the real pre-fix code, and MISSED all three defects - so enforcement moved into
the type system instead. The difference is that the empty-as-zero bug had a
representable shape and this one does not; when a fourth effect-identity bug
appears, the thing to reconsider is whether it has become representable, not
whether the sweep was thorough.

### 18i. AZR-13 - the catalog derives its profile list from entra-diagnostics

**Chosen: `derive`,** over hand-adding SecurityOnly to the catalog and over
withdrawing SecurityOnly.

`ENTRA_PROFILES` becomes the single authority and the catalog imports it.
Hand-adding is the smallest diff and leaves TWO hand-maintained lists that must
agree - the duplicated decision that caused this in the first place, so the next
profile change breaks it again. Withdrawing SecurityOnly is honest but undoes a
deliberate AZR-2 decision and re-opens the LOG-07 drift AZR-2 was asked to
resolve.

**The cost is real and worth stating,** because it is the reason this looked
close: deriving WEAKENS a verbatim provenance pin. That pin changes from "equals
the legacy two" to "contains the legacy two, plus SecurityOnly which AZR-2 added
deliberately". That is a weaker claim, and it is the right one - the pin was
asserting a fact that AZR-2 had already made false on purpose, so it was
pinning the port's history rather than its correctness.

## 19. DBT-71 answered: pin every line ending to LF - 2026-09-01

**The question.** The repo has no `.gitattributes`, so how a file is stored and
checked out depends on each clone's `core.autocrlf`. Two defects shipped from
that in one day - [[DBT-66]] and [[DBT-70]] - and both passed CI. Pin
repo-wide, pin narrowly, or keep fixing instances?

**Chosen: `repo-wide`.** `* text=auto eol=lf`, accepting the renormalisation.

**Why the narrow option loses, despite being twenty times cheaper.** It pins
the 29 `.mjs` scripts and the generated asset - exactly where the two known
defects landed - and leaves 1,440-odd files on per-clone config. That is
fixing the two instances a third time rather than closing the class. The whole
argument for acting at all is that neither instance was visible to CI: the
runner is Linux and checks out LF, so both were well-formed there while broken
on the machine the work happens on. A narrow pin leaves that detection gap
exactly where it is for every file it does not cover.

**THE COST I PREDICTED DOES NOT EXIST, and the correction matters more than
the estimate did.** This section first said the change renormalises 1,473
tracked text files, breaks `git blame` repo-wide and conflicts with every open
branch. All of that was wrong, and it was wrong because of how I measured:
`git cat-file -p HEAD:<file> | od -c` showed CR bytes, and I read that as the
blob being CRLF. It was not. `git ls-files --eol` is the tool that actually
answers this, and it reports `i/lf` for 1,502 files - **the index was already
LF and always had been.**

So the renormalisation moved **nothing**: `git add --renormalize .` staged one
file, `.gitattributes` itself. There is no history churn, no blame damage and
no branch conflict, and the scheduling constraint I derived from those was
imaginary.

**What the change actually does is fix the WORKING TREE.** The index was LF and
the checkout was CRLF, which is precisely the gap DBT-66 and DBT-70 fell into -
the bytes on disk were not the bytes in the repo. `eol=lf` makes the checkout
match, and makes it match regardless of each clone's `core.autocrlf`. After
refreshing the tree: 1,500 files `w/lf`, and exactly 2 still `w/crlf` - the two
`.bat` launchers, pinned deliberately because `cmd.exe` needs CRLF.

**The lesson is the measurement, not the outcome.** The decision was right on
reasoning that included a fabricated cost, and it survived only because the
cheaper option lost on principle rather than on price. Had the 1,473 figure
been the deciding factor, a bad measurement would have produced a bad decision
- and this is the third time in two days that a claim of mine borrowed
authority from a number nobody checked.

**What this does NOT replace.** Making comparisons normalise, which was
DBT-70's fix, stays correct and stays in. It defends code we control against a
tree we may not; the `.gitattributes` defends the tree. DBT-66 is the reason
both are needed - a tool choked on CRLF in a file nothing compared, so no
amount of careful comparison would have saved it.

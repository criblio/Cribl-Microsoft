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
  `_profileOptions` omits.
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
`soc-optimizationtoolkit/**` and by `npm run check-release` locally. It reads the
packaged tarball's version and holds four claims to it - `package.json`, the
single tarball in `release/`, a `## X.Y.Z` section in
[release-notes.md](release-notes.md), and the "IS CURRENT" line directly below -
failing when any of them names a different version.

**Unreleased source WARNS and never fails**, which is the one rule to keep if
this is ever rewritten: a feature branch normally carries source the last package
does not, so failing there would mean packaging on every branch to stay green,
which is how a check gets disabled rather than obeyed. When git cannot count -
a shallow clone has no history - the run says so rather than printing the clean
line a measured zero would print, because this repo's own inventory standard
applies to its tooling too. The pins live beside it in
`check-release-drift.test.mjs`, and the pure half takes facts so the cases can be
stated without a repo, a git history or a tarball.

**1.12.1 IS CURRENT (2026-08-24).**
`release/soc-optimizationtoolkit-1.12.1.tgz` - the guid-column cast (ADR-0004)
and the architecture-audit cleanup, on top of 1.12.0's ADR-0003 in full.
Release notes in [release-notes.md](release-notes.md), started as an accumulating
file at 1.4.0 and now current through 1.12.1.

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

### 13d. The solution list swallows the mouse wheel (DBT-14)

With the pointer over the solution list, wheel scrolling moves neither the list
nor the page. The pointer has to be moved outside the list before the page will
scroll at all. Eight results were visible and five were reachable. This is the
concrete reproduction the old open question about nested scrolling never had.

### 13e. One solution renders no delivery-fit badge (DBT-15)

In the eight `Palo` results, "Palo Alto Cortex XDR" carries no fit badge while
all seven siblings carry one (Legacy, Supported, or Recommended). Blank is
ambiguous between "not measured" and "does not apply", which is the same
absent-versus-zero distinction the inventory standard exists to protect.

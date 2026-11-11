# Azure Native Source Onboarding: tenant inventory heat map

Status: Proposed - redesign of the Azure Native Source Onboarding screen around a tenant
inventory heat map; not yet planned or built.
Last-confirmed: 2026-11-11

## Intent

Today the screen starts from "what do you want to create": choose an Event Hub, tick sources,
deploy or follow How-to steps. It never says what the tenant ALREADY collects, so an operator can
create a second diagnostic setting, policy or export for logs that already reach Sentinel or
storage, paying twice and duplicating every event.

The operator decided (2026-11-11) to turn the screen around: first show, for every Azure native
log type the app knows, whether it is already collected, by what, where it goes, and whether it
is archived in low-cost object storage. Only then offer to collect what is missing, or to archive
what is collected but not archived. The point is to send operators to the logs they already have
instead of building new collection.

The design builds on the coverage model from the PowerShell research in
`deprecated/Azure/Azure-LogCollection/` (built-in Audit initiative, community initiative, Activity
Log, Entra ID, Defender for Cloud export, XDR streaming, Blob-only flow logs). That research only
ever checked whether its OWN objects existed; it never inventoried other collection.

## Goals

1. The first thing on the screen is a heat map of the tenant's Azure native logging.
2. Granularity reaches the log type (the operator's example: Entra ID
   NonInteractiveUserSignInLogs, not just "Entra ID").
3. Every log type says: collected or not, by which collector, sent where, archived or not.
4. Automation and the manual path both start from the log types the operator selects.
5. A log type that is already collected never pushes the operator toward creating a second
   collection path; its next step is "get it from <destination>" or "add an archive via Cribl".

## Non-goals

- Enabling Defender plans or any paid feature (unchanged from the research).
- Routing Activity Log or Defender for Cloud alerts to Sentinel through Cribl (operator decision
  2026-11-10, AZR-35: native connectors do that).
- Cost estimation or volume forecasting.
- Changing any existing collector that the app did not create.

## Anti-goals (failure even if it technically works)

- Showing "not collected" for something the app could not read. A refused, failed, truncated or
  never-sent read is "could not check" with its reason (claude-kit `inventory-honesty.md`; the
  same rule `domain/tenant-gap` already follows).
- Offering Automate for a log type that is already collected, without first saying where it is
  already going.
- A second selection list that can disagree with the heat map (the defect AZR-100 records).

## Decided by the operator (2026-11-11)

**What counts as already collected:** any path that already gets the log type out of Azure - a
Sentinel / Log Analytics native data connector, a diagnostic setting (direct or deployed by a
policy assignment), a Defender for Cloud continuous export, XDR streaming. The cell names the
collector and the destination (workspace, Event Hub, storage account, partner solution).

**Archived** is a separate label. A log type is archived when either:
- a matching flow is consumed by Cribl Stream and sent to object storage (a Cribl source reading
  the Event Hub or storage the collector writes to, plus a route from that source to an object
  store destination such as Cribl Lake, S3 or Azure Blob - AZR-35's Lake route is one), or
- a diagnostic setting (or flow log) writes it straight to a storage account.

A log type reaching Sentinel only through a native connector is labelled "not archived in
low-cost object storage" unless one of the two above also holds.

**Layout - a heat map:**
- One card per top category: Entra ID, Azure Activity Log, Defender for Cloud, Defender XDR,
  Resource logs, VNet flow logs, NSG flow logs.
- Card colour: green collected and archived, amber collected not archived, red not collected,
  blue could not check; mixed categories show the mix.
- Each card carries two bars: collected % and archived %.
- Clicking a card drills into a second heat map of its log types with the same colours, each tile
  naming collector, destination and archive state. Resource logs drill by resource type, then by
  category.

**Acting starts from the drill-down:** select log types, then either
- **Automate** - runs the app's deploy for exactly those log types behind the usual confirm that
  names what will be created, or
- **How-to** - opens a popup with the manual steps for exactly that selection, filled with the
  operator's names and ids.

**Everything else moves behind the tiles.** The heat map is the whole first view. The Event Hub
choice, the dataflow diagram, Validate, and the Cribl source / Lake route sections are reached from
a category or its selection, not shown as page sections.

**Scope: every readable subscription in the tenant**, the Logging Map's reach. The bars count log
types across subscriptions (Activity Log collected in 3 of 5 subscriptions); a log type collected
in some scopes and not others is its own "partly collected" state and colours amber or mixed.
Resource-level detail is read only on drill-down. Sentinel data connectors are read from every
Sentinel workspace the connection can list.

**"Add archive via Cribl" for a log type that reaches only a workspace** (a native connector or a
foreign setting with a workspace destination): the app creates ITS OWN diagnostic setting (or
export) for just those log types, to an Event Hub Cribl reads, plus the Cribl source and the Lake
route. It never edits the existing collector, Sentinel keeps its native path, and the confirm says
plainly that this adds a second, archive-only path. This is the one sanctioned exception to "never
push toward a second collection path".

The mockups the operator reacted to are a record of the conversation, not a spec:
`inventory-heatmap.html` in the brainstorming session (not committed).

## Calls made by the designer (open to change)

- **Archive shows as a bar, not a colour of its own.** Colour carries collected / not / unknown
  plus the amber "collected, not archived" state; the bar carries the share.
- **Resource logs drill two levels** (type, then category) because a tenant can hold hundreds of
  resources.
- **Selection lives in the drill-down, not on the top cards.**
- **Automate disabled with its reason** for log types the app cannot deploy yet (today only the
  Defender for Cloud export is deployable; AZR-98 adds Activity Log). How-to always works.
- **Already-collected tiles offer two actions only:** "where to get it" (a link to the workspace,
  hub or storage account) and "Add archive via Cribl" when not archived.
- **AZR-98's Activity Log deploy becomes the Automate action behind the Activity Log tile**, not a
  section of its own.
- **Automate deploys only the selected, missing log types** as the app's own setting, never
  overlapping an existing one. The deploy refusal changes from "another setting already sends to
  this hub" to "another setting already sends THESE log types to this destination". Deploy usecases
  and How-to step generation take a log-type subset.
- **The log-type list EXTENDS `ONBOARDING_SOURCES`** (each source gains child log types); it does
  not replace it, so stored How-to progress, `ITEM_AVAILABILITY` and the dataflow lanes keep their
  keys. Tenant Logging Gaps is later rebuilt on the inventory so two screens cannot answer "is X
  collected" differently; until then its own (i) says it covers only what the app created.
- **Phased delivery:** (1) read-only heat map from today's reads, unbuilt categories blue with the
  reason "not checked yet" (distinct from refused or failed), existing sections still reachable;
  (2) drill-down and selection; (3) re-host the sections behind the tiles; (4) Automate and How-to
  per selection; (5) the new reads (data connectors, per-resource settings, flow logs, Resource
  Graph).

## Where the facts come from

| Fact | Read | Exists today? |
|---|---|---|
| Policy assignments that deploy diagnostic settings, and their destination kind | Logging Map logic (`domain/logging-map/logging-classifier.ts`) | yes (AZR-19) |
| Subscription diagnostic settings (Activity Log) | `GET /subscriptions/{sub}/providers/Microsoft.Insights/diagnosticSettings` | yes (Validate) |
| Entra ID diagnostic settings and categories | `GET /providers/microsoft.aadiam/diagnosticSettings` | yes (read op exists) |
| Defender for Cloud continuous exports | `Microsoft.Security/automations` list | yes (AZR-3) |
| Sentinel data connectors per workspace | `Microsoft.SecurityInsights/dataConnectors` | no |
| Per-resource diagnostic settings | per-resource `GET .../providers/Microsoft.Insights/diagnosticSettings` | no |
| Resource inventory by type | Resource Graph (`Search-AzGraph` in the research) | partly (AZR-21 is backlog) |
| Cribl sources, routes, destinations | Cribl config reads (`read-onboarding-cribl-side`, routes table) | yes |
| Flow logs | Network Watcher flow logs list | no |

## Left to the builder

- Read pacing and caching. Reads must fit the app's request budget (Validate already caps at 40 a
  minute); the inventory needs a "read at <time>" stamp and must render partial results honestly.
- How the "matching flow" test joins an Azure collector to a Cribl source (hub or container name,
  namespace) and to an object-store route.
- How multi-tenant connections (ADR 0009) select the tenant shown.
- Component structure, and how the existing sections are re-hosted behind the tiles.

## Assumptions not yet true (measured vs inferred)

- **Inferred, unmeasured:** that the modern Sentinel Azure Activity and Entra ID connectors show up
  as diagnostic settings the reads above already see, so the data-connector read mainly adds
  Defender for Cloud and connector names. Measure on a workspace with each connector enabled.
- **Inferred:** Resource Graph has no table of per-resource diagnostic settings, so resource-level
  coverage costs one request per resource unless policy compliance state
  (`Microsoft.PolicyInsights`) can stand in for policy-deployed settings. Check before planning.
- **Unmeasured:** the category list for Entra ID per licence tier (P1 / P2 categories absent rather
  than empty). The app's Entra profiles (`ENTRA_PROFILE_CATEGORIES`) are the starting list.
- **Unmeasured:** whether the XDR streaming configuration is readable with the app's connection at
  all. If not, XDR stays blue ("could not check") permanently, which the design accepts.

## What would make this wrong

- A read cost so high that the heat map cannot be drawn within the request budget for a realistic
  tenant (hundreds of resources). Then the first view must be built from cheaper aggregates
  (policy compliance, Resource Graph) and per-resource detail fetched only on drill-down.
- An operator decision that the native-connector path should be ignored, or that the screen must
  keep the create-first flow.

## Board impact

- **AZR-100** (two selection lists): resolved by this design; the heat map is the only selection.
- **AZR-101** (Activity Log grouped under the policy initiatives): superseded; the heat map groups
  by log category, not by collection method. The research deployed Activity Log through a built-in
  policy, which is why the old grouping existed.
- **AZR-98** (Activity Log automate): its deploy usecase stays; its UI moves behind the Activity Log
  tile.
- **AZR-102** (one Event Hub choice): resolved if the hub is asked inside Automate only.
- **AZR-29, AZR-21** (Logging Map lanes, Resource Graph read): inputs to this inventory.

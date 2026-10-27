# ADR 0005: Azure onboarding sections, KV documents, and create-only Defender export

Date: 2026-10-21
Status: Accepted
Invalidates: backlog.md, feature-catalog.md
        backlog.md section 6h says "Event Hub namespace creation is `arm.deploy`"
        <!--drift-ok-->. That is false: `arm.deploy` is measured from
        `deployments/write` only (`capability-mapping.ts`), while the labs
        preflight checks `namespaces/write` directly (`lab-permissions.ts`).
        feature-catalog.md LOG-08 describes the legacy Defender export as a
        one-to-one port; this ADR records eight places the port departs from it.

## Context

AZR-18 is the Azure Native Source Onboarding screen (route `azure-onboarding`,
nav section development). The AZR cards assumed a screen that did not exist.
The first slice ships two working pieces:

- **AZR-11, use an existing Event Hub.** Pick a namespace, then a
  namespace-level authorization rule that can Send, then a hub. A pasted hub
  resource id works too.
- **AZR-3, Defender for Cloud continuous export.** Only for the configured
  subscription, and only the Alerts source. It creates one
  `Microsoft.Security/automations` resource named `CriblDefenderExport` that
  streams to the chosen hub.

Every other catalog item is shown on the screen, with its row disabled.

Four existing facts shaped the design:

1. The coverage catalog groups items by legacy `method`, and the `script`
   method holds both `entraId` and `defenderExport`
   (`coverage-model.test.ts`). Only one of the two is built.
2. Both existing KV adapters fold a 403 into `null` (`PlatformSecretsStore`
   and `KvContentCache` in `apps/cribl-app/src/platform/adapters.ts`).
   `decodeSelection(null)` gives the defaults, so after a failed read the next
   Save would overwrite the operator's real selection. claude-kit
   `standards/cribl-kv-store.md` forbids this ("A failed read is not a first
   run").
3. A `Microsoft.Security/automations` PUT replaces the whole resource. Legacy
   `Deploy-DefenderExport.ps1` PUT blindly on every run, into the hard-coded
   resource group `CriblSecurityExport`. Its GET helper is never called.
4. The Event Hub ARM builders existed twice, in `domain/eventhub-discovery` and
   `domain/labs/lab-analytics.ts`, each with its own api-version. Neither could
   list namespace-level rules or call listKeys (AZR-12 verdict: extend, do not
   build a second surface).

## Decision

### 1. Availability is per item, and is data in core

`packages/core/src/domain/onboarding-sections/` holds the screen layout as
data: `ONBOARDING_SECTIONS`, `ITEM_AVAILABILITY`, `ITEM_PREREQUISITES` and
`sectionAvailability`.

- `ITEM_AVAILABILITY` is keyed by item id. Only `defenderExport` is
  `available`. A section is available when any of its items is, so the
  `script` section is available while its `entraId` row stays disabled.
- An id missing from the map counts as not built, never as available.
- The layout has the methods first, then every `UNSUPPORTED_SOURCES` row, then
  one explicit row built from `XDR_TABLES_NOT_SUPPORTED`. That row is separate
  because the XDR tables live in a separate object, and a layout that walked
  only the unsupported sources would drop BehaviorEntities and BehaviorInfo
  without changing a "catalog plus unsupported" count. The pins count
  catalog + unsupported + 1 and name both tables.
- Sections that are not built render as `NumberedSection` `coming-soon`, with
  the new optional `notBuiltBody` showing their disabled rows. `blocked` is not
  used, because it means a gated commit.

### 2. The Event Hub prerequisite sits outside the catalog

Every tickable item streams to an Event Hub. The hub is therefore a
precondition of the items, not an item the operator ticks.
`ITEM_PREREQUISITES` names it for each item. The choice lives in React state
only. Persisting it is a follow-up.

### 3. KV documents get a three-way read, and an exact-version gate

The new port `KvDocumentStore` (`packages/core/src/ports/kv-document-store.ts`)
has two methods:

- **`load` never rejects.** It resolves to one of three results:
  - `absent`: a 404, an empty body, or a body that is not JSON;
  - `value`: the parsed JSON;
  - `unknown`: a 403, a 5xx, a timeout or a transport error.
- **`save` rejects** on any non-ok response. Values are always written
  unencrypted.

The cloud adapter is `apps/cribl-app/src/platform/kv-document-store.ts`. It is
bound once, as `kvDocuments` in `CloudPorts` and `makeCloudPorts`. The fake is
`packages/core/src/testing/fake-kv-document-store.ts`.

Whether a `value` is ours and readable is a second, separate check:
`readCoverageDocument` in `domain/coverage-model/coverage-selection.ts`. It
returns one of three results:

- `ok`: `kind` matches or is absent, and `version` is exactly
  `COVERAGE_SELECTION_VERSION` (1);
- `foreign`: `kind` is present and is someone else's;
- `unreadable`: the document is ours with any other `version`, including a
  missing one, 0, the string "1", or a higher number.

Save is enabled only after an `absent` load or an `ok` document. It is never
enabled after `unknown`, `foreign` or `unreadable`, and it never runs
automatically. `decodeSelection` is unchanged.

The 403-as-null behaviour of the two existing adapters is NOT changed here,
because every current consumer depends on it. It is filed as a bug card,
priority now.

### 4. Defender writes are create-only

`packages/core/src/usecases/defender-export/` runs the deploy, and
`packages/core/src/domain/defender-export/` holds the builders. The deploy
runs in this order:

1. A two-step confirm on the screen. It names the subscription, resource
   group, hub and automation name, and resets whenever an input changes.
2. Re-list the automations SUBSCRIPTION-WIDE
   (`GET /subscriptions/{sub}/providers/Microsoft.Security/automations`).
   Refuse with:
   - `already-exists` when a `CriblDefenderExport` exists in ANY resource
     group, including legacy's `CriblSecurityExport`;
   - `possible-duplicate` when any automation, under any name, has an
     EventHub action targeting the chosen hub or its namespace. Deploying
     beside it would deliver every alert twice;
   - `present-differs` when our automation exists but does not match (see
     below).
3. listKeys on the chosen namespace rule.
4. PUT, into an existing resource group the operator picks, at that group's
   location.
5. GET the automation back by its id.

**Ours is matching or differs.** A found `CriblDefenderExport` is
`present-matching` only when it is enabled, has an Alerts source, and has an
EventHub action whose target can be parsed. Only `present-matching` counts as
deployed. `present-differs` renders as a warning that names the differences,
with repair disabled. The deploy refuses rather than repairs, so nothing is
replaced blindly. Repair through a confirmed re-PUT is a follow-up.

**Read-back over fields that carry no secret.** `automationMatches` compares
only:

- `isEnabled`
- `sources[].eventSource`
- `scopes[].scopePath`
- `actions[].actionType`
- `actions[].eventHubResourceId`

It never compares `connectionString`, which Azure probably omits or redacts on
GET. A match gives `written-and-read-back`, and anything else gives
`accepted-not-verified`. Neither result claims delivery: the screen says that
nothing is verified until an alert arrives in the hub.

**Only Send-capable rules.** The rule picker lists only rules whose rights
include Send or Manage. With none, the picker shows the warning "None of this
namespace's authorization rules can send events", followed by each rule's
rights. Deploy stays disabled because no rule is chosen: "Choose the namespace
authorization rule the export sends with." The gate also re-checks the chosen
rule's rights and refuses with "The selected rule cannot send events". The
filtered picker makes that reason unreachable in normal use, so it is only a
defensive check. Nothing is preselected (operator answer, 2026-10-21).
`RootManageSharedAccessKey` can be picked but is not the default, and a note
says that a dedicated Send-only rule is safer. Creating that rule is a
follow-up.

**The connection string stays inside the deploy.** listKeys runs only inside
`deployDefenderExport`, after the confirm and the re-list. Its result goes
into the PUT body and nowhere else. It is never in an outcome, a log line,
React state or KV. The listKeys permission is never probed, because a probe
would pull a SAS key into the iframe.

The app never re-PUTs, never DELETEs, never writes a pricing and never
enables a Defender plan. No pricings write builder exists anywhere.

### 5. Zero enabled plans: deploy allowed, with a warning (a departure)

Legacy refused to deploy when no paid plan was enabled, and printed the portal
steps to enable one. This app allows the deploy and shows a plain warning that
carries the same enablement steps. The free foundational CSPM tier is believed
to produce alerts, and a plan read is a measurement, not a missing input. The
behaviour is one constant, `ZERO_PLANS_DEPLOY_ALLOWED` in
`packages/ui/src/screens/azure-onboarding/azure-onboarding-state.ts`. Keeping
it was the operator's answer on 2026-10-21.

The text "no paid plan is enabled" appears only when the pricings read
succeeded, no known plan is Standard, AND no unrecognized pricing is Standard.
The read has four outcomes: `read`, `denied`, `unregistered` and `failed`, and
only `read` can ever say "no paid plan". `DEFENDER_PLANS` is ported verbatim
from the legacy 12-entry map and pinned against a frozen copy of the script.

### 6. The Event Hub ARM builders move into `domain/eventhub-arm`

`packages/core/src/domain/eventhub-arm/` is the one home for Event Hub ARM
builders, with one api-version (`EVENTHUB_ARM_API_VERSION`). The new export
names avoid clashes, because the core barrel uses `export *`.

- `listEventHubsRequest` is re-based on a minimal `NamespaceRef`
  (`{subscriptionId, resourceGroup, name}`). `EventHubNamespaceInfo` still
  satisfies it structurally, so callers do not change.
- New builders cover namespace-level rule listing (`ruleCanSend`), listKeys,
  and the hub resource id.
- `discoverEventHubNamespaces`, which uses Resource Graph only, is split out of
  `discoverEventHubs`. The picker therefore does not spend one ARM GET per
  namespace.
- The Event Hub Discovery screen is unchanged.

### 7. Permissions are shown, not yet measured

No existing capability covers `Microsoft.Security/pricings/read`,
`Microsoft.Security/automations/read` and `/write`, or the namespace rule
`listKeys/action`. They are filed as CAP-7, under CAP-F1.
`ROUTE_CAPABILITIES['azure-onboarding']` is an explicit `[]`, with a comment
naming CAP-7. The screen lists `DEFENDER_SUBSCRIPTION_ACTIONS` and
`DEFENDER_NAMESPACE_ACTIONS` as "needed, not yet measured". Both have necessity
`feature`, so DCR readiness is untouched. Each step classifies Azure's 403 and
names it.

## Departures from legacy LOG-08 (`Deploy-DefenderExport.ps1`)

| # | Legacy | This app | Why |
|---|---|---|---|
| 1 | `eventHubResourceId` is the NAMESPACE id | The HUB id | The published schema is believed to expect the hub (to verify live) |
| 2 | `scopes` are plain strings | `[{description, scopePath}]` objects | Same; one builder holds both |
| 3 | Creates resource group `CriblSecurityExport` | Uses an existing resource group the operator picks; never creates one | `resourceGroups/write` is deliberately unmapped |
| 4 | Hard-codes `eastus` | Uses the chosen resource group's location | A hard-coded region is wrong for most tenants |
| 5 | PUTs on every run, blindly | Create-only: re-list, refuse on already-exists or possible-duplicate, then read back | A PUT replaces the whole resource |
| 6 | A re-run repaired a drifted export | Refuses and warns on `present-differs`; repair is a follow-up | The slice never re-PUTs, so it must say something is wrong rather than claim "Deployed" |
| 7 | Refuses to deploy with zero enabled plans | Allows the deploy, with a warning carrying the same steps | Section 5 |
| 8 | Drops pricings outside its 12-name map | Counts an unrecognized Standard pricing as enabled, "not in the known plan list" | Newer plans would otherwise read as "no paid plan" |

Legacy also hard-coded `RootManageSharedAccessKey`. This app lets the operator
pick any rule that can Send, and preselects none.

## What is NOT decided here

These are filed as follow-up cards, not built:

- creating a namespace, hub or authorization rule, including a dedicated
  Send-only rule;
- the Recommendations, Secure Score and Regulatory Compliance sources;
- repairing a `present-differs` export;
- more than one subscription;
- Defender Remove;
- persisting the Event Hub choice;
- CAP-7 probes and the nav annotation;
- the Cribl Event Hub source (AZR-S2).

The automations api-version stays at legacy `2019-01-01-preview` until Live
Preview proves a GA version.

## Consequences

**An onboarding selection can no longer be lost to a failed read.** That holds
on this screen only. Every other KV consumer still reads a 403 as absent, until
the bug card lands.

**A legacy deployment blocks this one.** A tenant that ran the PowerShell
script gets `already-exists` (or `present-differs`) instead of a second export
to the same hub. Removing or repairing it is a manual step until the follow-ups
land.

**Not verified against live Azure.** These rest on inference, not on anything
in the repo:

- the subscription-wide automations list;
- the hub-id and scope-object body shape;
- how `connectionString` looks on GET;
- the role coverage of Security Admin.

All four are on the AZR-18 live-verification list. AZR-18, AZR-11 and AZR-3
close only after Live Preview.

## Addendum 2026-10-26: ADR 0007 (AZR-30 to AZR-34)

Appended; nothing above is edited. ADR 0007
(`docs/adr/0007-onboarding-cribl-source-and-howto-progress.md`) extends this
screen and changes four things this ADR stated:

- **The Cribl Event Hub source (AZR-S2) is decided there.** It leaves "What is
  NOT decided here". The app creates an `eventhub` or `azure_blob` input,
  create-only, behind a confirm, with the credential in a Cribl secret and a
  Listen-capable rule (not the Send rule this ADR's picker chooses).
- **Mount makes two KV loads, not one.** How-to progress is a second document,
  `azure-onboarding-progress`, read through the same gate as section 3. The
  `azure-coverage-selection` document is unchanged, and Save still never runs
  automatically.
- **Section 3's write rule now covers both documents.** A progress write is
  allowed only after an `absent` or `ok` progress load, independently of the
  selection document.
- **Section 4's "listKeys runs only inside the deploy" holds for the new
  write too.** The Cribl source create calls listKeys only inside its
  confirmed apply, and the new read-only Validate never calls it.

Persisting the Event Hub picker's choice is still not done (AZR-24): the How-to
plan values are persisted, but they do not seed the picker.

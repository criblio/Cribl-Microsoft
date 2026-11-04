# Data allowances on the workspace inventory

Status: Living - built on feature/data-volume-inventory (MIG-10..20, PR #198) and seen in Live Preview 2026-11-03; MIG-17 (benefit strings and bases) still open.

## Intent

The SIEM Migration workspace inventory (MIG-F1) shows each table's daily volume
and a Billable column taken from `Usage.IsBillable`. That column overstates
cost for any customer holding a Microsoft licence or plan that grants free
ingestion, because those grants are applied on the bill, not in `Usage`.

This feature tags every inventoried table with the allowance it falls under
and, per allowance, shows granted, eligible, used and over - with the licence
counts, queries and calls that produced each number, so the operator can see
WHY the figure is right rather than take it on trust.

It serves two outcomes equally (user, 2026-11-03):

1. **An honest bill** - billable volume minus the benefits Microsoft actually
   applied.
2. **A reduction target** - the volume over each allowance is the only volume
   where Cribl reduction saves money; inside an allowance, reduction saves
   nothing.

## The grants (Microsoft documentation as read 2026-11-03)

| Tag | Grant | Eligible tables | Source |
|---|---|---|---|
| `Free` | Never billed | AzureActivity, SentinelHealth, OfficeActivity (SharePoint/Exchange/Teams), SecurityIncident, SecurityAlert from Defender XDR / Defender for Cloud / MDE / MDI / MDO / MDCA / Entra ID Protection / Defender for IoT | [Sentinel billing - Free data sources](https://learn.microsoft.com/en-us/azure/sentinel/billing) (updated 2026-06-03) |
| `E5 5 MB/user` | 5 MB per qualifying user per day. Licences: Microsoft 365 E7, E5, A5, F5, G5 and their Security SKUs (full SKU list on the offer FAQ). Requires EA/EAS/CSP | SigninLogs, AuditLogs, AADNonInteractiveUserSignInLogs, AADServicePrincipalSignInLogs, AADManagedIdentitySignInLogs, AADProvisioningLogs, ADFSSignInLogs, McasShadowItReporting, InformationProtectionLogs_CL, DeviceEvents, DeviceFileEvents, DeviceImageLoadEvents, DeviceInfo, DeviceLogonEvents, DeviceNetworkEvents, DeviceNetworkInfo, DeviceProcessEvents, DeviceRegistryEvents, DeviceFileCertificateInfo, DynamicEventCollection, CloudAppEvents, EmailAttachmentInfo, EmailEvents, EmailPostDeliveryEvents, EmailUrlInfo, IdentityLogonEvents, IdentityQueryEvents, IdentityDirectoryEvents, AlertEvidence | [Sentinel benefit for M365 E7/E5/A5/F5/G5](https://azure.microsoft.com/en-us/pricing/offers/sentinel-microsoft-365-offer) |
| `Servers P2 500 MB/machine` | 500 MB per machine per day, summed over the subscription's machines, applied at the workspace. Needs Defender for Servers Plan 2 and the Security solution on the workspace | SecurityAlert, SecurityBaseline, SecurityBaselineSummary, SecurityDetection, SecurityEvent, WindowsFirewall, ProtectionStatus, Update/UpdateSummary (only when Update Management is not running or solution targeting is on), MDCFileIntegrityMonitoringEvents, WindowsEvent (Microsoft-SecurityEvent stream only), DeviceCustomFileEvents, DeviceCustomRegistryEvents | [Defender for Cloud data ingestion benefit](https://learn.microsoft.com/en-us/azure/defender-for-cloud/data-ingestion-benefit) (updated 2026-09-29) |
| `Billable` | none | everything else | - |

SecurityAlert appears in both Free and Servers P2: Free wins (it is already
non-billable in `Usage`).

**The mapping is data, not code.** It lives in one core module as a dated table
with each row's source URL, so a Microsoft revision is a one-file change with a
visible date. A table missing from the mapping is `Billable`, never a guess.

## How each number is obtained

| Number | From | Permission |
|---|---|---|
| Eligible volume per grant | the existing `Usage` query, grouped by the mapping above | existing (`workspace.read`) |
| **Used** per grant per day | workspace `Operation` table: `Detail` = `Benefit amount used: X GB`, `OperationKey` = `Benefit type used: <type>`. Recorded since 2024-01-27 per Microsoft ([cost-usage](https://learn.microsoft.com/en-us/azure/azure-monitor/fundamentals/cost-usage#view-data-allocation-benefits)) | existing |
| **Over** per grant per day | eligible minus used, per day, then averaged over the window | existing |
| **Granted** (E5) | Graph `GET /v1.0/subscribedSkus?$select=skuId,skuPartNumber,capabilityStatus,prepaidUnits,consumedUnits,appliesTo`; qualifying SKUs matched on `skuId` from a dated list | **NEW: `LicenseAssignment.Read.All`** (Graph application, admin consent) |
| **Granted** (Servers P2) | ARM `Microsoft.Security/pricings/VirtualMachines` per subscription (plan + subPlan), times machines reporting to the workspace (Heartbeat, by day, `Computer` and `_SubscriptionId`: the grant is per machine PER DAY, so machines are counted per day; the card shows the daily average and the cross-check compares each capped day with that day's count) | expected existing; confirm live (see Open) |

`Used` and `Over` are Microsoft's own record and need no licence data, so they
are exact even when Granted cannot be read.

### The cross-check (why the operator can trust Granted)

On days where eligible volume exceeded the benefit applied, the `Operation`
figure IS the cap Microsoft applied that day. The drill-down compares it with
the computed Granted and states `Consistent` or the difference. This also
settles, from the customer's own data, two things Microsoft's docs leave open:

- whether the E5 grant counts **assigned** (`consumedUnits`) or **purchased**
  (`prepaidUnits.enabled`) seats - both totals are shown, the matching one is
  marked. Seats count only on SKUs whose `capabilityStatus` is Enabled or
  Warning; and because `subscribedSkus` has no per-user overlap, a user
  holding two qualifying SKUs is counted twice, so when more than one
  qualifying SKU has seats assigned the assigned figure says it may
  double-count (MIG-21) and the cross-check settles it;
- whether Servers P2 counts machines in the subscription or machines reporting
  to this workspace - both counts are shown, the matching one is marked.

If no day ran over, the cross-check says it cannot be confirmed yet (no capped
day in the window), not that it passed.

## Where it lives (user decision 2026-11-03)

The inventory leaves SIEM Migration and becomes its own page, **Data Volume
Inventory** (route id `data-volume-inventory`), in the nav's **tools**
section. SIEM Migration keeps no link or pointer to it; the nav is the way in.
The move ships before the allowance work, and the allowances land on the new
page.

## What the operator sees (agreed: mockup option A with drill-down)

On the Data Volume Inventory page
(`packages/ui/src/screens/data-volume-inventory/workspace-inventory-panel.tsx`,
moved out of SIEM Migration by MIG-10):

1. **Stat row** gains `daily billable after allowances` beside the existing
   `daily average, billable`.
2. **One card per grant present** (E5, Servers P2): granted, eligible, used, a
   meter (eligible against a granted marker), and either `N GB/day over` or
   `N GB/day headroom`. Each card opens a drill-down with:
   - **Granted**: the licence table (every tenant SKU; qualifying ones first
     with the reason; non-qualifying ones dimmed with why not, e.g. E3,
     standalone Defender SKUs), columns purchased / grace-or-suspended /
     assigned, a totals row, the arithmetic (`2,400 x 5 MB = 12.0 GB/day`), and
     the alternative-basis figure. For Servers P2: one row per subscription with
     plan, machines covered, machines reporting here, and the arithmetic.
   - **Used**: a 30-day chart of eligible vs applied, from `Operation`.
   - **Eligible**: the eligible tables with volume and whether Cribl can write
     into each (Entra and Defender XDR tables: no).
   - **The cross-check** line.
   - The exact query or call behind each section, with the time it was read.
3. **Table** gains an `Allowance` tag column and an `Over allowance / day`
   column. Rows stay sorted by volume. A grant's overage is pooled, so per-table
   cells for pooled grants read `share of N GB`; the overage is never split
   across tables.
4. **Tag drill-down** per row: the grant's rule, and a reroute warning - data
   keeps its grant only if it still lands in the same native table; routing it
   to a `_CL` table forfeits up to its eligible volume of coverage.
5. **"Queries that produced these numbers"** gains the `Operation` query, the
   eligible-volume query, and the Graph and ARM calls.
6. **CSV** gains `Allowance`, `AllowanceEligibleDailyMB`, `AllowanceUsedDailyMB`,
   `AllowanceOverDailyMB` columns (the grant-level figures repeated per row),
   and `AllowanceFigures`, which says whether those figures are `exact` or a
   `lower bound` (a workspace not read, a partial Usage answer, or a partial
   benefit read), or why a cell is empty (eligible volume not read, a benefit
   known only in total). An unknown figure is an empty cell, never 0.

### Without the new permission

The E5 drill-down says licence counts were not read, names
`LicenseAssignment.Read.All`, says it reads SKUs and seat counts only (not who
holds them), and offers the change request. Granted is shown as `at least X` -
the largest benefit Microsoft applied on any day in the window - and headroom
is not shown. Used and Over are unaffected.

## Constraints

- **Inventory honesty** (`docs/inventory-standard.md`, binding): an empty
  `Operation` result, an empty `subscribedSkus`, or an empty pricings list is
  not a zero. Empty `Operation` with `workspace.read` granted means no benefit
  was applied in the window (say so, with the 2024-01-27 start date if the
  window predates it); a 403 from Graph means not read, never "no E5 licences".
- **Core is pure**: the mapping, the grant arithmetic, the cross-check and the
  per-day over computation are pure functions in `packages/core`; Graph and ARM
  reads go through ports implemented in `apps/cribl-app`.
- The Graph proxy already exists (`apps/cribl-app/config/proxies.yml`); the new
  permission is added to `GRAPH_PERMISSIONS` in
  `packages/core/src/domain/app-permissions/app-permissions.ts` as
  `necessity: "feature"`, so an approver can refuse it without blocking setup.
- No new Azure RBAC role unless the live check below says pricings are not
  readable.
- Units stay decimal MB, matching `Usage.Quantity` and `formatMB`.

## Non-goals

- Pricing in currency. Volumes only; the rate depends on tier and commitment
  and is not this feature.
- Free trial (10 GB/day for 31 days) and legacy Per Node / OMS entitlements.
  The Per Node tier also reports through the `Operation` table; if seen, show
  it under Servers P2 with a note, do not model it.
- Sentinel data lake tier pricing.
- Multi-tenant licence aggregation (single tenant only, per project decision).

## Anti-goals

- A Granted figure shown without the counts and arithmetic behind it.
- Splitting a pooled overage across tables as if it were measured.
- Reporting "no E5 licences" or "no benefit" from an unread or permission-
  filtered answer.
- Hard-coding the eligible-table lists in UI code.

## Calls made after the builder review (2026-11-03)

These are the designer's calls, not the user's; each is cheap to reverse.

1. **Degraded `Operation` attribution.** If benefit rows cannot be attributed
   to a grant (generic or combined `OperationKey`), the cards collapse to one
   pooled "benefit applied" figure: Used and Over are shown in total only, the
   per-grant meters are not drawn, and the drill-down says why. The core model
   carries `attribution: "per-grant" | "pooled"`.
2. **Conditions the app cannot read.** Granted for E5 is labelled "entitled if
   purchased through EA, EAS or CSP"; Graph cannot tell the purchase channel, so
   the cross-check is the proof and there is no operator override. Update and
   UpdateSummary are tagged `Servers P2 (conditional)` with the Update
   Management condition in the tip.
3. **Partly readable subscriptions (Servers P2).** Every subscription seen in
   `Heartbeat._SubscriptionId` gets a row; one whose pricings call is refused or
   not visible reads `not read` (inventory standard), and Granted becomes
   `at least X` from the readable rows.
4. **Cross-check tolerance.** `Operation` "GB" is treated as decimal (10^9,
   matching Sentinel billing units) until the live check says otherwise. A basis
   "matches" when the median capped-day figure is within 2% of it; a basis is
   marked only when exactly one matches, otherwise the drill-down shows both
   differences and marks neither. Seat counts are read today, so the line says
   "seat counts as of today, compared with the last 30 days".
5. **Eligible volume is billable volume** (`BillableMB` of the mapped tables),
   so "daily billable after allowances" = billable minus used. Table plan
   (Analytics / Basic / Auxiliary) is read where the inventory can already read
   tables; an eligible table not on Analytics is flagged "grant may not apply on
   this plan" rather than modelled.
6. **More than one Sentinel workspace in the tenant** - USER DECISION
   2026-11-03: the operator chooses. This rule is about the E5 grant only,
   which is the one grant shared across the tenant; Servers P2 is summed per
   subscription and applied at the workspace, so its card carries no
   shared-workspace label and its cross-check is not skipped for the workspace
   count (MIG-19, found in Live Preview). By default the cards cover the
   inventoried workspace: Used and Over are exact for it, E5 Granted is labelled
   "tenant-wide, shared across N Sentinel workspaces" (N from the existing
   workspace discovery, which already counts Sentinel-enabled workspaces;
   "at least N" when discovery could not see every subscription or
   workspace), and
   the cross-check is skipped with that reason; so are the E5 headroom and
   meter, which would compare the tenant-wide grant with one workspace's
   eligible volume. A "Compare against the whole
   tenant" action reads eligible volume and `Operation` benefit rows from every
   visible Sentinel workspace on demand, sums them, and then runs the
   cross-check tenant-wide. Workspaces it cannot read are listed as `not read`
   and the sums become `at least` (inventory standard). The same applies to
   Servers P2 when a subscription's machines report to several workspaces,
   except the tenant-wide cross-check: the Servers P2 benefit is capped per
   workspace, so a day capped in the tenant sum may be one workspace running
   out. The Servers P2 cross-check runs on a single workspace only.

## Open, to confirm on a workspace that receives a benefit (MIG-17)

Measured 2026-11-03 on the lab tenant (80 workspaces, 4 subscriptions, az CLI,
read-only): **no workspace received an E5 or Servers P2 benefit in 31 days**,
so items 2 and 3 could not be measured. The owner chose to ship without them;
MIG-17 stays open.

1. Pricings readable - CONFIRMED for the lab identity: `GET
   .../Microsoft.Security/pricings/VirtualMachines` answers (tier Free on two
   subscriptions); a subscription not registered for Microsoft.Security answers
   404 `SubscriptionNotRegistered`, which the code reports as `not read`. The
   Resource Graph machine count answers (55 machines in one subscription).
2. Which seat basis and which machine basis the `Operation` figures match -
   NOT MEASURED; the cross-check marks a basis when the data allows.
3. The literal `Operation` benefit-type strings - NOT MEASURED; an
   unrecognised type degrades the read to one pooled figure rather than
   guessing. The patterns cover the strings published so far (2026-11-04,
   asserted by a community guide, not observed): "SentinelMicrosoft365" reads
   as E5, "Standard Data Included per Node" (also Microsoft's meter name) as
   Servers P2, and the ambiguous "MicrosoftDefender" stays unattributed
   (MIG-26). A workspace with no applied benefit cannot answer this: the
   `Operation` table has no list of possible types, only rows for benefits
   applied.

## Left to the builder

Card and component structure, the chart implementation (follow the `dataviz`
skill), query batching against the 100 req/min proxy budget, and caching of the
Graph read.

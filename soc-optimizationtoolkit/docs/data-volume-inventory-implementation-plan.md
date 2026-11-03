# Data Volume Inventory and data allowances - Implementation Plan

Status: Record - executed 2026-11-03 subagent-driven (per-task review, a verified whole-branch review and one fix wave), plus MIG-18..20 found in review and Live Preview; see the MIG-F2 cards.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the workspace inventory to its own Data Volume Inventory page, then tag every table with the data allowance it falls under and show granted / eligible / used / over per grant, with the licence counts and queries behind each number.

**Architecture:** A new pure core module `domain/data-allowances` holds the dated table-to-grant catalog, the KQL, the parsers and the arithmetic. A new usecase `usecases/data-allowances` runs the reads over the existing `AzureManagement` port and an extended `GraphDirectory` port. The UI adds a pure `allowance-state.ts` and an `AllowanceCards` component to the moved panel.

**Tech Stack:** TypeScript, React, vitest (happy-dom for `*.dom.test.tsx`), Capra UI classes already in `styles.css`.

**Spec:** `docs/features/inventory-data-allowances.md` - read it first; this plan argues from it.

**Board:** feature `MIG-F2`, stories `MIG-10` .. `MIG-17` (one per task below, ids in each task heading). Move the card to `in-progress` BEFORE starting the task (CLAUDE.md board rule 1); close it with a `verified` value.

**Branch:** `feature/data-volume-inventory` from `origin/main`. Stage explicit paths only (never `git add -A`).

## Global Constraints

- Units are decimal: MB = 10^6 bytes (`BYTES_PER_MB`), `Operation` "GB" = 1000 MB until MIG-17 measures otherwise.
- Grants: E5 = `5` MB per qualifying seat per day; Servers P2 = `500` MB per machine per day.
- Window: the inventory's own - last `INVENTORY_WINDOW_DAYS` (30) complete UTC days, today excluded.
- Cross-check tolerance: a basis matches when the median capped-day used figure is within `0.02` (2%) of it; marked only when exactly one basis matches.
- Inventory honesty (`docs/inventory-standard.md`, BINDING): a refused, partial or permission-filtered read is never rendered as a zero or "none".
- `@soc/core` stays pure: no clock, no fetch, no React. IO only through ports.
- The Graph permission is `LicenseAssignment.Read.All` (application), `necessity: "feature"`.
- No emojis anywhere (repo rule).
- New route id `data-volume-inventory`, label `Data Volume Inventory`, nav section `tools`. SIEM Migration keeps NO link to it.

## Review Focus

1. **A workspace with no benefit at all** (no E5, no Defender for Servers): no grant cards, every table still tagged, and the copy says "no benefit was applied in the window", never "no licences". Pinned in Task 6.
2. **An unknown `Operation` benefit type string**: the whole read degrades to `attribution: "pooled"`; nothing is silently dropped or assigned to a guessed grant. Pinned in Task 3.
3. **A tenant whose E5 seats are all suspended or locked out**: SKUs still listed as qualifying, purchased `enabled` reads 0, granted 0, the grace/suspended column shows the counts. Pinned in Task 4.
4. **Heartbeat machines with an empty `_SubscriptionId`** (non-Azure, no Arc): listed as a "no subscription" row, excluded from Granted, never counted as covered. Pinned in Task 4.
5. **An eligible table whose volume is entirely non-billable**: eligible 0, meter draws without dividing by zero, "after allowances" never goes negative. Pinned in Task 3 and Task 6.

---

### Task 1 (MIG-10): Data Volume Inventory becomes its own page

**Files:**
- Move (`git mv`): `packages/ui/src/screens/siem-migration/workspace-inventory-panel.tsx`, `workspace-inventory-panel.dom.test.tsx`, `workspace-inventory-state.ts`, `workspace-inventory-state.test.ts` -> `packages/ui/src/screens/data-volume-inventory/`
- Modify: `packages/ui/src/screens/siem-migration/siem-migration-screen.tsx` (drop the import at line 52 and the render at line 555)
- Modify: `packages/ui/src/index.ts` (export `WorkspaceInventoryPanel`)
- Modify: `packages/ui/src/frame/route-capabilities.ts` (add `"data-volume-inventory": ["workspace.read"]` in the tools block, with a one-line comment)
- Modify: `apps/cribl-app/src/App.tsx` (a `renderDataVolumeInventory` beside `renderSiemMigration` at ~2179; nav entry after `logs`, before `settings`)
- Modify: `apps/cribl-app/scripts/board.mjs` (move `data-volume-inventory` from the planned block to the tools block of `MENUS`, remove it from `PLANNED_MENUS`; label stays)
- Modify: `CLAUDE.md` board section sentence about PLANNED menus, back to naming only `windows-events`
- Modify: `apps/cribl-app/scripts/board-menus-routes.test.mjs` - the planned-menu sentence pin goes back to `'One menu is PLANNED and has no route yet.'` (it reads Two while this card is open), and add a `describe('data-volume-inventory (MIG-10)')` asserting the route row is `{ id: 'data-volume-inventory', label: 'Data Volume Inventory', requiresId: 'data-volume-inventory', section: 'tools' }` and that it is no longer PLANNED
- Test: the moved DOM test

**Interfaces:**
- Produces: route `data-volume-inventory`; `WorkspaceInventoryPanel` exported from `@soc/ui`; all later tasks edit files under `screens/data-volume-inventory/`.

- [ ] **Step 1:** Add to the SIEM Migration screen's DOM test (create `siem-migration-screen.dom.test.tsx` beside the screen if none exists, reusing the moved panel test's `PortsProvider` setup) a test `"SIEM Migration no longer renders the workspace inventory"` that renders `SiemMigrationScreen` and asserts `screen.queryByText("Existing Sentinel workspace inventory")` is `null`.
- [ ] **Step 2:** Run `npx vitest run src/screens/data-volume-inventory` in `packages/ui`. Expected: the new test FAILS.
- [ ] **Step 3:** Do the moves and edits listed above. Page header copy: title `Data Volume Inventory`, subtitle `What an existing Log Analytics or Sentinel workspace ingests: every table, the sources feeding it, the daily volume, and the data allowances that make some of it free.`
- [ ] **Step 4:** Run from `soc-optimizationtoolkit/`: `npm run typecheck && npm test && npm run check-board && npm run check-classnames`. Expected: all pass, including `board-menus-routes`.
- [ ] **Step 5:** Live Preview (`/apps/a/__local__`): the page appears under Tools, inventories a workspace, and SIEM Migration shows no inventory panel.
- [ ] **Step 6:** Commit `Move workspace inventory to Data Volume Inventory`.

### Task 2 (MIG-11): The allowance catalog

**Files:**
- Create: `packages/core/src/domain/data-allowances/allowance-catalog.ts`, `allowance-catalog.test.ts`, `index.ts`

**Interfaces:**
- Produces:
  - `type GrantId = "e5" | "servers-p2"`
  - `type AllowanceTag = { kind: "free" } | { kind: "grant"; grant: GrantId; condition: string | null } | { kind: "billable" }`
  - `allowanceFor(table: string): AllowanceTag` (case-insensitive)
  - `eligibleTables(grant: GrantId): readonly string[]`
  - `E5_MB_PER_SEAT_PER_DAY = 5`, `SERVERS_MB_PER_MACHINE_PER_DAY = 500`
  - `ALLOWANCE_CATALOG_AS_OF = "2026-11-03"`
  - `ALLOWANCE_SOURCES: Record<"free" | GrantId, { url: string; title: string }>` (the three URLs in the spec's grants table)
  - `interface QualifyingSku { skuId: string; skuPartNumber: string; family: "E7" | "E5" | "E5 Security" | "A5" | "F5" | "G5" }`; `E5_QUALIFYING_SKUS: readonly QualifyingSku[]`

- [ ] **Step 1: Write the failing tests** in `allowance-catalog.test.ts`:
  - `allowanceFor("SecurityAlert")` -> `{ kind: "free" }` (Free wins over Servers P2)
  - `allowanceFor("signinlogs")` -> `{ kind: "grant", grant: "e5", condition: null }`
  - `allowanceFor("SecurityEvent")` -> `{ kind: "grant", grant: "servers-p2", condition: null }`
  - `allowanceFor("Update").condition` matches `/Update Management/`; `allowanceFor("WindowsEvent").condition` matches `/Microsoft-SecurityEvent/`
  - `allowanceFor("CommonSecurityLog")` and `allowanceFor("Zscaler_CL")` -> `{ kind: "billable" }`
  - `eligibleTables("e5")` has length `29` and contains `"InformationProtectionLogs_CL"`; `eligibleTables("servers-p2")` has length `13` (the spec's list including SecurityAlert, which `allowanceFor` still tags Free)
  - every `E5_QUALIFYING_SKUS` entry has a GUID-shaped `skuId` and no duplicate `skuId`
- [ ] **Step 2:** Run `npx vitest run src/domain/data-allowances` in `packages/core`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement. Table lists are copied verbatim from the spec's grants table. `E5_QUALIFYING_SKUS`: take each SKU the offer FAQ (https://azure.microsoft.com/en-us/pricing/offers/sentinel-microsoft-365-offer) names, and copy its `skuId`/`skuPartNumber` from Microsoft's "Product names and service plan identifiers for licensing" CSV (https://learn.microsoft.com/en-us/entra/identity/users/licensing-service-plan-reference); record the CSV's date in a comment beside `ALLOWANCE_CATALOG_AS_OF`. Never type a GUID from memory. Keep the module off the `@soc/core` barrel except through the usecase index (Task 5), per the AZR-53 rule in `usecases/workspace-inventory/index.ts`.
- [ ] **Step 4:** Re-run. Expected: PASS. Mutation check: drop `SecurityAlert` from the free list and confirm the first test fails.
- [ ] **Step 5:** Commit `Add the data allowance catalog`.

### Task 3 (MIG-12): Benefit used, eligible volume, and the per-grant fold

**Files:**
- Modify: `packages/core/src/domain/workspace-inventory/workspace-inventory.ts` (export the existing `WINDOW_FILTER` const)
- Create: `packages/core/src/domain/data-allowances/benefit-usage.ts`, `benefit-usage.test.ts`

**Interfaces:**
- Consumes: `GrantId`, `eligibleTables` (Task 2); `WINDOW_FILTER`, `kqlTableRef`, `BYTES_PER_MB`, `INVENTORY_WINDOW_DAYS` (workspace-inventory)
- Produces:
  - `BENEFIT_QUERY: string`: the spec's `Operation` query with the inventory `WINDOW_FILTER`, projecting `Day = format_datetime(startofday(TimeGenerated), 'yyyy-MM-dd')`, `BenefitType`, `BenefitUsedGB`
  - `eligibleDailyQuery(tables: readonly string[]): string`: `Usage | where WINDOW_FILTER and DataType in (...) and IsBillable == true | summarize EligibleMB = sum(Quantity) by Day, DataType`
  - `interface BenefitDay { day: string; grant: GrantId | "pooled"; usedMB: number }`
  - `parseBenefitRows(rows): { days: BenefitDay[]; attribution: "per-grant" | "pooled"; unmatchedTypes: string[] }`
  - `BENEFIT_TYPE_PATTERNS: ReadonlyArray<{ pattern: RegExp; grant: GrantId }>`: initial `/M365|Microsoft 365|Defender XDR/i` -> `e5`, `/Defender for Servers|per Node|Security/i` -> `servers-p2`; MIG-17 replaces these with the literal strings it records
  - `interface GrantUsage { eligibleDailyMB: number; usedDailyMB: number; overDailyMB: number; maxUsedDayMB: number; cappedDays: Array<{ day: string; usedMB: number }>; eligibleByDay: Map<string, number>; usedByDay: Map<string, number> }`
  - `foldGrantUsage(eligibleByDay: ReadonlyMap<string, number>, usedByDay: ReadonlyMap<string, number>): GrantUsage`

- [ ] **Step 1: Write the failing tests:**
  - `parseBenefitRows` with types `"Benefit type used: M365 Defender"` and a Servers string -> `attribution: "per-grant"`, GB converted (`1.5` GB -> `1500` MB)
  - one unrecognised type among recognised ones -> `attribution: "pooled"`, every day's grant `"pooled"`, `unmatchedTypes` lists it (Review Focus 2)
  - `foldGrantUsage`: eligible `{d1: 14000, d2: 9000}`, used `{d1: 12000, d2: 9000}` -> `overDailyMB === 2000 / 30`, `cappedDays` is `[{ day: "d1", usedMB: 12000 }]` (d2 is not capped: eligible within 1% of used), `maxUsedDayMB === 12000`
  - over is per-day clamped at 0: used above eligible on a day contributes 0, not negative
  - all-zero eligible -> every figure 0, no `NaN` (Review Focus 5)
  - `eligibleDailyQuery([])` throws; `eligibleDailyQuery(["SigninLogs"])` contains `IsBillable == true` and the `WINDOW_FILTER` text
- [ ] **Step 2:** Run in `packages/core`: `npx vitest run src/domain/data-allowances`. Expected: FAIL.
- [ ] **Step 3:** Implement. Averages divide by `INVENTORY_WINDOW_DAYS`, not by the count of days with data. A day is capped when `eligible > used * 1.01`.
- [ ] **Step 4:** Re-run. Expected: PASS. Mutation check: remove the clamp and confirm the over test fails.
- [ ] **Step 5:** Commit `Read benefit used and eligible volume per grant`.

### Task 4 (MIG-13): Granted, and the cross-check

**Files:**
- Modify: `packages/core/src/domain/defender-export/defender-plans.ts` (`PlanStatus` gains `readonly subPlan: string` from `properties.subPlan`, `""` when absent) and its test
- Create: `packages/core/src/domain/data-allowances/granted.ts`, `granted.test.ts`

**Interfaces:**
- Consumes: `E5_QUALIFYING_SKUS`, `E5_MB_PER_SEAT_PER_DAY`, `SERVERS_MB_PER_MACHINE_PER_DAY` (Task 2); `PricingsResult` (defender-plans)
- Produces:
  - `interface SubscribedSku { skuId: string; skuPartNumber: string; capabilityStatus: string; enabled: number; warning: number; suspended: number; lockedOut: number; consumed: number; appliesTo: string }`
  - `parseSubscribedSkus(body: unknown): SubscribedSku[]` (throws when `value` is not an array)
  - `interface LicenceRow extends SubscribedSku { qualifies: boolean; family: QualifyingSku["family"] | null; reason: string }`
  - `e5Granted(skus: readonly SubscribedSku[]): { rows: LicenceRow[]; purchased: number; assigned: number; inGrace: number; suspended: number; grantedMB: { assigned: number; purchased: number } }`. Rows: qualifying first, then by `consumed` descending
  - `interface ServersSubscriptionRow { subscriptionId: string; plan: "P2" | "P1" | "off" | "not-read"; machinesInSubscription: number | null; machinesReportingHere: number }`
  - `serversGranted(rows: readonly ServersSubscriptionRow[], unattributedMachines: number): { grantedMB: { reportingHere: number; inSubscription: number | null }; atLeast: boolean }`
  - `type CrossCheck = { kind: "no-capped-day" } | { kind: "skipped"; reason: string } | { kind: "matched"; basis: string; medianMB: number } | { kind: "unmatched"; medianMB: number; diffs: Array<{ basis: string; pct: number }> }`
  - `crossCheck(capped: ReadonlyArray<{ usedMB: number }>, bases: ReadonlyArray<{ basis: string; mb: number }>, tolerance?: number): CrossCheck` (default `0.02`)

- [ ] **Step 1: Write the failing tests:**
  - `parsePricings` keeps `subPlan: "P2"` on `VirtualMachines`
  - `e5Granted` with SPE_E5 (enabled 2000, consumed 1940), E5 Security (500 / 460), SPE_E3 (800 / 790) -> `assigned 2400`, `purchased 2500`, `grantedMB.assigned === 12000`, E3 row `qualifies: false` with a non-empty `reason`
  - all qualifying seats suspended (`enabled 0, suspended 2000`) -> `purchased 0`, `suspended 2000`, row still `qualifies: true` (Review Focus 3)
  - `serversGranted`: P2 rows reporting 46 and 14, a P1 row reporting 9 -> `grantedMB.reportingHere === 30000`, `atLeast: false`; adding a `not-read` row -> `atLeast: true`; `unattributedMachines` never changes the granted figure (Review Focus 4)
  - `crossCheck` with capped `[11970, 12010, 12000]` and bases `assigned 12000`, `purchased 12500` -> `matched`, basis `assigned`; both bases within 2% -> `unmatched`; empty capped -> `no-capped-day`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Qualification matches on `skuId`, never on display name.
- [ ] **Step 4:** Re-run. Expected: PASS. Mutation check: match on `skuPartNumber` only and confirm a test with a renamed part number fails.
- [ ] **Step 5:** Commit `Compute granted allowances and the cross-check`.

### Task 5 (MIG-14): Licence read, the permission, and the usecase

**Files:**
- Modify: `packages/core/src/ports/graph-directory.ts` (add `readSubscribedSkus`), `apps/cribl-app/src/platform/adapters.ts` (`PlatformGraphDirectory.readSubscribedSkus`)
- Modify: `packages/core/src/domain/app-permissions/app-permissions.ts` (`GRAPH_PERMISSIONS` gains `LicenseAssignment.Read.All`), its test, `apps/cribl-app/config/proxies.yml` (Graph comment names both permissions), `docs/feature-catalog.md` where it lists Graph permissions
- Create: `packages/core/src/usecases/data-allowances/data-allowances.ts`, `data-allowances.test.ts`, `index.ts`; export from `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Tasks 2 to 4; `buildPricingsListRequest`, `parsePricings`; `resourceGraphRequest` (eventhub-discovery); `parseQueryResult`, `WORKSPACE_QUERY_API_VERSION`, `INVENTORY_TIMESPAN`
- Produces:
  - port: `readSubscribedSkus(): Promise<{ kind: "read"; body: unknown } | { kind: "denied"; status: number; detail: string }>`. Rejects only on transport failure. Adapter URL: `${GRAPH_BASE_URL}/v1.0/subscribedSkus?$select=skuId,skuPartNumber,capabilityStatus,prepaidUnits,consumedUnits,appliesTo`; same 401/403 re-acquire-once as `listServicePrincipals`
  - `type LicenceRead = { kind: "read"; e5: ReturnType<typeof e5Granted>; readAt: string } | { kind: "denied"; detail: string } | { kind: "not-bound" }`
  - `interface GrantView { grant: GrantId; usage: GrantUsage; grantedMB: number | null; grantedIsFloor: boolean; crossCheck: CrossCheck; eligibleTables: Array<{ table: string; eligibleDailyMB: number }> }`
  - `interface DataAllowances { attribution: "per-grant" | "pooled"; grants: GrantView[]; pooled: GrantUsage | null; afterAllowancesDailyMB: number; licences: LicenceRead; servers: { rows: ServersSubscriptionRow[]; unattributedMachines: number }; scope: { kind: "workspace"; sentinelWorkspaces: number | null } | { kind: "tenant"; workspaces: string[]; notRead: Array<{ id: string; error: string }> }; queries: { benefit: string; eligible: string; heartbeat: string; machines: string; graph: string; pricings: string } }`
  - `readDataAllowances(azure: AzureManagement, graph: GraphDirectory | undefined, workspaceId: string, inventory: WorkspaceInventory, opts: { logger?: Logger; onProgress?: (s: string) => void; readAt: string; sentinelWorkspaces: number | null }): Promise<DataAllowances>` (`readAt` injected: core reads no clock)
  - `compareTenant(azure, graph, workspaceIds: readonly string[], inventories: ReadonlyMap<string, WorkspaceInventory>, opts): Promise<DataAllowances>` with `scope.kind === "tenant"`

- [ ] **Step 1: Write the failing tests** (`FakeAzureManagement` for ARM, an inline object for `GraphDirectory`):
  - `GRAPH_PERMISSIONS` names exactly `["Application.Read.All", "LicenseAssignment.Read.All"]`, both `necessity: "feature"`
  - the usecase posts `BENEFIT_QUERY` to `${WS}/query` with `INVENTORY_TIMESPAN`, then the eligible query, the Heartbeat query, one pricings GET per subscription seen in Heartbeat, and one Resource Graph POST
  - graph `undefined` -> `licences.kind === "not-bound"`; `denied` -> `"denied"` and the E5 view has `grantedMB` = `maxUsedDayMB` with `grantedIsFloor: true` and `crossCheck.kind === "skipped"` (reason: seat counts not read)
  - a 403 pricings answer -> that subscription row is `plan: "not-read"` (not `"off"`)
  - `sentinelWorkspaces: 2` -> every `crossCheck.kind === "skipped"` with a reason naming 2 workspaces
  - no benefit rows and no eligible tables -> `grants` is `[]` and `afterAllowancesDailyMB === inventory.totals.billableDailyAverageMB` (Review Focus 1)
  - `compareTenant` with one workspace refusing its query -> `scope.notRead` lists it and every `grantedIsFloor` / sum is flagged
- [ ] **Step 2:** Run in `packages/core`: `npx vitest run src/usecases/data-allowances src/domain/app-permissions`. Expected: FAIL.
- [ ] **Step 3:** Implement. Heartbeat query: `Heartbeat | where WINDOW_FILTER | summarize by Computer, SubscriptionId = tostring(_SubscriptionId)`. Resource Graph query: `resources | where type in~ ('microsoft.compute/virtualmachines', 'microsoft.hybridcompute/machines') | summarize Machines = count() by subscriptionId`. Every query failure lands in the result as a stated gap, never as zero; only a failed `Operation` read for the target workspace throws (the allowances then show an error line, the inventory stays). Implement the adapter method, then run `apps/cribl-app` tests.
- [ ] **Step 4:** Re-run core and `apps/cribl-app` tests. Expected: PASS. Mutation check: map a 403 pricings answer to `"off"` and confirm the test fails.
- [ ] **Step 5:** Commit `Read licences and Defender plans for data allowances`.

### Task 6 (MIG-15): Allowance cards, drill-downs, table columns and CSV

**Files:**
- Create: `packages/ui/src/screens/data-volume-inventory/allowance-state.ts`, `allowance-state.test.ts`, `allowance-cards.tsx`, `allowance-cards.dom.test.tsx`
- Modify: `workspace-inventory-panel.tsx` (after a successful inventory, run `readDataAllowances` with `readAt: new Date().toISOString()` from the UI and `sentinelWorkspaces` from the discovery rows; render cards, the stat, table columns and queries), `workspace-inventory-state.ts` (`inventoryCsv(inventory, allowances: DataAllowances | null)`), `packages/ui/src/styles.css` (only Capra-consistent classes; `check-classnames` must pass)

**Interfaces:**
- Consumes: `DataAllowances`, `GrantView`, `AllowanceTag`, `allowanceFor` (Tasks 2 to 5)
- Produces: `tagLabel(tag: AllowanceTag): string` (`"Free"`, `"E5 5 MB/user"`, `"Servers P2 500 MB/machine"`, `"Billable"`, conditional suffix `" (conditional)"`); `grantCardText(view: GrantView): { title: string; granted: string; eligibleUsed: string; status: string }`; `overCell(table: string, a: DataAllowances): string`; `crossCheckLine(c: CrossCheck): string`; `<AllowanceCards allowances={...} />`

- [ ] **Step 1: Write the failing tests:**
  - `grantCardText` for `grantedMB 12000`, `eligibleDailyMB 14100`, `usedDailyMB 12000`, `overDailyMB 2100` -> status `"2.1 GB/day over"`; for `grantedMB 30000`, `eligibleDailyMB 9300`, `overDailyMB 0` -> `"20.7 GB/day headroom"` (granted minus eligible); `grantedIsFloor` -> granted reads `"at least 12.0 GB/day"` and no headroom
  - `overCell` for an E5 table -> `"share of 2.10 GB"`; for a billable table -> its own daily average; for a free table -> `"0"`
  - `crossCheckLine` for `skipped` repeats the reason; for `no-capped-day` says it cannot be confirmed yet, never "consistent"
  - `inventoryCsv` header gains `Allowance,AllowanceEligibleDailyMB,AllowanceUsedDailyMB,AllowanceOverDailyMB`; with `null` allowances those cells are empty, not 0
  - DOM: with `licences.kind === "denied"` the E5 drill-down names `LicenseAssignment.Read.All` and shows no headroom; with `grants: []` no card renders and the panel says no benefit was applied in the window (Review Focus 1)
  - DOM: a failing `readDataAllowances` leaves the inventory table on screen and shows the error line
- [ ] **Step 2:** Run in `packages/ui`: `npx vitest run src/screens/data-volume-inventory`. Expected: FAIL.
- [ ] **Step 3:** Implement the layout the spec's "What the operator sees" section describes (mockup option A). Use the `info-affordances` skill for every new figure's tip and the `dataviz` skill for the 30-day eligible-vs-applied chart (inline SVG, no new dependency). Drill-downs use `<details className="gap-handles">` like the existing sources cell. The licence table lists every tenant SKU, qualifying first; the arithmetic line is literal (`2,400 x 5 MB = 12.0 GB/day`).
- [ ] **Step 4:** Run from `soc-optimizationtoolkit/`: `npm run lint && npm run typecheck && npm test && npm run check-classnames`. Expected: PASS.
- [ ] **Step 5:** Commit `Show data allowances on Data Volume Inventory`.

### Task 7 (MIG-16): Compare against the whole tenant

**Files:**
- Modify: `allowance-cards.tsx`, `allowance-cards.dom.test.tsx`, `workspace-inventory-panel.tsx`

**Interfaces:**
- Consumes: `compareTenant` (Task 5); the discovery rows' Sentinel-enabled workspace ids

- [ ] **Step 1: Write the failing DOM tests:** the "Compare against the whole tenant" button renders only when discovery found more than one Sentinel-enabled workspace; pressing it calls `compareTenant` with every Sentinel-enabled id; a workspace it could not read is listed by name as `not read` and the granted figures read `at least`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. The tenant read inventories the other workspaces' Usage first (`inventoryWorkspace`), then calls `compareTenant`; progress text names the workspace being read. Respect the 100 req/min proxy budget: read workspaces one at a time.
- [ ] **Step 4:** Run the UI tests. Expected: PASS.
- [ ] **Step 5:** Commit `Compare data allowances across the tenant's workspaces`.

### Task 8 (MIG-17): Live verification and the spec's open items

Runs against a workspace that receives a benefit, in Live Preview on the jpederson org. This is a spike card; it can start any time, and its findings may change Task 3's patterns and Task 4's defaults.

- [ ] **Step 1:** In the workspace, run `BENEFIT_QUERY` and record the literal `BenefitType` strings. Replace `BENEFIT_TYPE_PATTERNS` with exact matches on them; update the Task 3 test fixtures to the literal strings.
- [ ] **Step 2:** Compare one capped day's `BenefitUsedGB` with the Cost Management usage export's "Free Benefit - M365 Defender Data Ingestion" quantity for the same day; record whether "GB" is decimal.
- [ ] **Step 3:** Confirm the connected identity reads `Microsoft.Security/pricings` (the `defender-plans.read` capability in the audit) and the Resource Graph machine count.
- [ ] **Step 4:** Read which seat basis and machine basis the cross-check marks; record both.
- [ ] **Step 5:** Write the answers into the spec's "Open" section (each item becomes a dated finding), move its `Last-confirmed` forward, close MIG-17 with `verified: "live"`, and record the outcome on each touched card.
- [ ] **Step 6:** Full gate run from `soc-optimizationtoolkit/`: `npm run lint && npm run typecheck && npm run check-listings && npm run check-schema-asset && npm run check-classnames && npm test && npm run build && npm run check-release && npm run check-docs && npm run check-board && npm run check-board-freshness`. Expected: all pass.
- [ ] **Step 7:** Commit `Record live findings for data allowances`.

# Data Volume Inventory By source - Implementation Plan

Status: Proposed - written 2026-11-04 from the approved design; not started.
Last-confirmed: 2026-11-04

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a source lens to the Data Volume Inventory - product identity, collector and billed vs free per source - shown in the By table drill-down and in a new By source view, beside the unchanged Usage-based table lens.

**Architecture:** The existing source-breakdown query (`sourceBreakdownQuery`, one query per 10 tables) gains a per-table identity expression, a collector column and billable bytes; the parser and `InventorySource` carry them. A new pure fold `bySource` merges sources across tables into view rows with a reconciliation. The UI adds a By table / By source switch.

**Tech Stack:** TypeScript, React, vitest (happy-dom for `*.dom.test.tsx`), KQL via the ARM query passthrough.

**Spec:** `docs/features/inventory-by-source.md` - read it first, including "Calls made after the builder review".

**Board:** feature `MIG-F3`, stories `MIG-27` .. `MIG-31` (one per task). Move a card to `in-progress` before its task starts; close with a `verified` value.

**Branch:** `feature/inventory-by-source` from `origin/main`. Stage explicit paths only.

## Global Constraints

- Source figures are `_BilledSize` bytes / `INVENTORY_WINDOW_DAYS` (30) in decimal MB (`BYTES_PER_MB`); never scaled to `Usage`.
- Billed bytes = `sumif(_BilledSize, _IsBillable == true)`; free = total - billed, per row of the breakdown (same query, same rows).
- Reconciliation COMPARES the lenses ("agree within Z%"); never computes a remainder by subtracting row bytes from `Usage`.
- Inventory honesty (`docs/inventory-standard.md`, BINDING): a failed or unrequested breakdown is "not read", never zero, never dropped.
- `column_ifexists` for every identity column; one table missing a column must not fail the batch.
- No new query per table; the extra columns ride on the existing breakdown query.
- Core stays pure (no clock, fetch or React).
- No emojis.

## Review Focus

1. **A table whose identity columns are all empty on some rows** (CEF rows with no DeviceVendor): those rows fall back to today's order, never to an empty identity. Pinned in Task 1.
2. **The 25-row cap**: the "other" row carries billed bytes too, and a billed source hidden in "other" still trips the catalog flag. Pinned in Task 1 and Task 2.
3. **A table whose breakdown was not requested (tenant compare, `SOURCES_NOT_REQUESTED`) or failed**: By source shows "<table> (sources not read)" with its Usage volume and billed/free "not read". Pinned in Task 2.
4. **Case and spacing variants of one product** ("Cisco ASA", "cisco asa "): one By source row, displayed with the most common casing. Pinned in Task 2.
5. **The existing CSV columns** keep their names and order; new columns only append. Pinned in Task 3.

---

### Task 1 (MIG-27): Identity, collector and billed bytes in the breakdown

**Files:**
- Create: `packages/core/src/domain/workspace-inventory/source-identity.ts`, `source-identity.test.ts`
- Modify: `packages/core/src/domain/workspace-inventory/workspace-inventory.ts` (`sourceBreakdownQuery`, `parseSourceRows`, `InventorySource`, `SourceAttribution`), its test, and `packages/core/src/domain/workspace-inventory/index.ts`

**Interfaces:**
- Produces:
  - `SourceAttribution` gains `"product"`; `"device"` stays (unmapped tables that carry DeviceVendor/DeviceProduct).
  - `SOURCE_IDENTITY_AS_OF = "2026-11-04"`
  - `interface SourceIdentityRule { table: string; attribution: "product" | "computer"; columns: readonly string[]; keepsCollector: boolean }` and `SOURCE_IDENTITY_RULES` with: CommonSecurityLog -> product from `DeviceVendor` + `DeviceProduct`, keepsCollector true; SecurityAlert -> product from `ProductName`, then `ProviderName`, keepsCollector true; Syslog -> computer from `Computer` + `Facility`, keepsCollector false.
  - `identityKql(): string` - the KQL `extend` fragment that sets `Source`, `Attribution`, `Collector` per `SourceTable` with `case(...)`; rows of a mapped table whose identity columns are empty fall through to today's `_ResourceId` / `Computer` / `DeviceVendor DeviceProduct` order.
  - `InventorySource` gains `collector: string` ('' when none), `billableBytes: number`, `billableDailyMB: number`, `freeDailyMB: number`.
  - `sourceBreakdownQuery` groups by `SourceTable, Source, Attribution, Collector`, sums `Bytes`, `BillableBytes = sumif(_BilledSize, _IsBillable == true)`, `Events`; ranks by bytes within a table; rank > `SOURCES_PER_TABLE` rolls into one `other` row whose Bytes and BillableBytes are summed.

- [ ] **Step 1: Write the failing tests:**
  - `identityKql()` contains `column_ifexists('DeviceVendor', '')`, `column_ifexists('ProductName', '')`, `column_ifexists('Facility', '')` and a `SourceTable =~ 'CommonSecurityLog'` branch
  - `sourceBreakdownQuery(["CommonSecurityLog"])` contains `sumif(_BilledSize, _IsBillable == true)` and groups by `Collector`
  - `parseSourceRows` on `[{SourceTable:"CommonSecurityLog", Source:"Cisco ASA", Attribution:"product", Collector:"localhost", Bytes:1356860000, BillableBytes:1356860000, Events:1, Sources:1}]` -> one source with `collector:"localhost"`, `billableDailyMB` 45.23 (to 2 dp), `freeDailyMB` 0
  - an `other` row keeps its `billableBytes` (Review Focus 2)
  - a row with `Attribution:"product"` and `Source:""` never yields an empty product: the parser treats it as `none` (Review Focus 1 belt-and-braces; the KQL is the primary guard)
  - a breakdown answer with no `BillableBytes` column throws (a contract break, like a missing primary table) - it must never read as "all free"
- [ ] **Step 2:** Run `npx vitest run src/domain/workspace-inventory` in `packages/core`. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep `SourceIdentityRule` data-only; `identityKql` builds the `case` from the rules.
- [ ] **Step 4:** Re-run; then run the query once live (Task 5 owns the full live check, but the KQL must parse): `az rest` POST of `sourceBreakdownQuery(["CommonSecurityLog"])` to the `sentinel-new` workspace's `/query?api-version=2017-10-01` returns columns `SourceTable, Source, Attribution, Collector, Bytes, BillableBytes, Events, Sources` and a Cisco ASA row. Record the output in the report.
- [ ] **Step 5:** Mutation-check: drop the `CommonSecurityLog` rule and confirm the product test fails. Commit `Identify CEF, alerts and Syslog sources (MIG-27)`.

### Task 2 (MIG-28): The By source fold

**Files:**
- Create: `packages/core/src/domain/workspace-inventory/by-source.ts`, `by-source.test.ts`; export through `packages/core/src/usecases/workspace-inventory/index.ts` (the feature's public surface)

**Interfaces:**
- Consumes: `WorkspaceInventory`, `InventorySource` (Task 1); `allowanceFor` (domain/data-allowances/allowance-catalog)
- Produces:
  - `interface SourceViewRow { key: string; kind: "product" | "computer" | "table" | "not-read"; label: string; tables: string[]; dailyMB: number; measured: boolean; billedDailyMB: number | null; freeDailyMB: number | null; collectors: Array<{ name: string; dailyMB: number }>; freeTaggedTablesBilled: string[] }`
  - `interface SourceViewReconciliation { measuredDailyMB: number; usageDailyMB: number; notReadDailyMB: number; notReadTables: number; agreementPct: number | null }`
  - `bySource(inventory: WorkspaceInventory): { rows: SourceViewRow[]; reconciliation: SourceViewReconciliation }`
- Rules (from the spec's calls):
  - Mapped tables (in `SOURCE_IDENTITY_RULES`): one row per identity; key = attribution + trimmed, case-folded `source`; rows merge across tables only with the same key; label = the most common original casing; collectors listed for product rows only.
  - Unmapped tables whose sources were read: ONE row per table, `kind:"table"`, label `"<table> (no product columns)"`, `dailyMB`/billed/free summed from that table's sources (`measured: true`).
  - Tables whose sources failed or were not requested: one row, `kind:"not-read"`, label `"<table> (sources not read)"`, `dailyMB` = the table's Usage daily average, `measured:false`, billed/free `null`.
  - An `other` (rank > 25) source of a mapped table becomes part of a `"<table> (other sources)"` table row, never merged into a product.
  - `freeTaggedTablesBilled`: tables in the row where `allowanceFor(table).kind === "free"` and the row's billed volume in that table > 0.
  - Reconciliation: `measuredDailyMB` = sum of measured rows; `usageDailyMB` = the Usage daily average of the tables whose sources were read; `agreementPct` = `100 * min/max` of those two (null when both 0); `notReadDailyMB` and `notReadTables` from the not-read rows.
  - Rows sorted by `dailyMB` descending, ties by label.

- [ ] **Step 1: Write the failing tests:** Cisco ASA via three collectors in CommonSecurityLog -> one product row, 3 collectors, dailyMB = their sum; "Cisco ASA" and "cisco asa " merge with label "Cisco ASA" (Review Focus 4); an unmapped AWS table -> one "(no product columns)" row; a not-requested table -> "(sources not read)" with Usage volume and null billed/free (Review Focus 3); SecurityAlert tagged Free with a billed source -> `freeTaggedTablesBilled: ["SecurityAlert"]`, including when that billed volume sits in the `other` row (Review Focus 2); reconciliation numbers exact for a fixture.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run; mutation-check the merge key (drop case-folding -> Review Focus 4 test fails).
- [ ] **Step 5:** Commit `Fold the inventory by source (MIG-28)`.

### Task 3 (MIG-29): By table drill-down and CSV

**Files:**
- Modify: `packages/ui/src/screens/data-volume-inventory/workspace-inventory-state.ts` (`sourceLabel`, `inventoryCsv`), its test, `workspace-inventory-panel.tsx`, its DOM test

**Interfaces:**
- Consumes: `InventorySource` fields from Task 1; `bySource(...).reconciliation` from Task 2 for the line
- Produces: `sourceLabel` returns `{ text: "Cisco ASA", kind: "Product", via: "localhost", tip }` for product sources (`via` '' otherwise); the drill-down row reads `Cisco ASA via localhost - 45.2 MB/day (billed 45.2, free 0)`; the reconciliation line under each table's sources; CSV appends `SourceIdentity,Collector,BillableDailyMB,FreeDailyMB`.

- [ ] **Step 1: Write the failing tests:** product label and via; the drill-down text for the Cisco fixture; the CSV header equals the old header plus the four new names, in that order (Review Focus 5); an `other` row's billed/free appear in the CSV.
- [ ] **Step 2-4:** Run (FAIL), implement, run (PASS); InfoTips per the info-affordances standard for the new figures (no native `title=`).
- [ ] **Step 5:** Commit `Name sources by product in By table (MIG-29)`.

### Task 4 (MIG-30): The By source view

**Files:**
- Create: `packages/ui/src/screens/data-volume-inventory/by-source-view.tsx`, `by-source-view.dom.test.tsx`
- Modify: `workspace-inventory-panel.tsx` (a "By table" / "By source" switch; By table default), `styles.css` (Capra-consistent classes only)

**Interfaces:**
- Consumes: `bySource` (Task 2), `formatMB`
- Produces: `<BySourceView inventory={...} />` rendering the spec's columns (Source, Lands in, Daily avg, Billed / Free with a proportional bar, Collectors count with a drill-down, Allowance tags plus the catalog flag), and the reconciliation sentence: "Sources (measured from the rows) total X MB/day; Usage reports Y MB/day for the same tables; they agree within Z%." plus "and N MB/day from K tables whose sources were not read" when K > 0.

- [ ] **Step 1: Write the failing DOM tests:** the switch defaults to By table; By source lists Cisco ASA once with 3 collectors; a not-read table renders "(sources not read)" and "not read" in Billed/Free; the flag text names SecurityAlert; the reconciliation sentence exact for a fixture.
- [ ] **Step 2-4:** Run (FAIL), implement (use the `info-affordances` and `dataviz` skills for the bar and tips), run (PASS).
- [ ] **Step 5:** Gate from `soc-optimizationtoolkit/`: `npm run lint && npm run typecheck && npm test && npm run check-classnames`. Commit `Add the By source view (MIG-30)`.

### Task 5 (MIG-31): Live check

Controller-owned (needs Live Preview on port 5173; follow the memory note on stopping the dev server's node child afterwards).

- [ ] **Step 1:** Live Preview on `sentinel-new`: By table shows "Cisco ASA via localhost / : / SNL-ASA-VPN-A01"; By source shows one Cisco ASA row with 3 collectors and ~56 MB/day, all billed; the reconciliation sentence agrees within a few percent.
- [ ] **Step 2:** Find a workspace with Syslog and SecurityAlert (a Usage query across the lab's Sentinel workspaces), check both read sensibly, and decide whether `Facility` reads better in the identity or as the via; record the decision in the spec and the card.
- [ ] **Step 3:** Full gate from `soc-optimizationtoolkit/`: `npm run lint && npm run typecheck && npm run check-listings && npm run check-schema-asset && npm run check-classnames && npm test && npm run build && npm run check-release && npm run check-docs && npm run check-board && npm run check-board-freshness`. Mark the spec Living and this plan Record. Commit.

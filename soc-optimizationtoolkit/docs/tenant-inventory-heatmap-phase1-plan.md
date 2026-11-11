# Tenant inventory heat map, phase 1 (read-only) Implementation Plan

Status: Proposed - phase 1 of docs/tenant-inventory-heatmap-design.md: a read-only heat map at the
top of Azure Native Source Onboarding, built from reads the app already makes; not yet started.
Last-confirmed: 2026-11-11

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, at the top of Azure Native Source Onboarding, a heat map of what the tenant already collects for Entra ID, Activity Log and Defender for Cloud, down to the log type, with where it is sent and whether it is archived; every other category shows "not checked yet".

**Architecture:** A pure domain module `domain/tenant-inventory` turns already-parsed reads into log-type cells and category cards; one usecase `readTenantInventory` issues the reads (paced, GET only) and never throws; one UI component renders cards and a drill-down. Nothing is written. Phases 2-5 (selection, re-hosting sections, Automate/How-to per selection, new reads) get their own plans.

**Tech Stack:** TypeScript, vitest (+ happy-dom, @testing-library/react for dom tests), React; npm workspaces packages/core and packages/ui.

**Spec:** `docs/tenant-inventory-heatmap-design.md`

## Global Constraints

- Read-only: GET requests only; no new policies.yml or proxies.yml entries (all calls go through the existing management.azure.com proxy, as Validate's do).
- Scope: every readable subscription (design: "Scope: every readable subscription in the tenant").
- A read that is refused, failed, truncated or never sent is `could-not-check` with its reason, never `not-collected` (claude-kit `inventory-honesty.md`). An empty, permission-filtered subscription list is `could-not-check`, not "no subscriptions".
- Phase-1 categories not built yet show the reason "not checked yet", distinct from refused or failed.
- Colours: green collected and archived, amber collected not archived, red not collected, blue could not check; mixed categories show the mix.
- Archived = a Cribl flow to object storage, or a setting that writes straight to a storage account (design, "Archived").
- Pacing: reuse `VALIDATE_REQUESTS_PER_MINUTE` (40) through `paceAzureManagement`.
- Core stays pure: no Date.now / Math.random / crypto; `now` is injected.
- Visible copy carries no card id, date or phase number (`findHistoryInCopy`); every new UI file joins `AZURE_ONBOARDING_COPY_FILES`.
- No emojis. Every disabled control says why in visible text. Any dropdown is a `SearchableSelect`.
- Board: file one card for this plan (AZR-107) and move it to in-progress BEFORE Task 1.

## Review Focus

1. One subscription answers 403 to its diagnostic-settings list while others answer: that subscription's Activity Log cells are could-not-check for it, the cell reads "collected in 2 of 3 read, 1 could not be read", never "not collected". (Task 3)
2. A setting enables a category GROUP (`categoryGroup: "allLogs"`) instead of named categories: `allLogs` counts every category of that source; any other group name makes the affected log types could-not-check with the group named. (Tasks 1, 2)
3. A Defender automation exists but `isEnabled: false`: its export types are not collected, and the tile names the disabled automation. (Task 4)
4. The subscription list comes back empty: the whole Activity Log and Defender cards are could-not-check ("no subscription was visible to this connection"), not red. (Task 6)
5. One setting sends to a workspace AND a storage account: the cell lists both destinations and is archived (storage). (Task 5)

---

### Task 1: Destinations in the shared diagnostic-setting and Defender parsers

**Files:**
- Modify: `packages/core/src/domain/activity-log-export/diagnostic-setting.ts` (`DiagnosticSettingRead`, `readDiagnosticSetting`)
- Modify: `packages/core/src/domain/defender-export/defender-automation.ts` (`AutomationAction`, the automation parser)
- Test: `packages/core/src/domain/activity-log-export/diagnostic-setting.test.ts`, `packages/core/src/domain/defender-export/defender-automation.test.ts`

**Interfaces:**
- Produces: `DiagnosticSettingRead` gains `workspaceId: string`, `storageAccountId: string`, `partnerId: string` (each `""` when absent, as `ruleId` already is) and `enabledGroups: readonly string[]` (category groups split out of `enabled`, which keeps only named categories). `AutomationAction` gains `workspaceResourceId: string` (`""` unless `actionType` is `"Workspace"`).

- [ ] **Step 1: Write the failing tests**

```ts
it("reads every destination of a diagnostic setting", () => {
  const s = readDiagnosticSetting({ id: "x", name: "aad", properties: {
    workspaceId: "/subscriptions/s/resourceGroups/r/providers/Microsoft.OperationalInsights/workspaces/law",
    storageAccountId: "/subscriptions/s/resourceGroups/r/providers/Microsoft.Storage/storageAccounts/st",
    eventHubAuthorizationRuleId: "", marketplacePartnerId: "",
    logs: [{ category: "SignInLogs", enabled: true }, { categoryGroup: "allLogs", enabled: true }, { category: "AuditLogs", enabled: false }] } });
  expect(s.workspaceId).toMatch(/workspaces\/law$/);
  expect(s.storageAccountId).toMatch(/storageAccounts\/st$/);
  expect(s.enabled).toEqual(["SignInLogs"]);
  expect(s.enabledGroups).toEqual(["allLogs"]);
});
it("reads a Defender workspace action", () => {
  const a = parseAutomationForTest({ actions: [{ actionType: "Workspace", workspaceResourceId: "/subscriptions/s/.../workspaces/law" }] });
  expect(a.actions[0].workspaceResourceId).toMatch(/workspaces\/law$/);
});
```

(`parseAutomationForTest` = the module's existing single-automation parser; use its real name.)

- [ ] **Step 2: Run** `npx vitest run packages/core/src/domain/activity-log-export packages/core/src/domain/defender-export` from `soc-optimizationtoolkit/` - expect FAIL on the new fields.
- [ ] **Step 3: Implement** the fields. Existing callers (`classifyEntra`, `classifyActivityLog`, `classifyOursSetting`, `activityLogSettingDiffs`) must keep passing: check whether any compares `enabled` against a list that contained group names, and if so compare against `enabled` + `enabledGroups` there.
- [ ] **Step 4: Run** the core suite `npm test --workspace packages/core` - expect PASS, no existing pin edited.
- [ ] **Step 5: Commit** `git add <the four files>` - "Read every destination of a diagnostic setting".

### Task 2: Tenant inventory domain types and Entra ID cells

**Files:**
- Create: `packages/core/src/domain/tenant-inventory/tenant-inventory.ts`, `index.ts`; export from `packages/core/src/index.ts`
- Test: `packages/core/src/domain/tenant-inventory/tenant-inventory.test.ts`

**Interfaces:**
- Consumes: Task 1 `DiagnosticSettingRead`; `ENTRA_CATEGORIES` (`domain/entra-diagnostics/entra-categories.ts`); `Listing` (`domain/inventory-listing`).
- Produces:
```ts
export type InventoryCategoryId = "entraId" | "activityLog" | "defenderExport" | "resourceLogs" | "xdrStreaming" | "vnetFlowLogs" | "nsgFlowLogs";
export type DestinationKind = "workspace" | "event-hub" | "storage" | "partner";
export interface Destination { readonly kind: DestinationKind; readonly resourceId: string }
export interface Collector { readonly kind: "diagnostic-setting" | "defender-export"; readonly name: string; readonly scope: string /* subscription id, or "tenant" */; readonly destinations: readonly Destination[] }
export type CellState =
  | { readonly kind: "collected"; readonly scopes: { readonly collected: number; readonly read: number; readonly unread: number } }
  | { readonly kind: "partly"; readonly scopes: { readonly collected: number; readonly read: number; readonly unread: number } }
  | { readonly kind: "not-collected" }
  | { readonly kind: "could-not-check"; readonly reason: string };
export type ArchiveState = { readonly kind: "archived"; readonly via: "storage" | "cribl" } | { readonly kind: "not-archived" } | { readonly kind: "unknown"; readonly reason: string };
export interface LogTypeCell { readonly category: InventoryCategoryId; readonly logType: string; readonly title: string; readonly collectors: readonly Collector[]; readonly state: CellState; readonly archive: ArchiveState }
export type EntraRead = { readonly kind: "read"; readonly settings: Listing<DiagnosticSettingRead> } | { readonly kind: "unread"; readonly reason: string };
export function destinationsOf(setting: DiagnosticSettingRead): readonly Destination[];
export function entraCells(read: EntraRead): readonly LogTypeCell[];   // one cell per ENTRA_CATEGORIES entry, in that order; archive left { kind: "unknown", reason: "not classified yet" } (Task 5 fills it)
```

- [ ] **Step 1: Failing tests** - `entraCells` returns 15 cells in `ENTRA_CATEGORIES` order; a setting enabling `SignInLogs` to a workspace makes that cell `collected` (scopes 1/1/0, scope "tenant") with one workspace destination; `AuditLogs` with no setting is `not-collected`; `{kind:"unread"}` makes all 15 `could-not-check` with the reason; an `enabledGroups: ["allLogs"]` setting collects all 15; an unknown group `"audit"` makes the categories not named elsewhere `could-not-check` naming the group (Review Focus 2); an empty listing makes every cell `not-collected`.
- [ ] **Step 2: Run** `npx vitest run packages/core/src/domain/tenant-inventory` - FAIL.
- [ ] **Step 3: Implement.** A setting with no enabled category for a log type is not its collector.
- [ ] **Step 4: Run** - PASS.
- [ ] **Step 5: Commit** "Add tenant inventory cells for Entra ID".

### Task 3: Activity Log cells across subscriptions

**Files:** Modify `domain/tenant-inventory/tenant-inventory.ts`; test file as Task 2.

**Interfaces:**
- Consumes: `ACTIVITY_LOG_CATEGORIES` (`domain/activity-log-export/activity-log-setting.ts`).
- Produces:
```ts
export type SubscriptionSettingsRead = { readonly subscriptionId: string } & ({ readonly kind: "read"; readonly settings: Listing<DiagnosticSettingRead> } | { readonly kind: "unread"; readonly reason: string });
export function activityLogCells(reads: readonly SubscriptionSettingsRead[]): readonly LogTypeCell[];   // one cell per ACTIVITY_LOG_CATEGORIES entry
```

- [ ] **Step 1: Failing tests** - 3 subscriptions, all with `Administrative` on: cell `collected`, scopes 3/3/0. 2 of 3: `partly`, scopes 2/3/0. Review Focus 1: 2 read with it on, 1 unread: `partly`, scopes 2/2/1 - never `not-collected`. All unread: `could-not-check`. `reads` empty: `could-not-check`, reason "no subscription was visible to this connection" (Review Focus 4). `allLogs` group counts all 8.
- [ ] **Step 2-4:** run FAIL, implement, run PASS (`collected` only when every subscription was read and has it; any unread subscription makes it at best `partly`).
- [ ] **Step 5: Commit** "Add Activity Log cells across subscriptions".

### Task 4: Defender for Cloud export-type cells

**Files:** Modify `domain/tenant-inventory/tenant-inventory.ts`; test file as Task 2.

**Interfaces:**
- Consumes: `DefenderAutomation` (Task 1), `Listing`.
- Produces:
```ts
export const DEFENDER_EXPORT_TYPES: readonly { readonly logType: "alerts" | "recommendations" | "secureScore" | "compliance"; readonly title: string; readonly eventSources: readonly string[] }[];
export type SubscriptionAutomationsRead = { readonly subscriptionId: string } & ({ readonly kind: "read"; readonly automations: Listing<DefenderAutomation> } | { readonly kind: "unread"; readonly reason: string });
export function defenderCells(reads: readonly SubscriptionAutomationsRead[]): readonly LogTypeCell[];
```
`DEFENDER_EXPORT_TYPES` values (Documented, Azure Security automation `eventSource`; NOT measured - say so in a comment): alerts `["Alerts"]`; recommendations `["Assessments", "AssessmentsSnapshot", "SubAssessments", "SubAssessmentsSnapshot"]`; secureScore `["SecureScores", "SecureScoresSnapshot", "SecureScoreControls", "SecureScoreControlsSnapshot"]`; compliance `["RegulatoryComplianceAssessment", "RegulatoryComplianceAssessmentSnapshot"]`.

- [ ] **Step 1: Failing tests** - an enabled automation with source `Alerts` and an Event Hub action collects `alerts` with an `event-hub` destination; a Workspace action gives a `workspace` destination; `isEnabled: false` collects nothing and the cell is `not-collected` with the automation still listed as a collector named "(disabled)" (Review Focus 3); unread subscription behaves as Task 3.
- [ ] **Step 2-4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** "Add Defender for Cloud export cells".

### Task 5: Archive classification and category cards

**Files:** Modify `domain/tenant-inventory/tenant-inventory.ts`; test file as Task 2.

**Interfaces:**
- Consumes: `OnboardingProgress` (`domain/onboarding-howto/progress-document.ts`: `criblSources`, `criblLakeRoutes`), the plan's namespace (`planValues`), `namespaceRuleResourceId` / namespace path helpers in `domain/eventhub-arm`.
- Produces:
```ts
export interface AppArchiveEvidence { readonly namespacePath: string | null; readonly lakeRoutedSources: readonly InventoryCategoryId[] }   // sources whose progress has a criblSources record AND criblLakeRoutes[source].routeId != null
export function archiveEvidenceFrom(progress: OnboardingProgress): AppArchiveEvidence;
export function withArchive(cells: readonly LogTypeCell[], evidence: AppArchiveEvidence): readonly LogTypeCell[];
export type CardColour = "green" | "amber" | "red" | "blue" | "mixed";
export interface CategoryCard { readonly id: InventoryCategoryId; readonly title: string; readonly colour: CardColour; readonly counts: Readonly<Record<"green" | "amber" | "red" | "blue", number>>; readonly collectedShare: number | null; readonly archivedShare: number | null; readonly notChecked: string | null }
export const NOT_CHECKED_YET: string;   // visible reason for categories this phase does not read
export function categoryCards(cells: readonly LogTypeCell[]): readonly CategoryCard[];   // all 7 ids, in InventoryCategoryId order; resourceLogs, xdrStreaming, vnetFlowLogs, nsgFlowLogs: colour "blue", notChecked = NOT_CHECKED_YET
```
Rules: a cell with a `storage` destination is `archived/storage` (Review Focus 5). A cell whose collector sends to an Event Hub in `evidence.namespacePath` and whose category is in `lakeRoutedSources` is `archived/cribl`. An Event Hub destination outside that is `unknown` ("an Event Hub this app's Cribl sources do not read"). Workspace-only is `not-archived`. Not-collected and could-not-check cells keep `unknown`. Cell tone: collected/partly + archived = green; collected/partly + not-archived or unknown = amber; not-collected = red; could-not-check = blue. Shares are over cells that are not blue; `null` when every cell is blue.

- [ ] **Step 1: Failing tests** for each rule above, the 7-card order, and Review Focus 5.
- [ ] **Step 2-4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** "Classify archive and roll up category cards".

### Task 6: readTenantInventory usecase

**Files:**
- Create: `packages/core/src/usecases/read-tenant-inventory/read-tenant-inventory.ts`, `index.ts`; export from `packages/core/src/usecases/index.ts`
- Test: `.../read-tenant-inventory.test.ts`

**Interfaces:**
- Consumes: `listSubscriptions` (`usecases/azure-discovery/azure-discovery.ts`), `listSettingsRequest` (Entra), `buildSubscriptionDiagnosticSettingsListRequest`, `readDefenderState` (`usecases/defender-export`), `readAllPages` (`usecases/read-logging-map/arm-pager.ts`), Tasks 2-5.
- Produces:
```ts
export interface TenantInventory { readonly readAt: string; readonly subscriptions: Listing<{ readonly id: string; readonly name: string }> | { readonly kind: "unread"; readonly reason: string }; readonly cells: readonly LogTypeCell[]; readonly cards: readonly CategoryCard[]; readonly requests: number }
export function readTenantInventory(input: { readonly azure: AzureManagement; readonly progress: OnboardingProgress; readonly now: () => string; readonly onProgress?: (done: number, total: number) => void }): Promise<TenantInventory>;
```
Order: list subscriptions; Entra list once; per subscription, the diagnostic-settings list then `readDefenderState`. Never throws: every rejection becomes an `unread` read with its reason. GET only.

- [ ] **Step 1: Failing tests** with a fake `AzureManagement` routing by path: happy path (2 subs) yields 7 cards with Entra/Activity/Defender cells; the request log contains only `GET`; a 403 on one subscription's settings list gives Review Focus 1's cell; an empty subscription list gives Review Focus 4; a transport rejection on the Entra list gives 15 could-not-check Entra cells; `readAt` is the injected `now()`.
- [ ] **Step 2-4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** "Add the read-only tenant inventory usecase".

### Task 7: Heat map component with drill-down

**Files:**
- Create: `packages/ui/src/screens/azure-onboarding/inventory/tenant-inventory-heatmap.tsx`, `tenant-inventory-state.ts`, `tenant-inventory-heatmap.dom.test.tsx`; CSS in `packages/ui/src/styles.css` (classes prefixed `tih-`)
- Modify: `packages/ui/src/screens/azure-onboarding/azure-onboarding-copy-history.test.ts` (`AZURE_ONBOARDING_COPY_FILES` += both new files)

**Interfaces:**
- Consumes: Task 6 `TenantInventory`, `CategoryCard`, `LogTypeCell`; `InfoTip` (`components/info-tip.tsx`).
- Produces: `TenantInventoryHeatmap(props: { inventory: TenantInventory | null; reading: boolean; disabledReason: string | null; onRead: () => void })`; pure helpers in `tenant-inventory-state.ts`: `cellLabel(cell): string`, `cardSummary(card): string`, `destinationLabel(d: Destination): string` (last path segment plus kind, e.g. "workspace law-soc-prod").

- [ ] **Step 1: Failing dom tests** - with `inventory: null` it shows a "Read the tenant's logging" button and the sentence that nothing is changed; `disabledReason` disables it with the reason visible; with an inventory it renders 7 cards with their titles and `cardSummary`; clicking "Entra ID" shows 15 tiles, the SignInLogs tile showing its collector name and destination label; a `could-not-check` tile shows its reason, and no tile ever renders the words "not collected" for a could-not-check cell; the 4 not-built cards show the "not checked yet" reason; the read time is shown.
- [ ] **Step 2: Run** `npx vitest run packages/ui/src/screens/azure-onboarding/inventory` - FAIL.
- [ ] **Step 3: Implement.** Cards are buttons (keyboard reachable); the open card has `aria-expanded`. Colour is never the only signal: each card and tile also carries its state in words.
- [ ] **Step 4: Run** it and the copy-history test - PASS.
- [ ] **Step 5: Commit** "Add the tenant inventory heat map component".

### Task 8: Put it at the top of the screen

**Files:**
- Modify: `packages/ui/src/screens/azure-onboarding/azure-onboarding-screen.tsx` (render before `EventHubPrerequisiteSection`; state for the inventory; reads paced with `paceAzureManagement(ports.azure, { ...pacing, maxRequestsPerMinute: VALIDATE_REQUESTS_PER_MINUTE })`)
- Modify: `azure-onboarding-screen.dom.test.tsx`; `packages/ui/CONTEXT.md`, `packages/core/CONTEXT.md` (dated status line); `docs/board.json` (AZR-107 done with `verified`)

**Interfaces:**
- Consumes: Task 6 `readTenantInventory`, Task 7 component; the screen's loaded `progress`.

- [ ] **Step 1: Failing dom test** - the heat map renders above the "Event Hub the sources send to" section; clicking Read issues only GET requests against the `RoutingAzure` fake and renders the cards; with no Azure connection the button is disabled with the reason.
- [ ] **Step 2-4:** FAIL, implement, PASS.
- [ ] **Step 5: Run every gate** from `soc-optimizationtoolkit/`: lint, typecheck, check-listings, check-schema-asset, check-classnames, test, build, check-release, check-docs, check-board, check-board-freshness - all PASS.
- [ ] **Step 6: Verify in Live Preview** (`npm run dev`, `/apps/a/__local__`): read the lab tenant; confirm the Activity Log card reflects the diagnostic setting(s) on the lab subscription and the Entra card the aadiam settings, or blue with a reason where the connection is refused. Record what was seen on AZR-107.
- [ ] **Step 7: Commit** "Show the tenant inventory heat map on onboarding"; `npm run bump`; PR.

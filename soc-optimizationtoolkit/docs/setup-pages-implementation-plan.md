# Setup pages Implementation Plan

Status: Proposed - implementation plan for `setup-pages-plan.md` (design
approved by the operator 2026-11-02). Not started.
Last-confirmed: 2026-11-02

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Azure setup step opens on a saved Fully / Partially / Disconnected choice. That choice shapes the change request and the next action, and every setup page shows only what is needed, with explanations behind (i) icons.

**Architecture:** A pure core module, `azure-connectivity`, maps the saved choice to the permissions it asks for and the Azure scope it needs. `AzureConfig` persists the choice. `change-request` and `journey-state` read it. The UI adds one section component and trims the existing setup sections, and `App.tsx` wires the facts.

**Tech Stack:** TypeScript, React, vitest (happy-dom), npm workspaces (`packages/core`, `packages/ui`, `apps/cribl-app`).

**Spec:** `docs/setup-pages-plan.md`

## Global Constraints

- No emojis anywhere (repository rule).
- Core stays pure: no IO and no React in `packages/core`.
- The choice gates no route and no action. It never feeds `CapabilityContext`, `routeCapability` or `mustProduceArtifacts` (capability model, 2026-08-05).
- The (i) text reuses the existing `justification` and `withoutIt` strings from `app-permissions.ts` / `role-plan.ts`; it is not rewritten.
- A gate reason stays on screen; only the WHY moves behind an (i).
- An unset connectivity parses as `full`, with `allowedPermissions: ["Reader"]`.
- Lab setup paths are Fully Connected only. Partially Connected always uses `setupPath: "existing"`.
- Board rule 1: a card moves to `in-progress` BEFORE its task starts. Board rule 2: each defect in committed code gets a card before it is fixed.
- Every task ends green on `npm run typecheck`, `npm run lint` and `npm test`, run from `soc-optimizationtoolkit/`.

## Review Focus

1. **An install saved before this change** (no `connectivity` key): it must behave exactly as today, as Fully Connected. Pinned in Task 2.
2. **Partially Connected with nothing ticked:** the request must say it asks for nothing, not render an empty role list, and the target stage must not ask for a scope. Pinned in Tasks 1, 3 and 4.
3. **Switching from Partially to Fully and back:** the ticked set survives the round trip. Pinned in Task 2.
4. **Disconnected with a stored identity from earlier:** the page says so in one line and offers Clear or Partially Connected. It is never silently live. Pinned in Task 6.
5. **A lab path saved, then Partially Connected chosen:** the path becomes `existing` and the page says so. The ticket never asks for lab Contributor. Pinned in Tasks 1 and 6.

---

### Task 0: Branch and cards

**Files:**
- Modify: `docs/board.json`, `docs/board.md` (generated)
- Move: `docs/setup-pages-plan.md` and `docs/setup-pages-implementation-plan.md` (untracked on `feature/integrate-collapse-on-load`) to the new branch

- [ ] **Step 1:** `git switch -c feature/setup-connectivity origin/main` with the two untracked docs carried along. Confirm `git status` shows only those two files.
- [ ] **Step 2:** Add one story card for the feature: epic `DBT`, feature `DBT-F2`, type `story`, priority `now`, status `backlog`. Title: "Setup: Azure connectivity choice shapes the change request and the next action". Its detail quotes the operator's 2026-11-02 words and links `setup-pages-plan.md`.
- [ ] **Step 3:** Add eight bug cards (`DBT-F2`, priority `now`, status `backlog`), one per defect in the design's "Defects found by the review" list, each citing its file:line from that review. Take the next free DBT ids (DBT-238 at the time of writing; re-check after the DBT-237 merge).
- [ ] **Step 4:** Run `npm run board`, then `npm run check-board`. Expected: "board.md matches board.json".
- [ ] **Step 5:** Commit: `git add docs/board.json docs/board.md docs/setup-pages-plan.md docs/setup-pages-implementation-plan.md` with message "Setup pages: design, plan and cards".

### Task 1: Core connectivity rule

**Files:**
- Create: `packages/core/src/domain/azure-connectivity/azure-connectivity.ts`, `index.ts`
- Test: `packages/core/src/domain/azure-connectivity/azure-connectivity.test.ts`
- Modify: the core domain barrel that exports `app-permissions` (add the new module beside it)

**Interfaces:**
- Consumes: `appPermissionPlan(path: AzureSetupPath): AppPermission[]`, `AppPermission`, `AzureSetupPath`
- Produces:
  - `type AzureConnectivity = "full" | "partial" | "disconnected"`
  - `const READ_ONLY_PERMISSION = "Reader"`
  - `effectiveSetupPath(connectivity: AzureConnectivity, saved: AzureSetupPath): AzureSetupPath` returns `"existing"` for partial and `saved` otherwise
  - `requestedPermissions(connectivity: AzureConnectivity, allowed: readonly string[], saved: AzureSetupPath): AppPermission[]`
  - `type ScopeNeed = "none" | "subscription" | "full"`
  - `scopeNeed(connectivity: AzureConnectivity, requested: readonly AppPermission[]): ScopeNeed`
  - `checklistEntries(): { readOnly: AppPermission; others: AppPermission[] }`, from `appPermissionPlan("existing")`

- [ ] **Step 1: Write the failing tests** (`describe("azure connectivity (setup-pages-plan)")`):
  - `requestedPermissions("full", [], "existing")` equals `appPermissionPlan("existing")` by name.
  - `requestedPermissions("partial", ["Reader"], "lab-new-rg").map(p => p.name)` equals `["Reader"]`, so a lab path never leaks into partial.
  - `requestedPermissions("partial", [], "existing")` equals `[]`.
  - `requestedPermissions("disconnected", ["Reader"], "existing")` equals `[]`.
  - `scopeNeed("disconnected", [])` is `"none"`. `scopeNeed("partial", [])` is `"none"`.
  - With only Reader requested, `scopeNeed("partial", …)` is `"subscription"`. With Reader and Monitoring Contributor requested, it is `"full"`.
  - `scopeNeed("full", appPermissionPlan("existing"))` is `"full"`.
  - `effectiveSetupPath("partial", "lab-byo-rg")` is `"existing"`, and `effectiveSetupPath("full", "lab-byo-rg")` is `"lab-byo-rg"`.
  - `checklistEntries().readOnly.name` is `"Reader"`. `others` holds every other `existing` entry, in plan order, without Reader.
- [ ] **Step 2:** Run `npx vitest run packages/core/src/domain/azure-connectivity`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement. `scopeNeed`: `none` when disconnected or nothing is requested; `full` when any entry is `scopeLevel === "resourceGroup"`; `subscription` when any entry is `subscription`; otherwise `none` (tenant-only Graph entries need no scope).
- [ ] **Step 4:** Run the tests again. Expected: PASS. Then mutation-check: make partial ignore `allowed`. Expected: the "lab path never leaks" and empty-set tests fail. Revert.
- [ ] **Step 5:** Commit with the story card id.

### Task 2: Persist the choice in AzureConfig

**Files:**
- Modify: `packages/core/src/domain/azure-config/azure-config.ts` (interface, `parseAzureConfig`, `serializeAzureConfig`, the default config)
- Test: `packages/core/src/domain/azure-config/azure-config.test.ts`

**Interfaces:**
- Produces: `AzureConfig` gains `connectivity: AzureConnectivity` and `allowedPermissions: string[]`

- [ ] **Step 1: Write the failing tests:**
  - Parsing a stored JSON with no `connectivity` gives `connectivity === "full"` and `allowedPermissions` equal to `["Reader"]` (Review Focus 1).
  - An unknown `connectivity` string parses as `"full"`.
  - Non-string entries in `allowedPermissions` are dropped.
  - Serialize then parse round-trips `{connectivity: "partial", allowedPermissions: ["Reader", "Log Analytics Contributor"]}` exactly (Review Focus 3).
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Extend the parse and serialize functions, following the tolerant-and-total contract in the file's header comment.
- [ ] **Step 4:** Run `npm run typecheck`. Every `AzureConfig` literal elsewhere, including test fixtures and the default, now needs the two fields; add them. Then run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task 3: The change request follows the choice (defect: two descriptions)

**Files:**
- Modify: `packages/core/src/domain/change-request/change-request.ts` (`appRegistrationRequest`)
- Test: `packages/core/src/domain/change-request/change-request.test.ts`

**Interfaces:**
- Consumes: `requestedPermissions`, `effectiveSetupPath` (Task 1); `AzureConfig.connectivity` / `allowedPermissions` (Task 2)
- Produces: `requestSummary(config: AzureConfig): string`, the count line beside the button, for example `"2 roles - Reader, Monitoring Contributor"`, or `"nothing selected"`

- [ ] **Step 1:** Move this task's defect card to `in-progress`.
- [ ] **Step 2: Write the failing tests:**
  - With partial and `["Reader"]`, the request text contains `"Reader"` and does not contain `"Monitoring Contributor"` or `"Application.Read.All"`.
  - With partial and `[]`, the request says the registration is asked for with no roles, and has no RBAC section.
  - With full and `existing`, the output is unchanged from today: snapshot against the current output, captured before editing.
  - `requestSummary` returns `"nothing selected"` for partial and `[]`, and `"1 role - Reader"` for partial and `["Reader"]`.
  - With Graph ticked, the summary counts it separately: `"1 role - Reader; 1 Graph permission"`.
- [ ] **Step 3:** Run the tests. Expected: FAIL.
- [ ] **Step 4:** Replace `appPermissionPlan(ctx.config.setupPath)` with `requestedPermissions(config.connectivity, config.allowedPermissions, config.setupPath)`. Disconnected never reaches this function; the UI does not render the button.
- [ ] **Step 5:** Run the tests. Expected: PASS. Close the card with `verified: pins`, then commit.

### Task 4: Journey follows the choice (defects: Azure nag, retired Azure Targeting copy)

**Files:**
- Modify: `packages/core/src/domain/journey-state/journey-state.ts`
- Test: `packages/core/src/domain/journey-state/journey-state.test.ts`

**Interfaces:**
- Consumes: `AzureConnectivity`, `ScopeNeed` (Task 1)
- Produces:
  - `JourneyFacts` gains optional `connectivity?: AzureConnectivity` (absent means `full`), `scopeNeed?: ScopeNeed` (absent means `full`), `subscriptionChosen?: boolean`, `tokenPresent?: boolean` and `tokenRequired?: boolean`. Absent token facts mean the stage is satisfied, so existing callers keep their behaviour until Task 5 wires them.
  - `FirstRunStageId` gains `"github"`. `FIRST_RUN_ARC` becomes `["accept", "github", "connect", "target", "ready"]`, with the label "Connect GitHub".
  - `StageStatus` gains `"not-needed"`. `ChipState` gains `"not-used"`.

- [ ] **Step 1:** Move both defect cards (Azure nag, retired-route copy) to `in-progress`.
- [ ] **Step 2: Write the failing tests:**
  - Disconnected, accepted, `tokenPresent` true, no identity: `nextAction(...).stageId` is `"choose-content"`. The `connect` and `target` stages have status `"not-needed"`, and the stage `nextAction` points at is the only `current` one (the existing invariant test, extended).
  - Disconnected: the identity, secret and scope chips all have `state === "not-used"`.
  - Disconnected: Deploy's `blockedReason` contains `"export"` and does not contain `"tenant"`.
  - Partial with `scopeNeed: "subscription"` and `subscriptionChosen: true`: the target stage is complete, even though `scopeCommitted` is false.
  - Partial with `scopeNeed: "none"`: target is `"not-needed"` (Review Focus 2).
  - `tokenRequired` true and `tokenPresent` false: `nextAction` is `{stageId: "github", label: "Save a GitHub token"}`.
  - Without the new facts at all: every existing test passes unchanged.
  - No `description`, `hint` or `blockedReason` anywhere in the module contains `"Azure Targeting"` or `"Use this target"`. The target description reads "Pick a subscription, resource group and workspace on Setup."
- [ ] **Step 3:** Run the tests. Expected: FAIL.
- [ ] **Step 4:** Implement. In `firstRunCompletion`, a stage that is `not-needed` counts as done for `allPriorDone`, and `deriveJourney` renders it as `not-needed` instead of `complete`. `nextAction` skips the connect and target branches when they are not needed. The `"Enter the tenant and client IDs in Connect first."` deploy reason (around line 241) becomes, under disconnected, "Disconnected: export the ARM templates instead."
- [ ] **Step 5:** Run the tests. Expected: PASS. Mutation-check: make `connectivity` ignored. Expected: the disconnected tests fail. Revert. Close both cards with `verified: pins`, then commit.

### Task 5: Wire the facts in the shell

**Files:**
- Modify: `apps/cribl-app/src/App.tsx` (the `journeyFacts` literal around lines 1569-1586)
- Modify: `packages/ui/src/screens/home/home-screen.tsx` (render the `not-needed` status and the `not-used` chip)
- Test: `packages/ui/src/screens/home/home-screen.dom.test.tsx` (create it if missing)

**Interfaces:**
- Consumes: Tasks 1, 2 and 4.

- [ ] **Step 1: Write the failing DOM test:** with disconnected facts, Home shows no "Enter your Azure identity", and the chips read "not used".
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** In `App.tsx`, set these facts:
  - `connectivity: activeConfig.connectivity`
  - `scopeNeed: scopeNeed(activeConfig.connectivity, requestedPermissions(...))`
  - `subscriptionChosen: activeConfig.subscriptionId.trim() !== ''`
  - `tokenRequired: patPolicyFor('cloud').required`
  - `tokenPresent`: read through the same port and key `RepositoriesScreen` uses for the stored PAT (grep `githubPat` under `packages/ui/src/screens/repositories/`). An unknown or refused read is NOT present-and-ok; treat it as `undefined` (DBT-175 rule).
  
  Home renders `not-needed` like Sentinel Integration's "Not needed" tag.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. Then commit.

### Task 6: The connectivity section (Option A)

**Files:**
- Create: `packages/ui/src/screens/setup-wizard/azure-connectivity-section.tsx`
- Test: `packages/ui/src/screens/setup-wizard/azure-connectivity-section.dom.test.tsx`
- Modify: `packages/ui/src/screens/setup-wizard/azure-connect-section.tsx` (render nothing when disconnected; the setup-path radio shows under full only)
- Modify: `packages/ui/src/screens/setup-wizard/azure-resources-section.tsx` (nothing when disconnected)
- Modify: styles beside the other setup-wizard classes (run `npm run check-classnames`)

**Interfaces:**
- Consumes: `checklistEntries`, `requestSummary`, `AzureConfig`, `InfoTip`
- Produces: `AzureConnectivitySection(props: { config: AzureConfig; onChange: (next: AzureConfig) => void; storedIdentity: boolean; onClearIdentity: () => void })`

- [ ] **Step 1: Write the failing DOM tests:**
  - It renders a radiogroup named "How will this app work with Azure?" with exactly three radios: "Fully Connected", "Partially Connected", "Disconnected".
  - Partial shows a "Read-only access" checkbox, checked, with a "Recommended" badge, and the one line "Fills the workspace, table and DCR pickers and the inventory views."
  - Under "Also allow the app to" are one checkbox per `checklistEntries().others`, labelled by `feature`, each with an InfoTip whose text includes that entry's `justification` and `withoutIt`.
  - Ticking "Deploy Data Collection Rules" calls `onChange` with `allowedPermissions` containing `"Monitoring Contributor"`. The summary line updates.
  - Choosing Partial while the saved `setupPath` is `"lab-new-rg"` calls `onChange` with `setupPath: "existing"` and shows "Lab setups need Fully Connected; switched to existing resources." (Review Focus 5).
  - Disconnected with `storedIdentity` true shows one line with buttons "Clear stored identity" and "Use Partially Connected" (Review Focus 4). With `storedIdentity` false, it shows only "This app will produce ARM templates and deployment guides to hand to someone who can run them."
  - By default, outside InfoTips, the section renders no more than three sentences. Count `.` terminators in the visible text of the partial view.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Render it at the top of the wizard's Azure step and on Setup (Task 7 places it).
- [ ] **Step 4:** Run the tests, `npm run check-classnames` and `npm test`. Expected: PASS. Then commit.

### Task 7: Wizard and Setup page trim (defects: GitHub "optional", duplicate ticket, "section on Setup", "connection bar above")

**Files:**
- Modify: `packages/ui/src/screens/setup-wizard/setup-wizard.tsx` (`AzureConnectStep` 429-480; the footer "This step is optional." at 382-384)
- Modify: `apps/cribl-app/src/App.tsx` (cloud view list around line 1535 drops `preflight`; guidance at 1536-1540; storage note at 1476-1487; Setup sections at 1749-1756)
- Modify: `packages/ui/src/screens/setup-wizard/first-run-wizard.ts` / `setup-wizard-state.ts` (make the GitHub view not skippable when `patPolicyFor(shell).required`)
- Test: the existing `setup-wizard*.test.*` and `first-run-wizard.test.ts`

- [ ] **Step 1:** Move the four defect cards to `in-progress`.
- [ ] **Step 2: Write the failing tests:**
  - The cloud views are exactly `["repositories", "connect-azure"]`.
  - On the cloud shell the GitHub view is not skippable, and its footer does not render "This step is optional."
  - The Connect Azure step renders exactly one "Generate Change Request" button.
  - No rendered setup text contains "section on Setup" or "connection bar above".
  - The storage, "write-only", and "discovery runs automatically" explanations each appear only inside an InfoTip.
- [ ] **Step 3:** Run them. Expected: FAIL.
- [ ] **Step 4:** Implement.
  - Delete `AzureConnectStep`'s own generator, keeping the section's.
  - Fold its two paragraphs into one line plus an InfoTip.
  - Move the remaining wordy paragraphs in `azure-connect-section.tsx` and `azure-resources-section.tsx` behind InfoTips. The inventory is in the review: the role script, path notes and storage note.
  - The Setup page renders `AzureConnectivitySection` above `AzureConnectSection`.
- [ ] **Step 5:** Re-pin rather than delete any older pin that encoded the old copy (memory: those pins are the specification). Run `npm test`. Expected: PASS. Close the cards with `verified: pins`, then commit.

### Task 8: Remaining copy defects (resource-picker intro, token scope) and Settings

**Files:**
- Modify: `packages/ui/src/screens/setup-wizard/azure-resources-section.tsx:402-403, 550-554`
- Modify: `packages/ui/src/screens/repositories/repositories-screen.tsx:352` and `packages/core/src/domain/sentinel-content/pat-policy.ts:39-43` (one scope statement: no scopes for a classic token reading public repositories)
- Modify: `packages/ui/src/screens/settings/settings-screen.tsx:181-184` (delete the note that repeats the Reconfigure InfoTip)

- [ ] **Step 1:** Move both defect cards to `in-progress`.
- [ ] **Step 2: Write the failing tests:**
  - The resource section's intro does not mention setup paths.
  - Repositories renders no "public_repo".
  - Settings renders the Reconfigure explanation once.
- [ ] **Step 3:** Run them, implement, and run `npm test`. Expected: PASS.
- [ ] **Step 4:** Close the cards with `verified: pins`, then commit.

### Task 9: Gates, live check, close

- [ ] **Step 1:** Run every CI gate from `soc-optimizationtoolkit/`:
  - `npm run lint`, `typecheck`, `test`, `build`
  - `check-listings`, `check-schema-asset`, `check-classnames`
  - `check-release`, `check-docs`, `check-board`, `check-board-freshness`

  Expected: all exit 0.
- [ ] **Step 2: Live Preview** (`/apps/a/__local__` on the jpederson org; never Deploy or Apply). Do NOT use Settings > Reconfigure: it writes `{}` to `setupComplete` and resets the live install. Confirm on the Setup page, which renders the same sections:
  - The wizard order (Agreement, then GitHub, then Azure) is covered by Task 7's pins, not by this live check.
  - Partially Connected shows Option A with Read-only checked.
  - The change request lists only Reader.
  - Disconnected makes Setup's next action stop asking for Azure.

  Restore the original choice afterwards. Record it on the story card and close it with `verified: both`.
- [ ] **Step 3:** Mark `setup-pages-plan.md` and this plan `Status: Record - IMPLEMENTED` with the PR number. Add a `release-notes.md` entry under the next version. Push, and open a PR against `main`.

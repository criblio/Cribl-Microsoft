# UX Flow Plan: From Screen Collection to Guided Journey

Companion to [porting-plan.md](porting-plan.md) (which this document amends), [roadmap.md](roadmap.md), and [feature-catalog.md](feature-catalog.md). Directive: the legacy Electron app's FLOW was better - one guided corridor from first launch to a deployed, wired, validated integration. The new toolkit has shipped better mechanics (Units 1-6: persistence, honest step lists, typed options, batch queue) but arranged them as a flat screen collection whose sidebar order is the inverse of the dependency order. This plan turns the shipped spine into a guided journey WITHOUT regressing anything the new app already does better, and converges with Unit 20 (the porting plan already names its unlock chain "the product's guided UX").

Scope discipline: Units 1-5 are shipped and Unit 6 is landing - nothing here reworks them; amendments only append UX requirements to unshipped units and insert one new unit (6.5) before Unit 7. All UI work obeys CONTEXT.md invariants: pure decisions in core, screens in @soc/ui over ports, both shells in the same increment, no emojis.

Legacy source root: `IS-R/` = `Cribl-Microsoft_IntegrationSolution/src/renderer/`.

---

## 1. What the legacy flow got right (port these patterns)

Each pattern below is tied to its mined source and is a JOURNEY pattern, not an implementation to copy (redesign-first principle).

1. **One destination page owns the whole job.** The home route IS the flagship workflow (`IS-R/App.tsx` 220-221, `IS-R/pages/SentinelIntegration.tsx`). There is no "pick a task" hub; everything else feeds or observes the job. The new app inverts this: the initial route (Onboard) is guaranteed gated for a fresh user, so first contact is a "Connection incomplete" wall.
2. **Single-page visible wizard with numbered circles.** All core sections render at once, scrollable and readable ahead; circle badges flip blue to green via `sectionDone()` (`SentinelIntegration.tsx` 1465-1473). Gating is enforced only at the commit button, never on reading or filling ahead.
3. **Earned sections.** Source Wiring appears only after `deployComplete`; Data Flow Validation only after `wiringComplete` (`SentinelIntegration.tsx` 3327, 3453). The page physically grows as milestones are hit - progress is tangible and post-deploy steps stay in the same context.
4. **Single-next-action hint text.** Every disabled primary button names exactly one missing thing: the Deploy hint cascade ("Select a solution" -> "Select a workspace" -> "Approve field mappings (1/2 tables approved)", `SentinelIntegration.tsx` 3303-3311), the RepoSetup wizard footer (`IS-R/pages/RepoSetup.tsx` 504-511), wizard step gating.
5. **Prerequisite chip checklist at the point of commitment.** The Deploy section restates Solution/Samples/Mappings/Workspace/WorkerGroups/PackName as green-check chips filtered by mode (`SentinelIntegration.tsx` 3255-3273), so readiness is auditable without scrolling back.
6. **Explicit approval gate on machine-generated plans.** "Approval Required" pills per table, per-table Approve, "Auto-Approve All" escape hatch, "N of M approved" progress, deploy hard-blocked until reviewed (`SentinelIntegration.tsx` 2266-2307, 1459-1463). Review is mandatory but one click can satisfy it.
7. **Manual analysis with staleness signaling.** Changing inputs flips an orange border and relabels the button "Analyze" vs "Re-Analyze" instead of auto-recomputing (`SentinelIntegration.tsx` 487-497, 2191-2231) - the user controls when expensive work runs and always knows if results are stale.
8. **Prefill-but-editable defaults everywhere.** Pack name derived from solution (noise words stripped), RG/location auto-filled on workspace pick, first worker group pre-checked, best available mode auto-selected with a "Recommended" badge (`SentinelIntegration.tsx` 470-485, 2854-2862, 266; `IS-R/pages/SetupWizard.tsx` 254-261). Derive, do not ask.
9. **Live derived-value echo.** As the user types an org ID, the computed base URL renders beneath the field before any submit (`SetupWizard.tsx` 357-361) - the machine shows its interpretation.
10. **Preflight permission check with remediation in place.** Selecting a workspace auto-runs an RBAC probe rendering per-capability dots, detected roles, and on failure an "Action required" card naming the exact role plus Retry Check / Switch Account buttons (`SentinelIntegration.tsx` 389-419, 2926-3031).
11. **Preview-before-commit with provenance.** Resource preview with Exists / Will Create pills and click-to-view ARM JSON (`SentinelIntegration.tsx` 3104-3168); table-resolution banner states which tables were chosen and HOW (green = researched, amber = defaulted).
12. **Streaming narrated deploy log ending with the one remaining manual step.** The deploy log explains skips, version bumps, and route-discriminator choices, and ends "Update the client secret in the Cribl Sentinel destination to start data flow." (`SentinelIntegration.tsx` 906-1354). Success style is summarize-and-point-forward, never celebrate.
13. **Skippable-but-honest gates.** DepsCheck relabels its continue button "Skip (some tools may not work)"; unavailable mode cards dim with "Requires connection" badges (`IS-R/pages/DepsCheck.tsx` 260-264, `SetupWizard.tsx` 552-593). Skipping is allowed; its consequence is shown immediately.
14. **InfoTip as embedded glossary at the point of decision.** Section titles, every gap-analysis stat, every mapping-table column header (`IS-R/components/InfoTip.tsx` usage throughout) - density highest where jargon is thickest. Already adopted by Units 4-6; keep the placement conventions.
15. **Always-visible ambient status.** Connection dots on every screen, repo readiness strip atop the flagship page, mode badge in the sidebar footer (`IS-R/components/AuthBar.tsx`, `Sidebar.tsx` 132-153). The new app's committed-scope chip and mode chip are the successors; the journey needs one more: where-am-I.

Legacy anti-patterns this plan must NOT reproduce (already fixed or to be avoided): forced wizard gauntlet on every launch (`IS-R/App.tsx` 183-186 - the new app's persisted acceptance/mode already fixes this); all workflow state as unmounted-component state destroyed by navigation (`SentinelIntegration.tsx` 154-214 - JobStore/KV persistence already fixes this); approval gate silently absent when analysis never ran; green-coloring heuristic that styles failure lines as success; guidance duplicated as hand-written prose per screen.

---

## 2. What the new app already does better (keep-list - the journey work must not regress these)

1. **Per-context persistence with tolerant codecs.** Acceptance, mode, options, committed scope, profiles, and run records all persist and reload; resume is free. No forced re-entry, ever (`packages/ui/src/frame/frame-state.ts` never-flash contract; azure-profiles; appOptions).
2. **Honest seeded step lists with first-class 'skipped'.** `onboardTableStepsFor`/`onboardBatchStepsFor` seed every step `[pending]` before the run so the full plan is visible up front; skips render distinctly; error detail is verbatim per line (`packages/ui/src/onboarding/step-line.ts`, Unit 6 decision).
3. **Always-visible-disabled affordances with instructional placeholders.** Controls are never hidden; they are disabled with the reason ("Connect first, then Refresh from Azure") - an explicit design rule in `azure-targeting-screen.tsx`.
4. **Browse-never-commits plus explicit "Use this target" commit**, with the committed scope always visible as a topBar chip and invalidation consequences surfaced as notices (Unit 2).
5. **Secret hygiene.** Secrets never returned to the renderer; session-only liveness with hedged, honest messaging rather than false confidence; `redactedLength` as the only sanctioned log reference (Units 2-3).
6. **Dual-shell parity as a standing gate.** Every increment lands in both shells; shared screens take shell differences as props, not embedded prose (the harness-pointer defect in the shared Onboard footer is the counterexample to fix).
7. **Mode-derived navigation.** Nav filtering comes from route `requires` declarations through one `filterNavItems` - nav can never disagree with the mode (Unit 1; legacy had four independent mode reads).
8. **Options as saved defaults plus per-run tri-state overrides** ("Use saved option (on)" / on / off) with cross-field validation blocking Run with a named reason (Units 4/6).
9. **RecentRuns as a persisted run log** embedded in the onboarding screens - the app's memory of what happened (JobStore).
10. **Honest capability messaging.** "What a green run proves" disclaimers, "(not set)" rendering, no mode oversold (aspirationally - see section 3 on the azure-only gap).
11. **Budgeted, consolidated polling and the 30s/100-req-per-min discipline** (Unit 1 scheduler, Unit 6 pacing hooks).
12. **Pure, tested decision modules behind every screen** (frame-state, targeting-state, batch-state, custom-schema-state) - the exact mechanism the journey state will reuse.

---

## 3. The target journey (both shells)

Two arcs. The FIRST-RUN arc runs once per install (and never again - resume is automatic from persisted state). The INTEGRATE arc is the repeatable job. The design rule carried from legacy: all stages of the current arc are VISIBLE and readable at all times; gating applies only to commit actions, and every locked stage names its single unlock condition.

### 3.1 First-run arc: AUA -> Mode -> Connect -> Target -> Readiness

| Stage | Surface | Entry condition | Prefilled from state | Completing it unlocks |
|---|---|---|---|---|
| 1. Acceptable use | AuaGate (shipped, Unit 1) | Always first; never flashes for accepted users | Persisted acceptance record | Mode selection |
| 2. Mode | ModeSelect (shipped, Unit 1) | Acceptance recorded | Persisted mode (skips the stage entirely) | Home + journey rail for that mode |
| 3. Connect (identity) | Cloud: identity entry, today harness panel 3, promoted to a product Connect step by Unit 9; Local: leader/identity setup, completed by Unit 22 | Mode requires Azure and/or Cribl | Active profile (tenant/client), saved secret liveness state | Azure Targeting's live selectors |
| 4. Target (scope) | AzureTargetingScreen (shipped, Unit 2) | Identity connected (offline free-text branch for artifact modes) | Committed scope from the active profile; live subscription/workspace/RG lists | Onboard/Batch run buttons; readiness check |
| 5. Readiness | Preflight report (Unit 9); until it lands, Home's composite readiness chips (identity / secret / scope / options) | Scope committed | Profile + scope + secret-liveness signals | The Integrate arc with a green "canDeploy" |

Stage 3 is the current worst wall and where the three readiness layers must be distinguished (today's five-field gate conflates them): **identity** (tenant/client/secret entered and connected), **secret liveness** (session-only; 'unknown' renders honestly with a verify affordance until Unit 9's probe makes it definite), and **scope** (a committed target). The journey state models these as separate signals so the gate panel and Home can name the right next action instead of a generic field list.

### 3.2 Integrate arc: Choose -> Configure -> Review -> Deploy -> Validate -> Monitor

| Stage | Surface (today -> end state) | Entry condition | Prefilled from state | Completing it unlocks |
|---|---|---|---|---|
| 1. Choose content/tables | Table name entry + vendor-schema multi-select on Onboard/Batch (shipped) -> solution browser (Unit 14) and sample intake (Units 11/12/16) feeding table choice; deep-link `#/?solution=` preserved | First-run arc green (or artifact mode) | Vendor schema library; later: solution catalog, browse-modal recommended tiers pre-selected | Configure |
| 2. Configure | Custom-schema section (Unit 5), per-run tri-state overrides (Unit 6), Cribl defaults from Options (Unit 4) -> plus mapping/pipeline options (Units 13/17) | Table(s)/content chosen | Persisted appOptions (retention, DCE, prefixes, worker group); schema source precedence | Review |
| 3. Review / approve | NEW as a stage: Unit 7 resource preview (Exists vs Will Create + request JSON) -> joined by Unit 13 match preview and Unit 18 mapping approval (staleness-aware manual analyze) | Configuration complete enough to predict resources (dcr-naming is the single predictor) | Preview computed from live ARM + saved options; nothing to type | Deploy button (hard gate, with review-all escape hatch) |
| 4. Deploy | Onboard/Batch run with seeded step lines (shipped), role assignment step (Unit 8) -> guided multi-source deploy (Unit 20) with readiness chips at the commit point | Review approved (chips all green or explicitly skipped in artifact modes) | Everything above; per-run overrides | Earned stages: wiring, then validation; artifact download in partial modes |
| 5. Validate | Post-run "next step" line (today) -> KQL verify step (Unit 10), source wiring + DataFlowView embedded in the flow (Units 20/21) | Deploy succeeded (stage appears on completion - the legacy earned-section pattern) | Deployed DCR ids/endpoints from the run record; live source list | Monitor |
| 6. Monitor | RecentRuns (shipped), Logs (shipped) -> data-flow dashboard (Unit 27) | Any completed run | Run records, deployed table set (never hardcoded) | - (observing, not gating) |

### 3.3 Step vs tool: where every existing screen slots

Journey STEPS (rendered on the rail, ordered by dependency):

- Home / Overview (NEW, Unit 6.5) - the landing route in both shells.
- Connect (cloud: harness panel 3 via cross-link until Unit 9 promotes it; local: Settings note until Unit 22).
- Azure Targeting (existing screen, unchanged - it already behaves like a step).
- Onboard Table and Batch Onboard (existing screens; their gate panels become journey-state-driven).
- Review/Preview (Unit 7), Mapping Review (Unit 18), Wiring/Validation (Units 20/21) join the rail as they land.

Standalone TOOLS (nav section "Tools" - feed or observe the journey, never block it):

- Options (saved defaults; cross-linked from the Configure stage's "open Options" hook - already shipped in Unit 6).
- Logs (diagnostic observation; support bundle).
- Settings (platform facts, mode + Reconfigure, raw config editor).
- Later: pack inventory (Unit 19), monitoring dashboard (Unit 27), SIEM migration analyzer (Unit 26 - a journey FEEDER via deep link).

DIAGNOSTICS (nav section last, cloud shell only):

- Spike Harness, retitled "Diagnostics". Panels 1-2 and 5-7 stay here permanently. Panels 3-4 remain reachable here even after Units 9/22 promote their product function, per the existing route-table comment declaring targeting "the product path" and panel 4 "a diagnostic".

Mode honesty rule for the whole journey: a mode's rail shows ONLY stages that exist today for that mode. Where the mode description currently promises artifact generation that no visible route delivers (azure-only, air-gapped), either the route requirement is relaxed to match actual per-run needs (templateOnly runs need no Cribl) or the mode copy is tightened until Unit 20 - decision recorded in section 6, question 2. No stage ever renders as a teaser for unshipped capability.

---

## 4. Journey mechanics spec for @soc/ui

Four pieces, respecting invariant 1 (pure state in core, rendering in ui, signals injected by shells).

### 4.1 `journey-state` core module (packages/core)

Pure, tested, zero IO - the successor to the legacy `sectionDone`/`canDeploy` chain and the module Unit 20's plan already reserves ("a PURE tested workflow-state module... it IS the product's guided UX"). Unit 6.5 creates it for the shipped spine; Unit 20 EXTENDS it (one module, never two).

- Input: a `JourneyReadiness` record composed from signals that already exist - acceptance, mode, the five `ONBOARD_REQUIRED_FIELDS` split into identity fields (tenantId, clientId) vs scope fields (subscriptionId, resourceGroup, workspaceName), secret liveness (`'live' | 'unknown' | 'missing'`), committed-scope flag, persisted options presence, and the latest JobStore run summary.
- Output: `resolveJourney(readiness) -> { stages: JourneyStage[], nextAction: { label, routeId } | null }` where each stage is `{ id, label, status: 'done' | 'current' | 'available' | 'locked', unlockHint?: string }`. `unlockHint` is the single-next-action text (legacy pattern 4) and is DATA, not per-screen prose.
- Contract tests: stage order fixed per mode; exactly one 'current'; every 'locked' stage carries an unlockHint; 'unknown' secret liveness never renders as 'done' (honesty rule); artifact modes skip live-connection stages entirely rather than showing them locked.
- The Onboard/Batch gate panels are REWRITTEN to consume this module: the "Connection incomplete" wall becomes a compact journey excerpt (which layer is missing - identity, secret, or scope - plus the one next-action button). This deletes the duplicated hand-written connect-then-target prose the two screens currently carry (the mined drift risk).

### 4.2 `JourneyStepper` component (packages/ui)

- A progress rail (vertical in Home, compact horizontal strip at the top of step screens) of numbered circles: green = done, blue = current, muted = available, dimmed + lock hint = locked. Same visual grammar as the legacy numbered sections.
- Steps with status done/available/current are clickable and navigate via the existing `AppFrameNav` (the mechanism gate panels already use). Locked steps are rendered but not clickable, with their unlockHint as the title and inline microcopy - never hidden (keep-list item 3).
- **Jump-back-safe**: revisiting a done step never destroys later state. This holds by construction because state is persisted per context, commits are idempotent, and re-committing surfaces consequences through the existing connection-invalidation notices (e.g. re-committing scope shows what it invalidates). A test pins: navigating done -> earlier -> forward re-renders from persisted state identically.
- **Resume-where-you-left-off is derived, not stored**: there is no separate wizard-progress blob to drift. `resolveJourney` recomputes position from persisted state on every mount, so resume is automatic and can never disagree with reality (and can never reproduce the legacy forced-gauntlet anti-pattern).

### 4.3 Home / Overview screen (packages/ui, route id `home`, requires `none`)

State-aware landing surface, `initialRouteId` in BOTH shells. Never a wall - it always renders something actionable.

- The journey rail (4.2, vertical) for the active mode, with where-you-are and what-is-next visible at a glance.
- A single primary next-action card: one button, one sentence, driven by `nextAction` from journey-state (legacy single-next-action pattern applied at app level).
- Readiness chips: identity / secret (with the honest 'unknown' rendering and a verify affordance once Unit 9 lands) / scope (the committed-scope chip's data) / saved options - the point-of-commitment chip checklist (legacy pattern 5) promoted to the overview.
- Recent runs: the existing RecentRuns component embedded read-only, so "what happened last time" frames "what to do next".
- Mode note: the honest one-liner for the active mode plus the Settings/Reconfigure pointer (reusing MODE_LABELS/MODE_OPTIONS - one source).

### 4.4 Nav reordering and cross-links (packages/ui AppFrame + both shells)

- `AppRoute` gains an optional `section: 'journey' | 'tools' | 'diagnostics'` (default `'tools'`). AppFrame renders grouped nav with small uppercase headers (JOURNEY / TOOLS / DIAGNOSTICS), preserving `filterNavItems` semantics within each group - mode filtering is unchanged, only presentation order changes.
- Order: journey steps in dependency order (Home, Connect*, Azure Targeting, Onboard, Batch Onboard), then Tools (Options, Logs, Settings), then Diagnostics (Harness, cloud only). This fixes the mined defect that the sidebar lists screens in the inverse of dependency order with no step-vs-tool distinction. (*Connect appears when its product surface exists; until then Home cross-links.)
- Cross-link fix (shipped-screen defect, in scope because it is a cross-link): the shared OnboardTableScreen footer's pointer to "panel 4 ... of the Spike Harness view" (which does not exist in the local shell) becomes a shell-provided `roleGuidance` link prop - cloud points at Diagnostics panel 4, local points at the role-plan/change-request surface. Shared screens never name shell-specific UI in prose again (parity keep-list item 6).

---

## 5. Porting-plan amendments (concrete, minimal)

### 5.1 NEW - Unit 6.5: Guided journey shell (S/M), slotted before Unit 7

- Covers: the journey IA gap for the ALREADY-SHIPPED connect -> target -> onboard spine (no new engine capability; composition of existing signals).
- Legacy sources (patterns, not code): `IS-R/pages/SentinelIntegration.tsx` sectionDone/canDeploy chain, hint cascade 3303-3311, chip checklist 3255-3273; `IS-R/pages/SetupWizard.tsx` step semantics.
- New core: `journey-state` pure module per section 4.1 (readiness composite splitting identity vs secret liveness vs scope; `resolveJourney`; unlockHint as data). Contract tests per 4.1.
- UI (@soc/ui): Home/Overview screen (4.3), JourneyStepper rail (4.2), AppRoute `section` + grouped nav (4.4), Onboard/Batch gate panels rewritten over journey-state (duplicated prose deleted), shell-provided `roleGuidance` cross-link prop replacing the harness pointer in shared copy.
- Shells: both set `initialRouteId="home"`, register the route table with sections, and compose `JourneyReadiness` from their existing signals (config fields, secret liveness, committed scope, options, JobStore). Cloud Home cross-links Connect to Diagnostics panel 3 until Unit 9; local Home states the config-file identity path until Unit 22.
- Mode honesty decision recorded in this unit's PR: relax `batch-onboard` `requires` to `azure` with templateOnly forced on when Cribl is absent, OR tighten azure-only/air-gapped mode copy until Unit 20 (recommendation: relax - see section 6 Q2).
- External surface: none. Depends on: Units 1-6 (Unit 6's batch screen is a journey step; do not start before it merges).
- Rider: the QUEUED dark-mode toggle (porting-plan note after Unit 5) lands WITH this unit - both are app chrome, as the note itself anticipates ("Lands with the guided-journey shell unit").

### 5.2 Amendment to Unit 7 (Existing-resource check and deployment preview)

Append: the preview is not a standalone screen - it renders as the Integrate arc's REVIEW stage. Requirements: (a) entry from the Configure stage via the stepper; (b) the preview's Exists / Will Create rows feed a review gate - Deploy stays blocked until the preview has been viewed for the current inputs, with a one-click acknowledge-all escape hatch (legacy approval-gate pattern, scaled to what exists pre-Unit-18); (c) staleness: changing tables/options after a preview flips the stage back to 'current' with an orange stale marker and relabels the action "Re-check" (legacy manual-analysis pattern); (d) the Deploy button's disabled hint comes from journey-state's unlockHint, naming the single missing thing.

### 5.3 Amendment to Unit 9 (Permission preflight report) - rider

Append: Unit 9's panel is the journey's "Connect and verify" step - it promotes identity entry and verification out of Diagnostics into a product surface on the cloud shell (panel 3 remains as a diagnostic), turns secret liveness 'unknown' into a definite probe result consumed by journey-state, and feeds Home's readiness chips from the combined PermissionReport. The per-capability dots + Retry / Switch Account remediation card follow the legacy preflight pattern (section 1, item 10).

### 5.4 Amendment to Unit 13 (Destination schema catalog and field matcher)

Append: the minimal match-preview view slots into the Integrate arc's Review stage next to the Unit 7 resource preview (one review moment, two panels), not as a separate nav destination. Requirements: (a) the six-stat scoreboard carries InfoTips with the legacy domain text (source fields / dest columns / passthrough / overflow vocabulary); (b) match results participate in the same staleness flag as Unit 7's preview; (c) the surfaced missing-AdditionalData_d warning renders inside the review stage where the decision is made, not in a log.

### 5.5 Amendment to Unit 20 (Guided deploy, source wiring, and air-gap export) - the Integrate arc completion

Append: Unit 20 explicitly COMPLETES the Integrate arc; its planned "PURE tested workflow-state module" is the Unit 6.5 `journey-state` module EXTENDED, never a second implementation. Requirements: (a) the guided workflow sections render on the same JourneyStepper rail - Choose/Configure/Review stages (Units 7/13/18) followed by Deploy, then EARNED stages Wiring and Validation that appear on completion in place (legacy earned-sections pattern; Unit 21's DataFlowView embeds as the Validation stage); (b) readiness chips at the Deploy commit point restate every prerequisite filtered by mode; (c) the deploy run keeps the shipped seeded-step-line idiom and ends summarize-and-point-forward: counts, artifact location, and the single remaining manual step - and status coloring derives from step status, never from line-text heuristics (the legacy green-indent defect); (d) wiring supports "wire another source" (the legacy one-shot dead end does not port); (e) mode gating (skipAzure/skipCribl) flows from journey-state so partial modes see a shorter rail, not disabled stages.

### 5.6 Amendment to Unit 22 (Local-app first-run onboarding completion) - rider

Append: Unit 22's target chooser / leader-connect step is the local shell's Connect stage on the same rail (replacing the edit-config-file-and-restart wall), and its availability-gated mode cards (hasCribl/hasAzure matrix with "Requires connection" badges and auto-selected best mode) close the loop on ModeSelect honesty.

### 5.7 Click-count target vs legacy

Legacy happy path (fresh install, full mode, mined measurement): approximately 24 clicks to a deployed, wired, validated integration - about 13 of them inside the flagship flow; repeat sessions paid a forced 5-6 click wizard gauntlet before reaching the app.

Targets (measured the same way: dropdown = open + pick = 2, excluding typing):

| Path | Legacy | Target |
|---|---|---|
| Fresh install to first successful deploy (spine: through Unit 6.5 + 7) | ~24 (full arc incl. wiring/validation) | <= 20 through the equivalent point |
| Integrate arc alone, once first-run is done (Unit 20 exit) | ~13 | <= 13 (parity or better; earned stages and prefills do the work) |
| Repeat session to a new table deployed | ~18 (gauntlet + flagship) | <= 8 (zero gate clicks - persisted acceptance/mode/scope; Home next-action -> Onboard -> Review acknowledge -> Run) |

The repeat-session row is the journey's headline win and is only possible because of keep-list item 1; any amendment that adds a mandatory per-session click needs an explicit justification in its PR.

---

## 6. Open UX questions (with recommendations)

1. **Where does cloud identity entry live before Unit 9?** Options: grow Unit 6.5 to build a product Connect screen now, or have Home cross-link into Diagnostics panel 3 until Unit 9 promotes it. Recommendation: cross-link now, promote in Unit 9 - keeps Unit 6.5 at S/M and avoids building a screen twice; the rail names the stage from day one so the IA is stable.
2. **How do azure-only and air-gapped modes reach the artifact paths that already exist?** Options: relax `batch-onboard` route `requires` to `azure` (templateOnly forced on when Cribl is absent) and route the targeting offline branch, or tighten the mode descriptions until Unit 20 delivers the full air-gap story. Recommendation: relax - the Unit 6 templateOnly + ArtifactSink work already delivers real value in azure-only mode, and honesty-by-capability beats honesty-by-copy-edit; air-gapped keeps tightened copy until Unit 20.
3. **Stepper linearity: hard-linear wizard or the legacy read-ahead model?** Recommendation: legacy model - all stages of the active arc visible and readable, jump-back-safe navigation, gating enforced only at commit actions (Use this target, Run, Deploy). Hard-linear wizards fight the keep-list (always-visible-disabled affordances) and punish expert users.
4. **Should Home land on every launch, or should the app resume to the last-visited screen?** Recommendation: Home on every launch - it is state-aware and one click from anywhere the user was, costs nothing (no forced re-entry, unlike the legacy gauntlet), and gives the where-am-I/what-is-next answer first. Revisit only if real users report the extra click as friction.

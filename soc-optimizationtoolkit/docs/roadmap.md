# Implementation Roadmap

Derived from [feature-catalog.md](feature-catalog.md) with all review questions resolved (2026-07-01). Phases are vertical slices: each delivers user-visible capability end-to-end in BOTH targets, per ADR-0001. Feature IDs reference the catalog. The redesign-first principle and its compatibility contracts apply throughout.

Standing gates for every phase:
- Capability works in apps/cribl-app AND apps/local-app (parity gates legacy archival).
- Domain logic lands in packages/core with contract tests; characterization tests where the catalog names a compatibility contract.
- proxies.yml/policies.yml (cloud) and the local host allowlist change in the same PR as the feature.
- CONTEXT.md files and ADRs updated when boundaries or decisions change.
- No emojis anywhere.

## Flagship vertical: Azure Native Source Onboarding

A content-preserving onboarding of Azure-native diagnostic sources (e.g. Entra Non-Interactive Sign-in logs) through Cribl into Sentinel. Full plan: [features/azure-native-onboarding.md](features/azure-native-onboarding.md). Slots as a dedicated vertical AFTER Phase 2 (needs the full DCR engine + custom tables) and pulls the LOG-07/03/16 Event Hub source path forward from Phase 4. Gate before its walking-skeleton slice: empirically validate the two live-Azure unknowns (do native Entra tables accept a Kind:Direct DCR at all; will a workspace register a function-alias equal to a native table name). Note: for the Entra flagship, Mode A (clean native-table ingestion) is NOT available today - no Entra identity table is on the Logs Ingestion API supported-tables list - so it is Mode B (custom _CL table + function-alias/ASIM) only, and UEBA cannot follow a rerouted table.

## Phase 0: Workspace foundation - DONE 2026-07-01

npm-workspaces restructure (packages/core, packages/ui, apps/cribl-app, apps/local-app), CONTEXT.md per workspace, ADR-0001, build and .tgz packaging verified.

## Phase 1: Walking skeleton (onboarding thread, one table, both shells)

Goal: the thinnest end-to-end slice that proves every architectural seam - ports, both shells, Azure auth, polled jobs, Cribl product API.

STATUS 2026-07-03: cloud-shell slice SHIPPED (commit 166deed) and VERIFIED LIVE the same day - a real run against the user's Azure tenant + Cribl.Cloud org completed all seven steps green: SecurityEvent schema (232 columns) fetched, dcr-SecurityEvent-eastus deployed as Kind:Direct with a real immutable id and ingestion endpoint, MS-Sentinel-SecurityEvent-dest created, and commit-and-deploy succeeded (resolving the group-scoped /version/commit policy-path question). All three risk spikes verified live earlier (KV write-only, token via proxy injection, iframe downloads). LOCAL SHELL SHIPPED 2026-07-03 (commit c0aa948): zero-runtime-dependency Node host (127.0.0.1, config-file credentials, server-side token cache, bounded upstream timeouts, file-backed secrets/jobs with write-only encrypted parity) serving the SAME @soc/ui OnboardTableScreen through six local adapters; shared UI stylesheet extracted to @soc/ui/styles.css (byte-compared) so both shells consume one source; adversarially reviewed with a live smoke test. Pending a live run against a real leader + Azure from the host (user). PHASE 1 EXIT MET 2026-07-03 (commit 64a2e3d): porting Unit 1 delivered the settings graduation - both shells now run the shared app frame (AUA gate, mode select, route-table nav from the app-mode core module, Settings screen, consolidated budget-aware status poller). Remaining live-verification items are user-side (local-shell run against a real leader; installed-mode re-checks). Data-flow validation (a source sending events end-to-end) is deliberately a later-phase concern and additionally requires the ingestion SP's Monitoring Metrics Publisher grant (Phase 2 ENG-37). Incremental porting now proceeds per docs/porting-plan.md (27 units; Unit 1 SHIPPED).

- Test and CI foundation FIRST: vitest wired across the workspace (colocated *.test.ts), golden-vector characterization fixtures recorded by executing the legacy PowerShell logic, and a path-filtered GitHub Actions workflow (lint + typecheck + test + build) gating every PR from this phase onward.
- Ports in packages/core: CriblClient, AzureManagement, SecretsStore, JobStore, UserContext, ArtifactSink; fakes for tests.
- Domain: dcr-naming (port v1's TS implementation V1-30; characterization tests against legacy output - compatibility contract), column type mapping (DCR-08), DCR column-set generation (DCR-09).
- Cloud shell adapters: platform fetch, KV store (encrypted secrets), ARM via proxies.yml; policies.yml first entries.
- Local shell: minimal Node host serving packages/ui, outbound HTTP adapter, encrypted local secret store, static leader-token auth.
- Onboarding settings screen: Azure consent flow with the informed-consent step and permission matrix (per catalog Onboarding requirements), permission preflight (real-action checks, ENG-38 capability).
- The slice: pick one native table (SecurityEvent) -> retrieve schema (DCR-07) -> deploy Direct DCR via direct ARM PUT (redesign, no template indirection) -> create the Sentinel destination through the Cribl API (collapses DCR-25/26/27 + ENG-35) -> validation query confirms the wiring (ENG-32, thin).
- Spikes settled here: iframe Blob download; KV encrypted write-only + Basic header injection on the token endpoint; ARM polling under the 30s proxy timeout.

Exit: one table onboarded to a live workspace from both shells; all gates green.

## Phase 2: Onboarding thread thickened (Tier 1 complete)

Goal: the full DCR engine and deployment workflow at production quality.

- Custom tables: creation from JSON schema (DCR-18/19), MMA migration (DCR-21/22), schema variant resolution hardened (DCR-07 edge cases as tests).
- DCE and Private Link modes (DCR-16/17); DCE-based naming (64-char path of DCR-10).
- Batch deployment: client-side queue respecting proxy rate limits (cloud) with resumable polled jobs; combined summaries (DCR-02 capability).
- Name confirmation UX (DCR-11), existing-resource preview (ENG-36), role assignment for the ingestion SP (ENG-37, RBAC Administrator path).
- Template/asset library bundled into packages/core (AST-01/02, DCR-20, DCR-33); ARM template export as air-gap artifact (DCR-12 as ArtifactSink output, not deployment mechanism).
- Azure targeting and RBAC preflight screens (GUI-10/11/12).
- QUEUED (user request, 2026-07-03) - Logger port and in-app diagnostics: a Logger port in @soc/core (debug/info/warn/error with structured context; injected like other ports - pure domain modules stay log-free, use-cases and adapters log through it, entries tagged with the jobId where applicable so a run's diagnostics attach to its job record). Cloud adapter: bounded in-memory ring buffer mirrored to the console in dev, persisting only warn/error to KV (respect KV write volume); local-shell adapter: file log. UI: a log viewer alongside the RecentRuns history, plus a download-support-bundle action via ArtifactSink (logs + recent job records) for troubleshooting handoffs. Hard rule carried from the secret model: no secret or token value is ever loggable - the Logger port's context type excludes them by construction and review enforces it.

Exit: DirectNative/DirectCustom/DCE/PrivateLink coverage on par with legacy Run-DCRAutomation modes, from both shells.

## Phase 3: Pipeline and pack engine

Goal: the Integration Solution's crown jewels, redesigned into packages/core.

- Multi-format pipeline generation (ENG-01), reduction rules KB (ENG-02), serialize overflow (ENG-03), 6-phase field matcher (ENG-04), sample parser + capture auto-detection (ENG-14/15), headerless CSV flow (ENG-16, GUI-07), tagging/log-type detection (ENG-18).
- Sample acquisition: tiered resolver (ENG-19) with Sentinel repo on-demand GitHub queries + KV cache (redesign of ENG-21/23), synthetic samples (ENG-41).
- Pack lifecycle: scaffolding (ENG-06), lookup generation (ENG-07), .crbl assembly in-browser (ENG-08), inventory (GUI-19/20), direct install via Cribl API; DCR gap analysis with mapping review (ENG-12, GUI-08).
- Air-gap bundle export (ENG-10/GUI-15 capability via ArtifactSink).
- Onboarding GUI completion in local-app first-run: target chooser, .tgz packaging/upload walkthrough, leader connect (per dual-target architecture).

Exit: solution browsed -> samples -> pipeline -> pack -> installed destination end-to-end; Cloudflare pack (DOC-01) reproducible through the app.

## Phase 4: Discovery and governance (Tier 2)

- Event Hub discovery: Resource Graph single-query path only (EVH-03/04/06/07/08); Cribl Event Hub source generation (LOG-16).
- vNet Flow Logs: tenant-wide discovery (VNF-01), collector config generation (VNF-02), AzureFlowLogs pack assets shipped installable (VNF-08 through VNF-14).
- Azure Log Collection suite: policy initiatives, diagnostic settings at scale, Entra/Defender exports (guided where elevated roles are needed), conflict/collision detection, compliance gap analysis, remediation, cleanup (LOG-02 through LOG-15).
- Lookups via Graph exclusively (LKP-01 capability, LKP-02 redesigned; LKP-04/05 native Cribl API); analytics rule coverage (ENG-11, GUI-09).
- QUEUED (user request, 2026-07-07) - Architecture Pattern advisor: a new menu item where the user selects the Cribl products in use (Stream, Edge, Lake, Search, worker groups / edge fleets) and the Azure resources in use (Sentinel/Log Analytics, Event Hub, Storage/blob, DCR/DCE, Private Link/AMPLS, Entra diagnostics), and the app renders the matching reference-architecture DIAGRAM(s) plus recommended patterns for that combination (e.g. Edge-to-Stream-to-Sentinel, Event Hub fan-in, Lake tiering, Private Link ingestion). Shape: the product/resource catalog and the selection-to-pattern mapping are PURE core (a data-driven rule set, unit-tested), diagrams rendered self-contained (inline SVG - no external assets, strict-CSP safe) so both shells and the Artifact path can show/export them; selectors reuse the searchable dropdown. Advisory only - it recommends and visualizes, it deploys nothing. Can draw on the AI-assisted layer (see [ai-assisted-analysis-plan.md](ai-assisted-analysis-plan.md)) for pattern rationale, with the deterministic mapping as the source of truth.

## Phase 5: Labs

- UnifiedLab profile first (resolved): phased ARM deployments as resumable jobs (LAB-01 through LAB-12), TTL self-destruct MANDATORY on every app-provisioned lab, naming/validation logic into core (LAB-13/14), Cribl wiring generation merged with discovery features (LAB-05/11/19).
- AzureFlowLogLab as a second profile afterward (LAB-17 through LAB-21).

## Phase 6: Drift engine

- Shared drift-check implementation (SYN-04 through SYN-09), on-demand in cloud, scheduled by the local host (resolved); AI schema extraction/inference and pack generation/correction via Anthropic proxy (SYN-02/03/12/13), deterministic fallback (SYN-14), cost tracking (SYN-11), audit logging (SYN-10). GitOps/GitHub Actions flow retires.

## Phase 7: Long tail, parity audit, archival

- SIEM migration analyzer (ENG-40, GUI-22), monitoring dashboard (GUI-18), guided-doc flows (DOC-02 through DOC-06 as in-app checklists), Power BI/Search connector story (DOC-07).
- Parity audit against this catalog; mark every feature domain superseded or explicitly dropped.
- Archival endgame: migrate remaining assets into packages/core, tag legacy-final, remove Cribl-Microsoft_IntegrationSolution/, Azure PowerShell trees, and SOC-OptimizationToolkit_v1/ from main; retire the stale v1 CI workflow and root launchers (workspace CI exists from Phase 1).

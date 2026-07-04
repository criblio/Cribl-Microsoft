# Porting Plan: Legacy Integration Solution to the Dual-Target Toolkit

Companion to [roadmap.md](roadmap.md) and [feature-catalog.md](feature-catalog.md). This plan decomposes the legacy Electron Integration Solution (ENG-01..52, GUI-01..32) into ordered port units that slot into the roadmap's existing phases. It does NOT invent a new sequence: units are grouped by roadmap phase (2, 3, 4, with a small tail the roadmap itself schedules in phases 6-7), ordered by dependency edges, then by operational friction (never leave the new app more manual than legacy where users actually touch it).

Grounding rules:

- Redesign-first principle governs every unit (catalog "Redesign-first principle"): legacy is a capability reference, not an implementation spec. Compatibility exceptions are characterization-pinned (section 3 below).
- ALREADY PORTED - do not duplicate: the Phase 1 walking skeleton (onboardTable usecase, OnboardTableScreen, both shells live), the six ports + fakes (CriblClient, AzureManagement, SecretsStore, JobStore, UserContext, ArtifactSink), dcr-naming (characterized), schema-mapping (characterized), dcr-request (incl. parseDcrDeployment endpoint fallback), sentinel-destination, azure-permissions (effective-action preflight core), azure-config, azure-profiles (named connection profiles + active pointer), connection-invalidation, azure-resource-id, role-plan + change-request (human-mediated role setup), dataflow-diagram, and the local Node host + Cribl auth manager (local shell shipped 2026-07-03). Units below port DELTAS against this baseline.
- Every unit ships as ONE reviewable increment delivering user-visible capability in BOTH shells (roadmap standing gates).
- No emojis anywhere.

Legacy source root abbreviations used below:

- `IS/` = `Cribl-Microsoft_IntegrationSolution/src/main/ipc/`
- `IS-R/` = `Cribl-Microsoft_IntegrationSolution/src/renderer/`
- `IS-T/` = `Cribl-Microsoft_IntegrationSolution/tests/`

---

## 1. Port-unit backlog

### Phase 2: Onboarding thread thickened

#### Unit 1: App shell, mode-aware navigation, and settings (S/M)

- Covers: GUI-01, GUI-29, GUI-30, GUI-27.
- Legacy sources: `IS-R/App.tsx`, `IS-R/components/Sidebar.tsx`, `IS-R/components/Layout.tsx`, `IS-R/components/InfoTip.tsx`, `IS-R/components/StatusBadge.tsx`, `IS-R/pages/Settings.tsx`, `IS-R/components/ConfigEditor.tsx`.
- New core: mode model (full | azure-only | cribl-only | air-gapped) as ONE source of truth in a workflow-state module (legacy had four independent reads); nav-filter pure function (`requires: cribl|azure|both`); acceptance record `{acceptedAt}`.
- Adapters: acceptance + mode in KV (cloud) / config port (local). No new ports.
- UI (@soc/ui): app frame with route table, AUA scroll-to-bottom gate (rewrite the AUA text for the platform), mode chip, settings screen (platform info, mode display, Reconfigure = clear mode + reload), InfoTip that renders embedded newlines, advanced raw-JSON editor pattern (validate-before-save) retained from ConfigEditor only where a JSON-editable surface survives.
- Characterization fixtures: none exist; new tests for the nav filter matrix, AUA gate never flashing (null = loading), Reconfigure-writes-empty-object contract.
- External surface: none new. Consolidate ALL status polling into one budget-aware scheduler now (legacy: AuthBar 30s + Sidebar 30s + DataFlow 30/45/60s - three concurrent pollers on day one is how the 100 req/min budget dies).
- Depends on: Phase 1 exit (settings screen graduation).
- Notes: full-width layout escape hatch (legacy /data-flow) preserved for Unit 27 later.

#### Unit 2: Azure resource discovery and targeting (M)

- Covers: ENG-31 (delta), GUI-10, GUI-28 (Azure half).
- Legacy sources: `IS/auth.ts` (session helpers ~1082-1200, handlers ~1403-1604), `IS-R/hooks/azure-resources.ts`, `IS-R/pages/SentinelIntegration.tsx` (~328-455, 2795-3168), `IS-R/components/AuthBar.tsx`.
- New core: discovery usecases over AzureManagement - list subscriptions (Enabled only), workspaces (name/RG/location/customerId/sku), resource groups; create-RG, create-workspace (PerGB2018, RetentionInDays 90, provisioning poll), enable-Sentinel (SecurityInsights solution resource, idempotent pre-check, FIX the legacy always-eastus location bug - use the workspace's actual location, pinned by test); `deriveResourceGroupsFromWorkspaces` ported verbatim with its tests as the RG-list-denied fallback; workspace selection commits scope through azure-profiles (merge, never replace) + connection-invalidation (already ported).
- Adapters: ARM GET/PUT via existing AzureManagement port (extend port methods as needed); pagination (nextLink) handled in the adapter.
- UI: Azure targeting section (subscription -> workspace -> RG cascade, create-new-RG input with name sanitization, offline free-text branch for air-gapped mode), profile/workspace switcher replacing AuthBar's Azure pill; browse vs commit separated (legacy switched subscription context as a side effect of browsing - do not reproduce).
- Characterization fixtures: `IS-R/hooks/azure-resources.test.ts` ports verbatim. New tests: enable-Sentinel location, profile update is a merge, one loader (legacy had three overlapping effects), Enabled-subscription filter.
- External surface: management.azure.com already declared (Phase 1). Local allowlist unchanged.
- Depends on: Unit 1.
- Notes: interactive Connect-AzAccount has no equivalent; both shells use SP client-credentials with device-code fallback (already the Phase 1 consent model). ConnectionStatus failure classes stay specific (bad tenant vs bad secret vs network vs no-permission).

#### Unit 3: Logger port and in-app diagnostics (S/M)

- Covers: the roadmap Phase 2 QUEUED logger item; supersedes the purpose of ENG-48 (verdict platform-provided - reimplement, do not port).
- Legacy sources: `IS/logger.ts` (spec only: line format, rotation policy as prior art).
- New core: Logger port (debug/info/warn/error, structured context, jobId tagging); context type excludes secrets/tokens by construction; pure domain modules stay log-free - usecases and adapters log through the port.
- Adapters: cloud = bounded in-memory ring buffer, warn/error mirrored to KV (respect write volume); local = file log with rotation.
- UI: log viewer beside RecentRuns; download-support-bundle (logs + recent job records) via ArtifactSink.
- Characterization fixtures: none; new contract tests (secret-free context, ring bound, bundle content).
- External surface: none.
- Depends on: Unit 1. Deliberately early: every later unit's jobs get diagnostics for free.

#### Unit 4: Deployment and naming options as typed forms (S)

- Covers: ENG-43.
- Legacy sources: `IS/param-forms.ts` (three ParamFormDefinition objects; azure form largely superseded by azure-profiles).
- New core: form-definition data module (operation options: createDCE, skipExistingDCRs, deploymentTimeout, templateOnly, keepTemplateVersions, custom-table retention 30/90, dcePublicNetworkAccess, amplsResourceId; cribl options: destinationPrefix 'MS-Sentinel-', suffix '-dest', workerGroup) with the field descriptions' operational knowledge (30/64-char limits, Cribl 4.14+) preserved; nested get/set helpers; explicit validation replacing legacy silent `Number()||0` coercion (decision: fix, with a test pinning the new rejection behavior).
- Adapters: KV/config port persistence; merge-preserving semantics (unmanaged keys and comments survive a save) pinned by test.
- UI: options panel feeding Units 5-7 and 20.
- External surface: none. Depends on: Unit 1.

#### Unit 5: Custom (_CL) table creation (M)

- Covers: ENG-34, custom-table path of ENG-33 (roadmap DCR-18/19/20 line).
- Legacy sources: `IS/azure-deploy.ts` 326-405 (generateCustomTableSchemas + mapColumnType), legacy PS engine table PUT behavior, `Azure/CustomDeploymentTemplates/DCR-Automation/core/custom-table-schemas/`.
- New core: create-custom-table usecase - ARM PUT `workspaces/{ws}/tables/{table}` with schema + retention 30/90 defaults (compatibility contract); `mapColumnType` extracted verbatim (datetime/int/long/real/boolean/dynamic/guid/default-string); dual schema-variant acceptance (`properties.schema.columns` OR `properties.schema.tableDefinition.columns`) - both variants exist in the wild, both tested; user-authored schema wins over auto-generation; bundled vendor schema library (CrowdStrike, Cloudflare) as core assets.
- Adapters: none new. GitHub-sourced auto-generation of table definitions (searching solutions for `<Table>.json`) is a DELTA that activates after Unit 14 lands the content port; until then sources are bundled assets + user upload.
- UI: custom table step in onboarding (schema upload/pick, column preview), wired into the onboardTable flow as the pipelined single job the catalog prescribes (custom table + DCR as one job, no PS double-run).
- Characterization fixtures: none exist; new tests for mapColumnType (verbatim table), both schema variants, retention contract, skip-if-exists idempotency, missing type defaults to string.
- External surface: management.azure.com (existing).
- Depends on: Units 2, 4.

> UNIT 6 FOLLOW-UPS (review observations, 2026-07-04): (a) the legacy Fix-HandlerControlEndpoint
> repair (handler.control.monitor -> ingest.monitor rewrite, catalog DCR-28) is deferred to the
> sentinel-destination composition layer - port it there (with the legacy-cited test) before
> DCE-based Cribl configs ship to environments exhibiting the anomaly; (b)
> AMPLS_SCOPED_RESOURCE_API_VERSION 2021-07-01-preview was not minable from legacy (Az cmdlets) -
> confirm against a live ARM call before relying on the association path in production (add to the
> user's live-testing list).

> QUEUED (user, 2026-07-04): DARK MODE TOGGLE - refactor the shared stylesheet's hardcoded colors
> into CSS custom properties on :root with a [data-theme="dark"] override (single source, both
> shells; no rule duplication); theme choice light|dark|system (default system via
> prefers-color-scheme) persisted as a plain 'appTheme' entry following the appMode pattern; toggle
> control in the frame topBar plus the Settings screen. Caveat to document: inside the Cribl iframe,
> "system" follows the OS preference, not Cribl's own UI theme (no platform theme signal exists in
> AGENTS.md). Lands with the guided-journey shell unit (both are app chrome) or immediately after
> Unit 6 - whichever comes first once the in-flight UI work clears.

> DECISIONS RESOLVED (user, 2026-07-03, via multiple choice - all recommendations accepted):
> (1) JobStatus/step status gains a first-class 'skipped' value (binds Units 6/20 and step-line rendering).
> (2) Cribl destinations reference a named Cribl secret object (app ensures it via API); '<replace me>' survives only in air-gapped export artifacts (binds Unit 20).
> (3) Suppress rules HONOR maxEvents - the legacy allow:1 defect is fixed and pinned; fielded packs emitting allow:1 get rebuild guidance (binds Units 13/18).
> (4) Cloud pack artifacts REGENERATE deterministically from stored pack definitions; artifact bytes are never persisted in KV (binds the pack lifecycle units).

#### Unit 6: Batch deployment queue and DCE/Private Link modes (L)

- Covers: ENG-33 (delta), ENG-39 (inner multi-table batch loop; full multi-source orchestrator is Unit 20), roadmap DCR-16/17 + DCE naming.
- Legacy sources: `IS/azure-deploy.ts` 233-680, `IS/e2e-orchestrator.ts` runDcrDeploy (divergence bug archive), legacy `Create-TableDCRs.ps1` behavior via existing characterization vectors.
- New core: onboard-batch usecase wrapping onboardTable per table: client-side queue respecting the 100 req/min cloud budget, resumable JobStore records, per-table partial results (never all-or-nothing), skip-existing semantics, mode selection (Direct vs DCE x native vs custom), DCE resource creation + dataCollectionEndpointId wiring, AMPLS/private-link network access options, 64-char DCE naming through the existing dcr-naming module. Decide ONCE how skips render: extend JobStatus with 'skipped' or encode as succeeded+detail (this decision also binds Unit 20 and step-line rendering).
- Adapters: ARM PUT/poll (existing); local shell may run the batch server-side.
- UI: batch deploy screen (table multi-select, per-table step lines, combined summary).
- Characterization fixtures: none exist for azure-deploy; new tests pin: re-running a completed job is a no-op; templateOnly ACTUALLY works (legacy accepted it and silently never forwarded it - fix + pin); table classification (`_CL` suffix); downstream steps of a failed prerequisite stop-or-skip (legacy cascaded confusing errors - decide and pin).
- External surface: management.azure.com (existing). Template-only output goes through ArtifactSink.
- Depends on: Units 2, 4, 5.
- Notes: exactly ONE deploy usecase (legacy had two drifted implementations: pwsh temp-dir vs powershell.exe-in-repo-cwd). ARM error bodies surface raw and greppable (httpErrorText pattern already established).

#### Unit 7: Existing-resource check and deployment preview (M)

- Covers: ENG-36, GUI-12.
- Legacy sources: `IS/azure-deploy.ts` 540-628 (check-existing), 684-763 (preview-resources).
- New core: check-existing usecase (live ARM DCR list scoped to the profile's RG + per-match GET at api-version 2023-03-11 for immutableId/ingestion endpoint); preview composition (per table: DCR resource + workspace/table resource for _CL, exists flag, attached request body). dcr-naming becomes the SINGLE source for predicted names - the legacy preview used a simplified approximation that diverged from deployed names; test asserts preview name === deployed name across the abbreviation-triggering characterization vectors. Existence truth is live ARM only (legacy preview trusted stale cached files while check-existing queried live - unify on live).
- UI: resource preview screen (Exists vs Will Create rows, expandable request JSON, DCR/TBL tags).
- Characterization fixtures: dcr-naming legacy-vectors.json reused; new collision tests (shared-prefix tables like Cloudflare vs CloudflareAudit must not cross-match; replace all four legacy fuzzy substring matchers with dcr-naming-based matching).
- External surface: existing.
- Depends on: Units 2, 6 (mode knowledge), bundled template assets (AST-01/02 land here or in Unit 6, whichever ships first).
- Notes: legacy check-existing catch referenced an out-of-scope variable (never-exercised error path) - treat the whole handler as uncharacterized; tests are written from the mining, not the code.

#### Unit 8: Ingestion role assignment usecase (S/M)

- Covers: ENG-37 (runtime half; the human-mediated script/ticket half is ALREADY PORTED as role-plan + change-request).
- Legacy sources: `IS/azure-deploy.ts` 895-978.
- New core: assign-dcr-role usecase - per-DCR scope, Monitoring Metrics Publisher GUID `3913510d-42f4-4e42-8a64-420c390055eb` (verbatim constant), idempotency via existing-assignment check or PUT-then-409-RoleAssignmentExists-is-success, principalType ServicePrincipal with retry-on-PrincipalNotFound (Graph replication lag - the cmdlet was immune, REST is not; test it), result aggregation {results, assigned, total}. GUID minting for assignment names stays shell-side (shell owns ids convention). DCR-to-table matching goes through dcr-naming, not substring guessing.
- UI: role-assignment step in deploy flow + Enterprise Application OBJECT ID input with the hard-won guidance text (object id, NOT app registration client id).
- Characterization fixtures: none exist; new tests per the above.
- External surface: management.azure.com roleAssignments paths (existing domain).
- Depends on: Units 2, 6.

#### Unit 9: Permission preflight report (M)

- Covers: ENG-38 (delta), GUI-11.
- Legacy sources: `IS/permission-check.ts` (444 lines; the Azure role-name heuristics are a NEGATIVE example - azure-permissions already implements effective-action checks correctly).
- New core: preflight orchestration usecase - fetch `providers/Microsoft.Authorization/permissions` at the right scope per SetupPath (REQUIRED_ACTIONS already in core), live no-op existence probes (workspace GET, tables list, DCR list), Cribl-side capability report via CriblClient probes (probes are truth, role name is decoration - preserve the graceful degradation), combined PermissionReport {cribl, azure, canDeploy, summary} with fixed-priority failure reasons; both sides checked in parallel, partial results always render.
- UI: RBAC preflight panel (per-capability dots, granted roles, Retry / Switch Account actions); wired into onboarding consent flow per catalog Onboarding requirements.
- Characterization fixtures: azure-permissions unit tests exist; new tests: Reader-only yields canDeploy false (read does not imply write), no-RG-configured stub, checked-actions list exported as data (doubles as the least-privilege custom-role definition).
- External surface: existing ARM domain; policies.yml already grants the Cribl probe paths used by the walking skeleton (extend as probes widen).
- Depends on: Unit 2.
- Notes: on the cloud shell the Cribl-side probe is near-vacuous (app runs inside the leader under approved policies.yml); on local it is genuinely informative. Same report shape both shells.

#### Unit 10: Log Analytics KQL query port (S/M)

- Covers: ENG-32.
- Legacy sources: `IS/auth.ts` 2041-2088.
- New core: LogAnalyticsQuery port (or AzureManagement extension with a second base URL): POST `api.loganalytics.io/v1/workspaces/{customerId}/query` with {query, timespan default PT1H}; columnar-to-row-object zip as a pure function; workspace customerId comes from the ACTIVE profile (legacy queried the first workspace found - fix + pin); 200-with-zero-rows = success with empty rows (pinned).
- Adapters: token cache becomes AUDIENCE-KEYED (api.loganalytics.io is a second AAD audience distinct from management.azure.com).
- UI: onboardTable verify step upgraded from DCR GET to a real destination-side query.
- Characterization fixtures: none exist; new tests per above plus malformed-body tolerance.
- External surface: NEW proxies.yml domain api.loganalytics.io with the Origin-suppressing header allowlist (same AADSTS9002326 class as ARM); NEW local-host allowlist entry - both in this unit's PR (invariant 4). Keep timespans bounded under the 30s proxy timeout.
- Depends on: Unit 2. Unblocks Units 21 and 27.

Phase 2 exit check (roadmap): DirectNative/DirectCustom/DCE/PrivateLink parity with legacy Run-DCRAutomation modes from both shells. Units 1-10 deliver it.

### Phase 3: Pipeline and pack engine

#### Unit 11: Sample parser core and sample intake (M/L)

- Covers: ENG-14, ENG-15, ENG-18, GUI-06 (upload/paste/tag portions; browse modal arrives in Unit 16).
- Legacy sources: `IS/sample-parser.ts` (892 lines; ~700 pure), `IS-R/pages/SentinelIntegration.tsx` 584-903 sample handlers.
- New core: sample-parsing domain module - ONE format detector merging the two legacy detectors (sample-parser detectFormat vs sample-resolver detectSampleFormat) with explicit strict/lenient modes; parseSampleContent (CEF/LEEF/CSV/KV/JSON/NDJSON/syslog, type inference + merge lattice, collectFields, guessTimestampField); capture inner-_raw detection (ENG-15) as FIRST-CLASS (user memory: Cribl capture is the primary sample format; format is ALWAYS detected from rawEvents content, never declared format); tagged-sample store behind a TaggedSampleStore port (replace-by-logType semantics); auto-detect-types discriminator logic with ONE unified DISCRIMINATOR_FIELDS list (legacy had three drifted copies); detectLogType/isHeaderlessCsv/original-format-preservation heuristics from the renderer extracted as pure functions. ParsedSample/DiscoveredField/TaggedSample become shared core domain models BEFORE any consumer ports.
- Adapters: browser File API both shells (no upload endpoint); tagged samples to KV (cloud, 200-event rawEvents cap keeps size sane) / host store (local).
- UI: sample intake screen - multi-file upload, paste + logType, sample chips with field table and raw preview, logType rename (rename must also re-key mapping edits - fix the legacy orphaning bug and pin it).
- Characterization fixtures: `IS/sample-parser.test.ts` ports near-verbatim; VENDOR the crowdstrike-fdr corpus (10 NDJSON files, 272KB) into core test assets NOW. New tests for the ENG-15 gap (silent wrapper fallback, format replacement, >=5-comma CSV threshold, PAN-OS prefix strip) - the catalog explicitly flags capture detection as edge-case-archive material.
- External surface: none (parsing is local compute).
- Depends on: Unit 1.

#### Unit 12: Headerless CSV and vendor feed-config resolution (M)

- Covers: ENG-16, ENG-17, GUI-07.
- Legacy sources: `IS/sample-parser.ts` 194-315 + 457-600, `IS/sample-resolver.ts` 1026-1200 (full PAN-OS dictionaries), renderer CSV dialog in SentinelIntegration.tsx.
- New core: parseCsvWithHeaders (syslog prefix stripped BEFORE split, future_use skipped, _extra_N overflow columns, skipFirstRow); ONE canonical PAN-OS column dictionary set (the documented PAN-OS 11.0 order, 8 log types) resolving the three-way drift (parser index 20 'log_action' vs resolver 'logset') with a test characterizing the difference consciously; PANOS_LOG_TYPES map deduplicated; feed-config parser (Zscaler NSS three extraction patterns, Palo Alto syslog profile, FortiGate, Cloudflare Logpush, CrowdStrike SIEM connector, rsyslog fallback) with the load-bearing branch order pinned ('dataset' keyword claims Cloudflare - documented false-positive).
- UI: CSV header resolution dialog (two tabs: header file / paste feed config; preview zip; mismatch warning; Skip vs Apply) - QUEUE remaining files instead of legacy's silent drop of the rest of the batch (fix + pin).
- Characterization fixtures: none exist (named coverage gap); new tests from mining (quoted-comma limitation documented, '1,' slice fingerprint, Zscaler default-TCP).
- External surface: none. Depends on: Unit 11.

#### Unit 13: Destination schema catalog and 6-phase field matcher (L)

- Covers: ENG-04, ENG-05, ENG-03 (overflow config + matcher routing; pipeline emission in Unit 17).
- Legacy sources: `IS/field-matcher.ts` (861 lines), `IS/pack-builder.ts` 60-218 (loadDcrTemplateSchema + SYSTEM_COLUMNS).
- New core: (a) SchemaCatalog port + pure resolution algorithm - name normalization (Microsoft- prefix both directions), bundled PRE-EXTRACTED column sets for the ~120 DCR template schemas as core assets (not full ARM templates), custom-schema entries, SYSTEM_COLUMNS filter set extracted verbatim (deduplicated - legacy defined it twice), async API (kills the legacy dynamic-import contortions), empty-result flows gracefully to an all-unmatched MatchResult; GitHub CustomTables fallback activates after Unit 14. (b) field-matcher module ported with knowledge bases verbatim: ALIAS_TABLE (~240 entries), REVERSE_ALIAS, COALESCE_PRIORITY, classifyEventType + EVENT_TYPE_BOOSTS, scoreMatch ladder + typeValueBoost, substring guards (vendor-prefix and *Label vs STANDARD_COLUMNS), VALUE_NORMALIZATIONS (exported, still unused - future Lookup-function feature); actual-sample-casing rule (Cribl renames are case-sensitive); 'in' reserved-word overflow-by-design. (c) overflow config: TABLE_OVERFLOW_FIELDS map verbatim, skip-list, enabled-only-when-field-exists rule with a SURFACED WARNING when a _CL schema lacks AdditionalData_d (legacy silently dropped data - fix + pin).
- UI: minimal match-preview view (sample vs table -> matched/overflow/unmatched counts) as the seed of the Unit 18 review screen.
- Characterization fixtures: `IS/field-matcher.test.ts` ports with vendored fixtures + pre-extracted schemas replacing %APPDATA% state (all 10 CrowdStrike tables: system columns filtered, matchRate > 0.3, timestamp mapping, no Cribl internals, per-class overflow config, 5 strategy cases); relevant assertions from `IS-T/test-uat-crowdstrike.ts`.
- External surface: none in the bundled path (core assets ship in the .tgz - the air-gap-capable path stays fetch-free).
- Depends on: Unit 11.

#### Unit 14: Sentinel content port, PAT management, and solution browser (L)

- Covers: ENG-21 (redesigned), ENG-23, ENG-30, ENG-22 (content-filter data only; crash detection DROPPED), ENG-52 (superseded by this unit's lazy-fetch cache policy), GUI-04 (redesigned), GUI-05.
- Legacy sources: `IS/sentinel-repo.ts` (~1208), `IS/github.ts` (~559), `IS/auth.ts` PAT portion (244-320, 1378-1400), `IS/edr-blocklist.json`, `IS-R/pages/RepoSetup.tsx`, SentinelIntegration.tsx solution-browser sections.
- New core: ONE GitHubContent/SentinelContent port (listSolutions, listSolutionFiles, listConnectorFiles recursive, readFile, raw fetch) backed by on-demand per-solution tree queries + targeted raw fetches with KV caching keyed by solution+commit SHA - the mirror-and-scan architecture does NOT port (Electron-era workaround, catalog line 103). Pure knowledge extracted verbatim: file-selection extension sets (INCLUDED/BLOCKED/SKIP + SKIP_DIRS) as a persistence filter, solution deprecation heuristics (all-connectors-deprecated rule), 'Data Connectors' name variants, nested template_*/connector_* scans, the 4-format connector decoder consolidated to ONE decoder with three projections (full ENG-23 / VendorLogType ENG-24 / fingerprint ENG-26), normalizeDcrType as ONE superset map (currently triplicated with drift), rate-limit header bookkeeping in the adapter (per-host, not module-global). PAT: encrypted KV secret (cloud) / host secret store (local), validate-then-store via GET /user, never returned to the renderer (hasPat boolean), header injection via proxies.yml so the token never reaches browser code; PAT effectively REQUIRED on cloud (shared egress IP makes anonymous quota unreliable) - onboarding states purpose and minimal scope.
- UI: solution browser (search, deprecated badges + reason, deep-link contract `#/?solution=` preserved for Unit 26), repositories/PAT settings page (13-step PAT walkthrough text kept; bulk-mirror progress UX shrinks to per-solution fetch spinners; save-then-unstick stale-error sequence preserved as reactive state).
- Characterization fixtures: record NEW fixtures before porting: real connector JSONs covering all 4 formats (incl. columnName/columnType variants and Custom- streams), Solution_*.json deprecation content, CrowdStrikeCustomDCR.json (vendored, also feeds Unit 18); `IS-T/test-uat-crowdstrike.ts` TEST 10 (recursive discovery 2 levels deep) re-recorded as fixture-based.
- External surface: NEW proxies.yml entries api.github.com + raw.githubusercontent.com with PAT header injection; NEW local-host allowlist entries - same PR. Per-solution tree queries (not whole-repo recursive tree) to stay under the 30s timeout.
- Depends on: Unit 1. Unlocks Units 5-delta, 15, 16, 18, 23, 25, 26.
- Notes: local shell - if any IOC-laden rule content is ever persisted to disk, the EDR content filter (BLOCKED_EXTENSIONS/isIncluded) is MANDATORY on the persistence path; the built-in blocklist entries (BloodHound Enterprise, FalconFriday, etc.) survive as an optional content filter, the fetching.json crash detection does not.

#### Unit 15: Vendor research engine and registry (M/L)

- Covers: ENG-24, ENG-25 (redesigned).
- Legacy sources: `IS/vendor-research.ts` (~1469; VENDOR_REGISTRY lines 433-1073), `IS/registry-sync.ts` (~525).
- New core: VENDOR_REGISTRY (~640 lines of curated per-vendor field knowledge incl. production fieldMappings encoding deployed DCR schema constraints) shipped verbatim as a versioned core data module; three schema parsers (OpenAPI with $ref/allOf, Sentinel connector, JSON schema) + mapOpenApiType; resolution chain with PROVENANCE surfaced in the result (which tier answered - legacy fell through silently); merge semantics pinned (static wins when fetched has fewer fields; dual Timestamp mapping for Cloudflare DNS); resolveFromSentinelRepo auto-resolver (3-tier fuzzy match, DCR extraction, table-definition override order). Registry redesign: PREBUILT index shipped as an app asset for search/browse + lazy per-solution refresh cached in KV (the legacy full remote scan was chronically rate-limited and never worked - catalog correction recorded; do not treat it as a baseline); normalized vendor-key derivation pinned as a mini compatibility contract (vendor-research and change-detection look entries up by it). Local shell may run the slow scheduled full sync as the producer of the shared prebuilt index.
- UI: research provenance display in the analyze flow; registry search.
- Characterization fixtures: none exist; new tests for merge semantics, fuzzy tiers, latent `sourcetypeHint ? undefined : undefined` bug NOT reproduced, dynamicEntryToResult defaults.
- External surface: reuses Unit 14 GitHub entries (registry schema URLs point at raw.githubusercontent.com; static registry IS the pre-bundle so no vendor-doc domains needed).
- Depends on: Unit 14.

#### Unit 16: Tiered sample acquisition and synthesis (L)

- Covers: ENG-19, ENG-20 (redesigned: lazy fetch, prefetch dropped), ENG-41, ENG-42; completes GUI-06 (browse modal).
- Legacy sources: `IS/sample-resolver.ts` (1873), `IS/default-samples.ts` (967).
- New core, extracted verbatim: SOLUTION_SAMPLE_MAP (~25 curated entries), lookupSolution 4-stage fuzzy match consolidated to ONE matcher (currently re-implemented three times), fuzzyMatchElasticPackage scoring, tier precedence (user > criblpacks > elastic > synthesis), splitting/unwrapping (elastic 6-format cascade, Filebeat message envelope, noise-field removal, hasNamedFields), stable browse/load IDs (`${source}:${logType}` - characterize generation, any split nondeterminism breaks selection), event caps (50/50/100); ENG-42: ABBREVIATIONS dictionary (~70 vendors), EXCLUDE_PATTERNS, SENTINEL_SCHEMA_MARKERS set with the 3+-hits preIngested rule and its three user-facing messages, scoring thresholds (short-keyword suppression, score>=8), original-raw-line preservation for cef/leef/syslog, CrowdStrike consolidation via table routing; ENG-41: generateValue heuristic table verbatim (Web Crypto instead of Node crypto), KQL-literal reuse in Tier 3 synthesis (synthetic events must satisfy analytics-rule where-clauses - explicit test), serializeEvent per format. ENG-20's eager prefetch is NOT ported: lazy per-selected-solution fetch with per-solution KV cache TTL (the 12h staleness idea survives as cache invalidation).
- UI: browse-samples modal (tiers, previews, indeterminate select-all, per-tier load summary), auto-load with preIngested messaging.
- Characterization fixtures: none exist (named gap); new fixture-based tests for markers, abbreviations scoring, hasNamedFields, PAN-OS load-time conversion, browse/load ID stability.
- External surface: reuses Unit 14 GitHub entries (elastic/integrations, criblpacks, Azure-Sentinel all via the one content port - single declaration set, one enforcement point for the 100 req/min budget).
- Depends on: Units 11, 12, 14, 15 (synthesis uses REVERSE_ALIAS from Unit 13 and vendor fields from Unit 15).

#### Unit 17: Pipeline generation engine (L)

- Covers: ENG-01, ENG-02, ENG-03 (emission), ENG-13.
- Legacy sources: `IS/pack-builder.ts` 221-1017 + scaffold-time orchestration 1770-2510, `IS/reduction-rules.ts` (662), `IS/source-types.ts` (1278).
- New core: (a) PipelinePlan - the scaffold orchestration's five competing options.tables mutation paths reified as ONE pure planner producing an explicit plan (the digest's central redesign note); (b) generatePipelineConf as a pure builder over the plan: format-specific extraction knowledge verbatim (CEF two-step eval avoiding regex_extract, LEEF tab kvp, CSV syslog-prefix strip + PAN-OS positional map + generic serde fallback, JSON/KV serde), timestamp logic (candidate list, CrowdStrike eval-first + backup auto_timestamp, CEF rt override), buildCoercionExpr type map, enrich Type=<table>, cleanup field list, reduction steps BEFORE rename (KB filters address raw vendor names - reordering silently breaks every filter), escapeYamlFilter order; guard the CEF indexOf(-1) garbage case with a test; (c) reduction-rules KB as a versioned core data module (8 rule sets with reasons - display content for the review UI) + findReductionRules lookup semantics characterized (aggressive bidirectional containment pinned); DECISION: fix the live suppress emission bug (`rule.allow || 1` discards maxEvents; the only correct code was dead) - fix + pin with KB-lookup and suppress-emission tests, since no customer-visible artifact depends on allow:1; (d) route.yml emission (paired reduction/passthrough routes, filter key contract, disable-swap comments); resolve the tableOverflowConfigs-keyed-by-table vs per-logType collision (Cloudflare multi-logType single-table) consciously; (e) source-types catalog + generateInputsYml ported verbatim (merge order, formatYamlValue quoting rules, discovery-section guard).
- UI: pipeline preview panel (generated conf.yml per log type, reduction rules with reasons).
- Characterization fixtures: `IS-T/test-uat-transformations.ts` assertions converted to vitest over in-memory outputs (groupId presence, serde selection, cleanup, PAN-OS CEF extraction, no-duplicate-DCR-transforms); checkCriblYaml linter from `IS-T/test-uat-pack-build.ts` extracted as a CORE VALIDATOR with its own tests (Cribl YAML acceptance rules); regression 'filter: not condition:' re-pointed at real code.
- External surface: none (pure generation; delivery is Units 19/20).
- Depends on: Units 11, 13; consumes Unit 15 vendor mappings and Unit 18 routing as TYPED INPUTS (planner takes results, does not call subsystems).

#### Unit 18: DCR gap analysis and mapping review (L)

- Covers: ENG-12, GUI-08, GUI-32.
- Legacy sources: `IS/kql-parser.ts` (424), `IS/pack-builder.ts` 2991-3174 (analyze-samples) + 1330-1439 (gap reports), `IS-R/hooks/analyze-workflow.ts` + tests, SentinelIntegration.tsx 487-581 + 2193-2578.
- New core: kql-parser ported (parseTransformKql with function-name skip list and typeMap, parseDcrJson tolerating all 3 shapes, generateRouteCondition - ESCAPE AND ANCHOR the >5-name regex, legacy over-matched substrings, fix + pin), analyzeDcrGap with criblInternalFields drop-set verbatim and the design contract header preserved (Cribl must never duplicate DCR work); formalize the dual-engine split: field matcher owns user-facing counts, gap analysis owns DCR-side partitioning (legacy case-mismatch branch was dead code - do not port it; the consistency contract from test-uat-transformations TEST 8 becomes the spec); analyze-samples becomes a pure core usecase composing sampleParser + SchemaCatalog + matcher + content port, chunked per-table for UI responsiveness; analyze-workflow helpers (resolveDestinationTables precedence with provenance strings, matchSampleToTable) port VERBATIM with tests; gap reports become typed result objects rendered in UI / exported via ArtifactSink (no .txt side files); the CrowdStrike-flavored _time enrichment and FDR common-field injection made vendor-parameterized.
- UI: mapping review screen - editable mapping table (dest dropdown, action dropdown), approval state machine (approvals reset on re-analysis, mappingEdits survive keyed by logType and RE-KEY on rename), staleness flag, deploy gate (every table with mappings approved), six stat tiles with their InfoTip domain text, overflow-contributes-source+dest coverage semantics; RULE badges activate when Unit 23 lands.
- Characterization fixtures: `IS-R/hooks/analyze-workflow.test.ts` verbatim; vendored CrowdStrikeCustomDCR.json (>=8 flows, >=20 Process columns, plain-object backward compat); TEST 8 consistency contract; data-loss footgun pinned (vendor field named 'source'/'host'/'port' dropped as internal - decide surface-or-preserve).
- External surface: reuses Unit 14 entries.
- Depends on: Units 11, 13, 14.

#### Unit 19: Pack assembly, lifecycle, and install (L)

- Covers: ENG-06, ENG-07, ENG-08, ENG-09, ENG-28 (deltas: two-step pack upload, breakers, secrets create-or-update; base client ALREADY PORTED in walking skeleton), GUI-19, GUI-20 (folded).
- Legacy sources: `IS/pack-builder.ts` 1025-1323 + 1446-1608 + 1644-2624 + 2741-2962, `IS/app-paths.ts` (knowledge only), `IS/auth.ts` 448-704, `IS-R/pages/Packs.tsx`, `IS-R/pages/PackBuilder/*`.
- New core: in-memory pack tree model (relPath -> string|bytes) as the domain object; scaffold from PipelinePlan + analysis inputs (naming contract characterization - section 3); breakers.yml KB (json_array/json_newline rules, CrowdStrike 786432 maxEventBytes + timestampAnchorRegex); sample-file generation (Cribl envelope, CEF reconstruction from tagged JSON, generateFieldValue heuristic KB verbatim); samples.yml registry; outputs.yml via the existing sentinel-destination module; lookup CSV generation + lookups.yml at default/ (never data/lookups/); pure ustar/.crbl builder as the ONLY implementation (tar.exe path deleted) with deterministic mtime option; pack build records + retention in KV/local store; install via Cribl packs API (PUT ?filename= then POST source, duplicate-conflict delete-and-retry) with the returned-randomized-filename rule; deployed-status truth from the Cribl packs API, not local storage. FIX + PIN two legacy defects: route/reduction suffix vs capped/_CL-stripped pipeline dir mismatch (unify the naming function), and tables read from tags.streamtags (legacy read top-level streamtags, always empty). Decide the report-file exclusion set for .crbl content (legacy shipped gap-analysis txt inside every pack) and pin it. GUI-20's unique value (manual per-field grid, add/remove tables, DCR schema autocomplete) folds into Unit 18's review step - the tabbed page does not port; ONE merged inventory screen (legacy had two competing implementations).
- UI: pack inventory (build records, deployed badges per worker group, storage/retention, download .crbl via ArtifactSink, delete with scoped record-id validation - no path semantics).
- Characterization fixtures: golden-file test of the pure tar builder against a Cribl-ACCEPTED reference .crbl (header layout, checksum, dirs-before-files alphabetical, package.json LAST) - zero legacy coverage existed; `IS-T/test-uat-pack-build.ts` structure assertions (sample files contain only _raw + envelope; route.yml references every pipeline; CEF renames) as deterministic core tests; regression Pack Structure notes.
- External surface: policies.yml paths for /packs (upload/install/list), /system/outputs, /lib/breakers, /system/secrets; local host uses the same product API against the leader. Cloud .crbl download depends on the already-verified Blob download spike; cloud inventory favors deterministic regeneration from stored pack definitions over persisting artifact bytes in KV (size limits) - decision recorded below.
- Depends on: Units 17, 18.

#### Unit 20: Guided deploy, source wiring, and air-gap export (L)

- Covers: ENG-10, ENG-35 (deltas), ENG-39 (full multi-source orchestrator), GUI-13, GUI-14, GUI-15, GUI-16; optional ENG-13 delta (live input creation via /system/inputs).
- Legacy sources: SentinelIntegration.tsx 905-1451 + 3171-3451, `IS/e2e-orchestrator.ts` (419), `IS/azure-deploy.ts` 113-227 + 770-893, `IS/pack-builder.ts` 2631-2739.
- New core: the guided deploy usecase generalizing onboardTable - multi-source outer loop with failure isolation, idempotent skip rules ported as tests (azure-tables skip when no _CL; azure-dcrs skip when all destinations exist; build-pack short-circuit; embed vs skip semantics), single-flight guard, per-step JobStore persistence (survives reload; cloud decomposes into per-step calls under 30s; local can run server-side); route-discriminator auto-detection (3 strategies over the candidate field list); pack-name auto version bump; CrowdStrike FDR breaker literal extracted verbatim into core data; destination wiring uses the shared sentinel-destination builder (legacy duplicated a subset inline); DECISION: one secret-placeholder convention - '!{sentinel_client_secret}' reference + ensure-secret step via /system/secrets, with '<replace me>' retained only in air-gap artifacts (test both paths); refresh-destinations endpoint-resolution chain folded into parseDcrDeployment (VERIFY it covers the handler.control.monitor -> ingest.monitor hostname rewrite - test with a handler.control URL); destination records tagged with the producing profile/scope (stale-data hazard); source wiring: Sentinel route (filter `__inputId=='...'`, final:true, position 0) + optional Lake dataset/route (non-final, cloud deployment type only) + commit + deploy-to-groups - the ROUTE ORDER SEMANTICS are the top characterization candidate (regression silently drops data); air-gap export: artifact set (crbl + per-table ARM request bodies from core assets + destination configs + generated README) assembled in memory, delivered as one archive via ArtifactSink (browser Blob on cloud, file on local; local can instead install directly - the stronger air-gap story).
- UI: guided workflow sections 4-6 (Cribl target config, deploy with step lines, wiring with Lake toggle), readiness chips and the sectionDone/canDeploy/deployComplete unlock chain extracted into a PURE tested workflow-state module (it IS the product's guided UX); mode gating (skipAzure/skipCribl).
- Characterization fixtures: new tests for skip rules, unlock chain, route order/final flags, breaker config, discriminator strategies, version bump; vendor-research memoized (legacy called it three times per deploy).
- External surface: policies.yml adds routes read/write, version/commit, master/groups/{g}/deploy, lake datasets, /system/inputs (if live input creation ships); endpoint paths PINNED from the vendored OpenAPI spec - the legacy multi-endpoint fallback guessing arrays do not port.
- Depends on: Units 6, 8, 10, 19.

#### Unit 21: Data-flow validation and capture (M)

- Covers: ENG-29, GUI-17.
- Legacy sources: `IS/auth.ts` 706-1079, `IS-R/components/DataFlowView.tsx` (471).
- New core: 3-strategy capture cascade (samples library fuzzy match -> ad-hoc collection job -> preview capture) with the fuzzy source-name matcher extracted verbatim and per-strategy error accumulation into the composed guidance message (a UX contract); sample-content parsing rules; preview request shape; search job lifecycle (2s poll / 60s cap, synchronous-answer tolerance) restructured so each poll fits the 30s cloud timeout; Lake dataset list/create with 409-is-success.
- UI: DataFlowView as workflow section 7 - two stages (Source capture, Sentinel KQL via Unit 10), health bar, auto-refresh OFF by default under the global polling scheduler; the 4-stage design (Source/After Route/After Pipeline/Destination) recorded as the north star. DECISION: fix the take-then-order KQL quirk to order-then-take, pinned.
- Characterization fixtures: new (fuzzy matcher vectors, cascade composition, zero-events-is-error).
- External surface: policies.yml capture/preview/search/lake paths; 60s captures chunked on cloud.
- Depends on: Units 10, 20.

#### Unit 22: Local-app first-run onboarding completion (M)

- Covers: GUI-03 (delta - consent flow, permission matrix, and preflight shipped in Phases 1-2; Cribl auth manager already exists).
- Legacy sources: `IS-R/pages/SetupWizard.tsx` (676) as prior art for step/skip semantics.
- New core/UI: target chooser (Cribl-hosted vs local, tradeoff table), .tgz packaging/upload walkthrough for the cloud target, leader-connect step for local (base-URL derivation rules and dual-profile swap semantics from legacy, minus the reconnect-with-divergent-overrides bug class - overrides and stored secrets validated together, tested), mode auto-selection rules (hasCribl/hasAzure matrix) with availability-gated mode cards.
- External surface: none new.
- Depends on: Units 1, 2, 9; roadmap places this at Phase 3 exit ("Onboarding GUI completion in local-app first-run").

Phase 3 exit check (roadmap): solution browsed -> samples -> pipeline -> pack -> installed destination end-to-end; Cloudflare pack reproducible through the app. Units 11-22 deliver it.

### Phase 4: Discovery and governance

#### Unit 23: Analytics rule coverage (M)

- Covers: ENG-11, GUI-09.
- Legacy sources: `IS/sentinel-repo.ts` 897-1085 (KQL_BUILTINS, extractKqlFields, listAnalyticRules), `IS/pack-builder.ts` 3176-3307, SentinelIntegration.tsx 2580-2793.
- New core: KQL_BUILTINS (~130 entries) verbatim; extractKqlFields RELOCATED into the analysis module (it lives in the repo adapter today but is domain logic) with the regression suite's vectors re-pointed at the REAL implementation (the legacy tests ran an inline copy with a reduced builtins set - re-verify against the full set); rule acquisition through the Unit 14 content port (three dir-name variants); adopt a real YAML parser AFTER pinning current regex extraction behavior with fixtures (incl. the JS-literal-\Z query-regex quirk and the silent drop of zero-schema-field rules - decide keep-or-surface); coverage math (schema union across all destination tables, case-insensitive availability set, missingFieldsAcrossRules frequency ranking, ruleReferencedFields casing preserved); custom-rule upload parse (dedupe-by-name quirk: fix to allow re-upload, pinned); coverage re-run rules (no stale-skip when mappedDest empty - fix + pin).
- UI: coverage panel (three-way summary, per-rule expandables, severity badges, CUSTOM badge, aggregated missing-fields chips, custom YAML upload/clear); activates the RULE badges in Unit 18's mapping table (the ruleReferencedFields coupling is a kept contract).
- Characterization fixtures: `IS-T/regression.test.ts` KQL Field Extraction block re-pointed; new rule-YAML fixtures from real solutions.
- External surface: reuses Unit 14 entries; per-solution rule fetches batched under the proxy budget with KV-cached parsed AnalyticRule[] per solution+commit.
- Depends on: Units 14, 18.

#### Unit 24: Discovery tools screens (M, scope note)

- Covers: GUI-24 (redesigned). The underlying capabilities are EVH-03..08, VNF-01/02, LOG-16 - outside this plan's ENG/GUI id scope but scheduled by roadmap Phase 4; this unit is the GUI-24 re-delivery: Resource Graph single-query discovery + Cribl Event Hub source creation using the Unit 17 source-types catalog, replacing the PowerShell wrapper page.
- Legacy sources: `IS-R/pages/Discovery.tsx` (drop-list fragment inventory).
- External surface: management.azure.com Resource Graph (existing domain, new resource path); policies.yml /system/inputs.
- Depends on: Units 2, 17; details belong to the Phase 4 discovery features, not this porting plan.

### Roadmap phases 6-7 tail (scheduled there by the roadmap; listed here for coverage completeness)

#### Unit 25: Upstream change detection (M/L) - Phase 6 drift pattern

- Covers: ENG-26, GUI-21.
- Legacy sources: `IS/change-detection.ts` (957), `IS-R/pages/PackBuilder/PackManager.tsx` (alert/diff portions), Sidebar badge.
- New core: hashFields fingerprint primitive; BuildSnapshot model; the change taxonomy + severity policy extracted verbatim as a decision table; comparison algorithm (schema re-parse gated on connector change); recommendation policy; GitHub history mechanics (commits-by-date, compare API with client-side path filtering - prefer per-path commits + tree diff for size); DECISION: ONE hash domain - git blob SHA from the tree API (content need not be fetched to compare), snapshot records which domain they used (legacy mixed sha256-16 and blob SHAs and flagged everything modified across modes); per-pack check errors surfaced distinctly (legacy swallowed them into false negatives); fix the analyticRules fieldCount misnomer (token-count churn metric renamed or fixed). Snapshot captured at Unit 19 build time.
- UI: pack-row badges (SCHEMA CHANGED / UPDATES), diff panel, dismiss; on-demand/on-open checks on cloud, host-scheduled on local (the roadmap's drift pattern).
- External surface: reuses Unit 14 GitHub entries; snapshots/alerts in KV.
- Depends on: Units 14, 19.

#### Unit 26: SIEM migration analyzer (M/L) - Phase 7

- Covers: ENG-40, GUI-22.
- Legacy sources: `IS/siem-migration.ts` (964), `IS-R/pages/SiemMigration.tsx` (359).
- New core: the mapping knowledge bases verbatim as versioned data assets (SPLUNK_MACRO_MAP ~46, SPLUNK_DATAMODEL_MAP, QRADAR_EXTENSION_MAP ~24, SPLUNK_PREFIX_MAP ordered, internal/skip macro sets, isSplunkFilterMacro); parsers (Splunk export shapes, QRadar RFC 4180 state machine); identifyDataSources grouping/merging; fuzzyMapSolutions + enrichWithAnalyticRules over the Unit 14 port; MITRE coverage; MigrationPlan builder. DECISION: fix the data-source key normalization mismatch ([^a-z0-9.] vs [^a-z0-9]) that inflates unmappedRules for dotted identifiers - fix + pin. siem:build-pack does NOT port (dead code; the shipped flow is the deep link into the guided workflow - keep only its table-derivation snippet). Report: decide target format (implementation is styled HTML, catalog says Markdown - correct the catalog; consider shipping both), generated in core, delivered as client-side Blob download in BOTH shells. Content sniffing considered for the extension-only platform detection (pin current behavior first).
- UI: upload, five stat tiles, mapped/unmapped solution cards, MITRE tiles, nested Sentinel-rules browser, deep link `#/?solution=` into the guided flow (regression 'Integration Bridge URL Parsing' cases re-pointed at the real router param handling).
- Characterization fixtures: regression.test.ts CSV/macro/datamodel/merge blocks re-pointed at real core functions; SANITIZED excerpts of the two customer export fixtures (Splunk 1837-rule JSON, QRadar CSV) vendored into the repo - see working agreement, these live only in ~/Downloads today.
- External surface: reuses Unit 14 entries; large exports parsed in memory, only the MigrationPlan persisted to KV.
- Depends on: Units 14, 18 (deep-link target), 23 (rule enrichment).

#### Unit 27: Data-flow monitoring dashboard (M) - Phase 7

- Covers: GUI-18.
- Legacy sources: `IS-R/pages/DataFlow.tsx` (615).
- New core: per-source flow model with merge-preserving refresh; IP-correlation heuristic ported as pure functions with its false-positive bounds documented; destination tables fed from deployed pack/DCR state (FIX the hardcoded CommonSecurityLog); capture-all as bounded-concurrency cancellable jobs (legacy serialized 60s captures with no cancel).
- UI: full-width dashboard (Unit 1's layout escape hatch), per-source rows, side-by-side event comparison labeled best-effort (index pairing is not correlation).
- External surface: reuses Units 10/21 declarations; cloud chunks captures under 30s and drops the 45s auto-refresh for on-demand + staggered scheduling; local host may schedule.
- Depends on: Units 10, 20, 21.

---

## 2. Coverage proof

Disposition of every ENG-01..52 and GUI-01..32. "Unit N" = ported/redesigned in that unit. ALREADY PORTED names the existing new-toolkit module. DROPPED cites the catalog verdict.

| ID | Disposition | Notes |
|---|---|---|
| ENG-01 | Unit 17 | generatePipelineConf as pure builder over PipelinePlan |
| ENG-02 | Unit 17 | reduction KB as versioned data module; suppress maxEvents bug fixed + pinned |
| ENG-03 | Unit 13 (config/routing) + Unit 17 (emission) | overflow map verbatim; missing-overflow-field warning surfaced |
| ENG-04 | Unit 13 | knowledge bases verbatim; legacy tests ported with vendored fixtures |
| ENG-05 | Unit 13 | SchemaCatalog port; bundled pre-extracted schemas; GitHub fallback delta via Unit 14 |
| ENG-06 | Unit 19 | in-memory pack tree; naming contract characterized |
| ENG-07 | Unit 19 | CSV + lookups.yml at default/ pinned |
| ENG-08 | Unit 19 | pure ustar builder only; golden-file vs Cribl-accepted .crbl |
| ENG-09 | Unit 19 | KV/local build records + retention; Cribl API is deployed-status truth |
| ENG-10 | Unit 20 | in-memory artifact set via ArtifactSink |
| ENG-11 | Unit 23 | extractKqlFields relocated to analysis module |
| ENG-12 | Unit 18 | kql-parser + analyzeDcrGap; dual-engine contract formalized |
| ENG-13 | Unit 17 | catalog + inputs.yml verbatim; optional live input creation in Unit 20/24 |
| ENG-14 | Unit 11 | one merged format detector; ParsedSample as shared core model |
| ENG-15 | Unit 11 | capture inner-_raw detection first-class; edge cases become tests |
| ENG-16 | Unit 12 | one canonical PAN-OS dictionary set |
| ENG-17 | Unit 12 | branch order pinned |
| ENG-18 | Unit 11 | TaggedSampleStore port; rawEvents-content-over-declared-format rule |
| ENG-19 | Unit 16 | tier precedence + ID stability characterized |
| ENG-20 | Unit 16 | REDESIGNED: eager prefetch dropped, lazy per-solution fetch + KV TTL |
| ENG-21 | Unit 14 | REDESIGNED: on-demand GitHub + KV cache replaces mirror; accessor surface preserved as port |
| ENG-22 | DROPPED (platform-provided) | crash detection has no target in browser shells; content-filter data sets survive inside Unit 14 as mandatory persistence filter on local disk writes |
| ENG-23 | Unit 14 | one 4-format decoder, three projections; normalizeDcrType consolidated |
| ENG-24 | Unit 15 | VENDOR_REGISTRY verbatim; provenance surfaced |
| ENG-25 | Unit 15 | REDESIGNED: prebuilt index asset + lazy refresh (legacy remote scan was rate-limit-broken) |
| ENG-26 | Unit 25 | one hash domain (git blob SHA); severity taxonomy verbatim |
| ENG-27 | ALREADY PORTED | cloud: platform-provided auth; local: Node host auth manager + encrypted secrets shipped 2026-07-03 |
| ENG-28 | Unit 19/20 (deltas) | base CriblClient exists (walking skeleton); pack upload two-step, routes, breakers, secrets land as deltas; endpoint guessing replaced by OpenAPI-pinned paths |
| ENG-29 | Unit 21 | capture cascade + search lifecycle; poll shape fits 30s cloud cap |
| ENG-30 | Unit 14 | PAT in encrypted KV/host store; proxy header injection; required-and-explained on cloud |
| ENG-31 | Unit 2 (delta) | profiles/config/invalidation/resource-id ALREADY PORTED; discovery + create + enable-Sentinel (eastus bug fixed) are the delta |
| ENG-32 | Unit 10 | new api.loganalytics.io surface; audience-keyed tokens |
| ENG-33 | Unit 6 (+ Unit 5 custom path) | one deploy usecase; templateOnly fixed; PS engine fully replaced by ARM REST |
| ENG-34 | Unit 5 | mapColumnType verbatim; GitHub auto-generation delta after Unit 14 |
| ENG-35 | Unit 20 (deltas) | sentinel-destination + parseDcrDeployment ALREADY PORTED; outputs.yml artifact, refresh flow, profile-tagged records, ensure-secret are the delta |
| ENG-36 | Unit 7 | dcr-naming is single source for preview and match |
| ENG-37 | Unit 8 (runtime) | role-plan/change-request ALREADY PORTED (human path) |
| ENG-38 | Unit 9 (delta) | azure-permissions core ALREADY PORTED; orchestration + Cribl report + combined shape are the delta |
| ENG-39 | Unit 20 (+ Unit 6 batch loop) | inner loop ALREADY PORTED as onboardTable; multi-source orchestrator, skip semantics, resumability are the delta |
| ENG-40 | Unit 26 | mapping KBs verbatim; siem:build-pack dead code not ported |
| ENG-41 | Unit 16 | generateValue table verbatim; Web Crypto; KQL-literal reuse tested |
| ENG-42 | Unit 16 | markers/abbreviations/scoring verbatim; on-demand fetch |
| ENG-43 | Unit 4 | form definitions as core data; merge-preserving save pinned |
| ENG-44 | DROPPED (platform-provided) | KV + bundled core assets replace paths/repo-linking; data-domain taxonomy informs KV namespaces |
| ENG-45 | DROPPED (not-portable) | replaced in spirit by Unit 9 preflight (connectivity/permissions, no host probing) |
| ENG-46 | DROPPED (not-portable) | no generic script runner in either shell (arbitrary-code-execution surface); consumers became REST in Units 2-8 |
| ENG-47 | DROPPED (platform-provided) | KV/config port; config keyed by name, not path |
| ENG-48 | DROPPED (platform-provided) | in-app diagnostics re-provided fresh by Unit 3 Logger port (reimplementation, not a port) |
| ENG-49 | DROPPED (platform-provided) | local host was designed fresh (Phase 1), authenticated/allowlisted - the unauthenticated Express bridge does not port; its fake-IpcMain pattern remains historical evidence only |
| ENG-50 | DROPPED (out-of-scope) | dev harness; its /api/cribl/diagnose probe list reused once while pinning real endpoints in Units 19-21 |
| ENG-51 | DROPPED (platform-provided) | iframe/local-host shells replace Electron; preload.ts kept as the port-interface completeness CHECKLIST |
| ENG-52 | Unit 14 (superseded) | REDESIGNED: startup bulk refresh replaced by lazy per-solution fetch + KV staleness stamps (cloud) and optional host scheduling (local) |
| GUI-01 | Unit 1 | AUA gate; text rewritten for the platform |
| GUI-02 | DROPPED (not-portable) | no host prerequisites; readiness = Unit 9 preflight |
| GUI-03 | Unit 22 (delta) | consent flow + permission matrix + preflight shipped Phases 1-2; target chooser/.tgz walkthrough/leader connect are the delta |
| GUI-04 | Unit 14 | REDESIGNED: PAT settings + lazy per-solution fetch; EDR blocklist UI reduced to content-filter note |
| GUI-05 | Unit 14 | solution browser; deep-link contract preserved |
| GUI-06 | Unit 11 (+ Unit 16 browse modal) | intake, tagging, format preservation |
| GUI-07 | Unit 12 | CSV dialog; batch-queue fix |
| GUI-08 | Unit 18 | mapping review + approval gate; RULE badges activate with Unit 23 |
| GUI-09 | Unit 23 | coverage panel + custom rule upload |
| GUI-10 | Unit 2 | targeting cascade + offline branch |
| GUI-11 | Unit 9 | preflight panel |
| GUI-12 | Unit 7 | resource preview; live-ARM existence truth |
| GUI-13 | Unit 20 | worker groups + pack naming (contract) |
| GUI-14 | Unit 20 | deploy orchestration as JobStore usecase |
| GUI-15 | Unit 20 | air-gap export via ArtifactSink |
| GUI-16 | Unit 20 | wiring + Lake; route-order semantics characterized |
| GUI-17 | Unit 21 | validation widget; 4-stage north star recorded |
| GUI-18 | Unit 27 | monitoring dashboard; CommonSecurityLog hardcode fixed |
| GUI-19 | Unit 19 | ONE merged inventory screen |
| GUI-20 | Unit 19 (folded) | unique value folded into Unit 18 review step; page superseded by guided flow |
| GUI-21 | Unit 25 | badges + diff panel |
| GUI-22 | Unit 26 | report export as client-side download; format decision recorded |
| GUI-23 | DROPPED (not-portable) | PS wrapper; value re-delivered by Units 6/20 |
| GUI-24 | Unit 24 | REDESIGNED: Resource Graph + Cribl source creation |
| GUI-25 | DROPPED (out-of-scope as GUI) | lab capability re-enters via roadmap Phase 5 LAB-* features, not this page; wizard-values-never-written TODO not carried anywhere |
| GUI-26 | DROPPED (not-portable) | PS terminal; in-page job step lines replace its UX role |
| GUI-27 | Unit 1 | validate-before-save JSON editor pattern, KV-backed |
| GUI-28 | Unit 2 | Azure half = profile/workspace switcher; Cribl pill platform-provided on cloud, exists on local via shipped auth manager |
| GUI-29 | Unit 1 | settings; Reconfigure contract kept |
| GUI-30 | Unit 1 | mode-aware nav; one mode source of truth |
| GUI-31 | DROPPED (platform-provided) | SPA + ports replace the bridge; api-client.ts retained as the backend-operation completeness checklist |
| GUI-32 | Unit 18 | analyze-workflow helpers + tests ported verbatim |

Recount: 52 ENG + 32 GUI = 84 ids. Unit-assigned: 42 ENG + 27 GUI = 69. ALREADY PORTED (no unit needed): 1 (ENG-27; partial-already notes on ENG-28/31/35/37/38/39 have their deltas unit-assigned above). DROPPED: 9 ENG (22, 44, 45, 46, 47, 48, 49, 50, 51) + 5 GUI (02, 23, 25, 26, 31) = 14. 69 + 1 + 14 = 84. No id missing.

---

## 3. Compatibility contracts (characterization-pinned)

Per CONTEXT.md invariant 3 and the catalog's compatibility exceptions, these legacy OUTPUTS are the contract - customers have deployed resources with them. Each gets characterization tests recorded from legacy output before its unit merges; everywhere else tests assert the re-derived capability contract, not legacy quirks.

1. DCR/DCE name generation and abbreviation - already characterized (dcr-naming legacy-vectors.json). Units 6/7/8 must route ALL table-to-DCR matching through it (legacy had four drifted fuzzy matchers).
2. Pack naming conventions (Unit 19): vendorPrefix rule (noise-word strip list, first 2 words, 20 chars, 'vendor' fallback); GUI pack name (kebab + '-sentinel'); pipeline `{vendorPrefix}_{suffix}` (_CL strip, sanitize, 25-char cap); `Reduction_` prefix; route ids `route_`/`reduction_`; sample display names; input id. The legacy route/pipeline suffix mismatch is a DEFECT, not a contract - unify and pin the fixed behavior.
3. Destination and stream identity (Units 19/20): destination ids `MS-Sentinel-{Table}-dest`; stream names `Custom-{Table}` (_CL stripped); `Custom-`/`Microsoft-` stream-key normalization both directions.
4. outputs.yml sentinel tuning block (Unit 20): the fixed field set (keepAlive true, concurrency 5, maxPayloadSizeKB 1000, compress true, rejectUnauthorized true, timeoutSec 30, flushPeriodSec 1, onBackpressure drop, scope https://monitor.azure.com/.default, endpointURLConfiguration ID, type sentinel), single-quoted client_id, ingestion URL shape `{dce}/dataCollectionRules/{dcrId}/streams/{stream}?api-version=2021-11-01-preview`.
5. .crbl layout and ordering (Unit 19): package.json at root and LAST in the archive; dirs-before-files alphabetical; `default/` holds pack.yml, breakers.yml, outputs.yml, samples.yml, lookups.yml, pipelines/route.yml, pipelines/{Name}/conf.yml; `data/` holds samples and lookups CSVs; lookups.yml at `default/`, NEVER `data/lookups/`; golden-file test against a Cribl-accepted reference archive (headers, checksum, trailer).
6. Lookup CSV format (Unit 19): fixed 8-column header, quote-and-double escaping rule, registry entry shape.
7. Cribl-safe YAML rules (Unit 17, as a core validator): no `description: >` blocks, no double-quoted descriptions, no colon+space or '=' in unquoted descriptions, no tabs, unquoted field names in rename/add/remove, route key `filter:` never `condition:`.
8. Log Analytics type maps (Units 5/14): mapColumnType and the consolidated normalizeDcrType superset - these values are an ARM tables-API contract; custom-table retention defaults 30/90.
9. SYSTEM_COLUMNS filter set (Unit 13): the 17/18-entry Azure system-column exclusion (TenantId ... EventOriginId) - schema oracles must keep filtering exactly this set.
10. Sample-file envelope (Unit 19): pack sample events contain ONLY `_raw` + envelope keys (_time, source, sourcetype, host, index); pipeline serde re-extracts from _raw.
11. Breaker knowledge (Units 19/20): json_array/json_newline breaker rules; CrowdStrike FDR breaker (maxEventBytes 786432, timestampAnchorRegex, %s%L format).
12. Reduction-rules KB semantics (Unit 17): filters address RAW vendor field names and run BEFORE rename; null-safe `(field || '')` expression style preserved in any port.
13. Naming inputs from workflow state (Units 18/20): mappingEdits keyed by logType; overflow contributes source AND dest to rule-coverage availability; deep-link `#/?solution=` param contract.
14. Vendor registry key derivation (Units 15/25): normalized vendor key (lowercase, non-alnum to '_') - cross-module lookup contract inside the app.

Fixture-rescue list (assets that exist only outside the repo today; capture before the legacy environment is lost): `packs/vendor-samples/crowdstrike-fdr/` corpus (272KB, 10 files); a Cribl-accepted reference .crbl; CrowdStrikeCustomDCR.json and a Process-Events sample slice; sanitized excerpts of Splunk_Export_Migration_Demo.json (1837 rules) and QRadar_Export_Demo.csv from ~/Downloads; checkCriblYaml rule set from test-uat-pack-build.ts; connector JSONs covering all four schema formats; the ~120 pre-extracted DCR template schemas.

---

## 4. Working agreement

Each unit lands through the established loop:

1. Mine and decide first: re-read the digest's edge cases for the unit; every flagged legacy defect gets an explicit fix-vs-preserve decision recorded in the unit's PR description (defaults chosen in this plan: fix + pin for suppress maxEvents, route/pipeline suffix mismatch, streamtags read, enable-Sentinel location, templateOnly forwarding, first-workspace query, CSV batch drop, rename re-keying, normalization mismatch, take-then-order; preserve + pin for anything a deployed artifact depends on).
2. Core first: pure domain module(s) in packages/core with contract tests; characterization tests where section 3 names a contract; fixtures vendored into the repo (never %APPDATA%/Downloads/machine state; skipIf-gated tests are not characterization).
3. Both shells in the same increment: adapters bound in apps/cribl-app AND apps/local-app; parity is the gate (roadmap standing gates). Long operations are polled JobStore jobs; each cloud request fits 30s; batches respect the 100 req/min budget through the shared scheduler.
4. External surface in the same PR: proxies.yml/policies.yml (cloud) and the local-host allowlist change with the feature (invariant 4). New Azure-facing proxy entries always carry the Origin-suppressing header allowlist.
5. Adversarial verify before merge: drive the affected flow end-to-end in at least one shell (live where feasible, as the Phase 1 slice was verified live); code review at high effort for units touching contracts (17, 19, 20); CI gates (lint, typecheck, test, build, boundary lint) green.
6. One reviewable increment = one unit = one PR/commit train; no unit starts before its dependency units merge.
7. Legacy stays untouched and runnable as the fallback throughout. When a unit family completes a catalog domain in BOTH shells, mark that domain superseded in feature-catalog.md (strangler-fig plan); archival only at roadmap Phase 7 parity audit.
8. Documentation: CONTEXT.md per package and ADRs updated when a unit changes boundaries or records a cross-cutting decision (secret placeholder convention, JobStatus 'skipped', hash domain, report format are ADR-worthy). Catalog corrections found during mining (ENG-25 scans remote not mirror; GUI-22 emits HTML not Markdown) are applied to the catalog when the owning unit lands.
9. No emojis anywhere; commit messages follow repo guidelines.

Immediate pre-work (before Unit 11 at the latest): execute the fixture-rescue list from section 3 while the legacy environment still exists.

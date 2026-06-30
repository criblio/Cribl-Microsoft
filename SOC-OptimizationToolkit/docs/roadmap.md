# Roadmap — SOC-OptimizationToolkit

The canonical execution plan. Eleven phases (0-10), strangler-fig, with the old app as the fallback
the whole way through ([adr/0006](adr/0006-strangler-fig-with-old-app-as-fallback.md)). Each phase has
a goal, the capabilities it moves, deliverables, an exit criterion, and the dominant risk.
Capabilities are ported by reimplementation with a characterization test recorded from the legacy
behavior FIRST ([testing-strategy.md](testing-strategy.md)).

This roadmap covers the **complete repository capability census** in [../CONTEXT.md](../CONTEXT.md) —
every directory, not just the integration app. The destination is always Microsoft Sentinel; the
variety is on the **source** side (Cribl Stream is the pipe). The shape:

- **Phases 0-6** — the Sentinel destination pipeline (DCR/tables/Cribl-to-Sentinel) and the desktop
  GUI (the bulk of the existing app).
- **Phase 7** — the adjacent Azure subsystems (lab automation, Azure-LogCollection policy). Discovery
  lands earlier, in Phase 5.
- **Phase 8** — broaden sources: an **AWS source connector** (S3/SQS/Kinesis/CloudWatch) feeding
  Cribl -> Sentinel ([adr/0008](adr/0008-sentinel-destination-pluggable-sources.md)).
- **Phase 9** — the autonomous AI schema-drift engine
  ([adr/0009](adr/0009-ai-assisted-pack-generation.md)).
- **Phase 10** — enrichment lookups, identity (O365/Entra) preflight, reporting (PowerBI/Cribl
  Search), and the prebuilt pack library; final promotion.

Sequencing logic: lay the gated foundation first (with the **Sentinel destination ports and a
pluggable `SourceConnector` port designed up front**); carve the cheapest pure IP; attack the two
standing liabilities (the Cribl client, the Azure-via-PowerShell path) before the expensive DCR engine;
unify orchestration and ship the CLI (with discovery); then the heaviest format-coupled modules and the
rest of the GUI; then adjacent Azure subsystems; then broaden sources (AWS source connector); then the
AI engine; then enrichment/identity/reporting; promotion last. The Sentinel destination is built first
because it is the constant in every flow and the bulk of the product; AWS is added as a source once the
`SourceConnector` seam is proven.

Effort note: this is now an L-to-XL initiative (the AWS source connector plus an AI engine expanded the
scope). The value is that it ships incrementally — every phase leaves the product working, because the
old app and the standalone scripts keep running anything not yet cut over.

**Build strategy — vertical slices, not horizontal layers
([adr/0010](adr/0010-vertical-slices-walking-skeleton-gui-last.md)).** Core-first, but never the whole
core in isolation. Phase 1 is a **walking skeleton**: one onboarding thread working end-to-end through
core + minimal real adapters + a minimal CLI **and one thin GUI screen**, so the ports are validated
against real callers before anything is thickened. Phases 2-5 then **thicken** the layers the skeleton
stubbed, each delivered as its own vertical slice (a capability working end-to-end via the CLI _and_ a
thin GUI screen before moving on). Two thin consumers, different jobs: the **CLI** is the automation/CI
backbone; the **GUI grows in tandem** as the manual/exploratory surface (launchable from source via
`Start-App-Windows.bat`). The GUI stays a thin shell (zero logic, boundary-rule enforced). The
_polished, complete_ GUI is finished last (Phase 6) — by then most screens already exist as thin
shells. "UI first" (a thick UI up front) is rejected; a thin GUI in tandem is adopted.

---

## Phase 0 — Scaffold the fresh tree + CI skeleton

**Goal:** make every future slice gated and reviewable before any logic moves; stand up the infra
that does not exist today. No behavior change to the old tree.

**Capabilities migrated:** none (scaffolding only).

**Deliverables:**

- `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, TypeScript project references.
- GitHub Actions skeleton (lint/typecheck/unit parallel; integration -> build -> package) with
  branch-protection required checks on `main` ([ci-cd.md](ci-cd.md)).
- Husky + lint-staged + pre-commit hooks; ESLint with the hexagonal boundary rule (including
  `apps/desktop` may hold no business logic); Prettier.
- The from-source launchers `Start-App-Windows.bat` + `Start-App-macOS.sh` (already present in the
  toolkit root) wired to `pnpm --filter desktop dev`, so the thin GUI is double-click launchable the
  moment Phase 1's screen exists. From source, not a packaged `.exe`, to avoid EDR false positives.
- The documentation set: `CONTEXT.md`, `architecture.md`, ADRs 0001-0010, `testing-strategy.md`,
  `ci-cd.md`, this roadmap.
- Empty `packages/core` + `adapters-*` (azure, aws, cribl, fs, infra, ai, identity, reporting) +
  `packages/shared-config` + `apps/*` shells wired into the build graph.
- **Destination + source port signatures defined up front**: the Sentinel destination ports
  (`SentinelClient`, `DcrDeployer`, `SchemaStore`, `PolicyClient`) and a pluggable `SourceConnector`
  port, even though only Azure/Sentinel adapters are implemented in Phases 3-4 — designing the
  `SourceConnector` seam now means adding the AWS source in Phase 8 is a new adapter, not a refactor
  ([adr/0008](adr/0008-sentinel-destination-pluggable-sources.md)).
- Copy the ~100 ARM templates into `packages/core/assets/arm-templates/` and the prebuilt packs
  (`packs/*.crbl`) into `packages/core/assets/cribl-packs/`.

**Exit criteria:** CI is green on `main` with all required checks; the empty shells build and run; a
trivial pure function imported from `packages/core` proves the wiring end to end;
`Cribl-Microsoft_IntegrationSolution/` and `Azure/` are byte-for-byte unchanged.

**Risk:** pure greenfield infra ships no user value; mitigate by time-boxing it and forbidding any
module extraction until this phase is green.

## Phase 1 — Walking skeleton (one onboarding thread end-to-end), then carve the pure core

**Goal:** prove the architecture against a real caller before thickening anything
([adr/0010](adr/0010-vertical-slices-walking-skeleton-gui-last.md)). Build the thinnest _real_
end-to-end onboarding thread first; only then continue carving the cheap pure IP.

**Part A — the walking skeleton (do this first).** Pick one simple thread: onboard a single native
source (e.g. `CommonSecurityLog`) as a Direct DCR. Build:

- a thin `OnboardSource`/`DeployDcrs` usecase in `packages/core` with just the domain it needs (DCR
  name abbreviation, `ConvertTo-DCRColumnType`, the field-match for that one source);
- a **minimal real** `adapters-cribl` (create one Sentinel destination) and `ArmDcrAdapter` (deploy
  one Direct DCR via `@azure/arm-monitor`/`arm-resources`);
- **two thin frontends over the one usecase**: a minimal `dcr deploy` command in `apps/cli`, **and one
  thin screen in `apps/desktop`** (a form that runs the thread and renders the `ProgressSink` stream),
  launchable from source via `Start-App-Windows.bat`.

Run it green end-to-end against a throwaway Sentinel workspace, from both the CLI and the GUI. This is
real ammunition, one shot: it validates `OnboardSource`, the `SourceConnector`/destination/`CriblClient`
ports, the composition root, the `ProgressSink` + `window.api` IPC contract, and the test harness
(fakes + one live smoke) before any layer is thickened. The minimal adapters, CLI, and GUI screen here
are intentionally thin — Phases 2-5 harden them, and the GUI grows one thin screen per later slice.

**Part B — carve the rest of the cheap pure IP.** With the ports proven, move the remaining
already-pure logic into `packages/core` behind them: the full field-matcher 6-phase cascade,
sample-parser format detection + inner-`_raw` re-parse, kql-parser parse/gap/route, reduction-rules KB,
source-types, and the full DCR naming/column/disambiguation. Extract pure functions in place from
their IO-mixed sources (the `analyze-workflow.ts` pattern) **before** relocation; collapse the
triplicated Naming/Output/Menu helpers to one core implementation.

**Deliverables:** the green end-to-end skeleton thread driven from both frontends (CLI **and** one thin
GUI screen -> core -> Cribl + DCR -> Sentinel), launchable via `Start-App-Windows.bat`; the pure-core
domain modules + exhaustive unit tests (multiplying the existing `field-matcher.test.ts` /
`sample-parser.test.ts`); characterization tests recorded from legacy behavior FIRST.

**Exit criteria:** the skeleton onboards one source end-to-end from **both** the CLI and the GUI (one
live smoke + replayable contract test); the GUI is a thin shell with zero business logic (boundary-rule
green); all ported functions have legacy-recorded characterization tests passing; per-glob coverage
gate active on `packages/core`; the old app and `Azure/` are untouched.

**Risk:** the temptation is to fully build a layer before the thread works — resist it; the skeleton
must be end-to-end first. Most pure modules are refactors with regression surface, not clean moves;
mitigate with extract-then-move and behavior-pinning tests before relocation.

## Phase 2 — De-risk the Cribl client (adopt SDK + vendor overrides)

**Goal:** thicken the skeleton's minimal `adapters-cribl` into the hardened client — replace the
hand-rolled Cribl REST surface in `auth.ts` with the official Cribl TS SDK plus a generated client,
keeping the load-bearing overrides as a separate vendored layer — tackling the permanent-ownership
liability early, not last.

**Capabilities:** Cribl auth (cloud OAuth + self-managed login, token cache); create/list Sentinel
destinations; upload + install `.crbl` packs (PUT-then-install conflict-delete-retry); list
workspaces/worker-groups/sources/routes; the `Keystore` port.

**Deliverables:** `adapters-cribl` (official TS SDK + generated client + non-generated override shim);
the Cribl paths delegate to the `CriblClient` port; MSW cassette contract tests + override snapshot
tests; client pinned and vendored, regeneration never auto-run into the build.

**Exit criteria:** all Cribl operations route through the port; a contract test proves the fake
matches real `/packs` + outputs; a load-bearing-shape change in regeneration fails CI loudly.

**Risk:** official Cribl SDKs are Preview/pre-1.0 and can drift on any release; mitigate by pinning
exact versions, gating upgrades behind a contract-test refresh, and keeping the override shim as the
supported path until the SDK reaches >= 1.0 ([adr/0007](adr/0007-adopt-official-cribl-ts-sdk-with-override-shim.md)).

## Phase 3 — Replace the Azure-via-PowerShell auth/session path

**Goal:** thicken the skeleton's minimal Azure adapter into the full auth/session path — build
`adapters-azure` on `@azure/identity` + `@azure/arm-*` and route the auth/session/schema/KQL flows off
PowerShell, eliminating stdout-scraping and the visible-window login.

**Capabilities:** Azure connection/token lifecycle (`DefaultAzureCredential`/
`InteractiveBrowserCredential`); list subscriptions/workspaces/resource-groups, set context; create
RG + Log Analytics workspace, enable Sentinel; table schema retrieval + `Get-TableColumns`
disambiguation; KQL over `@azure/monitor-query`; permission/can-deploy pre-flight.

**Deliverables:** `adapters-azure` implementing `AzureClient` + `SchemaStore`; the Azure auth and
permission-check flows routed through the port; Azure SDK test-proxy record/replay cassettes
(sanitized) for these calls.

**Exit criteria:** no PowerShell spawn for auth/session/schema/KQL; the visible `Connect-AzAccount`
window and the token-scrape hack are gone; replayed cassettes pass offline.

**Risk:** net-new code (`azure-deploy.ts` has 0 `@azure` imports); dynamic Azure shapes can slip past
TS types; mitigate with zod boundary validation and test-proxy fidelity.

## Phase 4 — Strangle the DCR deploy engine, mode by mode

**Goal:** thicken the skeleton's single Direct DCR into the full engine — extend `ArmDcrAdapter` behind
the `DcrDeployer` port and cut over one mode at a time while the old app stays the fallback; reuse the
ARM templates unchanged.

**Capabilities:** Direct DCR creation (30-char); DCE-based DCR + DCE + AMPLS/Private Link wiring
(64-char); custom table (`_CL`) creation + MMA -> DCR migration; Cribl Sentinel destination export
(`logsIngestion` read-back + `Fix-HandlerControlEndpoint`).

**Deliverables:** `ArmDcrAdapter` on `@azure/arm-monitor`/`arm-operationalinsights`/`arm-resources`;
ordered cutover `DirectNative -> DCE+AMPLS -> custom/_CL`, each behind a recorded cassette contract
test + one live smoke deploy into a throwaway RG; the old app remains the deploy path for any
not-yet-cut-over mode.

**Exit criteria:** each mode reaches parity (cassette + live smoke) before it is declared
production-ready in the new tree; ARM templates submitted unchanged via `@azure/arm-resources`.

**Risk:** this is the documented strangler-stall point and the hardest re-encode (AMPLS ordering,
`logsIngestion` not surfaced by cmdlet, reserved-column 400s, MMA migration). **Hard kill-criteria:**
if a mode misses parity by its time-box, users keep the old app for that mode — partial cutover is an
acceptable terminal state, not an open-ended dual runtime
([adr/0006](adr/0006-strangler-fig-with-old-app-as-fallback.md)).

## Phase 5 — Unify the orchestration spine, add discovery, and grow the CLI

**Goal:** grow the thin skeleton CLI from Phase 1 into the full command surface, and broaden the
single onboarding thread into the complete e2e orchestrator — move the onboarding state machine into a
full core `OnboardSource` usecase with an injected `ProgressSink`; add source discovery (which feeds
onboarding); and retire the `-NonInteractive` PowerShell entry point.

**Capabilities:** e2e onboarding orchestrator (research -> custom tables -> deploy DCRs ->
build/locate pack -> embed destinations -> create Cribl destinations -> upload `.crbl`, idempotent);
**discovery** (Event Hub discovery via Resource Graph + vNet Flow Log discovery -> generate Cribl
configs, surfaced in the Discovery page and the `discover` CLI command); the DCR automation menu
(replaced by oclif commands).

**Deliverables:** core `OnboardSource` usecase with a pluggable `ProgressSink` (CLI stdout / GUI
`BrowserWindow` / service SSE share one spine); core `DiscoverSources` usecase on
`@azure/arm-resourcegraph` (ported from `Azure/dev/EventHubDiscovery/` and the vNetFlowLogDiscovery
tools); `apps/cli` (oclif): `dcr deploy --mode`, `pack build`, `onboard`, `discover`; the Discovery
page wired in `apps/desktop`; CI uses the CLI instead of `Run-DCRAutomation.ps1 -NonInteractive`.

**Exit criteria:** CLI smoke (`TemplateOnly`) green in CI; `OnboardSource` idempotency/skip semantics
pinned by integration tests against fakes; `DiscoverSources` returns the same source set as the
legacy discovery tools (characterization test); GUI and CLI drive identical transitions.

**Risk:** a subtle idempotency divergence could create duplicate DCRs/destinations in a tenant;
mitigate with full-sequence integration tests asserting skip logic before retiring the PS entry
point. Discovery's Resource Graph queries are pinned with test-proxy cassettes.

## Phase 6 — Heaviest modules and the polished desktop GUI

**Goal:** port the most IO/format-coupled modules, and **polish the desktop GUI to feature-complete**.
The GUI has been growing one thin screen per slice since Phase 1, so this is **polish plus porting the
last remaining real pages**, not building the GUI from zero — it is mechanical onto a core fully proven
by the CLI and the thin GUI screens ([adr/0010](adr/0010-vertical-slices-walking-skeleton-gui-last.md)).
The old GUI has covered users the whole time, so feature-completeness lands here without pressure.

**Capabilities:** pack-builder (`.crbl` custom tar + deep Cribl pipeline-conf YAML, CrowdStrike
breaker special-casing); sample-resolver tiered acquisition; vendor-research schema-fetch engine;
change-detection drift snapshots; ContentRepo (Sentinel selective-fetch + EDR blocklist) +
registry-sync finalized in `adapters-fs`; the remaining React pages completed in `apps/desktop`
(Settings, SetupWizard, DataFlow lineage view, DepsCheck) plus the `CheckReadiness` usecase behind
DepsCheck (`deps.ts` + `permission-check.ts`); `param-forms` finalized in `packages/shared-config`.

**Deliverables:** pack-builder + sample-resolver + vendor-research moved into `core`/`adapters-fs`
behind ports (pure sub-parts extracted first); golden-file + contract tests on the `.crbl` emitter
(byte-pinned against legacy output); the full desktop GUI ported; `CheckReadiness` covering
dependency + permission preflight.

**Exit criteria:** pack-builder/sample-resolver/vendor-research fully ported with golden + contract
coverage; all 12 GUI pages present and functional in `apps/desktop`; no PowerShell on the host for
any core onboarding flow.

**Risk:** pack-builder (~3307 lines) and sample-resolver (~1873 lines) are the heaviest, most
format-coupled ports and resist clean decomposition. **Decision checkpoint:** if Phase 6 re-encoding
exceeds the combined effort of Phases 1-5, freeze and ship the new tree for everything it already
covers while the old app keeps handling the remainder — the strangler is allowed to stop.

## Phase 7 — Adjacent Azure subsystems; retire the integration app

**Goal:** port the two adjacent Azure subsystems that are pure-Azure (lab automation,
Azure-LogCollection policy) so the **integration app** reaches full parity and can be retired.
(Discovery landed in Phase 5; windows-schema-sync is its own AI engine in Phase 9.)

**Capabilities:**

- **Lab automation** — provision self-contained Azure test environments (VNet/NSG/Storage/VMs/
  monitoring) and seed sample data, from `Azure/Labs/UnifiedLab/`, `Azure/Labs/AzureFlowLogLab/`,
  `Azure/dev/LabAutomation/` and the LabAutomation page.
- **Azure-LogCollection** — policy-driven log-collection automation (Azure Policy + Event Hub
  architecture), from `Azure/Azure-LogCollection/`.

**Deliverables:**

- `core/usecases/ProvisionLab` + `adapters-infra` (`InfraProvisioner`): the lab orchestration logic
  lives in the core usecase; the actual infra is **Bicep/Terraform invoked through the adapter**, not
  hand-rolled ARM in the core. Surfaced in the LabAutomation page and a `lab` CLI command. (The
  `InfraProvisioner` built here is the same one AWS labs reuse in Phase 8.)
- `core/usecases/ConfigureLogCollection` + `adapters-azure` (`PolicyClient` on
  `@azure/arm-policyinsights`).
- Characterization tests for each subsystem recorded from the legacy scripts first.

**Exit criteria:** both subsystems reach parity with their characterization tests green; **the
integration app `Cribl-Microsoft_IntegrationSolution/` is now fully replaced and is retired** — every
one of its GUI pages and IPC handlers has a home in the new tree. The standalone Azure/Dev tools
covered by Phases 8-10 keep running until their phases complete; final repository archival is at
Phase 10.

**Risk:** lab automation is infra-heavy and the slowest to validate (real Azure deploys); it is
sequenced here deliberately so a stall never blocks the core product. **Kill-criteria:** if a
subsystem cannot reach parity by its time-box, users keep the old PowerShell script for that
subsystem — partial parity is acceptable, consistent with
[adr/0006](adr/0006-strangler-fig-with-old-app-as-fallback.md).

## Phase 8 — Broaden sources: the AWS source connector

**Goal:** add an **AWS source connector** behind the `SourceConnector` port designed in Phase 0, so
AWS data flows AWS -> Cribl -> Sentinel through the same `OnboardSource` usecase. The destination
stays Sentinel; AWS is a source ([adr/0008](adr/0008-sentinel-destination-pluggable-sources.md)).

**Capabilities:** AWS source onboarding — S3 + SQS event notifications, Kinesis Data Streams/Firehose,
CloudWatch Logs, IAM roles for Cribl auth; auto-generated Cribl **source** configs that feed the
Sentinel destination; AWS lab provisioning via Terraform (sample-data generation).

**Deliverables:** `adapters-aws` implementing `SourceConnector` with the AWS SDK for JS v3; the AWS
Cribl source-config shaping rules ported into `core/domain` (from
`Dev/AWS/Labs/AWSIntegrationLab/Core/Generate-CriblConfigs.py` + `helpers/naming_engine.py`) with
characterization tests; AWS lab Terraform wired through `adapters-infra`; the desktop GUI and CLI gain
an AWS source option; AWS SDK client fakes + recorded-response contract tests.

**Exit criteria:** onboarding an AWS source runs through the SAME `OnboardSource` usecase and lands in
Sentinel (proving the `SourceConnector` seam works without touching the destination,
[adr/0008](adr/0008-sentinel-destination-pluggable-sources.md)); generated Cribl source configs match
the legacy Python output (characterization test); `Dev/AWS/` is retired.

**Risk:** the `SourceConnector` abstraction could be too thin for a source as rich as AWS (S3+SQS vs
Kinesis vs CloudWatch differ a lot); keep source-type specifics in the AWS adapter rather than forcing
them into the shared port. Validate against a real AWS account in a throwaway environment before
retiring `Dev/AWS/`.

## Phase 9 — Autonomous AI schema-drift engine

**Goal:** port `windows-schema-sync` — the AI-powered monitor -> detect-drift -> generate-pack ->
GitOps loop — behind the `AiClient` port, with its non-determinism quarantined
([adr/0009](adr/0009-ai-assisted-pack-generation.md)).

**Capabilities:** schema monitoring (Windows Security Events from MS docs + Sentinel SecurityEvent
table); drift detection; AI-assisted Cribl pack generation/update; GitOps commit/PR; cost tracking;
the deterministic deploy helpers (`Deploy-AMA`, `Deploy-KeyVault`, `Deploy-Sentinel`, `Deploy-DCRs`,
`Deploy-IncrementalOnboarding`, `Sync-SchemaFromAzure`, `Compare-TableData`).

**Deliverables:** `core/usecases/{MonitorSchemaDrift,GeneratePackWithAI}` (drift detection is
deterministic; only generation/extraction call the LLM); `adapters-ai` (Anthropic) with the embedded
prompts ported as versioned assets + golden-output tests; GitOps via `ContentRepo`; AMA/KeyVault deploy
via `adapters-azure`; cost tracking ported; a human-review PR gate before any generated pack deploys.
**Implementation choice (recorded as an ADR addendum):** port the Python intelligence to TS, or wrap
it as a sidecar behind `AiClient` — decide before the work starts based on prompt/logic complexity.

**Exit criteria:** drift detection is deterministic and tested; AI output is always validated (parses

- passes pack contract tests) with retry + last-known-good fallback; generated packs land via PR, not
  auto-deploy; cost bounded and tracked; `Azure/dev/windows-schema-sync/` is retired.

**Risk:** non-deterministic LLM output in a determinism-based test strategy; mitigate by faking
`AiClient` with recorded responses, golden-output prompt tests, and mandatory deterministic validation
of every generated artifact. External paid dependency (Anthropic) — pin the model, cache extractions.

## Phase 10 — Enrichment, identity, reporting, pack library, and final promotion

**Goal:** port the remaining standalone capabilities and complete the repository consolidation.

**Capabilities:**

- **Enrichment lookups** — AD via LDAP -> CSV -> Cribl Cloud lookup -> commit/deploy
  (`Lookups/DynamicLookups/ActiveDirectory/`); static lookups (`Lookups/StaticLookups/`).
- **Identity preflight** — O365/Entra app-registration validation
  (`KnowledgeArticles/O365AppRegistrationForCribl/`).
- **Reporting** — PowerBI + Cribl Search (`KnowledgeArticles/PowerBI_CriblSearch/`).
- **Prebuilt pack library** — ship and install `packs/*.crbl` and the Azure_vNet_FlowLogs pipelines.

**Deliverables:** `core/usecases/SyncLookup` + `adapters-fs` (`LookupSource` LDAP) + `adapters-cribl`
lookup upload; static lookups as `core/assets/lookups/`; `core/usecases/ValidateAppRegistration` +
`adapters-identity` (Microsoft Graph); `core/usecases/ExportToReporting` + `adapters-reporting`; the
prebuilt pack library installed through `adapters-cribl`. Characterization tests recorded from the
legacy Python/PS first.

**Exit criteria (final promotion):** all four capability groups reach parity with tests green;
**`Azure/`, `Dev/`, `Lookups/`, and the migrated `KnowledgeArticles/` tools are archived** (kept for
reference, not run). The new tree is the whole product.

**Risk:** these are smaller and lower-risk; the main pitfall is treating the AD lookup attribute set
or the O365 Graph permission set as incidental — they are preserve-verbatim assets
([../CONTEXT.md](../CONTEXT.md) section 6). **Kill-criteria** per [adr/0006](adr/0006-strangler-fig-with-old-app-as-fallback.md)
apply: a subsystem that misses parity keeps its standalone script.

## Future extension points (cataloged, not scheduled)

Designed-for but not yet scheduled; each fits the existing architecture without reshaping it:

- **Microsoft Fabric RTI** (`Azure/dev/FabricRTI/`, empty) — a possible future _alternative
  destination_ (Microsoft Fabric Real-Time Intelligence). Would add a second destination adapter
  alongside the Sentinel one; Sentinel stays primary. Not built until needed
  ([adr/0008](adr/0008-sentinel-destination-pluggable-sources.md)).
- **Sentinel pack library** (`Azure/SentinelPacks/`, empty) — additional entries in
  `core/assets/cribl-packs/`.
- **Home lab** (`Dev/HomeLab/`, empty) — a future profile under `ProvisionLab`.
- **Reference docs** (`KnowledgeArticles/AzureMonitorMigration/`, `PrivateLinkConfiguration/`,
  `Azure/Diagrams/`) — migrate into `docs/`; the underlying logic (MMA migration, AMPLS) is already
  covered in Phase 4.

---

## Cross-cutting risks (carried through every phase)

1. Permanent ownership of the Cribl client (no first-party-forever JS/TS SDK).
2. The DCR engine is net-new code, not a transliteration.
3. Two-tree drift while the old tree keeps changing — freeze it as read-only reference.
4. `auth.ts` is large, security-sensitive, and WIP — land + freeze it first, then port; not earliest.
5. TS structural-typing leaks on cloud shapes — zod at adapter boundaries.
6. Characterization-test inversion — capture golden from legacy FIRST.
7. Solo-maintainer key-person risk — `CONTEXT.md` + ADRs keep it navigable and auditable.
8. Mistaking sources for destinations — the destination is always Sentinel; AWS and other clouds are
   sources behind `SourceConnector`. Do not abstract Sentinel into a "generic cloud destination"
   ([adr/0008](adr/0008-sentinel-destination-pluggable-sources.md)).
9. Non-deterministic AI output in a determinism-based test strategy — isolate behind `AiClient`,
   validate every artifact deterministically, gate deploys behind a human PR
   ([adr/0009](adr/0009-ai-assisted-pack-generation.md)).
10. Scope is now L-to-XL — the incremental, old-tree-as-fallback sequencing is what keeps it shippable
    rather than a big-bang; honor the per-phase kill-criteria so a late phase can stop without
    stranding the product.

Full mitigations for each are in the linked ADRs and [testing-strategy.md](testing-strategy.md).

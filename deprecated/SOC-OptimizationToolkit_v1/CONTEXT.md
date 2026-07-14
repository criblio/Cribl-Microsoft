# CONTEXT — SOC-OptimizationToolkit

Read this first. It is the map a new engineer (or an AI agent) reads before editing anything in
this directory. It defines the product, the language we speak about it, the layered structure, and
the exact place every existing capability is ported FROM and lands TO.

This directory is built **greenfield**. It is self-contained from day one and has no runtime
dependency on the rest of the repository. The existing `Cribl-Microsoft_IntegrationSolution/`
(Electron/TypeScript app) and `Azure/` (PowerShell automation) trees are the **running product and
the behavioral reference** we port logic FROM, file by file. They are never modified by work in
this directory. They are retired only when this tree reaches parity (see
[docs/roadmap.md](docs/roadmap.md) Phase 6).

> No emojis anywhere in this repository. See the repository-root CLAUDE.md.

---

## 1. What this product is

One production-ready application that consolidates **every capability in this repository** — the
Electron app, the Azure PowerShell automation, and the standalone tools under `Azure/`, `Dev/`,
`Lookups/`, `packs/`, and `KnowledgeArticles/`. It is a **Microsoft Sentinel SOC Optimization
Toolkit**.

**The destination is always Microsoft Sentinel.** Every flow lands data in a Sentinel / Log Analytics
workspace via Data Collection Rules. **Cribl Stream is the pipe in the middle.** The variety is on the
**source** side: data is collected from many places — Azure native, **AWS** (S3/SQS/Kinesis/CloudWatch),
Event Hub, vNet Flow Logs, O365, on-prem — routed through Cribl Stream, shaped to the Sentinel table
schema, and ingested. References to "other clouds" (AWS, etc.) are **data sources feeding Cribl ->
Sentinel**, never alternative destinations.

What it does:

- **Onboard a data source end to end** — research the vendor, configure the source collection (incl.
  cloud sources like AWS), create the Sentinel/Log Analytics tables, deploy the Azure Data Collection
  Rules, build and install the Cribl pack, and wire the Cribl-to-Sentinel destination.
- **Source connectors** — pluggable: AWS (S3/SQS/Kinesis/CloudWatch + IAM for Cribl auth), Event Hub,
  vNet Flow Logs, O365. Each generates the Cribl **source** config that feeds the one Sentinel
  destination.
- **Discovery** of sources (Event Hub, vNet Flow Logs).
- **Enrichment** via lookups (Active Directory -> Cribl Cloud, static lookups).
- **Identity prerequisites** (O365/Entra app-registration validation for Cribl collection).
- **Autonomous schema-drift onboarding** (AI-assisted: monitor source + Sentinel schemas, generate
  Cribl packs with Claude, commit via GitOps).
- **Reporting** (PowerBI + Cribl Search).
- **Lab automation** (Azure + AWS test environments that generate sample source data) and a
  **prebuilt Cribl pack library**.

It is exposed through a desktop GUI, a CLI, and an optional local service.

It is structured as a **core engine plus thin frontends**: a pure, fully-tested domain core that
holds all the business logic, a set of typed adapters that talk to the outside world (Microsoft
Sentinel/Azure, Cribl, AWS and other source connectors, Microsoft Graph, the Anthropic API, the
filesystem/GitHub), and three frontends that are little more than wiring. The destination side is
**Sentinel-specific**; the source side is **pluggable** behind a `SourceConnector` port, so adding a
new data source (AWS, etc.) is a new adapter, never a change to the Sentinel destination logic (see
[ADR 0008](docs/adr/0008-sentinel-destination-pluggable-sources.md)).

## 2. Ubiquitous language

These terms mean exactly one thing across code, tests, docs, and commit messages.

| Term                      | Meaning                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **DCR**                   | Azure Data Collection Rule. The object that routes and transforms ingested logs into a Log Analytics table.                           |
| **Direct DCR**            | A DCR ingested into directly (Cribl `Kind:Direct`), 30-character name limit.                                                          |
| **DCE**                   | Data Collection Endpoint. Fronts DCR ingestion for advanced routing; raises the name limit to 64 chars.                               |
| **AMPLS**                 | Azure Monitor Private Link Scope. Private-network wiring for DCE/Log Analytics; order-sensitive to create.                            |
| **`_CL`**                 | Custom Log table suffix. Any customer-defined table name must end in `_CL`.                                                           |
| **MMA migration**         | Migrating a legacy Microsoft Monitoring Agent table to the DCR-based ingestion model.                                                 |
| **Native table**          | A built-in Sentinel/Log Analytics table (SecurityEvent, CommonSecurityLog, Syslog, ...).                                              |
| **transformKql**          | The KQL `transform` expression on a DCR that shapes incoming rows.                                                                    |
| **overflow column**       | The single destination column unmatched source fields are folded into (AdditionalExtensions for CEF, SyslogMessage for Syslog, etc.). |
| **coalesce priority**     | The rule that picks one source field when several map to the same destination column (e.g. many candidates -> TimeGenerated).         |
| **pack**                  | A Cribl `.crbl` content package (pipelines, routes, lookups, samples) installed into a Cribl worker group.                            |
| **port**                  | An interface OWNED by the core that the outside world must satisfy (hexagonal architecture).                                          |
| **adapter**               | A concrete implementation of a port living OUTSIDE the core (Azure SDK, Cribl client, fs).                                            |
| **usecase**               | A core orchestration that wires domain logic to driven ports (e.g. DeployDcrs, OnboardSource).                                        |
| **characterization test** | A test that records the CURRENT behavior of the legacy code, written BEFORE porting, so the new code is proven identical.             |
| **cutover**               | Switching a capability's production path from the old app to this tree, once validated.                                               |
| **promotion**             | Retiring the old app after this tree reaches parity.                                                                                  |

## 3. Layered structure (hexagonal / ports and adapters)

The one rule that governs everything: **source dependencies point inward.** The core never imports
infrastructure; adapters depend on the core, never the reverse. Full design in
[docs/architecture.md](docs/architecture.md).

```
apps/{desktop,cli,service}        frontends: compose adapters into core usecases, present results
        |  (inject)
        v
packages/core                     pure domain + usecases + ports; ZERO imports of @azure/*, cribl,
        |                         powershell.exe, electron, or fs
        |  uses ->  packages/shared-config (declarative param-forms; pure)
        ^  (implement)
        |
packages/adapters-{azure,aws,cribl,fs,infra,ai,identity,reporting}  driven adapters: only IO lives here
```

- `packages/core/domain/` — value objects and pure logic. No IO. Runs in milliseconds against
  in-memory data.
- `packages/core/usecases/` — orchestrations that depend on domain plus **driven ports**:
  `OnboardSource`, `DeployDcrs`, `CreateCustomTable`, `GenerateCriblDestinations`, `BuildPack`,
  `AnalyzeDcrGap`, `DiscoverSources`, `ProvisionLab`, `ConfigureLogCollection`, `CheckReadiness`,
  plus the cross-product usecases `MonitorSchemaDrift`, `GeneratePackWithAI`, `SyncLookup`,
  `ValidateAppRegistration`, `ExportToReporting`. `OnboardSource` combines a **source** (a
  `SourceConnector`) with the one **destination** (Sentinel via `DcrDeployer`) through Cribl.
- `packages/core/ports/` — the interfaces the core owns. The **destination is singular (Microsoft
  Sentinel)**; the **source side is pluggable**. Driven ports:
  - destination (Sentinel): `SentinelClient` (auth/session/workspace), `DcrDeployer`, `SchemaStore`,
    `PolicyClient`.
  - source: `SourceConnector` (configure a data source for Cribl collection and emit its Cribl source
    config — AWS, Event Hub, vNet Flow, O365), `DiscoverSources` driving its inputs.
  - pipe + shared: `CriblClient`, `ContentRepo`, `Keystore`, `InfraProvisioner`, `AiClient`,
    `IdentityClient`, `ReportingClient`, `LookupSource`, `Clock`, `FileSystem`, `ProgressSink`.
  - Driving: the usecase interfaces.
- `packages/core/assets/` — pure data: the ~100 ARM templates, lab/policy IaC, and the **prebuilt
  Cribl pack library** (`packs/*.crbl`, the Azure_vNet_FlowLogs pack).
- `packages/shared-config/` — the declarative `param-forms` schema and integration-mode gating. Pure
  data + validation, consumed by `core` and rendered by the frontends.
- `packages/adapters-azure/` — the **Sentinel destination** plus Azure-native sources: implements
  `SentinelClient`/`DcrDeployer`/`SchemaStore`/`PolicyClient` with `@azure/identity` + `@azure/arm-*`
  (incl. `arm-resourcegraph` for discovery, `arm-policyinsights`/`arm-resources` for log-collection
  policy) + `@azure/monitor-query`, and the Event Hub / vNet Flow `SourceConnector`s.
- `packages/adapters-aws/` — an **AWS source connector**: implements `SourceConnector` with the AWS
  SDK for JS v3 (S3/SQS/Kinesis/CloudWatch/IAM), generating the Cribl source config so Cribl collects
  AWS data and forwards it to the Sentinel destination; lab provisioning via Terraform (see
  `adapters-infra`). AWS is a source, not a destination.
- `packages/adapters-cribl/` — implements `CriblClient` with the official Cribl TS SDK + a generated
  OpenAPI client + a vendored override shim (see [ADR 0005](docs/adr/0005-pin-and-vendor-the-cribl-client.md), [ADR 0007](docs/adr/0007-adopt-official-cribl-ts-sdk-with-override-shim.md)).
- `packages/adapters-fs/` — implements `ContentRepo`/`FileSystem`/`Keystore`/`LookupSource` (Sentinel
  fetch, EDR blocklist, registry sync, sample resolution, AD/LDAP lookup queries, config, OS keychain).
- `packages/adapters-infra/` — implements `InfraProvisioner` for lab automation: runs Bicep/Terraform
  to stand up and tear down self-contained Azure and AWS test environments.
- `packages/adapters-ai/` — implements `AiClient` with the Anthropic API (schema extraction, schema
  inference, AI-assisted Cribl pack generation; see [ADR 0009](docs/adr/0009-ai-assisted-pack-generation.md)).
- `packages/adapters-identity/` — implements `IdentityClient` with Microsoft Graph (O365/Entra
  app-registration validation and permission checks).
- `packages/adapters-reporting/` — implements `ReportingClient` for PowerBI + Cribl Search export.
- `apps/desktop` — Electron shell; `main.ts` is the composition root; React pages are presentation
  only behind `window.api`.
- `apps/cli` — oclif CLI over the same usecases.
- `apps/service` — Express service over the same usecases (the `api-router` + SSE seam).

## 4. The channel <-> route convention

Every capability is addressed by a stable name used identically by all three frontends. The desktop
IPC channel and the service HTTP route are the same string in two shapes: `auth:status` <->
`GET /api/auth/status`. The old app already does this through
[src/server/electron-stub.ts](../Cribl-Microsoft_IntegrationSolution/src/server/electron-stub.ts)
and [src/server/api-router.ts](../Cribl-Microsoft_IntegrationSolution/src/server/api-router.ts) —
that seam is the reference for `apps/service`. Progress is streamed through a single `ProgressSink`
port (BrowserWindow `send` on desktop, SSE via
[event-bus.ts](../Cribl-Microsoft_IntegrationSolution/src/server/event-bus.ts) in the service,
stdout in the CLI).

## 5. Port-from map

Where each capability lives today and where it lands here. Paths are relative to the repo root.
Verify each entry against the source before porting; record a characterization test FIRST (see
[docs/testing-strategy.md](docs/testing-strategy.md)).

### Pure domain logic -> `packages/core/domain/`

| Capability                                                                                                                                                                          | Ported FROM (verified)                                                                                                   | Lands in                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Field matcher: 6-phase cascade, `ALIAS_TABLE` (300+ aliases), `COALESCE_PRIORITY`, `EVENT_TYPE_BOOSTS`, scoring                                                                     | `Cribl-Microsoft_IntegrationSolution/src/main/ipc/field-matcher.ts` (862 lines)                                          | `core/domain/field-matching/`                             |
| Sample parser: format detection, inner-`_raw` re-parse, PAN-OS positional maps                                                                                                      | `.../src/main/ipc/sample-parser.ts`                                                                                      | `core/domain/sample-parsing/`                             |
| KQL parser: `parseTransformKql`, `analyzeDcrGap`, `generateRouteCondition`                                                                                                          | `.../src/main/ipc/kql-parser.ts`                                                                                         | `core/domain/kql/`                                        |
| Reduction-rules knowledge base                                                                                                                                                      | `.../src/main/ipc/reduction-rules.ts`                                                                                    | `core/domain/reduction/`                                  |
| SIEM migration maps (`SPLUNK_*`, `QRADAR_*`)                                                                                                                                        | `.../src/main/ipc/siem-migration.ts`                                                                                     | `core/domain/siem-migration/`                             |
| Change-detection fingerprint + diff taxonomy                                                                                                                                        | `.../src/main/ipc/change-detection.ts`                                                                                   | `core/domain/change-detection/` (IO split to adapters-fs) |
| DCR name abbreviation map (`CommonSecurityLog -> CSL`, ...)                                                                                                                         | `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1:2599`                                          | `core/domain/dcr-naming/`                                 |
| `ConvertTo-DCRColumnType` (25+ aliases -> 8 DCR types, guid->string)                                                                                                                | `.../Create-TableDCRs.ps1:396`                                                                                           | `core/domain/dcr-schema/`                                 |
| `Get-TableColumns` disambiguation (standardColumns vs columns, MMA detect, TenantId-only heuristic), reserved-column blocklist, `_CL` normalization, per-table ARM column injection | `.../Create-TableDCRs.ps1:1475`                                                                                          | `core/domain/dcr-schema/`                                 |
| `Fix-HandlerControlEndpoint` regex; `Get-CriblConfigFromDCR` shaping                                                                                                                | `.../Create-TableDCRs.ps1:1633`, `Azure/CustomDeploymentTemplates/DCR-Automation/core/Generate-CriblDestinations.ps1:41` | `core/domain/cribl-destination/`                          |

### Pure data assets -> `packages/core/assets/`

| Asset                                                           | FROM (verified)                                                                                                                      | Lands in                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| ~100 ARM templates (DCE + NoDCE variants of every native table) | `Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables/DataCollectionRules(DCE)/` and `.../DataCollectionRules(NoDCE)/` | `core/assets/arm-templates/` |

### Orchestrations -> `packages/core/usecases/`

| Capability                                                                                           | FROM                                                    | Lands in                                                                 |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| End-to-end onboarding state machine (research -> tables -> DCRs -> pack -> destinations), idempotent | `.../src/main/ipc/e2e-orchestrator.ts`                  | `core/usecases/OnboardSource` (with injected `ProgressSink`)             |
| DCR deploy, custom-table create, Cribl destination generate                                          | `.../Create-TableDCRs.ps1`, `.../Run-DCRAutomation.ps1` | `core/usecases/{DeployDcrs,CreateCustomTable,GenerateCriblDestinations}` |

### Adapters (IO) -> `packages/adapters-*`

| Capability                                                                                                                                    | FROM (verified)                                                                                            | Lands in                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Cribl auth (cloud OAuth + self-managed), destinations, pack PUT-then-install conflict-delete-retry, multi-path version probing                | `.../src/main/ipc/auth.ts` (Cribl paths)                                                                   | `adapters-cribl` + `Keystore` port                      |
| Azure session/token (replace `Get-AzContext`/`Connect-AzAccount` window + stdout scrape), subscriptions/workspaces/RGs, schema retrieval, KQL | `.../src/main/ipc/auth.ts` (Azure paths), `.../src/main/ipc/azure-deploy.ts` (currently shells PowerShell) | `adapters-azure`                                        |
| DCR/DCE/AMPLS deployment engine                                                                                                               | `.../Create-TableDCRs.ps1` (reference) via `@azure/arm-*`                                                  | `adapters-azure` (`ArmDcrAdapter`)                      |
| Pack builder (`.crbl` tar + pipeline-conf YAML, CrowdStrike special-casing)                                                                   | `.../src/main/ipc/pack-builder.ts` (3307 lines)                                                            | `adapters-fs` + `core` (pure sub-parts extracted first) |
| Sample resolver (tiered acquisition)                                                                                                          | `.../src/main/ipc/sample-resolver.ts` (1873 lines)                                                         | `adapters-fs`                                           |
| Vendor research (schema fetch, field normalization)                                                                                           | `.../src/main/ipc/vendor-research.ts`                                                                      | `adapters-fs`                                           |
| Sentinel repo selective-fetch + two-layer EDR blocklist + registry sync                                                                       | `.../src/main/ipc/sentinel-repo.ts`, `.../src/main/ipc/registry-sync.ts`                                   | `adapters-fs` (`ContentRepo`)                           |

### Adjacent Azure subsystems (first-class capabilities)

Each is a real usecase with a roadmap home, not a deferral. See [docs/roadmap.md](docs/roadmap.md)
Phases 5 and 7.

| Capability                                                                                                                      | FROM                                                                                                                                                                                  | Lands in                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Discovery: Event Hub discovery (Resource Graph optimized) + vNet Flow Log discovery -> generate Cribl configs; feeds onboarding | `Azure/dev/EventHubDiscovery/`, `Azure/vNetFlowLogs/vNetFlowLogDiscovery/Run-vNetFlowLogDiscovery.ps1`, `Azure/dev/vNetFlowLogDiscovery/`, GUI `.../src/renderer/pages/Discovery.tsx` | `core/usecases/DiscoverSources` + `adapters-azure` (`@azure/arm-resourcegraph`) |
| Lab automation: self-contained Azure test environments (VNet/NSG/Storage/VMs/monitoring) + sample data                          | `Azure/Labs/UnifiedLab/Run-AzureUnifiedLab.ps1` (863-line orchestrator + phase scripts), `Azure/Labs/AzureFlowLogLab/Run-AzureFlowLogLab.ps1`, GUI `.../pages/LabAutomation.tsx`      | `core/usecases/ProvisionLab` + `adapters-infra` (Bicep/Terraform)               |
| Azure-LogCollection: policy-driven log-collection automation (Azure Policy + Event Hub architecture)                            | `Azure/Azure-LogCollection/Run-AzureLogCollection.ps1` (+ its own CLAUDE.md)                                                                                                          | `core/usecases/ConfigureLogCollection` + `adapters-azure` (`PolicyClient`)      |
| Cribl pack packaging automation                                                                                                 | `Azure/dev/Packs/Cribl_Pack_Packaging/Run-PackageAutomation.ps1`                                                                                                                      | folded into `BuildPack` / `adapters-fs` pack emitter                            |

### Cross-product capabilities (source connectors, AI, enrichment, identity, reporting)

The original codebase is more than the Azure-native pipeline. These are first-class (see
[docs/roadmap.md](docs/roadmap.md) Phases 8-10). The destination stays Microsoft Sentinel; these
broaden the **sources** and the surrounding workflow.

| Capability                                                                                                                                                                                                      | FROM                                                                                                                                                                                                                                                                                                                   | Lands in                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS as a data **source**: Terraform deploys VPC/S3+SQS/Kinesis/CloudWatch/EC2/IAM; Python generates the Cribl **source** configs (S3/Kinesis/CloudWatch) so Cribl collects AWS data and forwards it to Sentinel | `Dev/AWS/Labs/AWSIntegrationLab/` (`Run-AWSIntegrationLab.py`, `Core/terraform/`, `Generate-CriblConfigs.py`, `helpers/naming_engine.py`)                                                                                                                                                                              | `adapters-aws` (`SourceConnector`) + `adapters-infra` (Terraform); plugs into the same `OnboardSource` whose destination is Sentinel                     |
| Autonomous AI schema-drift engine: monitors Windows + Sentinel schemas (Claude extracts/infers), detects drift, AI-generates Cribl packs, GitOps commit/PR, cost tracking                                       | `Azure/dev/windows-schema-sync/` (`src/orchestrator.py`, `src/monitors/*`, `src/generators/cribl_generator.py`, `src/autonomous_onboarding.py`, `src/utils/cost_tracker.py`; Core PS `Deploy-AMA/KeyVault/Sentinel/DCR/GitHubWorkflow/IncrementalOnboarding.ps1`, `Sync-SchemaFromAzure.ps1`, `Compare-TableData.ps1`) | `core/usecases/{MonitorSchemaDrift,GeneratePackWithAI}` + `adapters-ai` (Anthropic) + GitOps via `ContentRepo`; AMA/KeyVault deploy via `adapters-azure` |
| Enrichment lookups: AD via LDAP -> CSV -> Cribl Cloud lookup -> commit/deploy; static lookups                                                                                                                   | `Lookups/DynamicLookups/ActiveDirectory/main.py`, `Lookups/StaticLookups/`                                                                                                                                                                                                                                             | `core/usecases/SyncLookup` + `adapters-fs` (`LookupSource`, LDAP) + `adapters-cribl` (lookup upload); static lookups -> `core/assets/lookups/`           |
| O365 / Entra app-registration validation (collection prerequisite)                                                                                                                                              | `KnowledgeArticles/O365AppRegistrationForCribl/dev/Run-O365PermissionValidation.ps1`, `Test-O365AppPermissions.ps1`                                                                                                                                                                                                    | `core/usecases/ValidateAppRegistration` + `adapters-identity` (Microsoft Graph)                                                                          |
| PowerBI + Cribl Search reporting                                                                                                                                                                                | `KnowledgeArticles/PowerBI_CriblSearch/PowerBI_CriblSearch.py`                                                                                                                                                                                                                                                         | `core/usecases/ExportToReporting` + `adapters-reporting`                                                                                                 |
| Prebuilt Cribl pack library + prebuilt pipelines                                                                                                                                                                | `packs/*.crbl` (e.g. `cloudflare-sentinel_0-5-8.crbl`), `Azure/dev/Azure_vNet_FlowLogs/`                                                                                                                                                                                                                               | `core/assets/cribl-packs/` (shipped assets, installed via `adapters-cribl`)                                                                              |

### Frontends -> `apps/*` (all 12 pages accounted for)

| Capability                                                                                                                                           | FROM                                                                               | Lands in                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Core-pipeline pages: SentinelIntegration, DcrAutomation, PackBuilder, Packs (browser), SiemMigration, RepoSetup, Discovery, LabAutomation            | `.../src/renderer/pages/*.tsx`                                                     | `apps/desktop` (ported incrementally, presentation only)                                                       |
| Support pages: SetupWizard (first-run config), Settings (global config), DataFlow (lineage/flow viz), DepsCheck (dependency + permission validation) | `.../src/renderer/pages/{SetupWizard,Settings,DataFlow,DepsCheck}.tsx`             | `apps/desktop`                                                                                                 |
| Dependency + permission preflight                                                                                                                    | `.../src/main/ipc/deps.ts`, `.../src/main/ipc/permission-check.ts`                 | `core/usecases/CheckReadiness` + `adapters-{fs,azure}`                                                         |
| Declarative parameter forms; default samples; config/app-paths/logger/github                                                                         | `.../src/main/ipc/{param-forms,default-samples,config,app-paths,logger,github}.ts` | `packages/shared-config` (param-forms), `adapters-fs` (samples/config/github), shared infra (logger/app-paths) |
| The `electron-stub` + `api-router` + `event-bus` seam                                                                                                | `.../src/server/*.ts`                                                              | `apps/service`                                                                                                 |
| `-NonInteractive` automation entry point                                                                                                             | `.../Run-DCRAutomation.ps1`                                                        | `apps/cli` (oclif)                                                                                             |

### Future extension points and reference material (cataloged, not dropped)

Everything else in the repository, recorded so nothing is silently lost. The architecture leaves room
for the placeholders; the reference docs migrate into `SOC-OptimizationToolkit/docs/`.

| Item                                      | Location                                                | Disposition                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Microsoft Fabric RTI integration          | `Azure/dev/FabricRTI/` (empty)                          | A possible future _alternative Microsoft destination_ (Fabric Real-Time Intelligence). Would be a second destination adapter alongside Sentinel; out of scope until built. Sentinel remains the primary destination                                                                                                                                                                                     |
| Sentinel pack library                     | `Azure/SentinelPacks/` (empty)                          | Future home for additional prebuilt packs in `core/assets/cribl-packs/`                                                                                                                                                                                                                                                                                                                                 |
| Home lab                                  | `Dev/HomeLab/` (empty)                                  | Future lab profile under `ProvisionLab`                                                                                                                                                                                                                                                                                                                                                                 |
| Azure Monitor -> Sentinel migration guide | `KnowledgeArticles/AzureMonitorMigration/`              | Reference doc; the MMA->DCR migration logic itself is already covered in Phase 4. Migrate the doc into `docs/`                                                                                                                                                                                                                                                                                          |
| Private Link / AMPLS configuration guide  | `KnowledgeArticles/PrivateLinkConfiguration/`           | Reference doc; AMPLS wiring is covered in Phase 4. Migrate the doc into `docs/`                                                                                                                                                                                                                                                                                                                         |
| Architecture diagrams                     | `Azure/Diagrams/`                                       | Move relevant diagrams into `docs/`                                                                                                                                                                                                                                                                                                                                                                     |
| App launchers                             | old tree: `Start-App-Windows.bat`, `Start-App-macOS.sh` | KEPT as a pattern. Equivalent launchers now live IN this directory (`SOC-OptimizationToolkit/Start-App-Windows.bat` / `Start-App-macOS.sh`) and start the desktop GUI from source via `pnpm --filter desktop dev` — deliberately not a packaged `.exe`, to avoid the EDR false positives packaged executables trigger on corporate machines. They guard gracefully until Phase 0 scaffolds the monorepo |

## 6. Assets to preserve VERBATIM

These encode hard-won, under-documented behavior. Port them with byte-exact characterization tests;
do not "clean them up" during the port.

- The `ALIAS_TABLE` and scoring constants in `field-matcher.ts`.
- The DCR name-abbreviation map in `Create-TableDCRs.ps1` (line ~2599).
- The reserved-column blocklist and `ConvertTo-DCRColumnType` mapping.
- The `Get-TableColumns` TenantId-only disambiguation heuristic and MMA detection.
- The two-layer EDR blocklist (CrowdStrike content suppression) and its crash-detection logic.
- The Cribl client overrides: cloud-vs-self-managed audience selection, the `/packs`
  PUT-then-install conflict-delete-retry, and multi-endpoint version-drift probing.
- The AWS Cribl-config generation rules and `naming_engine.py` (S3+SQS/Kinesis/CloudWatch source +
  destination shaping) in `Dev/AWS/Labs/AWSIntegrationLab/Core/`.
- The embedded AI prompts in `windows-schema-sync` (schema extraction, schema inference, pack
  generation/update) — they encode the source->destination field semantics; treat as versioned
  assets with golden-output tests (see [ADR 0009](docs/adr/0009-ai-assisted-pack-generation.md)).
- The AD lookup attribute set and UPN/NetBIOS/plain credential handling in
  `Lookups/DynamicLookups/ActiveDirectory/main.py`.
- The O365/Graph permission set required for Cribl collection (`O365AppRegistrationForCribl`).

## 7. The one accepted liability

There is no first-party-guaranteed-forever JS/TS Cribl SDK, so this tree permanently owns a vendored
Cribl client carrying the overrides above. This is contained, not eliminated: pin and vendor the
client, isolate overrides in a non-generated layer, contract-test them, and never auto-regenerate
into the build. See [ADR 0005](docs/adr/0005-pin-and-vendor-the-cribl-client.md) and
[ADR 0007](docs/adr/0007-adopt-official-cribl-ts-sdk-with-override-shim.md).

## 8. Where to go next

- The design in depth: [docs/architecture.md](docs/architecture.md)
- Why TypeScript, and every other recorded decision: [docs/adr/](docs/adr/)
- How we test (and the capture-golden-from-legacy-FIRST rule): [docs/testing-strategy.md](docs/testing-strategy.md)
- How CI gates every change: [docs/ci-cd.md](docs/ci-cd.md)
- The phase-by-phase plan: [docs/roadmap.md](docs/roadmap.md)

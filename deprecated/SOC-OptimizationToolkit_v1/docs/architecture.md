# Architecture — SOC-OptimizationToolkit

This document describes the target design. It is prose; the decisions behind it are recorded as ADRs
in [adr/](adr/), and the domain language and port-from map are in [../CONTEXT.md](../CONTEXT.md).

## 1. The shape: hexagonal (ports and adapters)

The product is a pure domain **core** surrounded by **adapters** that perform IO, consumed by thin
**frontends**. We adopt the hexagonal / clean-architecture style for one reason that dominates every
other concern in this codebase: **the business logic must be unit-testable without Azure, Cribl, a
PowerShell runtime, a browser, or a filesystem.** The existing code fails this today — the valuable
logic (name abbreviation, schema mapping, field matching, the onboarding state machine) is
interleaved with `Invoke-AzRestMethod`, `Read-Host`, `child_process.spawn`, `fetch`, and `fs`, so it
cannot be exercised in isolation.

The governing rule:

> **Source-level dependencies point inward. The core imports nothing from the outside; adapters
> depend on the core; frontends depend on both. At runtime, control flows outward through interfaces
> the core owns.**

This is dependency inversion: the core declares the interfaces it needs (ports) and the outer layers
implement them. The compile-time arrow and the runtime call go in opposite directions.

```
                      +-------------------------------------------+
   driving side       |                 core                      |       driven side
  (who calls in)      |                                           |     (what core calls out to)
                      |   usecases  ->  ports (driven interfaces) |
  apps/desktop  --->  |      |                     ^              |  <---  adapters-azure
  apps/cli      --->  |      v                     |              |  <---  adapters-cribl
  apps/service  --->  |   domain (pure logic)      |              |  <---  adapters-fs
                      |                                           |
                      +-------------------------------------------+
        inject concrete adapters at the composition root of each frontend
```

## 2. The three layers

### Layer 1 — `packages/core` (pure)

No imports of `@azure/*`, the Cribl client, `powershell.exe`, `electron`, or `fs`. If a file in
`core` imports any of those, the layering is broken and CI fails it (an ESLint
`no-restricted-imports`/boundaries rule enforces this).

- `domain/` — value objects and pure functions: `DcrName` (the 30-char Direct / 64-char DCE
  abbreviation logic), `TableSchema`, the column-type map, the reserved-column blocklist, `_CL`
  normalization, ARM column injection, the field-matcher cascade, the sample-parser, the kql-parser,
  reduction rules, SIEM maps, change-detection fingerprints, the AWS Cribl-config shaping rules.
  These are deterministic: same input, same output, no clock, no network, no disk.
- `usecases/` — orchestrations that combine domain logic with driven ports: `OnboardSource`,
  `DeployDcrs`, `CreateCustomTable`, `GenerateCriblDestinations`, `BuildPack`, `AnalyzeDcrGap`,
  `DiscoverSources`, `ProvisionLab`, `ConfigureLogCollection`, `CheckReadiness`, and the cross-product
  usecases `MonitorSchemaDrift`, `GeneratePackWithAI`, `SyncLookup`, `ValidateAppRegistration`,
  `ExportToReporting`. A usecase never news-up an adapter; it receives ports through its
  constructor/arguments.
- `ports/` — the interfaces the core owns. The product has **one destination, Microsoft Sentinel**,
  and **many pluggable sources**. Driven ports split accordingly:
  - destination (Sentinel-specific): `SentinelClient` (auth/session/workspace), `DcrDeployer`,
    `SchemaStore`, `PolicyClient`.
  - source (pluggable): `SourceConnector` — configure a data source for Cribl collection and emit its
    Cribl source config (AWS, Event Hub, vNet Flow, O365). A new source is a new adapter, never a
    change to the destination.
  - pipe + shared: `CriblClient`, `ContentRepo`, `Keystore`, `InfraProvisioner` (lab IaC), `AiClient`
    (Anthropic), `IdentityClient` (Graph), `ReportingClient` (PowerBI/Cribl Search), `LookupSource`
    (LDAP/AD), `Clock`, `FileSystem`, `ProgressSink`.
  - Driving ports: the usecase interfaces.
- `assets/` — pure data shipped with the core: the ~100 ARM templates, lab/policy IaC, and the
  prebuilt Cribl pack library (`packs/*.crbl`, the Azure_vNet_FlowLogs pack). Reused unchanged.

**One destination, pluggable sources is the load-bearing rule.** `OnboardSource` reads "configure the
source via a `SourceConnector`, route it through Cribl, land it in Sentinel via `DcrDeployer`". The
destination side is deliberately Sentinel-specific (DCR/DCE/AMPLS/`_CL` are Sentinel concepts and
must not be abstracted into a fake "generic cloud"); the variety lives entirely on the source side, so
onboarding AWS vs. Event Hub vs. O365 is a matter of which `SourceConnector` adapter is injected. See
[adr/0008-sentinel-destination-pluggable-sources.md](adr/0008-sentinel-destination-pluggable-sources.md).

### Layer 2 — `packages/adapters-*` (IO)

The only code allowed to touch the network, the disk, the OS keychain, or a child process.

- `adapters-azure` — the **Microsoft Sentinel destination** (plus Azure-native sources):
  `@azure/identity` (`DefaultAzureCredential` / `InteractiveBrowserCredential`, replacing the visible
  `Connect-AzAccount` window and the stdout-scraping token hack), `@azure/arm-monitor` (DCR/DCE +
  `PrivateLinkScope` for AMPLS), `@azure/arm-operationalinsights` (`TablesClient` create/migrate),
  `@azure/arm-resources` (submit the ARM templates), `@azure/arm-resourcegraph` (discovery),
  `@azure/arm-policyinsights`/`@azure/arm-resources` (Azure-LogCollection policy), `@azure/monitor-query`
  (KQL). Implements `SentinelClient`, `DcrDeployer` (`ArmDcrAdapter`), `SchemaStore`, `PolicyClient`,
  and the Event Hub / vNet Flow `SourceConnector`s.
- `adapters-aws` — an **AWS source connector** with the AWS SDK for JS v3: S3 + SQS (event
  notifications), Kinesis Data Streams/Firehose, CloudWatch Logs, IAM roles for Cribl auth. Generates
  the Cribl **source** config so Cribl collects AWS data and forwards it to the Sentinel destination.
  Implements `SourceConnector`. AWS is a source, not a destination.
- `adapters-infra` — implements `InfraProvisioner` for lab automation: runs Bicep/Terraform to stand
  up and tear down self-contained **Azure and AWS** test environments and seed sample source data.
  Kept separate from the other adapters because lab provisioning is infrastructure-as-code, not
  control-plane onboarding.
- `adapters-cribl` — a client generated from the Cribl OpenAPI spec plus the official Cribl TS SDK
  where it cleanly covers operations, with the hand-won overrides kept in a **separate
  non-generated layer** (cloud-vs-self audience, `/packs` PUT-then-install conflict-delete-retry,
  multi-path version probing). Credential persistence is behind the `Keystore` port. Implements
  `CriblClient`. Also installs the prebuilt pack library.
- `adapters-ai` — implements `AiClient` with the Anthropic API: schema extraction from Microsoft
  docs, schema inference from samples, and AI-assisted Cribl pack generation/update. Powers the
  autonomous schema-drift engine. See
  [adr/0009-ai-assisted-pack-generation.md](adr/0009-ai-assisted-pack-generation.md).
- `adapters-identity` — implements `IdentityClient` with Microsoft Graph: O365/Entra app-registration
  validation and the permission set Cribl needs for O365 collection.
- `adapters-reporting` — implements `ReportingClient`: PowerBI + Cribl Search export.
- `adapters-fs` — `ContentRepo` (Sentinel selective fetch + the two-layer EDR blocklist + registry
  sync + the tiered sample resolver + GitOps commit/PR), `LookupSource` (AD/LDAP queries for the
  enrichment lookups), plus `FileSystem`, `Clock`, and `Keystore` for the non-desktop cases.

### Layer 3 — `apps/*` (frontends)

Each frontend is a **composition root**: it constructs the concrete adapters, injects them into core
usecases, and renders/streams the results. It contains no business logic.

- `apps/desktop` — the Electron app. `main.ts` becomes the composition root; each IPC handler
  shrinks to: unwrap arguments, call a usecase, stream progress through a `ProgressSink` backed by
  `BrowserWindow.send`. The React renderer stays presentation-only behind `window.api` and is ported
  from the existing renderer page by page.
- `apps/cli` — a new oclif CLI over the same usecases; the `ProgressSink` writes to stdout. This is
  what CI and automation call instead of `Run-DCRAutomation.ps1 -NonInteractive`.
- `apps/service` — an Express service over the same usecases, reusing the existing `api-router` and
  `event-bus` SSE seam; the `ProgressSink` emits SSE events. Versioned in-repo with the core so the
  shared-library coupling stays inside one product.

## 3. Ports in detail

A port is the core's contract with the world. The core depends only on the interface; tests pass an
in-memory fake; production passes a real adapter.

| Port                   | Direction | Real adapter                                                            | Fake (tests)                                 |
| ---------------------- | --------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| `SentinelClient`       | driven    | `adapters-azure` (`@azure/identity` + `@azure/arm-*`) — the destination | `FakeSentinelClient` + SDK test-proxy replay |
| `DcrDeployer`          | driven    | `ArmDcrAdapter` (`@azure/arm-monitor`) — Sentinel ingestion             | `FakeDcrDeployer`                            |
| `SourceConnector`      | driven    | `adapters-aws` (AWS SDK v3), Event Hub / vNet Flow (`adapters-azure`)   | `FakeSourceConnector` per source             |
| `SchemaStore`          | driven    | `@azure/arm-operationalinsights`                                        | in-memory schema fixtures                    |
| `PolicyClient`         | driven    | `@azure/arm-policyinsights` (log-collection policy)                     | in-memory policy fake                        |
| `CriblClient`          | driven    | official TS SDK + generated client + overrides                          | `FakeCriblClient` + MSW cassettes            |
| `ContentRepo`          | driven    | GitHub/Sentinel fetch over `fs` + `https`; GitOps commit/PR             | in-memory repo + MSW cassettes               |
| `Keystore`             | driven    | Electron `safeStorage`/DPAPI; OS keyring/env in CLI/service             | in-memory keystore                           |
| `InfraProvisioner`     | driven    | `adapters-infra` (Bicep/Terraform runner) for Azure + AWS labs          | `FakeInfraProvisioner`                       |
| `AiClient`             | driven    | `adapters-ai` (Anthropic API)                                           | recorded-response fake + golden outputs      |
| `IdentityClient`       | driven    | `adapters-identity` (Microsoft Graph)                                   | in-memory identity fake                      |
| `ReportingClient`      | driven    | `adapters-reporting` (PowerBI / Cribl Search)                           | in-memory reporting fake                     |
| `LookupSource`         | driven    | `adapters-fs` (AD/LDAP)                                                 | in-memory directory fixture                  |
| `Clock` / `FileSystem` | driven    | real system                                                             | deterministic fakes                          |
| `ProgressSink`         | driven    | `BrowserWindow.send` / SSE / stdout                                     | recording sink (asserts the event sequence)  |
| usecase interfaces     | driving   | called by frontends                                                     | called directly by integration tests         |

## 4. The composition-root pattern

Wiring lives at exactly one place per frontend. Example (desktop), illustrative:

```
// apps/desktop/src/main.ts  (composition root)
const clock    = new SystemClock();
const sentinel = new AzureSentinelAdapter({ credential: new DefaultAzureCredential() }); // destination
const source   = new EventHubSourceConnector({ /* ... */ });                             // a source
const cribl    = new CriblSdkClient({ keystore: new SafeStorageKeystore() });
const content  = new GithubContentRepo({ fs: nodeFs });

const onboard = new OnboardSource({ source, sentinel, cribl, content, clock });

ipcMain.handle('onboard:run', (e, args) =>
  onboard.run(args, new BrowserWindowProgressSink(e.sender)));
```

The CLI and service have their own composition roots that build the same usecases with different
`ProgressSink` and `Keystore` implementations. Nothing else in the tree calls `new` on an adapter.

## 5. Why this makes the product testable "as changes are made"

- The **entire domain** runs against in-memory fakes in milliseconds, so the broad base of the test
  pyramid is fast enough to run on every save and every commit.
- The **adapter boundary** is a small, explicit set of interfaces, so cloud integrations are faked
  with in-memory doubles for speed and pinned with recorded cassettes / the Azure SDK test-proxy for
  fidelity — without live calls in CI.
- The **frontends** carry no logic, so they need only thin smoke tests, not deep coverage.

The boundaries also make the codebase navigable for an AI agent or a new engineer: a change is
almost always "edit one pure function in `core` and its unit test," or "edit one adapter and its
contract test," rarely both. The full strategy is in [testing-strategy.md](testing-strategy.md).

## 6. Relationship to the existing trees

This tree is greenfield and independent (see
[adr/0004-greenfield-independent-toolkit-directory.md](adr/0004-greenfield-independent-toolkit-directory.md)).
Logic is ported in from `Cribl-Microsoft_IntegrationSolution/` and `Azure/` file by file, each port
gated by a characterization test recorded from the legacy behavior first. The old app remains the
running product and the fallback for any capability not yet cut over (see
[adr/0006-strangler-fig-with-old-app-as-fallback.md](adr/0006-strangler-fig-with-old-app-as-fallback.md)),
and is retired only at promotion. The sequence is in [roadmap.md](roadmap.md).

## 7. How we build it: vertical slices, core-first, GUI last

The build order follows the Dependency Rule in the small, not the large. We do **not** build the whole
core, then all adapters, then the UI (horizontal layering leaves nothing working for too long and lets
ports be designed without a real consumer). We build **vertical slices**: a thin thread through every
layer for one capability, working end-to-end, then thickened
([adr/0010-vertical-slices-walking-skeleton-gui-last.md](adr/0010-vertical-slices-walking-skeleton-gui-last.md)).

- The first slice (roadmap Phase 1) is a **walking skeleton** — onboard one source end-to-end through
  a thin `OnboardSource`, minimal real adapters, and a minimal CLI command, green against a throwaway
  Sentinel workspace. This validates the ports against a real caller before any layer is thickened.
- Within a slice we build **inside-out**: pure domain/usecase test-first (fastest feedback), then the
  adapter, then the thinnest frontend — driven **outside-in** from a user-visible acceptance criterion
  so only what is needed gets built.
- The **CLI is the first consumer** (cheap, headless, end-to-end). The **GUI is last** — it is the
  thickest, most volatile layer, mechanical to wire onto a proven core; the existing Electron app
  covers users until then. "UI first" is rejected for this project.

# CONTEXT: soc-optimizationtoolkit workspace

Purpose: consolidate the Cribl-Microsoft repository's capabilities (see docs/feature-catalog.md) into one maintainable product with two deployment targets sharing one codebase.

## Workspace map

- packages/core - domain logic + port interfaces. Zero IO, zero fetch, zero React. Vendored Cribl OpenAPI spec in assets/.
- packages/ui - shared React feature screens/components. Consumes ports via context; never performs IO directly.
- apps/cribl-app - Cloud shell. Vite build to .tgz for the Cribl App Platform (Cribl.Cloud only). Binds platform adapters: locked fetch, /kvstore, proxies.yml, policies.yml. Platform constraints documented in apps/cribl-app/AGENTS.md.
- apps/local-app - local shell for on-prem Cribl. Node host serves the same UI and fulfills the same ports (outbound HTTP, encrypted secrets, job scheduling). First run = onboarding GUI for both targets.

## Invariants (lint-enforced once packages have content)

1. core imports nothing from ui or apps. ui imports only core. Apps import both.
2. Every outbound call goes through a port client defined in core; each shell binds its own adapters.
3. Legacy code in the wider repo is a capability reference, never an implementation spec (redesign-first principle, see feature catalog). Exception: DCR/DCE name generation, production stream names/schemas, and pack naming are compatibility contracts preserved via characterization tests.
4. External-surface declarations (proxies.yml/policies.yml for cloud; local host allowlist) change in the same PR as the feature needing them.
5. No emojis anywhere (repo-wide rule).

## Status

Workspace restructured 2026-07-01. Phase 1 walking skeleton live in BOTH shells: onboardTable usecase + OnboardTableScreen over the six ports (in-memory fakes for tests); local Node host (loopback API, encrypted secrets, ARM/leader proxies) shipped 2026-07-03. Unit 1 app frame shipped: AUA gate, mode chooser, mode-filtered route table, settings screen, one budgeted status poller.

Unit 2 (Azure resource discovery and targeting) shipped 2026-07-03. Core: azure-discovery usecases - Enabled-only subscription list (legacy filter pinned), workspace list (name/RG/location/customerId/sku), resource-group choices with the VERBATIM deriveResourceGroupsFromWorkspaces fallback, create-RG / create-workspace (PerGB2018, 90-day retention, attempt-bounded provisioning poll), enable-Sentinel using the workspace's ACTUAL location (legacy always-eastus bug fixed + pinned), and commitTargetScope (merge into the active profile, never replace; browse NEVER commits). UI: AzureTargetingScreen in @soc/ui - always-visible selectors disabled-with-instructions before data, ONE loader effect (legacy had three overlapping), explicit "Use this target" commit surfacing invalidation consequences, offline free-text branch, RG-name sanitization (legacy rule mined), committed-scope chip in both frames' topBar. Shells: ARM nextLink pagination via AzureManagement.requestUrl - cloud adapter and local host route POST /api/azure/request-url, both hard-restricted to https://management.azure.com/ before any request (SSRF guard). The cloud harness's panel-4 discovery stays as diagnostics; the targeting screen is the product path.

Unit 3 (Logger port and in-app diagnostics) shipped 2026-07-03. Core (prior increment): Logger port with the structural hard rule (LogContextValue = string|number|boolean|null ONLY; redactedLength is the one sanctioned way to reference sensitive material), log-model (immutable ring append, PINNED formatLogLine format, filterLogEntries, buildSupportBundle), FakeLogger, and optional logger wiring in onboardTable/azure-discovery (absent logger = no-op). This increment: adapters, viewer, and shells. Cloud: PlatformLogger (500-entry in-memory ring, dev console mirror, warn/error lines mirrored fire-and-forget to ONE rolling plain KV entry, last 100, one PUT per warn/error). Local: browser HostLogger batches entries to POST /api/logs (20 entries or 3s, fire-and-forget); the host appends formatLogLine lines to data/logs/app.log (10MB cap, single .1 rollover - legacy rotation policy as prior art, reimplemented), serves GET /api/logs?tail=500, sanitizes every shipped entry server-side (non-primitive context values dropped), and logs its OWN events (API requests, ARM/Cribl token refreshes, upstream failures) through the same file - no secret or token value ever. UI: LogsScreen (requires 'none', registered in BOTH shells) with min-level/jobId/text filtering and a support-bundle download (logs + recent job records + shell platform facts) via ArtifactSink; @soc/ui parseLogLine round-trips the pinned line format so the local shell's file tail and the cloud shell's ring feed the same screen. UiPorts carries the logger, so usecases invoked with a shell's ports bundle log for free.

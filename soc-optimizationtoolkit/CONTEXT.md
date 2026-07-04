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

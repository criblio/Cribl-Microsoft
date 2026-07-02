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

Workspace restructured 2026-07-01. cribl-app is the working scaffold; core/ui/local-app are placeholders awaiting the implementation roadmap (feature catalog review nearly complete).

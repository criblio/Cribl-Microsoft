# CONTEXT: @soc/ui

Purpose: the shared React feature screens and components rendered by both shells (cribl-app iframe and local-app browser UI).

Boundaries: imports only @soc/core. No direct fetch or storage access; all IO flows through core ports provided via React context by the hosting shell.

Layout convention: one folder per feature domain from the catalog (onboarding, dcr, packs, discovery, governance, lookups, migration, drift, labs) plus shared components/.

Status: first shared screen live. src/ports-context.ts defines PortsContext / PortsProvider / usePorts, carrying the six @soc/core port instances plus the active non-secret AzureConfig; onboarding/OnboardTableScreen drives the @soc/core onboardTable use-case (worker-group picker via cribl.listGroups, transient write-only-aware secret input, live step list from onProgress, honest summary and role-assignment guidance). Styling assumes the hosting shell's panel / panel-title / field / run-button / result class conventions.

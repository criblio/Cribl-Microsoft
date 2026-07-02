# CONTEXT: @soc/ui

Purpose: the shared React feature screens and components rendered by both shells (cribl-app iframe and local-app browser UI).

Boundaries: imports only @soc/core. No direct fetch or storage access; all IO flows through core ports provided via React context by the hosting shell.

Layout convention: one folder per feature domain from the catalog (onboarding, dcr, packs, discovery, governance, lookups, migration, drift, labs) plus shared components/.

Status: placeholder. Screens migrate here as feature domains are implemented.

# CLAUDE.md

Status: Living - binding agent instructions for this repository; corrected to
match the code whenever they drift.

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

<!-- VERBATIM: ## CRITICAL: Code Style Rules -->

<!-- VERBATIM: ## The board is the source of truth for work -->

## Project Overview

This repository is the **SOC Optimization Toolkit** - a TypeScript application
shipped as a **Cribl App Platform app**, installed as a `.tgz` into a Cribl.Cloud
leader UI and published to the Cribl Marketplace. It integrates Cribl Stream with
Microsoft Sentinel and Log Analytics: sample acquisition, gap analysis against
destination table schemas, Cribl pack generation, and Data Collection Rule
automation.

It was extracted from `criblio/Cribl-Microsoft` with its history. That
repository keeps the DCR ARM templates (`Azure/CustomDeploymentTemplates/DCR-Templates/`,
the path Cribl's published docs link) and the deprecated PowerShell tools; this
one carries only the app.

```
soc-optimizationtoolkit/
  apps/cribl-app     the Cribl.Cloud app (the shell; adapters live here)
  packages/core      pure domain logic and port interfaces - no IO, no React
  packages/ui        React screens, shell-agnostic
  docs/              board.json (work), backlog.md (reasoning), adr/ (decisions)
```

## Core Architecture

`soc-optimizationtoolkit/` is one npm workspace root (`package.json`
workspaces: `packages/*`, `apps/*`) with three members:

- **`packages/core`** - pure domain logic, use cases and port interfaces. No
  IO and no React; everything that talks to Azure, Cribl or GitHub does so
  through a port the shell implements.
- **`packages/ui`** - the React screens (`packages/ui/src/screens/`), shared
  and shell-agnostic.
- **`apps/cribl-app`** - the Cribl.Cloud shell: the adapters behind the core
  ports, the route table and nav (`src/App.tsx`), the shipped `config/`
  (`policies.yml`, `proxies.yml`), and the release and docs tooling under
  `scripts/`.

Each workspace carries a `CONTEXT.md` with its purpose and invariants, and
`soc-optimizationtoolkit/docs/adr/` holds the architecture decisions. The
committed `packages/core/src/assets/dcr-template-schemas.json` is a frozen
asset: the templates it was extracted from stay in the old repository.

## Common Development Commands

Run from `soc-optimizationtoolkit/`:

```bash
npm install            # install all workspaces
npm run dev            # cribl-app Vite dev server for Cribl Live Preview
npm run typecheck
npm run lint
npm test
npm run build
npm run package        # mint the next version, write the .tgz, refresh apps/cribl-app/release/
npm run check-docs     # documentation drift gate
```

CI (`.github/workflows/soc-toolkit-ci.yml`) also runs `check-listings`,
`check-classnames`, `check-release`, `check-board` and `check-board-freshness`.

### Prerequisites

- **Node 22** (the version CI uses) and npm, for the workspaces
- **Cribl.Cloud** with Cribl Apps; installing the app needs an Organization
  administrator
- Azure access is configured inside the app (the Setup page and its encrypted
  KV store), not in files

<!-- VERBATIM: ## Git Workflow -->

## Security Considerations

- **Never commit real credentials.** Azure and Cribl credentials live in the
  app's encrypted KV store, set on the Setup page; nothing in this repository
  needs one.
- Use placeholder values in examples and fixtures.
- The app's Azure identity needs Monitoring Metrics Publisher on each deployed
  DCR before data can flow; the app grants it from Select Azure Resources.

## Testing Approach

The pre-merge gates are the CI jobs in `.github/workflows/soc-toolkit-ci.yml`.
Run them locally from `soc-optimizationtoolkit/`:

1. `npm ci` (or `npm install`)
2. `npm run lint` and `npm run typecheck`
3. `npm run check-listings` and `npm run check-classnames`
4. `npm test` and `npm run build`
5. `npm run check-release`, `npm run check-docs`, `npm run check-board`,
   `npm run check-board-freshness`

Passing pins is not the same as working in the product: confirm a behaviour
change in Cribl Live Preview (`/apps/a/__local__` on the leader runs the
working tree with live credentials).

<!-- VERBATIM: ## Documentation Standards -->

<!-- VERBATIM: ## Shared standards -->

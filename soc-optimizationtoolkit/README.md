# SOC Optimization Toolkit

Cribl + Microsoft Sentinel SOC optimization, delivered as two targets from one shared codebase:

- `apps/cribl-app` - Cribl App Platform app (Cribl.Cloud), installed as a .tgz into the leader UI.
- `apps/local-app` - the same UI served by a local Node host, for customer-managed (on-prem) Cribl deployments. Its first run is the onboarding GUI that guides setup of either target.
- `packages/core` - pure domain logic and port interfaces (no IO, no React).
- `packages/ui` - shared React feature screens and components.

## Getting started

**Install without building:** the latest packaged app is committed at
[apps/cribl-app/release/](apps/cribl-app/release/). A Cribl.Cloud
Organization administrator installs it via **Apps** - **Add App** -
**Import from File**, then shares it (**Apps** - **Installed** -
**Share**) with the members or teams who should run it. The full
walkthrough, including first-run Azure setup and upgrades, is in the
repository [QUICK_START.md](../QUICK_START.md).

Working from source:

```
npm install
npm run dev        # cribl-app dev server (live preview inside Cribl)
npm run build      # build all workspaces
npm run package    # build the installable cribl-app .tgz + refresh release/
npm run local      # build and start the local Node-hosted app
```

Development gates: `npm run typecheck`, `npm run lint`, `npm test`.

## Plan and decisions

- Feature catalog and migration plan: [docs/feature-catalog.md](docs/feature-catalog.md)
- Architecture decisions: [docs/adr/](docs/adr/)
- Per-package purpose and invariants: CONTEXT.md in each workspace.

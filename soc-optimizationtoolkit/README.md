# SOC Optimization Toolkit

Cribl + Microsoft Sentinel SOC optimization, delivered as two targets from one shared codebase:

- `apps/cribl-app` - Cribl App Platform app (Cribl.Cloud), installed as a .tgz into the leader UI.
- `apps/local-app` - the same UI served by a local Node host, for customer-managed (on-prem) Cribl deployments. Its first run is the onboarding GUI that guides setup of either target.
- `packages/core` - pure domain logic and port interfaces (no IO, no React).
- `packages/ui` - shared React feature screens and components.

## Getting started

```
npm install
npm run dev        # cribl-app dev server (live preview inside Cribl)
npm run build      # build all workspaces
npm run package    # build and produce the installable cribl-app .tgz
npm run local      # local app host (placeholder until implemented)
```

## Plan and decisions

- Feature catalog and migration plan: [docs/feature-catalog.md](docs/feature-catalog.md)
- Architecture decisions: [docs/adr/](docs/adr/)
- Per-package purpose and invariants: CONTEXT.md in each workspace.

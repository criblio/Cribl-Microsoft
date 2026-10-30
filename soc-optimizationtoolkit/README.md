# SOC Optimization Toolkit

Status: Living - the toolkit's entry page; corrected to match the code.

Cribl + Microsoft Sentinel SOC optimization, delivered as a Cribl App Platform app:

- `apps/cribl-app` - Cribl App Platform app (Cribl.Cloud), installed as a .tgz into the leader UI.
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

Working from source (requires Node 22, the version CI uses):

```
npm install
npm run dev        # cribl-app dev server (live preview inside Cribl)
npm run build      # build all workspaces
npm run package    # build the installable cribl-app .tgz + refresh release/
```

Development gates: `npm run typecheck`, `npm run lint`, `npm test`,
`npm run build`. CI additionally runs `npm run check-release`, `check-docs`,
`check-board`, `check-listings`, `check-classnames`, `check-schema-asset` and
`check-board-freshness`.

## Plan and decisions

- Work: [docs/board.md](docs/board.md) (generated from docs/board.json) and
  [docs/backlog.md](docs/backlog.md) (reasoning)
- Process: [docs/documenting-work.md](docs/documenting-work.md)
- Legacy feature survey (Record): [docs/feature-catalog.md](docs/feature-catalog.md)
- Architecture decisions: [docs/adr/](docs/adr/)
- Per-package purpose and invariants: CONTEXT.md in each workspace.

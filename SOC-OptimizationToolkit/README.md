# SOC-OptimizationToolkit

Cribl SOC Optimization Toolkit for Microsoft Sentinel — a greenfield, self-contained consolidation of
the capabilities in this repository into one production-ready product (one destination: Microsoft
Sentinel; many pluggable sources via Cribl Stream).

**Start here:** [CONTEXT.md](CONTEXT.md) — the domain map, the layered structure, and the port-from
map. Then [docs/architecture.md](docs/architecture.md), the decisions in [docs/adr/](docs/adr/), and
the execution plan in [docs/roadmap.md](docs/roadmap.md).

This directory is independent of the rest of the repo. The existing `Cribl-Microsoft_IntegrationSolution/`
and `Azure/` trees remain the running product and the behavioral reference until this tree reaches
parity (see [docs/adr/0004-greenfield-independent-toolkit-directory.md](docs/adr/0004-greenfield-independent-toolkit-directory.md)).

## Status: Phase 0 scaffold

The monorepo skeleton (pnpm + Turborepo, empty package/app shells, CI, ESLint boundary rule). No
business logic yet — that begins with the Phase 1 walking skeleton. See
[docs/roadmap.md](docs/roadmap.md).

## Develop

```bash
corepack enable           # provides pnpm
pnpm install              # install the workspace
pnpm import:assets        # copy the ~100 ARM templates + prebuilt packs into packages/core/assets
pnpm validate             # lint + typecheck + test
pnpm dev:desktop          # launch the desktop GUI shell (or double-click Start-App-Windows.bat)
```

Launchers `Start-App-Windows.bat` / `Start-App-macOS.sh` run the desktop GUI **from source** (not a
packaged `.exe`) to avoid EDR false positives on corporate machines.

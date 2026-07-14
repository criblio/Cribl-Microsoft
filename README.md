# Cribl-Microsoft Integration

Tooling for integrating Cribl Stream with Microsoft Sentinel and Azure
Monitor. The active project is the **SOC Optimization Toolkit** in
[`soc-optimizationtoolkit/`](soc-optimizationtoolkit/) - a Cribl.Cloud app
(plus a local Node-hosted variant) that takes a Sentinel solution from
selection to production:

- **Sentinel Integration** - pick a solution, analyze sample data against
  the destination table (DCR gap analysis, analytics-rule and workbook
  coverage), review field mappings, then deploy everything: Kind:Direct
  DCRs, the Cribl Sentinel destination, and a generated Cribl pack with
  pipelines, routes, and reduction rules.
- **DCR Automation** - inventory existing Data Collection Rules across
  resource groups, preview schema drift with a color-coded diff, update
  DCRs in place, and add or remove fields on tables and DCRs (including
  native-table `_CF` columns and extension-column grafts).
- **Pack Maintenance** - inspect built packs, edit their mappings, rebuild
  at the next version, and install to multiple worker groups with in-place
  upgrades.

## Getting started

Build the Cribl.Cloud app package and upload it to your workspace:

```bash
cd soc-optimizationtoolkit
npm install
npm run package   # writes apps/cribl-app/build/soc-optimizationtoolkit-<version>.tgz
```

Development gates: `npm run typecheck`, `npm run lint`, `npm test`,
`npm run build` (all from `soc-optimizationtoolkit/`).

## Repository layout

| Path | Contents |
| --- | --- |
| `soc-optimizationtoolkit/` | The active toolkit: `packages/core` (pure domain + usecases), `packages/ui` (shared React screens), `apps/cribl-app` (Cribl.Cloud shell), `apps/local-app` (local Node host) |
| `KnowledgeArticles/` | Integration knowledge base articles |
| `Dev/` | Development scratch area |
| `deprecated/` | Superseded components (PowerShell automation, the Electron GUI, v1 toolkit) - see [deprecated/README.md](deprecated/README.md) |

## Security

Never commit credentials. See [SECURITY.md](SECURITY.md) and
[SECURITY_DISCLAIMER.md](SECURITY_DISCLAIMER.md).

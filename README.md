# Cribl-Microsoft Integration

Tooling for integrating Cribl Stream with Microsoft Sentinel and Azure
Monitor. The active project is the **SOC Optimization Toolkit** in
[`soc-optimizationtoolkit/`](soc-optimizationtoolkit/) - a Cribl.Cloud app
(plus a local Node-hosted variant) that takes a Sentinel solution from
selection to production:

- **Setup** - one page for every setup task: connect the Entra app
  registration (with verified secret storage), discover and select Azure
  resources with generated role-assignment scripts and effective-permission
  validation, and connect GitHub content access.
- **Sentinel Integration** - pick a solution, analyze sample data against
  the destination table (DCR gap analysis, analytics-rule and workbook
  coverage), review field mappings, then deploy everything: Kind:Direct
  DCRs, the Cribl Sentinel destination, and a generated Cribl pack with
  pipelines, routes, and reduction rules. Custom `_CL` tables with no
  published schema (CCF solutions) derive their schema from the sample data
  and the solution's rule/workbook references, and are created on deploy.
- **DCR Automation** - inventory existing Data Collection Rules across
  resource groups, preview schema drift with a color-coded diff, update
  DCRs in place, and add or remove fields on tables and DCRs (including
  native-table `_CF` columns and extension-column grafts).
- **Pack Maintenance** - inspect built packs, edit their mappings, rebuild
  at the next version, and install to multiple worker groups with in-place
  upgrades.
- **SIEM Migration** - upload a Splunk or IBM QRadar detection-rule export;
  the analyzer identifies the data sources the rules depend on, maps them to
  Sentinel solutions and tables with confidence scoring and MITRE coverage,
  and pivots each mapped solution straight into Sentinel Integration.

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

Never commit credentials - use placeholders in configuration files and
keep real values in environment variables or Cribl/Azure secret stores.

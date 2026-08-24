# Cribl-Microsoft Integration

Tooling for integrating Cribl Stream with Microsoft Sentinel and Azure
Monitor. There are two ways to use this repository: the **SOC Optimization
Toolkit**, which automates the whole path, and the **DCR templates**, which
you deploy yourself. See [Choosing a path](#choosing-a-path) below.

The active project is the **SOC Optimization Toolkit** in
[`soc-optimizationtoolkit/`](soc-optimizationtoolkit/) - a Cribl.Cloud app
that takes a Sentinel solution from selection to production:

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

## Choosing a path

| | SOC Optimization Toolkit | DCR templates (manual) |
| --- | --- | --- |
| What you get | Gap analysis, field mapping, generated Cribl pack, DCR and destination deployed for you | An ARM template per table; you deploy it and wire Cribl up yourself |
| Where it runs | Cribl.Cloud only - Cribl Apps do not install on customer-managed leaders | Anywhere: Azure Portal, CLI, or your own IaC |
| Who installs it | Cribl.Cloud Organization administrator | Anyone with rights to deploy a DCR |
| Coverage | Native and custom `_CL` tables, including CCF solutions with no published schema | 50 Sentinel native tables, Direct and DCE variants |
| Best when | You want the whole integration built and maintained for you | You run a customer-managed leader, need one table, or want the DCR under your own IaC |

The two are not exclusive - the toolkit generates the same kind of DCR the
templates describe, so a template is also a reasonable way to see what the
toolkit will produce before running it.

### The manual option

[`Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables/`](Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables/)
holds 100 pre-built ARM templates - 50 Sentinel native tables in two
variants, with the full schema for each:

- **`DataCollectionRules(NoDCE)/`** - Direct DCRs (`"kind": "Direct"`). No
  Data Collection Endpoint, so no DCE charges, and the simpler deployment.
  DCR names are limited to 30 characters. Requires Cribl Stream 4.14+.
- **`DataCollectionRules(DCE)/`** - DCE-based DCRs for advanced routing and
  private endpoints. Needs a DCE created first, costs more, and allows
  64-character names.

Start with Direct unless you specifically need private endpoints or DCE
routing. Deploy the template, then point a Cribl **Microsoft Sentinel**
destination at the resulting DCR - see
[Cribl's Sentinel destination docs](https://docs.cribl.io/stream/destinations-sentinel/)
for the destination side. Per-table details are in the
[templates README](Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables/README.md).

## Getting started

The latest installable app package is COMMITTED in this repository - no
build required. See [QUICK_START.md](QUICK_START.md) for the full
walkthrough; the short version:

1. Download
   [`soc-optimizationtoolkit/apps/cribl-app/release/`](soc-optimizationtoolkit/apps/cribl-app/release/)
   (one `.tgz`, always the latest release).
2. As a Cribl.Cloud **Organization administrator**: **Apps** (top
   navigation) - **Add App** - **Import from File** - select the `.tgz`,
   review the declared endpoints and product-API policies, and confirm.
3. Share the app (**Apps** - **Installed** - **Share**) with the members
   or teams who should use it, then open it from the Apps bar.
4. Inside the app, start at **Setup** to connect Azure (Entra app
   registration, resource targeting, permission validation).

To build from source instead:

```bash
cd soc-optimizationtoolkit
npm install
npm run package   # mints the next version, writes build/<name>-<version>.tgz
                  # and refreshes apps/cribl-app/release/
```

Development gates: `npm run typecheck`, `npm run lint`, `npm test`,
`npm run build` (all from `soc-optimizationtoolkit/`).

## Repository layout

| Path | Contents |
| --- | --- |
| `soc-optimizationtoolkit/` | The active toolkit: `packages/core` (pure domain + usecases), `packages/ui` (shared React screens), `apps/cribl-app` (Cribl.Cloud shell) |
| `Azure/CustomDeploymentTemplates/DCR-Templates/` | Pre-built ARM templates for Sentinel native tables - the manual path, and the target of Cribl's published documentation links |
| `KnowledgeArticles/` | Integration knowledge base articles |
| `Dev/` | Development scratch area |
| `deprecated/` | Superseded components (PowerShell automation, the Electron GUI, v1 toolkit) - see [deprecated/README.md](deprecated/README.md) |

## Security

Never commit credentials - use placeholders in configuration files and
keep real values in environment variables or Cribl/Azure secret stores.

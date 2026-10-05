# CLAUDE.md

Status: Living - binding agent instructions for this repository; corrected to
match the code whenever they drift.

> **DEPRECATION NOTE (2026-07-13):** the PowerShell automation, Electron
> GUI, standalone lookups/packs, and the v1 toolkit described below were
> moved to `deprecated/` and are superseded by `soc-optimizationtoolkit/`
> (npm workspaces: packages/core, packages/ui, apps/cribl-app). New work
> happens there; path references below to `Azure/...` now live under
> `deprecated/Azure/...`, EXCEPT `Azure/CustomDeploymentTemplates/DCR-Templates/`,
> which stays at the root (Cribl's published docs link it).


This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CRITICAL: Code Style Rules

**NEVER USE EMOJIS**: Do not use emojis in any code, comments, output messages, documentation, or communication. This is a strict requirement for all files in this repository.

## The board is the source of truth for work

`soc-optimizationtoolkit/docs/board.json` is the source; `docs/board.md` is
GENERATED from it and CI fails if it is edited by hand. Read the full process in
`soc-optimizationtoolkit/docs/documenting-work.md` before changing how work is
tracked - this section is the summary that survives into a fresh session.

```bash
cd soc-optimizationtoolkit
npm run board          # regenerate board.md from board.json
npm run check-board    # validate the data and the rendered file (CI runs this)
npm run board:serve    # live kanban on http://localhost:5175, auto-refreshes
npm run groom          # what to work on next, and what is really blocking it
npm run groom -- integrate   # ...narrowed to one MENU ITEM
```

Every feature carries a `menu` - which part of the product it is about, using
the app's own route ids. `npm run board` renders a "By menu item" rollup, and
the live kanban has a menu filter. Two values (`azure-onboarding`,
`windows-events`) name PLANNED screens with no route yet; `none` means no
operator sees it (release mechanics, docs, board tooling) and is not a synonym
for "unsure".

Four rules, all learned the hard way:

1. **Move a card to `in-progress` BEFORE starting**, not after finishing. The
   In progress column read `0` for an entire session because every card went
   straight from backlog to done, so the board only ever described finished work.
   This holds when SUBAGENTS do the work too: dispatching a fan-out is starting,
   so the cards move before the agents launch, not when their results land.
2. **A defect found in COMMITTED code becomes a card before it is fixed**, even
   for a five-minute fix - file it, work it, close it with a `verified` value.
   Something you introduce and fix while drafting is editing and needs no card.
   Six defects were found and fixed in one day with no card at all; they existed
   only in commit messages.
3. **`verified` on a done card says how it was confirmed** - `pins`, `live`,
   `both` or `none`. `none` is honest for prose. Never let it borrow credibility
   from the thing being described.
4. **A `bug` card is `priority: now` unless it says why not.** Broken behaviour
   outranks new behaviour by default: a defect is already costing someone
   something, while a feature is only not-yet-earning. A lower priority stays
   available at the price of a `priorityWhy` on the card - `check-board` FAILS
   on a deprioritised bug without one, and on a placeholder. Write the argument,
   not "cosmetic". The rule exists in the tooling rather than only here because
   rule 1 was prose-only and got broken the day it was read.

Open questions can be answered on the card: a `decision` block renders as
clickable options in the live kanban, and answering records `chosen` WITHOUT
settling the card, because the reasoning still has to reach `backlog.md`.

For grooming - ordering, leverage, and what is blocking what - use the
`backlog-grooming` skill rather than reasoning it out.

## Project Overview

This is the **Cribl-Microsoft Integration** repository. Its deliverable is the
**SOC Optimization Toolkit** in `soc-optimizationtoolkit/` - a TypeScript
application shipped as a **Cribl App Platform app**, installed as a `.tgz` into
a Cribl.Cloud leader UI. It integrates Cribl Stream with Microsoft Sentinel and
Log Analytics: sample acquisition, gap analysis against destination table
schemas, Cribl pack generation, and Data Collection Rule automation.

```
soc-optimizationtoolkit/
  apps/cribl-app     the Cribl.Cloud app (the shell; adapters live here)
  packages/core      pure domain logic and port interfaces - no IO, no React
  packages/ui        React screens, shell-agnostic
  docs/              board.json (work), backlog.md (reasoning), adr/ (decisions)
```

**The PowerShell toolkit is DEPRECATED.** It was moved to `deprecated/` on
2026-07-13 and receives no further development. The PowerShell sections further
down this file describe it, and their paths are relative to `deprecated/` - for
example `deprecated/Azure/CustomDeploymentTemplates/DCR-Automation/`. Do not
start new work there; `deprecated/README.md` records what superseded each part.

## Core Architecture

### Workspaces

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
`soc-optimizationtoolkit/docs/adr/` holds the architecture decisions.

### Other components

1. **DCR-Templates** ([Azure/CustomDeploymentTemplates/DCR-Templates/](Azure/CustomDeploymentTemplates/DCR-Templates/))
 - 100 pre-built ARM templates (50 Sentinel native tables, Direct and DCE variants)
 - Organized by deployment mode (DCE vs. Non-DCE)
 - The manual path, and the target of Cribl's published documentation links -
   keep this path stable

2. **Deprecated components** - everything under `deprecated/`; see
   [Deprecated PowerShell toolkit](#deprecated-powershell-toolkit-deprecated-only)
   below and `deprecated/README.md`.

## Common Development Commands

### SOC Optimization Toolkit

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
`check-schema-asset`, `check-classnames`, `check-release`, `check-board` and
`check-board-freshness` - see [Testing Approach](#testing-approach).

### Prerequisites (toolkit)

- **Node 22** (the version CI uses) and npm, for the workspaces
- **Cribl.Cloud** with Cribl Apps; installing the app needs an Organization
  administrator
- Azure access is configured inside the app (the Setup page and its encrypted
  KV store), not in files

## Deprecated PowerShell toolkit (deprecated/ only)

Everything in this section describes components under `deprecated/`. They
receive no further development; it is kept because the moved code still runs
and its history is preserved. New work belongs in `soc-optimizationtoolkit/`.

### Directory Organization

The deprecated PowerShell tools use a **dev/core configuration pattern**:
- A hidden `.dev-mode` flag file determines environment selection
- `dev/` subdirectories contain experimental/testing code (gitignored, so they
  are not in a clone)
- `core/` subdirectories contain production-ready configurations
- Configuration files (`azure-parameters.json`, `operation-parameters.json`) live in `core/`

### Main Components

1. **DCR-Automation** (DEPRECATED - [deprecated/Azure/CustomDeploymentTemplates/DCR-Automation/](deprecated/Azure/CustomDeploymentTemplates/DCR-Automation/))
 - Core automation engine in `core/Create-TableDCRs.ps1` (~3,400 lines)
 - Interactive menu interface via `Run-DCRAutomation.ps1`
 - Cribl configuration generator in `core/Generate-CriblDestinations.ps1`
 - Supports two deployment modes:
 - **Direct DCRs**: Simple, direct ingestion (30-char name limit)
 - **DCE-based DCRs**: Advanced routing via Data Collection Endpoints (64-char limit)

2. **Discovery Tools** (DEPRECATED)
 - vNet Flow Log discovery and Cribl config generation:
   [deprecated/Azure/vNetFlowLogs/vNetFlowLogDiscovery/](deprecated/Azure/vNetFlowLogs/vNetFlowLogDiscovery/)
 - Event Hub discovery is superseded by the toolkit's Event Hub Discovery screen
   (`packages/ui/src/screens/eventhub-discovery/`); no tracked PowerShell copy remains

3. **Lab Automation** (DEPRECATED - [deprecated/Azure/Labs/](deprecated/Azure/Labs/): AzureFlowLogLab, UnifiedLab).
 Superseded by the toolkit's Labs screen (`packages/ui/src/screens/labs/`).

### Key Design Patterns

- **Interactive Menu Pattern**: Main entry points (`Run-*.ps1`) use menu interfaces with fallback to non-interactive mode for CI/CD
- **Configuration-Driven**: JSON configuration files separate from scripts
- **Template-Based Generation**: ARM templates and Cribl configs generated from parameterized templates
- **Name Abbreviation Intelligence**: Auto-truncates table names to fit Azure's 30-character Direct DCR limit while preserving readability

### Commands

```powershell
# DCR Automation - interactive menu (recommended for manual operations)
.\deprecated\Azure\CustomDeploymentTemplates\DCR-Automation\Run-DCRAutomation.ps1

# DCR Automation - non-interactive mode (for automation/CI-CD)
.\deprecated\Azure\CustomDeploymentTemplates\DCR-Automation\Run-DCRAutomation.ps1 -NonInteractive -Mode DirectBoth

# DCR Automation - template generation only (no deployment)
.\deprecated\Azure\CustomDeploymentTemplates\DCR-Automation\Run-DCRAutomation.ps1 -NonInteractive -Mode TemplateOnly

# vNet Flow Log discovery
.\deprecated\Azure\vNetFlowLogs\vNetFlowLogDiscovery\Run-vNetFlowLogDiscovery.ps1

# Azure Flow Log Lab
.\deprecated\Azure\Labs\AzureFlowLogLab\Run-AzureFlowLogLab.ps1

# Unified Lab
.\deprecated\Azure\Labs\UnifiedLab\Run-AzureUnifiedLab.ps1
```

Azure authentication, required before running any of them:

```powershell
Connect-AzAccount
Set-AzContext -Subscription "Your-Subscription-Name" # If multiple subscriptions
```

### Configuration Setup

Before running the deprecated DCR-Automation, configure these files under
`deprecated/Azure/CustomDeploymentTemplates/DCR-Automation/`:

1. **Azure Settings**: `core/azure-parameters.json`
 - Resource Group, Workspace, Location
 - Tenant ID, Client ID, Client Secret (for Cribl authentication)
 - DCR/DCE naming prefixes and suffixes

2. **Operation Settings**: `core/operation-parameters.json`
 - `createDCE`: false for Direct DCRs, true for DCE-based
 - `templateOnly`: true to generate templates without deploying
 - `customTableSettings.enabled`: true to process custom tables

3. **Table Lists**:
 - `core/NativeTableList.json`: Native Azure tables (e.g., SecurityEvent, Syslog)
 - `core/CustomTableList.json`: Custom tables (must have `_CL` suffix)

4. **Custom Table Schemas**: `core/custom-table-schemas/`
 - Create JSON schema files for custom tables that don't exist in Azure yet
 - Format: `TableName_CL.json` with columns array defining name/type

### DCR Deployment Modes

| Mode | Command Flag | Purpose |
|------|--------------|---------|
| DirectNative | `-Mode DirectNative` | Deploy native tables with Direct DCRs |
| DirectCustom | `-Mode DirectCustom` | Deploy custom tables with Direct DCRs |
| DirectBoth | `-Mode DirectBoth` | Deploy all tables with Direct DCRs |
| DCENative | `-Mode DCENative` | Deploy native tables with DCE |
| DCECustom | `-Mode DCECustom` | Deploy custom tables with DCE |
| DCEBoth | `-Mode DCEBoth` | Deploy all tables with DCE |
| TemplateOnly | `-Mode TemplateOnly` | Generate ARM templates without deploying |

The `-Mode` ValidateSet (`Run-DCRAutomation.ps1:10-14`) also accepts `Native`,
`Custom`, `Both`, `Status`, `PrivateLinkNative`, `PrivateLinkCustom`,
`CollectCribl`, `ValidateCribl` and `ResetCribl`; the tool's own README
describes them.

### Table Naming Conventions

- **Native Tables**: Standard Azure table names (e.g., SecurityEvent, CommonSecurityLog)
- **Custom Tables**: Must end with `_CL` suffix (e.g., CloudFlare_CL, MyApp_CL)
- **Direct DCR Limit**: 30 characters maximum (script auto-abbreviates)
- **DCE-based Limit**: 64 characters maximum

### Schema Management

- Native table schemas: Automatically retrieved from Azure Log Analytics
- Custom table schemas:
 - Retrieved from Azure if table exists
 - Loaded from `custom-table-schemas/` if table doesn't exist
 - Must define all columns with proper data types

### Cribl Configuration Export

After DCR deployment, the script automatically exports:
- `core/cribl-dcr-configs/cribl-dcr-config.json`: Main configuration
- `core/cribl-dcr-configs/destinations/*.json`: Individual destination configs
- Includes DCR IDs, ingestion endpoints, and stream names
- Client ID is properly quoted in JSON output

### Output Directories

These directories are auto-created by the deprecated scripts (do not commit):
- `core/generated-templates/`: ARM templates generated by automation
- `core/cribl-dcr-configs/`: Cribl Stream destination configurations
- `eventhub-discovery-results/`: Event Hub discovery output
- `cribl-destinations/`: vNet Flow Log Cribl configs

### Prerequisites (deprecated PowerShell)

- **Cribl Stream**: 4.14+ required for Direct DCRs (Kind:Direct)
- **PowerShell**: 5.1+ with Azure modules (Az.Accounts, Az.Resources, Az.OperationalInsights)
- **Azure Permissions**: Sufficient rights to create DCRs, DCEs, and custom tables
- **Log Analytics Workspace**: Must be created before running automation

### Testing (deprecated PowerShell and DCR-Templates changes)

1. Test with both Direct and DCE-based DCRs
2. Verify custom table creation works
3. Ensure Cribl config export is accurate
4. Deploy templates in test environment
5. Validate data flows to Log Analytics
6. Test with different Azure regions if applicable

## Cribl SDKs and Terraform Provider

This repository can be extended with Python automation or Terraform infrastructure-as-code using Cribl's official SDKs and Terraform provider.

### Cribl Python SDKs

Cribl provides two Python SDKs for different management planes:

#### 1. Cribl Cloud Management SDK (Preview)
**Purpose**: Operational control of administrative tasks like configuring and managing Workspaces.

**Status**: Preview feature, not recommended for production use.

**Installation**:
```bash
# Using pip
pip install cribl-mgmt-plane

# Using uv
uv add cribl-mgmt-plane

# Using poetry
poetry add cribl-mgmt-plane
```

**Authentication**:
- **OAuth2**: Recommended (via `client_oauth`)
- **Bearer Token**: Simple token-based (via `bearer_auth`)
- Environment variables: `CRIBLMGMTPLANE_CLIENT_OAUTH` or `CRIBLMGMTPLANE_BEARER_AUTH`

**Basic Usage Example**:
```python
from cribl_mgmt_plane import CriblMgmtPlane, models

with CriblMgmtPlane(
    security=models.Security(
        client_oauth=models.SchemeClientOauth(
            client_id="YOUR_CLIENT_ID",
            client_secret="YOUR_CLIENT_SECRET",
            token_url="YOUR_TOKEN_URL",
            audience="https://api.cribl.cloud"
        )
    )
) as client:
    # Check health
    response = client.health.get()

    # Manage workspaces
    workspaces = client.workspaces.list()
    workspace = client.workspaces.create(...)
    client.workspaces.update(workspace_id, ...)
    client.workspaces.delete(workspace_id)
```

**Available Operations**:
- `health.get()` - Application health status
- `workspaces.create()`, `list()`, `update()`, `delete()`, `get()` - Workspace management

**Advanced Features**:
- Async/await support via `get_async()` methods
- Configurable retry strategies with backoff
- Custom HTTP client integration
- Server URL override support

**Documentation**: https://docs.cribl.io/cribl-as-code/api-reference

#### 2. Cribl Control Plane SDK (Preview)
**Purpose**: Operational control over Cribl resources (destinations, worker groups, edge fleets, etc.).

**Status**: Preview feature, not recommended for production use.

**Installation**:
```bash
# Using pip
pip install cribl-control-plane

# Using uv
uv add cribl-control-plane

# Using poetry
poetry add cribl-control-plane
```

**Authentication**:
- **Bearer Token**: Via `CRIBLCONTROLPLANE_BEARER_AUTH` environment variable
- **OAuth2**: Token-based via `CRIBLCONTROLPLANE_CLIENT_OAUTH` environment variable

**Basic Usage Example**:
```python
from cribl_control_plane import CriblControlPlane, models
import asyncio

# Synchronous usage
with CriblControlPlane(security=models.Security(...)) as client:
    # List destinations
    destinations = client.destinations.list()

    # Create destination
    new_dest = client.destinations.create(...)

    # Update destination
    client.destinations.update(dest_id, ...)

    # Delete destination
    client.destinations.delete(dest_id)

# Asynchronous usage
async def manage_cribl():
    async with CriblControlPlane(security=models.Security(...)) as client:
        destinations = await client.destinations.list_async()
        # ... other async operations
```

**Available Operations**:
- **Destinations**: List, create, update, delete (including Azure Sentinel/Log Analytics destinations)
- **Worker Groups and Edge Fleets**: Management and monitoring
- **Lake Datasets**: Operations and configuration
- **Node Monitoring**: Summaries and counts
- **Health Checks**: Status verification
- **Persistent Queues**: Operations for destinations
- **Sample Data**: Handling for testing

**IDE Support**: PyCharm users benefit from installing the Pydantic plugin for enhanced integration.

### Cribl Terraform Provider

**Purpose**: Manage Cribl resources through Terraform infrastructure-as-code automation.

**Installation**:
```hcl
terraform {
  required_providers {
    criblio = {
      source = "criblio/criblio"
    }
  }
}
```

**Authentication Methods** (prioritized in order):
1. **Provider Configuration Block** (highest priority)
2. **Environment Variables**
3. **Credentials File** at `~/.cribl/credentials`

**Bearer Token Authentication** (Simplest):
```hcl
provider "criblio" {
  bearer_token = "your-bearer-token"
}
```

Or via environment variable:
```bash
export CRIBL_BEARER_TOKEN="your-bearer-token"
```

**OAuth Credentials** (Recommended):
```hcl
provider "criblio" {
  client_id       = "your-client-id"
  client_secret   = "your-client-secret"
  organization_id = "your-organization-id"
  workspace_id    = "your-workspace-id"
}
```

Or via environment variables:
```bash
export CRIBL_CLIENT_ID="your-client-id"
export CRIBL_CLIENT_SECRET="your-client-secret"
export CRIBL_ORGANIZATION_ID="your-organization-id"
export CRIBL_WORKSPACE_ID="your-workspace-id"
```

**Basic Usage Example**:
```hcl
# Configure the Cribl provider
provider "criblio" {
  client_id       = var.cribl_client_id
  client_secret   = var.cribl_client_secret
  organization_id = var.cribl_organization_id
  workspace_id    = var.cribl_workspace_id
}

# Example: Create a destination (syntax will vary by resource type)
resource "criblio_destination" "azure_sentinel" {
  # Configuration based on provider documentation
}
```

**Requirements**:
- Terraform >= 1.0
- Go >= 1.19 (for provider development)

**Key Features**:
- 45+ resources for managing Cribl infrastructure
- 50+ data sources for querying Cribl configurations
- Automatic generation of dependency inventories
- Continuous vulnerability monitoring

**Documentation**:
- Provider Documentation: https://registry.terraform.io/providers/criblio/criblio/latest/docs
- GitHub Repository: https://github.com/criblio/terraform-provider-criblio

### Integration with This Repository

The SOC Optimization Toolkit deploys the Cribl Sentinel destination itself
through the Cribl product API; it has no JSON export step. What follows applies
to the DEPRECATED PowerShell DCR-Automation, which writes Cribl destination
configurations as JSON files. These can be:

1. **Manually imported** into Cribl Stream UI
2. **Automated via Python SDKs**: Use the Control Plane SDK to programmatically create destinations from generated JSON
3. **Managed via Terraform**: Convert JSON configurations to Terraform HCL for infrastructure-as-code deployment

**Example Integration Workflow** (deprecated tool; step 2a is a script you would
write - none ships in this repository):
```powershell
# Step 1: Generate DCRs and Cribl configs with the deprecated DCR-Automation
.\deprecated\Azure\CustomDeploymentTemplates\DCR-Automation\Run-DCRAutomation.ps1 -NonInteractive -Mode DirectBoth -ExportCriblConfig

# Step 2a: Use the Python SDK from your own script (hypothetical name)
python deploy_cribl_destinations.py --config-dir core/cribl-dcr-configs

# Step 2b: Or use Terraform to manage as infrastructure-as-code
terraform apply -var-file="cribl.tfvars"
```

**Security Note**: When using SDKs or Terraform provider, store credentials securely:
- Use environment variables for CI/CD pipelines
- Use Azure Key Vault for production secrets
- Never commit credentials to version control
- Consider Cribl's built-in secrets management for sensitive values

## Git Workflow

 **The `main` branch is protected** - all changes must come through pull requests.

### Branch Naming Convention

- `feature/` - New features or enhancements
- `fix/` - Bug fixes
- `docs/` - Documentation updates
- `refactor/` - Code refactoring
- `test/` - Test additions or updates

### Standard Workflow

```bash
# Always start from latest main
git checkout main
git pull origin main

# Create feature branch
git checkout -b feature/your-feature-name

# Make changes and commit
git add .
git commit -m "Clear description of changes"

# Push to remote
git push origin feature/your-feature-name

# Create Pull Request on GitHub
```

### Commit Message Guidelines

- Use present tense verbs ("Add" not "Added")
- Keep first line under 50 characters
- Be descriptive and specific
- Good:
 - "Add support for custom table schemas"
 - "Fix timeout issue in DCR deployment"
- Bad:
 - "Fixed stuff"
 - "WIP"

## Security Considerations

- **Never commit real credentials** in `azure-parameters.json` or other config files
- Use placeholder values like `<YOUR-TENANT-ID-HERE>` in examples
- Azure AD credentials in config files must be manually secured (use .gitignore)
- Support for Cribl secrets management for client secret storage
- Required Azure RBAC roles:
 - Storage Blob Data Reader (for vNet Flow Logs)
 - Monitoring Metrics Publisher (for DCR access)

## File Locations Reference

Key files are located in:
- Main automation (DEPRECATED): [deprecated/Azure/CustomDeploymentTemplates/DCR-Automation/](deprecated/Azure/CustomDeploymentTemplates/DCR-Automation/)
- Static templates: [Azure/CustomDeploymentTemplates/DCR-Templates/](Azure/CustomDeploymentTemplates/DCR-Templates/)
- Discovery tools (DEPRECATED): [deprecated/Azure/vNetFlowLogs/vNetFlowLogDiscovery/](deprecated/Azure/vNetFlowLogs/vNetFlowLogDiscovery/)
- Labs (DEPRECATED): [deprecated/Azure/Labs/](deprecated/Azure/Labs/)
- Documentation: [KnowledgeArticles/](KnowledgeArticles/)
- **The current toolkit**: [soc-optimizationtoolkit/](soc-optimizationtoolkit/) - see its `README.md` and `docs/`

## Testing Approach

The pre-merge gates for the toolkit are the CI jobs in
`.github/workflows/soc-toolkit-ci.yml`, run on every PR that touches
`soc-optimizationtoolkit/`. Run them locally from `soc-optimizationtoolkit/`:

1. `npm ci` (or `npm install`)
2. `npm run lint` and `npm run typecheck`
3. `npm run check-listings`, `npm run check-schema-asset`, `npm run check-classnames`
4. `npm test` and `npm run build`
5. `npm run check-release`, `npm run check-docs`, `npm run check-board`,
   `npm run check-board-freshness`

Passing pins is not the same as working in the product: confirm a behaviour
change in Cribl Live Preview (`/apps/a/__local__` on the leader runs the
working tree with live credentials). Changes to the deprecated PowerShell tools
or the DCR templates follow the
[deprecated testing checklist](#testing-deprecated-powershell-and-dcr-templates-changes).

## Documentation Standards

Every contribution should include:
- Updated README if adding new features
- A `Status:` on every new document, per `soc-optimizationtoolkit/docs/documenting-work.md`
- Inline comments for complex logic
- Parameter descriptions for all configurable options
- Usage examples for new functionality
- Clear error messages with actionable guidance

## Shared standards — read before designing

Durable, cross-project conventions live in **`claude-kit`**
(`github.com/jamespederson1/claude-kit`, cloned to `~/git/claude-kit` or
`Desktop/git/claude-kit`).

- **`standards/`** — how we build a given thing, and why. **Read the relevant file BEFORE**
  designing, building, or reviewing that kind of work. These encode decisions already made;
  reinventing them has been rejected more than once.
- **`skills/`** — linked to `~/.claude/skills`, so they load automatically in every project.
  You do not need to do anything to use them.

Start with `standards/README.md` — it indexes what exists.

### Updating the standards

When something learned here stops being about this project and becomes *how we do the thing*,
promote it:

1. Write or edit the file in `claude-kit/standards/` (or add a skill under `claude-kit/skills/`)
2. Add it to `standards/README.md`
3. Commit and push — `gh auth switch --user jamespederson1` first, then switch back

Because `~/.claude/skills` is a junction to the repo, edits take effect **immediately in every
project**, before the push.

**Keep customer specifics out of claude-kit** — names, org ids, environment details, anything marked
internal. Those belong in this project's own memory, which is not synced.

---

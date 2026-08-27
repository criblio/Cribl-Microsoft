# CLAUDE.md - Azure Log Collection

This file provides guidance to Claude Code when working with the Azure-LogCollection solution.

## CRITICAL: Code Style Rules

**NEVER USE EMOJIS**: Do not use emojis in any code, comments, output messages, documentation, or communication. This is a strict requirement inherited from the parent repository.

## Solution Overview

The **Azure-LogCollection** solution collects Azure diagnostic logs and Microsoft Defender XDR telemetry, sending them to Event Hubs for Cribl Stream ingestion. It includes:
- **Azure Diagnostic Settings**: Uses Microsoft's built-in policy initiatives to configure logging across 69+ resource types
- **Microsoft Defender XDR**: Guides setup of the XDR Streaming API for endpoint, identity, email, and cloud app telemetry

**Key Goal**: Automatically configure diagnostic settings across 60-123+ Azure resource types and guide setup of Defender XDR streaming, routing logs through Event Hubs to Cribl Stream for processing.

## Architecture

### Directory Structure

```
Azure-LogCollection/
    Run-AzureLogCollection.ps1            # Main entry point (interactive menu)
    core/
        Deploy-EventHubNamespaces.ps1     # Creates Event Hub infrastructure
        Deploy-BuiltInPolicyInitiatives.ps1  # Assigns built-in policies
        Deploy-CommunityPolicyInitiative.ps1 # Community initiative (44 types including Storage)
        Deploy-SupplementalPolicies.ps1   # Activity Log policy (subscription-level)
        Deploy-EntraIDDiagnostics.ps1     # Entra ID log streaming
        Deploy-DefenderExport.ps1         # Defender for Cloud export
        Deploy-DefenderXDRStreaming.ps1   # Defender XDR Streaming API
        Analyze-ComplianceGaps.ps1        # Gap analysis for coverage
        Generate-CriblEventHubSources.ps1 # Cribl Stream source configs
        Output-Helper.ps1                 # Shared logging utilities
        azure-parameters.json             # Configuration file (EDIT THIS)
        resource-coverage.json            # Enable/disable log sources
        region-inventory/                 # Discovery results (auto-generated)
        cribl-configs/                    # Cribl Stream configs (auto-generated)
        logs/                             # Deployment logs
        reports/                          # Gap analysis reports
    docs/
        MCSB-AUDIT-LOGGING-ANALYSIS.md    # MCSB research
    README.md
    QUICK_START.md
    MANUAL_SETUP_GUIDE.md                 # Portal-based setup (no PowerShell)
    ARCHITECTURE_SUMMARY.md
    EVENT_HUB_BEHAVIOR.md
```

### Deployment Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **Centralized** | Single Event Hub Namespace in one region | Simple setup, lower cost, small deployments |
| **Multi-Region** | Per-region namespaces with resourceSelectors | Data residency, compliance, multi-region deployments |

### Built-in Policy Initiatives

| Initiative | ID | Resource Types | Use Case |
|------------|----|--------------:|----------|
| **audit** | `1020d527-2764-4230-92cc-7035e4fcf8a7` | 69 | Security monitoring, compliance, cost-conscious |

### Community Policy Initiative

The `Deploy-CommunityPolicyInitiative.ps1` script creates a custom initiative from 44 community policies (including Storage services):

| Tier | Resources | Examples |
|------|-----------|----------|
| Storage | 5 types | Blob, File, Queue, Table, Storage Accounts |
| Security | 5 types | Firewall, NSG, Application Gateway, ExpressRoute, VirtualNetwork |
| Data | 12 types | CosmosDB, Synapse, Data Factory, Databricks, MySQL, PostgreSQL |
| Compute | 7 types | App Service, Function App, Batch, Machine Learning, Application Insights |
| Integration | 5 types | Logic Apps, Event Grid Topic, Event Grid System Topic, Relay |
| Networking | 3 types | Load Balancer, Traffic Manager, CDN Endpoint |
| AVD | 4 types | Host Pool, Application Group, Workspace, Scaling Plan |
| Other | 3 types | Recovery Services, Healthcare APIs, Power BI Embedded |

```powershell
# Deploy all community policies as initiative
.\core\Deploy-CommunityPolicyInitiative.ps1

# Deploy specific tiers
.\core\Deploy-CommunityPolicyInitiative.ps1 -PolicyTiers Storage,Security,Data

# Validate without deploying
.\core\Deploy-CommunityPolicyInitiative.ps1 -ValidateOnly
```

### Shared Helper Functions (Output-Helper.ps1)

All deployment scripts use shared helper functions from `Output-Helper.ps1`:

| Function | Purpose |
|----------|---------|
| `Write-Step` / `Write-StepHeader` | Major step headers |
| `Write-SubStep` | Sub-step messages |
| `Write-Success` | Success messages |
| `Write-WarningMsg` | Warning messages |
| `Write-ErrorMsg` | Error messages |
| `Write-Info` | Informational messages |
| `Initialize-Logging` | Enable file logging |
| `Write-ToLog` | Write to log file |
| `Log-Exception` | Log exceptions with details |

## Key Scripts

### Run-AzureLogCollection.ps1 (Main Orchestrator)

Interactive menu-driven wrapper that coordinates the deployment workflow.

**Key Functions**:
- `Ensure-AzureConnection`: Validates Azure connection with auto-refresh
- `Test-AzureParametersConfiguration`: Validates config file completeness
- `Get-RegionInventory`: Discovers regions with resources via Resource Graph
- `Show-DeploymentConfirmation`: Safety confirmation before deployment

**Parameters**:
```powershell
-NonInteractive          # Skip menu, execute Mode directly
-Mode <string>           # Inventory, CentralizedAllLogs, CentralizedAudit,
                         # MultiRegionAllLogs, MultiRegionAudit
```

### Deploy-EventHubNamespaces.ps1 (Infrastructure)

Creates Event Hub Namespaces for diagnostic log ingestion.

**Parameters**:
```powershell
-DeploymentMode <string>       # "Centralized" or "MultiRegion"
-ValidateOnly                  # Check without creating resources
-ShowStatus                    # Display existing namespace status
-RemoveNamespaces              # Delete previously created namespaces
-SpecificRegions <string[]>    # Deploy to subset of regions
-UseExistingNamespaces <bool>  # Use existing vs create new
```

**Naming Pattern**:
- Centralized: `{prefix}-{subscriptionId8chars}` (e.g., `cribl-diag-a64acbf7`)
- Multi-Region: `{prefix}-{subscriptionId8chars}-{region}` (e.g., `cribl-diag-a64acbf7-eastus`)

### Deploy-BuiltInPolicyInitiatives.ps1 (Policy Assignment)

Assigns Microsoft's built-in diagnostic settings policy initiatives.

**Parameters**:
```powershell
-LoggingMode <string>          # "AllLogs" or "Audit"
-DeploymentMode <string>       # "Centralized" or "MultiRegion"
-ValidateOnly                  # Validation without assignment
-ShowStatus                    # Display assignment status
-RemoveAssignments             # Delete policy assignments
-SpecificRegions <string[]>    # Assign to subset of regions
```

**Assignment Naming**:
- Centralized: `Cribl-DiagSettings-AllLogs-Centralized`
- Multi-Region: `Cribl-DiagSettings-AllLogs-{region}` (with resourceSelector)

## Configuration

### azure-parameters.json

```json
{
  "tenantId": "",                          // Optional: for tenant validation
  "managementGroupId": "Lab",              // Where policies are assigned
  "eventHubSubscriptionId": "...",         // Where Event Hubs are created
  "eventHubResourceGroup": "rg-cribl-logging",
  "eventHubNamespacePrefix": "cribl-diag",
  "eventHubSku": "Standard",               // Basic, Standard, or Premium
  "eventHubCapacity": 1,                   // Throughput units (1-20)
  "useExistingNamespaces": false,          // Create new vs use existing
  "centralizedRegion": "eastus",           // For centralized mode
  "centralizedNamespace": ""               // For existing namespace in centralized mode
}
```

### Output Files (Auto-generated)

| File/Directory | Purpose |
|----------------|---------|
| `namespace-deployment-results.json` | Records created namespaces with resource IDs |
| `region-inventory/` | Discovery results showing resource distribution |
| `cribl-configs/` | Cribl Stream connection configurations |

## Common Commands

### Interactive Mode (Recommended)

```powershell
# Run interactive menu
.\Run-AzureLogCollection.ps1
```

Menu Options:
- `[1]` - Deploy All Logging: Deploy all enabled components from configuration
- `[2]` - Configure Coverage: Edit resource-coverage.json
- `[I]` - Inventory: Discover resources by region (required for Multi-Region mode)
- `[G]` - Gap Analysis: Identify resources not covered by policies
- `[P]` - Remediate Policies: Create remediation tasks for non-compliant resources
- `[C]` - Generate Cribl Sources: Discover Event Hubs and create Cribl source configs
- `[D]` - Defender XDR Streaming: Setup XDR Streaming API
- `[R]` - Remove Diagnostic Settings: Delete settings created by this solution

### Non-Interactive Mode (CI/CD)

```powershell
# Deploy all enabled sources from resource-coverage.json
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode DeployAll

# Discover resources by region (run first for MultiRegion mode)
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode Inventory

# Gap Analysis - Identify coverage gaps
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode GapAnalysis

# Create remediation tasks for non-compliant resources
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode Remediate

# Remove diagnostic settings created by this solution
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode RemoveDiagnosticSettings
```

### Direct Script Execution

```powershell
# Deploy namespaces directly
.\core\Deploy-EventHubNamespaces.ps1 -DeploymentMode Centralized
.\core\Deploy-EventHubNamespaces.ps1 -DeploymentMode MultiRegion -SpecificRegions eastus,westus2

# Assign policies directly
.\core\Deploy-BuiltInPolicyInitiatives.ps1 -LoggingMode AllLogs -DeploymentMode Centralized
.\core\Deploy-BuiltInPolicyInitiatives.ps1 -LoggingMode Audit -DeploymentMode MultiRegion

# Show status
.\core\Deploy-EventHubNamespaces.ps1 -ShowStatus
.\core\Deploy-BuiltInPolicyInitiatives.ps1 -ShowStatus

# Remove resources
.\core\Deploy-EventHubNamespaces.ps1 -RemoveNamespaces
.\core\Deploy-BuiltInPolicyInitiatives.ps1 -RemoveAssignments
```

### Azure Authentication

```powershell
# Required before running any automation
Connect-AzAccount

# If tenantId is configured in azure-parameters.json
Connect-AzAccount -TenantId "your-tenant-id"

# If multiple subscriptions
Set-AzContext -Subscription "Your-Subscription-Name"
```

## Deployment Workflow

1. **Configuration**: Edit `core/azure-parameters.json` with your values
2. **Discovery** (Multi-Region only): Run Inventory to discover regions with resources
3. **Event Hub Deployment**: Creates namespace(s) with authorization rules
4. **Policy Assignment**: Assigns built-in initiative with managed identity and RBAC
5. **Azure Auto-Configuration**: New resources automatically get diagnostic settings
6. **Remediation**: Existing resources require remediation task to become compliant

## Important Technical Details

### Environment Detection

The solution uses a `.dev-mode` flag file pattern:
```powershell
$DevModeFlag = Join-Path $PSScriptRoot ".dev-mode"
$Environment = if (Test-Path $DevModeFlag) { "dev" } else { "core" }
```

### Session Overrides

The main script supports runtime overrides for namespace configuration:
```powershell
$script:SessionOverrides = @{
    UseExistingNamespaces = $null    # null = use config file value
    CentralizedNamespace = $null     # null = use config file value
    RegionNamespaces = @{}           # region -> namespace name mapping
}
```

### ResourceSelectors (Multi-Region Mode)

Per-region policy assignments use resourceSelectors to filter by location:
```json
{
  "resourceSelectors": [{
    "name": "ResourcesInEastUS",
    "selectors": [{
      "kind": "resourceLocation",
      "in": ["eastus"]
    }]
  }]
}
```

### RBAC Roles (Auto-assigned)

| Scope | Role |
|-------|------|
| Management Group | Monitoring Contributor |
| Event Hub Namespace | Azure Event Hubs Data Owner |

### Event Hub Auto-Creation

When `eventHubName` is empty (default), Azure automatically creates Event Hubs per log category:
- `insights-logs-auditevent`
- `insights-logs-networksecuritygroupevent`
- `insights-logs-azurefirewallnetworkrule`
- etc.

Requires authorization rule with **Manage** permission (RootManageSharedAccessKey).

## Security Considerations

### Required Azure Permissions

**Management Group Level**:
- Policy Contributor: Create policy assignments
- User Access Administrator: Assign roles to managed identity

**Event Hub Subscription Level**:
- Contributor or Event Hubs Contributor: Create namespaces

### Never Commit

- Real credentials in `azure-parameters.json`
- Connection strings with keys
- Tenant IDs (use placeholder values in examples)

## Relationship to DCR-Automation

| Component | Focus | Best For |
|-----------|-------|----------|
| **DCR-Automation** | Direct ingestion via Data Collection Rules | Log Analytics native tables, structured data |
| **AzurePolicy-Initiative** | Policy-driven diagnostics via Event Hubs | Multi-region scale, heterogeneous environments |

Both solutions:
- Export Cribl Stream configurations
- Support multi-region deployments
- Use Event Hubs as ingestion point

## Compliance Frameworks Supported

- Microsoft Cloud Security Benchmark (MCSB LT-3)
- CIS Azure Foundations (Section 5)
- NIST 800-53 (AU-2, AU-3, AU-6, AU-12)
- ISO 27001 (A.12.4.1)
- PCI DSS (Requirement 10)
- SOC 2 (CC7.2)
- GDPR/Data Residency (via Multi-Region mode)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Access denied" creating namespaces | Verify Contributor role on Event Hub subscription |
| "Access denied" creating assignments | Verify Policy Contributor at Management Group |
| Namespace creation fails | Check namespace name is globally unique |
| Policy assignment skipped | Run "Deploy Event Hub Namespaces" first |
| 0% compliance after 30 min | Check managed identity has required roles |
| Logs not in Event Hub | Create remediation task; verify auth rule has Manage permission |
| Wrong tenant connected | Run `Connect-AzAccount -TenantId <configured-tenant-id>` |

## Cost Considerations

### Event Hub Costs (per namespace per region)

| SKU | Base Cost | Use Case |
|-----|-----------|----------|
| Basic | ~$11/month | Dev/test |
| Standard | ~$22/month (+ $22/TU) | Production |
| Premium | ~$930/month | High-throughput |

### Initiative Comparison

| Initiative | Daily Volume (100 resources) | Monthly Cost Estimate |
|------------|-----------------------------:|----------------------:|
| audit | 5-20 GB | $150-$600 |
| allLogs | 20-100+ GB | $600-$3,000+ |

**Recommendation**: Start with `audit` initiative, upgrade to `allLogs` if needed.

## Development Guidelines

### When Modifying Scripts

1. Import `Output-Helper.ps1` for console output functions (Write-Step, Write-SubStep, Write-Success, etc.)
2. Use shared helper functions instead of defining local duplicates
3. Preserve error handling with `$ErrorActionPreference = "Stop"`
4. Update summary tracking variables when adding new operations
5. Test both Centralized and Multi-Region modes
6. Update corresponding documentation files

### Helper Function Import Pattern

```powershell
# Standard import pattern for all core scripts
$ScriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutputHelperPath = Join-Path $ScriptPath "Output-Helper.ps1"
if (Test-Path $OutputHelperPath) {
    . $OutputHelperPath
}
```

### Testing Checklist

- [ ] Interactive menu flow works correctly
- [ ] Non-interactive modes execute successfully
- [ ] Namespace creation/validation works
- [ ] Policy assignments deploy correctly
- [ ] RBAC role assignments succeed
- [ ] Cribl config export is accurate
- [ ] Removal operations clean up properly
- [ ] Status display shows accurate information

## Version

- **Current Version**: 5.1.0
- **Last Updated**: 2026-01
- **Architecture**: Dual-Mode (Centralized/Multi-Region) with Built-in + Community Policy Initiatives

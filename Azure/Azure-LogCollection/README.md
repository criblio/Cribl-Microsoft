# Azure Log Collection for Cribl Stream

This PowerShell automation collects Azure diagnostic logs and Microsoft Defender XDR telemetry, sending them to Event Hubs for ingestion by Cribl Stream. It includes:
- **Azure Diagnostic Settings**: Uses Microsoft's built-in policy initiatives to configure logging across 69+ resource types
- **Microsoft Defender XDR**: Guides setup of the XDR Streaming API for endpoint, identity, email, and cloud app telemetry

## Deployment Modes

This solution supports two deployment architectures:

### Centralized Mode (Default)
- **Single Event Hub Namespace** in one region
- **Single policy assignment** applies to all resources
- All logs sent to one location
- Simpler to manage, lower infrastructure cost
- Cross-region egress charges may apply

```
Management Group (mg-root)
    |
    +-- Policy Assignment: Audit-Centralized --> Event Hub: cribl-diag-a1b2c3d4
            (all resources, all regions)                   (eastus)
```

### Multi-Region Mode
- **One Event Hub Namespace per region** (e.g., `cribl-diag-a1b2c3d4-eastus`)
- **Per-region policy assignments** with `resourceSelectors` to filter by location
- Logs stay within their source region
- Data residency compliance, no cross-region egress

```
Management Group (mg-root)
    |
    +-- Policy Assignment: Audit-eastus -----> Event Hub: cribl-diag-a1b2c3d4-eastus
    |       (resourceSelector: location in [eastus])
    |
    +-- Policy Assignment: Audit-westeurope -> Event Hub: cribl-diag-a1b2c3d4-westeurope
    |       (resourceSelector: location in [westeurope])
    |
    +-- Policy Assignment: Audit-westus2 ----> Event Hub: cribl-diag-a1b2c3d4-westus2
            (resourceSelector: location in [westus2])
```

**Note**: Namespace names include first 8 characters of subscription ID for global uniqueness.

## Documentation

| Guide | Description |
|-------|-------------|
| [QUICK_START.md](QUICK_START.md) | Step-by-step setup using PowerShell automation |
| [MANUAL_SETUP_GUIDE.md](MANUAL_SETUP_GUIDE.md) | Portal-based setup without PowerShell scripts |
| [ARCHITECTURE_SUMMARY.md](ARCHITECTURE_SUMMARY.md) | Technical architecture and diagrams |

## Key Features

- **Microsoft Built-in Initiatives**: Uses official Azure Policy initiatives (auto-updates when Microsoft adds resources)
- **Flexible Deployment Modes**: Choose Centralized (simpler) or Multi-Region (data residency)
- **Region Inventory Discovery**: Automatically scan your Management Group to find which regions have resources
- **Configuration-Driven**: Single `resource-coverage.json` file controls all deployment options
- **Supplemental Policies**: Fill gaps in built-in initiatives (Storage services, Activity Log)
- **Interactive Menu System**: Step-by-step deployment with confirmations
- **Event Hub Auto-Creation**: Azure automatically creates Event Hubs per log category
- **Cribl Configuration Export**: Generates connection configs for Cribl Stream sources
- **Globally Unique Naming**: Subscription ID included in namespace names to prevent collisions

## Resource Coverage Summary

This solution provides comprehensive Azure logging coverage through multiple methods:

| Category | Method | Resources | Key Logs |
|----------|--------|-----------|----------|
| **Azure Resources** | Built-in Policy Initiative | 69 resource types | Audit logs (Key Vault, SQL, App Service, etc.) |
| **Extended Resources** | Community Policy Initiative | 44 resource types | Storage, Firewall, Synapse, AVD, etc. |
| **Control Plane** | Activity Log Policy | All subscriptions | ARM operations, RBAC changes, deployments |
| **Identity** | Script (Entra ID) | Tenant-wide | Sign-ins, audit logs, risky users |
| **Security** | Script (Defender) | All subscriptions | Security alerts from enabled Defender plans |

**Note**: Storage services (Blob, File, Queue, Table, Storage Accounts) are now included in the Community Policy Initiative.

### Not Supported (Storage Account Only)

These log types cannot stream to Event Hub and require alternative collection methods:

| Resource | Limitation | Alternative |
|----------|-----------|-------------|
| **VNet Flow Logs** | Storage Account only | Use Cribl Azure Blob source |
| **NSG Flow Logs** | Storage Account only | Use Cribl Azure Blob source |
| **VM Guest Logs** | Requires Azure Monitor Agent | Use DCR-Automation solution |

## Built-in Policy Initiative

This solution uses Microsoft's **Audit** diagnostic settings initiative:

| Initiative | Resource Types | Log Categories | Policy ID |
|------------|---------------|----------------|-----------|
| **Audit to Event Hub** | 69 types | Audit categories | `1020d527-2764-4230-92cc-7035e4fcf8a7` |

The initiative auto-updates when Microsoft adds new resource types.

## Supplemental Policies

The Activity Log policy is deployed separately as it operates at the subscription level (not resource level):

| Policy | Resource Type | What It Captures | Type |
|--------|--------------|------------------|------|
| **Activity Log** | Subscription | ARM operations, RBAC changes, deployments | Built-in |

**Note**: Storage services (Blob, File, Queue, Table) are now deployed as part of the Community Policy Initiative.

## Community Policy Initiative (Extended Coverage)

The **Community Policy Initiative** bundles 44 policies into a single deployable initiative, providing comprehensive coverage beyond the built-in initiative. This includes Storage services (Blob, File, Queue, Table, Storage Accounts) plus 39 additional resource types from the [Azure Community Policy repository](https://github.com/Azure/Community-Policy/tree/main/policyDefinitions/Monitoring).

### Why Use the Community Initiative?

| Feature | Built-in Initiative | Community Initiative |
|---------|--------------------|--------------------|
| Resource Types | 69 types | 44 additional types |
| Storage Coverage | No | Yes (Blob, File, Queue, Table, Accounts) |
| Management | Microsoft-managed | Community-maintained |
| Updates | Automatic | Manual redeploy |
| Customization | None | Full control |

### Covered Resource Types (by Tier)

| Tier | Resources | Use Case |
|------|-----------|----------|
| **Storage** | Blob, File, Queue, Table, Storage Accounts | Data platform logging |
| **Security** | Azure Firewall, Front Door WAF, DDoS Protection | Security monitoring |
| **Data** | Synapse, Data Factory, Event Grid | Data pipeline auditing |
| **Compute** | AKS, Batch, Machine Learning | Compute workload logs |
| **Integration** | Service Bus, API Management, Logic Apps | Integration platform |
| **Networking** | Load Balancer, Public IP, Traffic Manager | Network visibility |
| **AVD** | Host Pools, App Groups, Workspaces | Virtual desktop monitoring |
| **Other** | Time Series Insights, Power BI Embedded | Specialized services |

### Deployment Options

The Community Policy Initiative is automatically deployed when you use the main menu's "Deploy All Logging" option (if enabled in `resource-coverage.json`). You can also deploy it directly:

```powershell
# Deploy all 44 community policies as a unified initiative
.\core\Deploy-CommunityPolicyInitiative.ps1

# Deploy specific tiers only
.\core\Deploy-CommunityPolicyInitiative.ps1 -PolicyTiers Storage,Security,Data

# Validate without deploying
.\core\Deploy-CommunityPolicyInitiative.ps1 -ValidateOnly

# Deploy and trigger remediation for existing resources
.\core\Deploy-CommunityPolicyInitiative.ps1 -Remediate

# Remove initiative and custom policies
.\core\Deploy-CommunityPolicyInitiative.ps1 -RemoveInitiative
```

### Deployment Architecture

When you deploy using the main menu, you get:

1. **Built-in Audit Initiative**: 69 resource types (Microsoft-managed)
2. **Community Policy Initiative**: 44 resource types including Storage (single initiative assignment)
3. **Activity Log Policy**: Deployed separately (subscription-level, cannot be bundled into resource-type initiatives)

This provides comprehensive coverage with just 2 initiative assignments + 1 policy, rather than dozens of individual policy assignments.

## Entra ID (Azure AD) Logging

Entra ID is a **global service** - logs are tenant-wide, not regional. This solution configures Entra ID diagnostic settings to stream to the centralized Event Hub namespace.

| Log Category | Description | Volume |
|--------------|-------------|--------|
| **AuditLogs** | Directory changes, app registrations | Moderate |
| **SignInLogs** | Interactive user sign-ins | Moderate |
| **NonInteractiveUserSignInLogs** | Token refresh, background auth | **5-10x higher** |
| **ServicePrincipalSignInLogs** | App/service principal auth | Variable |
| **ManagedIdentitySignInLogs** | Managed identity auth | Variable |
| **RiskyUsers / UserRiskEvents** | Identity Protection alerts | Low |

**Important**: NonInteractiveUserSignInLogs is excluded by default due to high volume. Set `profile: "HighVolume"` in `resource-coverage.json` to include it.

## Microsoft Defender for Cloud Export

Exports security alerts from Microsoft Defender for Cloud to Event Hub.

**IMPORTANT**: This does NOT enable any Defender plans. It only exports alerts from plans that are ALREADY enabled. Defender plans are paid services.

| What's Exported | Description |
|-----------------|-------------|
| **Security Alerts** | Threats detected by enabled Defender plans |
| **Recommendations** | Security posture improvement suggestions (optional) |
| **Secure Score** | Overall security score changes (optional) |
| **Compliance** | Regulatory compliance assessment results (optional) |

The script will scan your subscriptions and show which Defender plans are enabled before configuring export.

## Microsoft Defender XDR Streaming API (NEW)

Streams telemetry from Microsoft Defender XDR products to Event Hub via the Streaming API.

**IMPORTANT**: This is separate from Defender for Cloud. XDR covers endpoint, identity, email, and cloud app security.

### Tiered Export Recommendations

We recommend a **phased approach** - start with Tier 1, validate ingestion and costs, then expand.

#### Tier 1: Essential (Always Export)
High-value, lower volume tables critical for detection and investigation:

| Table | Product | Why Essential | Volume |
|-------|---------|---------------|--------|
| AlertInfo | XDR | All XDR alerts - foundation for incident correlation | Low |
| AlertEvidence | XDR | Context for all alerts - enables pivot/enrichment | Low |
| DeviceProcessEvents | MDE | Process execution - core for threat hunting | High |
| DeviceNetworkEvents | MDE | C2 detection, lateral movement | High |
| DeviceLogonEvents | MDE | Authentication monitoring, credential attacks | Medium |
| IdentityLogonEvents | MDI | AD/Entra auth - identity-based attacks | Medium |
| EmailEvents | MDO | Phishing detection, BEC | Low-Medium |

#### Tier 2: Recommended (High Value)
Important for comprehensive visibility:

| Table | Product | Use Case | Volume |
|-------|---------|----------|--------|
| DeviceFileEvents | MDE | Ransomware, data exfiltration | High |
| DeviceRegistryEvents | MDE | Persistence mechanisms | Medium |
| DeviceEvents | MDE | AV detections, ASR blocks, exploit attempts | Low-Medium |
| EmailAttachmentInfo | MDO | Malicious attachment analysis | Low-Medium |
| EmailUrlInfo | MDO | Phishing URL detection | Low-Medium |
| UrlClickEvents | MDO | User click behavior, compromised links | Low-Medium |
| IdentityDirectoryEvents | MDI | AD changes, privilege escalation | Medium |
| CloudAppEvents | MDCA | SaaS compromise, data exfiltration | Medium |

#### Tier 3: Situational (High Volume - Evaluate Carefully)
Export based on specific use cases or compliance requirements:

| Table | Product | Consideration | Volume |
|-------|---------|---------------|--------|
| DeviceImageLoadEvents | MDE | **CAUTION**: Very high volume - DLL sideloading detection | Very High (~100+ GB/day per 1K endpoints) |
| IdentityQueryEvents | MDI | **CAUTION**: High volume from normal AD operations - LDAP recon detection | High |
| DeviceInfo | MDE | Inventory snapshots - good for asset context | Low |
| DeviceNetworkInfo | MDE | Network config changes | Low |
| DeviceFileCertificateInfo | MDE | Code signing verification | Low |
| EmailPostDeliveryEvents | MDO | ZAP actions, remediation tracking | Low |

#### Recommended Implementation Phases

```
Phase 1: AlertInfo, AlertEvidence, DeviceProcessEvents, DeviceLogonEvents, IdentityLogonEvents
Phase 2: Add DeviceNetworkEvents, DeviceFileEvents, EmailEvents
Phase 3: Add remaining Tier 2 tables
Phase 4: Evaluate Tier 3 based on specific detection requirements
```

#### Tables NOT Available in Streaming API

- BehaviorEntities / BehaviorInfo - Not yet supported
- TVM tables (vulnerability/software inventory) - Not in streaming API

### Products Covered by XDR Streaming

| Product | Tables | Description |
|---------|--------|-------------|
| **Defender for Endpoint** | DeviceEvents, DeviceInfo, DeviceLogonEvents, DeviceNetworkEvents, DeviceProcessEvents, DeviceFileEvents, DeviceRegistryEvents, DeviceImageLoadEvents | Endpoint detection and response |
| **Defender for Identity** | IdentityLogonEvents, IdentityQueryEvents, IdentityDirectoryEvents | Active Directory/Entra ID threat detection |
| **Defender for Office 365** | EmailEvents, EmailAttachmentInfo, EmailUrlInfo, EmailPostDeliveryEvents | Email and collaboration security |
| **Defender for Cloud Apps** | CloudAppEvents | SaaS application monitoring (CASB) |
| **XDR Alerts** | AlertInfo, AlertEvidence, UrlClickEvents | Unified alerts and incidents |

### License Validation

The script automatically validates:
- Tenant licenses for each Defender product
- Actual usage (onboarded devices, deployed sensors, etc.)
- Provides clear guidance when products are not licensed or not active

### Setup Process

1. **Run the setup** - Select [D] from the menu or use `-Mode DefenderXDR`
2. **Review license validation** - Script checks which products are licensed and active
3. **Event Hub created** - Separate namespace (`cribl-xdr-{subscriptionId}`) for XDR data
4. **Portal configuration** - Script provides Resource ID and opens Defender portal
5. **Configure streaming** - Complete setup in Microsoft Defender portal (required - no API available)

### Usage

```powershell
# Interactive (recommended)
.\Run-AzureLogCollection.ps1
# Select [D] Defender XDR Streaming

# Non-interactive - full setup
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode DefenderXDR

# Non-interactive - validate licenses only
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode DefenderXDRValidateOnly
```

### Why Separate from Defender for Cloud?

| Defender for Cloud | Defender XDR |
|-------------------|--------------|
| Azure workload protection | Endpoint/Identity/Email/SaaS |
| Policy-based continuous export | Portal-based Streaming API |
| Security recommendations & alerts | Raw telemetry tables |
| Per-subscription configuration | Tenant-wide configuration |

## Gap Analysis

The gap analysis feature scans your Azure resources and identifies coverage gaps in diagnostic settings policies.

| Category | Description |
|----------|-------------|
| **Covered by Initiative** | Resources covered by built-in Audit initiative (69 types) |
| **Known Gaps** | Resources that need supplemental policies (Storage services) |
| **Potential Gaps** | Resources not in initiative - may need investigation |
| **Infrastructure** | Resources that don't support diagnostic settings |

**Use Cases:**
- Run before deployment to understand what policies you need
- Run after deployment to verify complete coverage
- Identify resources that may need custom policies

**Output:**
- Console summary with recommendations
- JSON report exported to `core/reports/`

## File Structure

```
Azure-LogCollection/
  Run-AzureLogCollection.ps1            # Main entry point with interactive menu
  core/
    Deploy-EventHubNamespaces.ps1       # Creates Event Hub Namespaces per region
    Deploy-BuiltInPolicyInitiatives.ps1 # Assigns built-in policy initiatives
    Deploy-CommunityPolicyInitiative.ps1 # Community policy initiative (44 resource types)
    Deploy-SupplementalPolicies.ps1     # Deploys Storage and Activity Log policies
    Deploy-EntraIDDiagnostics.ps1       # Configures Entra ID log streaming
    Deploy-DefenderExport.ps1           # Exports Defender for Cloud alerts
    Deploy-DefenderXDRStreaming.ps1     # Defender XDR Streaming API setup
    Analyze-ComplianceGaps.ps1          # Gap analysis for policy coverage
    Generate-CriblEventHubSources.ps1   # Generates Cribl Stream source configs
    Output-Helper.ps1                   # Shared logging and output utilities
    azure-parameters.json               # Configuration (EDIT THIS)
    resource-coverage.json              # Enable/disable log sources
    cribl-configs/                      # Generated Cribl Stream configs
    logs/                               # Deployment logs
    reports/                            # Gap analysis reports
  docs/
    MCSB-AUDIT-LOGGING-ANALYSIS.md      # MCSB research and gap analysis
  README.md
  QUICK_START.md
  ARCHITECTURE_SUMMARY.md
  EVENT_HUB_BEHAVIOR.md
```

## Configuration

### azure-parameters.json

```json
{
  "managementGroupId": "mg-root",
  "eventHubSubscriptionId": "12345678-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "eventHubResourceGroup": "rg-cribl-logging",
  "eventHubNamespacePrefix": "cribl-diag",
  "eventHubSku": "Standard",
  "eventHubCapacity": 1,
  "centralizedRegion": "eastus",
  "regions": [
    { "location": "eastus", "enabled": true },
    { "location": "westus2", "enabled": true },
    { "location": "westeurope", "enabled": true },
    { "location": "centralus", "enabled": false }
  ]
}
```

| Field | Description |
|-------|-------------|
| `managementGroupId` | Management Group where policies will be assigned |
| `eventHubSubscriptionId` | Subscription where Event Hub Namespaces are located |
| `eventHubResourceGroup` | Resource Group for Event Hub Namespaces |
| `eventHubNamespacePrefix` | Prefix for auto-generated namespace names |
| `eventHubSku` | SKU for new namespaces: Basic, Standard, or Premium |
| `eventHubCapacity` | Throughput units (1-20 for Standard) |
| `useExistingNamespaces` | Set to `true` to use pre-existing namespaces instead of creating new ones |
| `centralizedRegion` | For Centralized mode: region where single namespace is located |
| `centralizedNamespace` | For Centralized mode with existing namespaces: name of the namespace |
| `regions` | For Multi-Region mode: set `enabled: true` and optionally specify `namespaceName` |

### Namespace Naming Pattern

- **Centralized**: `{prefix}-{subscriptionId8chars}` (e.g., `cribl-diag-12345678`)
- **Multi-Region**: `{prefix}-{subscriptionId8chars}-{region}` (e.g., `cribl-diag-12345678-eastus`)

### Using Existing Event Hub Namespaces

If you already have Event Hub Namespaces deployed, set `useExistingNamespaces: true` and specify the namespace names:

**Centralized Mode with Existing Namespace:**
```json
{
  "useExistingNamespaces": true,
  "centralizedRegion": "eastus",
  "centralizedNamespace": "my-existing-namespace"
}
```

**Multi-Region Mode with Existing Namespaces:**
```json
{
  "useExistingNamespaces": true,
  "regions": [
    { "location": "eastus", "enabled": true, "namespaceName": "my-eh-eastus" },
    { "location": "westus2", "enabled": true, "namespaceName": "my-eh-westus2" },
    { "location": "westeurope", "enabled": false, "namespaceName": "" }
  ]
}
```

When `useExistingNamespaces` is `true`:
- The script skips namespace creation
- Validates that specified namespaces exist
- Requires namespaces to have `RootManageSharedAccessKey` authorization rule (or equivalent with Manage permission)

## Quick Start

```powershell
# 1. Edit azure-parameters.json with your values
# 2. Enable regions where you have resources

# 3. Connect to Azure
Connect-AzAccount

# 4. Run interactive menu
.\Run-AzureLogCollection.ps1

# 5. Select [1] Deploy Event Hub Namespaces
# 6. Select [2] or [3] to deploy policy assignments
```

## Usage

### Interactive Menu (Recommended)

```powershell
.\Run-AzureLogCollection.ps1
```

Menu options:
```
MAIN ACTIONS
  [1] Deploy All Logging - Deploy all enabled components from configuration
  [2] Configure Coverage - Edit resource-coverage.json to enable/disable sources

DISCOVERY & ANALYSIS
  [I] Inventory - Discover Resources by Region (required for MultiRegion mode)
  [G] Gap Analysis - Identify resources not covered by policies

DEFENDER EXTENDED
  [D] Defender XDR Streaming - Setup XDR Streaming API (Endpoint/Identity/O365/CloudApps)

CLEANUP
  [R] Remove Diagnostic Settings - Delete settings created by this solution
```

All logging sources are now configured via `resource-coverage.json` - a single configuration file that controls which sources to enable and which deployment method to use.

### Non-Interactive Mode (CI/CD)

```powershell
# Deploy all enabled sources from resource-coverage.json (recommended)
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode DeployAll

# Discover resources by region (required for MultiRegion mode)
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode Inventory

# Gap Analysis - Identify coverage gaps
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode GapAnalysis

# Remove diagnostic settings created by this solution
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode RemoveDiagnosticSettings

# Defender XDR Streaming - setup Event Hub and show portal configuration
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode DefenderXDR

# Defender XDR - validate licenses only (no infrastructure changes)
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode DefenderXDRValidateOnly
```

All deployment options are now configured via `resource-coverage.json`. Edit this file to enable/disable specific log sources before running `DeployAll`.

## Deployment Workflow

### Step 1: Select Deployment Mode

Choose between:
- **Centralized**: Single namespace, simpler management
- **Multi-Region**: Per-region namespaces, data residency compliance

### Step 2: Deploy Event Hub Namespaces

**Centralized Mode:**
- Creates single namespace: `cribl-diag-{subId8}` (e.g., `cribl-diag-12345678`)
- Located in `centralizedRegion` from configuration

**Multi-Region Mode:**
- Creates namespace per enabled region:
  - `cribl-diag-{subId8}-eastus` in East US
  - `cribl-diag-{subId8}-westeurope` in West Europe
  - etc.

Each namespace is created with:
- Specified SKU and capacity
- `RootManageSharedAccessKey` authorization rule (required for auto-creation of Event Hubs)
- Tags for identification

### Step 3: Deploy Policy Assignments

**Centralized Mode:**
- Creates single assignment: `Cribl-DiagSettings-Audit-Centralized`
- Applies to ALL resources in ALL regions
- All logs sent to centralized Event Hub

**Multi-Region Mode:**
- Creates per-region assignments with `resourceSelectors`:
  - `Cribl-DiagSettings-Audit-eastus` with resourceSelector for eastus
  - `Cribl-DiagSettings-Audit-westeurope` with resourceSelector for westeurope
  - etc.
- Each assignment only affects resources in its specified region
- Logs stay within their source region

Each assignment:
- Uses Microsoft's built-in initiative
- Creates a managed identity with required roles

### Step 4: Remediation

After policy assignment:
- **New resources**: Automatically configured with diagnostic settings
- **Existing resources**: Marked as non-compliant (require remediation task)

Create remediation tasks via Azure Portal or PowerShell:

```powershell
Start-AzPolicyRemediation `
    -Name "Remediate-Audit-eastus" `
    -PolicyAssignmentId "/providers/Microsoft.Management/managementGroups/mg-root/providers/Microsoft.Authorization/policyAssignments/Cribl-DiagSettings-Audit-eastus" `
    -ManagementGroupName "mg-root"
```

## Event Hub Behavior

When `eventHubName` is left empty (default), Azure **auto-creates Event Hubs** per log category:
- `insights-logs-auditevent`
- `insights-logs-networksecuritygroupevent`
- `insights-logs-azurefirewallnetworkrule`
- etc.

This requires the authorization rule to have **Manage** permissions (RootManageSharedAccessKey has this).

## Cribl Stream Integration

After deployment, the script exports Cribl Stream configuration to `core/cribl-configs/event-hub-sources.json`:

```json
{
  "exportDate": "2025-01-15 10:30:00",
  "managementGroupId": "mg-root",
  "sources": [
    {
      "region": "eastus",
      "namespace": "cribl-diag-eastus",
      "connectionString": "Endpoint=sb://cribl-diag-eastus.servicebus.windows.net/;SharedAccessKeyName=...",
      "eventHubPattern": "insights-logs-*",
      "consumerGroup": "$Default"
    }
  ]
}
```

Configure Cribl Stream:
1. Create an Event Hub source for each region
2. Use the connection string from the exported config
3. Set consumer group to `$Default`
4. Create pipelines for log processing

## Security Considerations

### Required RBAC Roles

At Management Group level:
- **Policy Contributor**: Assign policy initiatives
- **User Access Administrator**: Create role assignments for managed identity

At Event Hub Subscription level:
- **Contributor** or **Event Hubs Contributor**: Create namespaces

### Managed Identity Roles (Auto-assigned)

The script automatically assigns:
- **Monitoring Contributor** at Management Group scope
- **Azure Event Hubs Data Owner** at each regional Event Hub Namespace (required for listkeys permission during remediation)

### Authorization Rule Requirements

| Scenario | Required Permissions |
|----------|---------------------|
| Auto-create Event Hubs (recommended) | **Manage + Send + Listen** |
| Pre-created Event Hubs | **Send** only |

## Cost Considerations

### Event Hub Costs (per namespace per region)

| SKU | Base Cost | Throughput Units | Use Case |
|-----|-----------|------------------|----------|
| Basic | ~$11/month | 1 TU included | Dev/test |
| Standard | ~$22/month | $22/TU/month | Production |
| Premium | ~$930/month | 1 PU included | High-throughput |

### Log Volume Estimates (per 100 resources)

| Component | Daily Volume | Monthly Cost* |
|-----------|-------------|---------------|
| Audit Initiative | 5-20 GB | $150-$600 |
| + Storage Services | 1-5 GB | $30-$150 |
| + Entra ID (Standard) | 0.5-2 GB | $15-$60 |
| + Entra ID (HighVolume) | 5-20 GB | $150-$600 |

*Includes Event Hub ingress/egress + downstream storage

### Cost Optimization

1. The **Audit** initiative captures essential security logs with lower volume
2. Enable only regions where you have resources
3. Use Cribl Stream to filter/reduce logs before storage
4. Start with Entra ID **Standard** profile (HighVolume adds 5-10x more data)
5. Consider Premium SKU only for high-throughput scenarios

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Access denied" creating namespaces | Verify Contributor role on Event Hub subscription |
| "Access denied" creating assignments | Verify Policy Contributor at Management Group |
| Namespace creation fails | Check namespace name is globally unique |
| Policy assignment skipped | Run "Deploy Event Hub Namespaces" first |
| 0% compliance after 30 min | Check managed identity has required roles |
| Logs not in Event Hub | Create remediation task; verify auth rule has Manage permission |

## Additional Resources

### Microsoft Documentation

- [Azure Policy Overview](https://learn.microsoft.com/en-us/azure/governance/policy/overview)
- [Diagnostic Settings Policy](https://learn.microsoft.com/en-us/azure/azure-monitor/essentials/diagnostic-settings-policy)
- [Built-in Initiatives (GitHub)](https://github.com/Azure/azure-policy/tree/master/built-in-policies/policySetDefinitions/Monitoring)

### Cribl Documentation

- [Cribl Stream Event Hub Source](https://docs.cribl.io/stream/sources-azure-event-hub/)

## Version History

### v5.1.0 (Current)
- **Community Policy Initiative**: New `Deploy-CommunityPolicyInitiative.ps1` bundles 44 community policies into a single initiative
  - Imports policies from Azure Community Policy GitHub repository
  - 8 policy tiers: Storage, Security, Data, Compute, Integration, Networking, AVD, Other
  - Selective tier deployment with `-PolicyTiers` parameter
  - Single initiative assignment instead of 41+ individual assignments
- **Code Consolidation**: Shared helper functions in `Output-Helper.ps1`
  - Unified Write-Step, Write-SubStep, Write-Success, Write-WarningMsg, Write-ErrorMsg, Write-Info
  - File logging with Initialize-Logging, Write-ToLog
  - Error collection and summary reporting
- **User-Assigned Managed Identity**: Policy assignments now use user-assigned managed identity for better lifecycle management
- **Cribl Config Generation**: New `Generate-CriblEventHubSources.ps1` for automated Cribl Stream source configuration

### v5.0.0
- Simplified menu to 2 main options: Deploy All Logging and Configure Coverage
- Configuration-driven deployment via `resource-coverage.json`
- Removed AllLogs initiative (uses Audit initiative only for better cost control)
- Removed legacy non-interactive modes (DeployAll replaces all individual modes)
- Added custom Table Services policy (completes Storage coverage)
- Non-interactive modes: DeployAll, Inventory, GapAnalysis, RemoveDiagnosticSettings

### v4.4.0
- Compliance gap analysis feature
- Identifies resources not covered by built-in policy initiatives
- Shows known gaps that can be filled with supplemental policies
- Highlights potential gaps that may need custom policies
- Menu option [G] for interactive gap analysis
- Non-interactive mode: GapAnalysis
- Analyze-ComplianceGaps.ps1 script with JSON report export

### v4.3.0
- Microsoft Defender for Cloud continuous export to Event Hub
- Exports security alerts from already-enabled Defender plans only
- Does NOT enable any paid Defender services
- DefenderStatus mode shows enabled plans before deployment
- Menu option [9] for Defender Export
- Non-interactive modes: DefenderExport, DefenderStatus
- Deploy-DefenderExport.ps1 script

### v4.2.0
- Entra ID (Azure AD) diagnostic settings support
- Sign-in logs, audit logs, risky users, service principal logs
- Two profiles: Standard (excludes high-volume) and HighVolume (includes NonInteractiveUserSignInLogs)
- Menu option [8] for Entra ID log deployment
- Non-interactive modes: EntraID, EntraIDHighVolume
- Deploy-EntraIDDiagnostics.ps1 script

### v4.1.0
- Supplemental policies for Storage services (Blob, File, Queue)
- Activity Log policy support (subscription-level control plane audit)
- Menu options [5], [6], [7] for supplemental policy deployment
- Non-interactive modes: StoragePolicies, StorageAndActivityLog, ActivityLogOnly
- MCSB audit logging gap analysis documentation
- Deploy-SupplementalPolicies.ps1 script

### v4.0.0
- Dual deployment modes: Centralized vs Multi-Region
- ResourceSelectors for proper region filtering in Multi-Region mode
- Globally unique namespace naming with subscription ID
- Interactive mode selection in menu
- Updated documentation for both modes

### v3.0.0
- Multi-region architecture with per-region Event Hub Namespaces
- Per-region policy assignments with resourceLocation filtering
- Event Hub Namespace deployment script
- Cribl configuration export
- Support for specific region targeting

### v2.0.0
- Rearchitected to use Microsoft built-in policy initiatives
- Single-region deployment

### v1.0.0
- Custom policy definitions with three tiers (Baseline, Enhanced, Verbose)

---

**Need help?**
- [QUICK_START.md](QUICK_START.md) - Step-by-step setup using PowerShell automation
- [MANUAL_SETUP_GUIDE.md](MANUAL_SETUP_GUIDE.md) - Portal-based setup without PowerShell scripts

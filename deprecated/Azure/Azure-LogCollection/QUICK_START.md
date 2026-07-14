# Quick Start Guide - Azure Log Collection

This guide walks you through deploying a logging infrastructure that sends Azure diagnostic logs to Event Hub for Cribl Stream ingestion.

## Two-Step Deployment

1. **Configure** - Edit `resource-coverage.json` to select which log sources to enable
2. **Deploy** - Run the automation and select [1] Deploy All Logging

## Prerequisites

1. **Azure PowerShell Module**
   ```powershell
   Install-Module -Name Az -Scope CurrentUser -Repository PSGallery -Force
   ```

2. **Required Azure Permissions**
   - **Management Group**: Policy Contributor, User Access Administrator
   - **Event Hub Subscription**: Contributor (to create namespaces)

## Step 1: Configure azure-parameters.json

Edit `core/azure-parameters.json`:

```json
{
  "managementGroupId": "mg-your-management-group",
  "eventHubSubscriptionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "eventHubResourceGroup": "rg-cribl-logging",
  "eventHubNamespacePrefix": "cribl-diag",
  "eventHubSku": "Standard",
  "eventHubCapacity": 1,
  "centralizedRegion": "eastus",
  "regions": [
    { "location": "eastus", "enabled": true },
    { "location": "westus2", "enabled": true },
    { "location": "westeurope", "enabled": false }
  ]
}
```

**Note**:
- `centralizedRegion` - Used for Centralized mode (single namespace location)
- `regions` - Used for Multi-Region mode (enable regions where you have resources)

### Finding Your Values

**Management Group ID:**
```powershell
Get-AzManagementGroup | Select-Object Name, DisplayName
```

**Subscription ID:**
```powershell
Get-AzSubscription | Select-Object Name, Id
```

**Regions with Resources:**
```powershell
Get-AzResource | Group-Object Location | Select-Object Name, Count | Sort-Object Count -Descending
```

## Step 2: Connect to Azure

```powershell
Connect-AzAccount

# If you have multiple subscriptions
Set-AzContext -Subscription "Your-Subscription-Name"
```

## Step 2: Configure resource-coverage.json

Edit `core/resource-coverage.json` to enable/disable log sources:

```json
{
  "deploymentSettings": {
    "mode": "Centralized"
  },
  "builtInPolicies": {
    "diagnosticSettingsInitiative": { "enabled": true }
  },
  "communityPolicyInitiative": {
    "enabled": true,
    "tiers": { "selected": ["All"] }
  },
  "supplementalPolicies": {
    "activityLog": { "enabled": true }
  },
  "scriptBasedDeployment": {
    "entraId": { "enabled": true, "profile": "Standard" },
    "defenderExport": { "enabled": false }
  }
}
```

**Key Settings:**
- `mode`: `Centralized` (single namespace) or `MultiRegion` (per-region namespaces)
- `communityPolicyInitiative.tiers.selected`: `["All"]` or specific tiers like `["Storage", "Security"]`
- Set `enabled: true` for sources you want, `enabled: false` to skip

## Step 3: Connect to Azure

```powershell
Connect-AzAccount
Set-AzContext -Subscription "Your-Subscription-Name"
```

## Step 4: Run the Automation

```powershell
cd Azure\dev\Azure-LogCollection
.\Run-AzureLogCollection.ps1
```

You'll see:

```
================================================================================
  AZURE POLICY AUTOMATION - DIAGNOSTIC SETTINGS TO EVENT HUB
  Send Azure diagnostic logs to Event Hub for Cribl Stream
================================================================================

  RESOURCE COVERAGE CONFIGURATION
  --------------------------------------------------
  Mode: Centralized
  [X] Built-in Initiative (69 resource types)
  [X] Community Initiative (44 types - All tiers)
  [X] Activity Log
  [X] entraId (script)
  [ ] defenderExport (script)
  --------------------------------------------------
  Enabled: 4 | Disabled: 1

  MAIN ACTIONS
  [1] Deploy All Logging - Deploy all enabled components from configuration
  [2] Configure Coverage - Edit resource-coverage.json to enable/disable sources

  DISCOVERY & ANALYSIS
  [I] Inventory - NOT RUN - Required for Multi-Region mode
  [G] Gap Analysis - Identify resources not covered by policies

  CLEANUP
  [R] Remove Diagnostic Settings - Delete settings created by this solution

  [Q] Quit
================================================================================
```

## Step 5: Deploy

1. Select **[1] Deploy All Logging**
2. Review the enabled components
3. Confirm deployment (Y)
4. Wait for deployment to complete

The automation will:
- Create Event Hub Namespace(s)
- Deploy built-in policy initiative
- Deploy supplemental policies (Storage, Activity Log)
- Configure Entra ID diagnostic settings
- Configure Defender export (if enabled)

## Step 6: Run Inventory (If Using Multi-Region)

If you set `mode: MultiRegion` in resource-coverage.json:

1. Press **[I]** for Inventory first
2. Discover which regions contain resources
3. Then select **[1] Deploy All Logging**

## Step 7: Remediate Existing Resources

New resources are automatically configured by Azure Policy. For **existing** resources, you must create remediation tasks.

### Using This Solution (Recommended)
1. Press **[P]** in the main menu
2. Select **[P]** to preview policies and non-compliant resource counts
3. Select **[R]** to create remediation tasks for all non-compliant resources

**Important**: Remediation modifies existing Azure resources. Review Microsoft's best practices:
- Test in a non-production environment first
- Large environments may take time to complete
- Monitor progress in Azure Portal > Policy > Remediation

### Azure Portal Method
1. Go to **Azure Policy** > **Remediation**
2. Select your policy assignment
3. Click **Create remediation task**
4. Review and confirm

### PowerShell Method
```powershell
Start-AzPolicyRemediation `
    -Name "Remediate-Audit-$(Get-Date -Format 'yyyyMMdd')" `
    -PolicyAssignmentId "/providers/Microsoft.Management/managementGroups/YOUR-MG/providers/Microsoft.Authorization/policyAssignments/Cribl-DiagSettings-Audit-Centralized" `
    -ManagementGroupName "YOUR-MG"
```

## Step 8: Configure Cribl Stream

The deployment exports Cribl configuration to `core/cribl-configs/event-hub-sources.json`.

For each region:
1. In Cribl Stream, go to **Sources** > **Azure Event Hub**
2. Create a new source
3. Use the connection string from the exported config
4. Set Event Hub pattern to `insights-logs-*`
5. Set Consumer Group to `$Default`

## Non-Interactive Deployment (CI/CD)

```powershell
# RECOMMENDED: Deploy all enabled sources from resource-coverage.json
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode DeployAll

# Run inventory first if using MultiRegion mode
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode Inventory

# Gap Analysis - Identify coverage gaps
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode GapAnalysis

# Create remediation tasks for existing non-compliant resources
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode Remediate

# Remove diagnostic settings created by this solution
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode RemoveDiagnosticSettings
```

## Which Options Should I Choose?

### Recommended Configuration (resource-coverage.json)

For **Security Monitoring** (most common):
```json
{
  "deploymentSettings": { "mode": "Centralized" },
  "builtInPolicies": { "diagnosticSettingsInitiative": { "enabled": true } },
  "communityPolicyInitiative": { "enabled": true, "tiers": { "selected": ["All"] } },
  "supplementalPolicies": { "activityLog": { "enabled": true } },
  "scriptBasedDeployment": {
    "entraId": { "enabled": true, "profile": "Standard" },
    "defenderExport": { "enabled": false }
  }
}
```

For **Compliance/Full Audit** (higher volume):
- Enable `defenderExport` if you have Defender plans
- Set Entra ID `profile` to `"HighVolume"` for complete audit trail

For **Selective Tier Deployment** (specific resource types):
```json
"communityPolicyInitiative": {
  "enabled": true,
  "tiers": { "selected": ["Storage", "Security", "Data"] }
}
```
Available tiers: Storage, Security, Data, Compute, Integration, Networking, AVD, Other

### Entra ID (Azure AD) Logging

Entra ID is a **global service** - logs go to the centralized namespace regardless of deployment mode.

Configure the `profile` setting in `resource-coverage.json`:

| Profile | What It Includes | Use Case |
|---------|------------------|----------|
| **Standard** | AuditLogs, SignInLogs, ServicePrincipal, ManagedIdentity, RiskyUsers | Standard security monitoring |
| **HighVolume** | All above + NonInteractiveUserSignInLogs | Complete audit (5-10x more volume) |

**Warning**: NonInteractiveUserSignInLogs captures token refresh and background auth - this can be 5-10x the volume of interactive sign-ins. Start with **Standard** unless you specifically need these logs.

### Microsoft Defender for Cloud Export

Exports security alerts from Microsoft Defender for Cloud to Event Hub.

**IMPORTANT**: This does NOT enable any Defender plans. It only exports alerts from plans that are ALREADY enabled. Defender plans are paid services - this solution respects what you have already configured.

To enable Defender export, set `defenderExport.enabled: true` in `resource-coverage.json`:
```json
"scriptBasedDeployment": {
  "defenderExport": { "enabled": true }
}
```

When enabled, the deployment will:
1. Scan all subscriptions for enabled Defender plans
2. Show you exactly which plans are active
3. Configure Security Automation rules to export alerts
4. Create a resource group `CriblSecurityExport` for export resources

### Gap Analysis

Before or after deployment, run gap analysis to identify coverage gaps:

```powershell
.\Run-AzureLogCollection.ps1 -NonInteractive -Mode GapAnalysis
```

The analysis shows:
- Resources covered by built-in initiatives
- Known gaps that need supplemental policies (Storage services)
- Potential gaps that may need custom policies or investigation
- Infrastructure resources that don't support diagnostic settings

Use this to verify complete coverage or identify what additional policies you need.

### Community Policy Initiative (Extended Coverage)

For comprehensive coverage beyond the built-in initiative (69 types), deploy the Community Policy Initiative which adds 44 resource types:

```powershell
# Deploy all 44 community policies as a unified initiative
.\core\Deploy-CommunityPolicyInitiative.ps1

# Deploy only specific tiers (Storage, Security, Data, Compute, Integration, Networking, AVD, Other)
.\core\Deploy-CommunityPolicyInitiative.ps1 -PolicyTiers Storage,Security

# Validate without deploying
.\core\Deploy-CommunityPolicyInitiative.ps1 -ValidateOnly

# Deploy and remediate existing resources
.\core\Deploy-CommunityPolicyInitiative.ps1 -Remediate
```

The Community Initiative covers additional resource types like:
- **Storage**: Blob, File, Queue, Table, Storage Accounts
- **Security**: Azure Firewall, Front Door WAF, DDoS Protection
- **Data**: Synapse, Data Factory, Event Grid
- **Compute**: AKS, Batch, Machine Learning
- **Integration**: Service Bus, API Management, Logic Apps
- **Networking**: Load Balancer, Public IP, Traffic Manager
- **AVD**: Host Pools, App Groups, Workspaces

## Adding New Regions Later

1. Edit `azure-parameters.json` and set `enabled: true` for the new region
2. Set `mode: "MultiRegion"` in `resource-coverage.json`
3. Run **[I] Inventory** to discover regions with resources
4. Select **[1] Deploy All Logging** to deploy to all enabled regions

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Access denied" creating namespaces | Verify Contributor role on Event Hub subscription |
| "Access denied" creating assignments | Verify Policy Contributor at Management Group |
| Policy assignment skipped | Namespace doesn't exist - run Step 5 first |
| 0% compliance after 30 min | Check managed identity has required roles |
| Logs not in Event Hub | Create remediation task for existing resources |

## Success Indicators

After successful deployment:
- Event Hub Namespaces visible in Azure Portal
- Policy assignments visible in Azure Policy > Assignments
- Managed identities created with correct roles
- Compliance evaluation starts (15-30 minutes)
- Event Hubs auto-created as logs flow (e.g., `insights-logs-auditevent`)

## Next Steps

1. Monitor Event Hub metrics for incoming messages
2. Configure Cribl Stream pipelines for log processing
3. Set up alerting for compliance drift
4. Review costs after 1 week and adjust if needed

---

**Full documentation:** [README.md](README.md)

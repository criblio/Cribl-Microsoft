# CLAUDE.md - Unified Azure Lab

This file provides guidance to Claude Code when working with the **Unified Azure Lab** system.

## CRITICAL: Code Style Rules

**NEVER USE EMOJIS**: Do not use emojis in any code, comments, output messages, documentation, or communication. This is a strict requirement for all files in this repository.

## Project Overview

The **Unified Azure Lab** is a comprehensive PowerShell-based deployment system that consolidates 6 specialized Azure labs into one cohesive, modular deployment framework. It automates the deployment of:

- **Infrastructure**: VNet, VPN Gateway, Azure Bastion, Network Security Groups
- **Monitoring**: Log Analytics, Sentinel, Network Watcher, VNet Flow Logs, Private Link (AMPLS)
- **Analytics**: Event Hub, Azure Data Explorer (ADX)
- **Storage**: Storage Accounts, Blob containers, Queues, Event Grid
- **Virtual Machines**: Test VMs with auto-shutdown for traffic generation

**Primary Use Case**: Testing and development environment for **Cribl Stream** integration with Azure services.

**IMPORTANT**: This lab deploys the Azure infrastructure. For creating Data Collection Rules (DCRs) to ingest data into Log Analytics, use the separate **DCR-Automation** system located at `Azure/CustomDeploymentTemplates/DCR-Automation/`. See the "DCR-Automation vs UnifiedLab" section below for details.

## DCR-Automation vs UnifiedLab

### Understanding the Separation

**UnifiedLab** and **DCR-Automation** are **two separate, complementary systems** that work together in the Cribl-Azure workflow:

#### UnifiedLab (This System)
 **Location**: `Azure/dev/LabAutomation/UnifiedLab/`

**Purpose**: Deploys Azure infrastructure and services

**What it creates**:
- VNets, subnets, VPN, Bastion, NSGs
- Log Analytics Workspace (but NOT DCRs)
- Sentinel enablement
- VNet Flow Logs
- Event Hub namespace and hubs
- Storage Accounts
- ADX clusters (optional)
- Test VMs

**Cribl Integration**: Generates **SOURCE** configurations
- Event Hub sources (where to collect from)
- Blob storage collectors (flow logs, etc.)
- Storage queue sources
- Log Analytics workspace queries

**Run This**: `.\Run-AzureUnifiedLab.ps1`

---

#### DCR-Automation (Separate System)
 **Location**: `Azure/CustomDeploymentTemplates/DCR-Automation/`

**Purpose**: Creates Data Collection Rules for Log Analytics ingestion

**What it creates**:
- Data Collection Rules (DCRs) for native tables
- DCRs for custom tables (with _CL suffix)
- Data Collection Endpoints (DCEs) for advanced routing
- Custom tables (if they don't exist)
- Schema validation and migration

**Cribl Integration**: Generates **DESTINATION** configurations
- DCR ingestion endpoints (where to send data to)
- Stream names and authentication details
- Table mappings

**Run This**: `.\Run-DCRAutomation.ps1` (from DCR-Automation directory)

---

### Typical Workflow

```

 Step 1: Run UnifiedLab (this script) 
 ------------------------------------------------------------ 
 Deploys: VNet, Log Analytics, Event Hub, Storage, etc. 
 Output: Cribl SOURCE configs (sources.json) 

 ↓

 Step 2: Run DCR-Automation (separate script) 
 ------------------------------------------------------------ 
 Creates: DCRs for SecurityEvent, Syslog, Custom_CL, etc. 
 Output: Cribl DESTINATION configs (destinations.json) 

 ↓

 Step 3: Configure Cribl Stream 
 ------------------------------------------------------------ 
 1. Import sources from UnifiedLab 
 2. Import destinations from DCR-Automation 
 3. Create pipelines/routes 

 ↓

 Step 4: Data Flow 
 ------------------------------------------------------------ 
 Event Hub → Cribl Stream → DCR Endpoint → Log Analytics 

```

### Why Separate?

1. **Different Lifecycles**: Infrastructure changes infrequently, DCRs change with data requirements
2. **Different Purposes**: Infrastructure = platform, DCRs = data ingestion paths
3. **Modularity**: Can update DCRs without redeploying infrastructure
4. **Specialization**: Each system focuses on its specific domain

### Access DCR-Automation from Menu

In the UnifiedLab menu, press **[D]** to see detailed information about DCR-Automation and how to run it.

## Recent Major Changes

### Session Summary (2025-12-05) - DCR and Cleanup Fixes

1. **Fixed logsIngestion Endpoint Extraction for Direct DCRs**:
   - **Root Cause**: Code was looking at wrong property path. Microsoft's March 2024 update changed the path from `properties.logsIngestion.endpoint` to `properties.endpoints.logsIngestion`
   - Updated [Create-TableDCRs.ps1](../../CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1) to use correct path
   - Added `properties.endpoints.logsIngestion` as primary extraction path
   - Kept legacy path `properties.logsIngestion.endpoint` as fallback
   - Added debug logging to show REST API response structure for troubleshooting

2. **Removed Location-Based Fallback for logsIngestion**:
   - Previously, if endpoint extraction failed, code would construct a fallback URL based on location
   - User explicitly requested: throw error instead of guessing
   - Now throws clear error: "Could not extract logsIngestion endpoint from Direct DCR"
   - This surfaces timing issues (DCRs not fully provisioned) rather than masking them

3. **Moved Cleanup to Resilient Location**:
   - **Problem**: DCR-Automation output directories (`cribl-dcr-configs`, `generated-templates`) were not being cleaned up on error
   - **Fix**: Moved cleanup from success path to `finally` block in [Deploy-DCRs.ps1](Core/Phase8-DataCollection/Deploy-DCRs.ps1#L362-L384)
   - Cleanup now runs regardless of success or failure
   - Prevents leftover files from accumulating in DCR-Automation directory

4. **Fixed PowerShell String Multiplication Syntax**:
   - **Issue**: `"="*50` was appearing literally as `=*50` in console output
   - **Fix**: Changed to `$('='*50)` in [Run-DCRAutomation.ps1](../../CustomDeploymentTemplates/DCR-Automation/Run-DCRAutomation.ps1)
   - PowerShell requires subexpression syntax for string multiplication in Write-Host

5. **Added Phase Selection Logic**:
   - Added `Test-PhaseRequired` helper function to [Run-AzureUnifiedLab.ps1](Run-AzureUnifiedLab.ps1#L364-L423)
   - Phases are now conditionally invoked based on lab configuration
   - Reduces debug log noise by not invoking phases that aren't needed
   - Phase 1 (Foundation) always runs; other phases run based on LabConfig

6. **Fixed Empty String Parameter Binding Error**:
   - **Problem**: Cribl destination config generation failed with: `Cannot bind argument to parameter 'Message' because it is an empty string`
   - **Root Cause**: Write-DCR* functions in [Output-Helper.ps1](../../CustomDeploymentTemplates/DCR-Automation/core/Output-Helper.ps1) had `[Parameter(Mandatory=$true)]` without `[AllowEmptyString()]` attribute
   - **Fix**: Added `[AllowEmptyString()]` attribute to all Write-DCR* functions:
     - `Write-ToLog`, `Write-DCRMessage`, `Write-DCRHeader`, `Write-DCRSubHeader`
     - `Write-DCRSuccess`, `Write-DCRError`, `Write-DCRWarning`, `Write-DCRVerbose`
     - `Write-DCRProgress`, `Write-DCRStatus` (both Property and Value parameters)
   - Only `Write-DCRInfo` previously had this attribute
   - This allows empty strings to be passed without throwing binding errors

**Timing Issue Note**: DCR logsIngestion endpoint extraction can fail if Azure hasn't fully provisioned the DCR. This is a timing issue - wait a few minutes and retry, or increase the wait time in Deploy-DCRs.ps1 (currently 60 seconds after Sentinel enablement).

### Session Summary (2025-10-26)

1. **Menu Override System**: Implemented menu configuration override logic in [Run-AzureUnifiedLab.ps1](Run-AzureUnifiedLab.ps1#L210-L273). Menu selections (options 1-9) now properly override operation-parameters.json defaults. Option [1] deploys everything regardless of JSON settings.

2. **VPN Connection Automation**:
 - Added [onprem-connection-parameters.json](onprem-connection-parameters.json) for on-premises VPN configuration
 - Implemented `Deploy-LocalNetworkGateway` function in [Deploy-Infrastructure.ps1](Core/Deploy-Infrastructure.ps1#L519-L578)
 - Implemented `Deploy-VPNConnection` function in [Deploy-Infrastructure.ps1](Core/Deploy-Infrastructure.ps1#L580-L743)
 - **Now automatically creates VPN Connection if onprem-connection-parameters.json is configured**
 - Displays on-premises device configuration instructions after connection creation

3. **VPN Gateway Fixes**:
 - Fixed Public IP to use Static allocation and Standard SKU (required for zone-redundant deployment)
 - Added zone redundancy (zones 1,2,3) for high availability

4. **Event Hub Consumer Groups**: Fixed parameter naming (`-Namespace` → `-NamespaceName`, `-EventHub` → `-EventHubName`) in [Deploy-Analytics.ps1](Core/Deploy-Analytics.ps1#L158-L177) to resolve ambiguous parameter errors.

5. **Sentinel & Monitoring Fixes**: Fixed Sentinel deployment to use ARM template method, fixed diagnostic settings cmdlet, enabled Flow Logs and VPN Gateway in default config.

### Session Summary (2025-10-25)

1. **Subnet Overlap Fix**: Updated [Deploy-Infrastructure.ps1](Core/Deploy-Infrastructure.ps1#L122-L193) to automatically remove old subnets before adding new ones, preventing overlap errors during VNet updates.

2. **Added PrivateLink Subnet**: Added dedicated subnet for private endpoints (10.198.30.128/27) with 30-day flow log retention. Updated [azure-parameters.json](azure-parameters.json#L114-L118).

3. **Consolidated Cribl Scripts**: Merged duplicate `Generate-CriblFlowLogCollectors.ps1` and `Generate-CriblConfigurations.ps1` into single dual-purpose [Cribl-Integration.ps1](Core/Cribl-Integration.ps1) that works as both a module (dot-sourced) and standalone CLI.

4. **Directory Restructure**: Eliminated `prod/` directory. Moved all deployment scripts to `Core/`, configuration files to root. Cleaner, simpler structure.

## Directory Structure

```
UnifiedLab/
 azure-parameters.json # Main Azure configuration
 operation-parameters.json # Deployment flags and options
 Run-AzureUnifiedLab.ps1 # Main entry point (interactive menu)

 Core/ # All scripts consolidated here
 Cribl-Integration.ps1 # Cribl config generator (dual-purpose)
 Deploy-Analytics.ps1 # Event Hub + ADX deployment
 Deploy-Infrastructure.ps1 # VNet, VPN, Bastion, NSGs
 Deploy-Monitoring.ps1 # Log Analytics, Flow Logs, AMPLS
 Deploy-Storage.ps1 # Storage Account, Blobs, Queues
 Deploy-VMs.ps1 # Test VM deployment
 Menu-Framework.ps1 # Interactive menu system
 Naming-Engine.ps1 # Centralized resource naming
 Validation-Module.ps1 # Configuration validation

 docs/ # Documentation
 Location-Based-Naming.md
 TTL-Implementation.md

 (generated at runtime)
 cribl-configurations/ # Generated Cribl Stream configs
```

## Core Architecture

### Configuration System

**Two-Tier Configuration Model**:

The UnifiedLab uses a two-tier system for controlling deployments:

1. **[azure-parameters.json](azure-parameters.json)** - "HOW to configure":
 - Contains detailed configuration for each resource type
 - Defines SKUs, sizes, retention periods, naming, etc.
 - Has `enabled` flags that act as **master switches** (must be true for component to deploy)
 - Example: `analytics.adx.enabled = true` means ADX CAN be deployed if requested
 - These settings are NOT overridden by menu selections

2. **[operation-parameters.json](operation-parameters.json)** - "WHAT to deploy":
 - Controls which components to deploy in a given run
 - Has `deployX` flags (deployADX, deploySentinel, etc.)
 - These flags ARE overridden by menu selections
 - Example: `deployment.analytics.deployADX = true` means ADX WILL be deployed (if azure-parameters also allows it)

**Deployment Logic**: A component deploys ONLY if BOTH conditions are true:
- `azure-parameters.json` → `enabled = true` (master switch)
- `operation-parameters.json` → `deployX = true` (deployment request, can be overridden by menu)

**Example**:
```
ADX will deploy if:
 azure-parameters.json → analytics.adx.enabled = true (allows ADX)
 AND
 operation-parameters.json → deployment.analytics.deployADX = true (requests ADX)
 OR
 Menu option [1] CompleteLab (overrides to deployADX = true)
```

**Important**: Menu overrides only affect operation-parameters, not azure-parameters. Therefore, azure-parameters.json `enabled` flags should be `true` by default for components you want available through menu selections.

### Current Subnet Architecture (5 subnets in 10.198.30.0/24)

| Subnet | CIDR | Purpose | Flow Log Retention |
|--------|------|---------|-------------------|
| GatewaySubnet | 10.198.30.0/27 | VPN Gateway (required name) | 1 day |
| AzureBastionSubnet | 10.198.30.32/27 | Azure Bastion (required name) | 7 days |
| SecuritySubnet | 10.198.30.64/27 | Security services, test VMs | 30 days |
| O11ySubnet | 10.198.30.96/27 | Observability (monitoring, logging) | 90 days |
| PrivateLinkSubnet | 10.198.30.128/27 | Private endpoints for PaaS services | 30 days |

**Remaining space**: 10.198.30.160/27 through 10.198.30.255 (96 addresses available)

### Key Design Patterns

1. **Location-Based Naming**: Resource names automatically include location suffix (e.g., `eastus`, `westus2`). Naming logic is centralized in [Naming-Engine.ps1](Core/Naming-Engine.ps1).

2. **Modular Deployment**: Each component has its own deployment script. Can deploy full lab or individual components.

3. **Incremental Deployment**: Scripts detect existing resources and skip/update them. Safe to run multiple times.

4. **Dual-Mode Scripts**: [Cribl-Integration.ps1](Core/Cribl-Integration.ps1) can be dot-sourced as a module OR run standalone as a CLI.

5. **TTL Tagging**: Automatic resource cleanup after specified hours. Tags are applied to Resource Group level.

6. **Subnet Management**: Automatic removal of old subnets before adding new ones to prevent overlap conflicts.

7. **Menu Override System**: Menu selections (option 1-9) override operation-parameters.json defaults. See details below.

## Usage

### Interactive Menu Mode (Recommended)

```powershell
.\Run-AzureUnifiedLab.ps1
```

Menu options:
- **[1-8]** - Deploy specific lab configurations (Complete, Infrastructure, Monitoring, etc.)
- **[9]** - Custom component selection
- **[C]** - Generate Cribl Stream configurations
- **[S]** - Status & resource display
- **[V]** - Validate configuration
- **[Q]** - Quit

### Non-Interactive Mode

```powershell
# Deploy all enabled components
.\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Full

# Deploy only infrastructure
.\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Infrastructure

# Deploy only monitoring
.\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Monitoring
```

### Generate Cribl Configurations

```powershell
# From menu: Option [C]

# Or run directly
.\Core\Cribl-Integration.ps1
.\Core\Cribl-Integration.ps1 -SkipWait
```

Generates configurations for:
- Log Analytics Workspace collectors
- Blob Storage collectors (including flow logs)
- Event Hub sources
- Storage Queue sources
- ADX destinations

Output: `cribl-configurations/` directory with JSON files

## Key Scripts Explained

### [Run-AzureUnifiedLab.ps1](Run-AzureUnifiedLab.ps1)
Main entry point. Loads configuration, validates settings, displays menu, orchestrates deployment scripts.

**Key functions:**
- `Show-Menu` - Interactive menu display
- `Show-Status` - Display current config and deployed resources
- `Deploy-Lab` - Main deployment orchestration

### [Deploy-Infrastructure.ps1](Core/Deploy-Infrastructure.ps1)
Deploys networking foundation.

**Key functions:**
- `Deploy-VirtualNetwork` - Creates VNet with automatic subnet management (removes old, adds new)
- `Deploy-NetworkSecurityGroups` - Creates NSGs for each subnet (except Gateway/Bastion)
- `Deploy-VPNGateway` - Creates VPN Gateway (30-45 min deployment time)
- `Deploy-AzureBastion` - Creates Azure Bastion (10-15 min deployment time)

**Important**: Lines 122-193 handle subnet transitions by removing old subnets before adding new ones.

### [Deploy-Monitoring.ps1](Core/Deploy-Monitoring.ps1)
Deploys observability stack.

**Key functions:**
- `Deploy-LogAnalyticsWorkspace` - Creates Log Analytics workspace
- `Deploy-NetworkWatcher` - Ensures Network Watcher exists
- `Deploy-FlowLogs` - Configures both vNet-level and subnet-level flow logs
- `Deploy-AMPLS` - Creates Azure Monitor Private Link Scope + private endpoint

**Important**: Flow logs support dual-level configuration (vNet + per-subnet) with different retention policies.

### [Deploy-Storage.ps1](Core/Deploy-Storage.ps1)
Deploys storage resources.

**Key functions:**
- `Deploy-StorageAccount` - Creates storage account with SKU selection
- `Deploy-BlobContainers` - Creates containers for logs, flow logs, Event Hub capture, ADX ingestion
- `Deploy-StorageQueues` - Creates queues for event processing

### [Deploy-Analytics.ps1](Core/Deploy-Analytics.ps1)
Deploys Event Hub and ADX.

**Key functions:**
- `Deploy-EventHubNamespace` - Creates Event Hub namespace
- `Deploy-EventHubs` - Creates individual hubs with partition/retention settings
- `Deploy-ADXCluster` - Creates Azure Data Explorer cluster (15-20 min deployment time)
- `Deploy-ADXDatabase` - Creates database in cluster

**Cost Warning**: ADX costs ~$240/month minimum even for Dev SKU.

### [Deploy-VMs.ps1](Core/Deploy-VMs.ps1)
Deploys test VMs for traffic generation.

**Key functions:**
- `Deploy-TestVMs` - Creates VMs with NICs, auto-shutdown schedules
- Supports deployment to SecuritySubnet and O11ySubnet
- Ubuntu 22.04 LTS, Standard_B1s size
- Auto-shutdown at 7 PM EST (configurable)

### [Cribl-Integration.ps1](Core/Cribl-Integration.ps1)
Dual-purpose Cribl configuration generator.

**Key functions (Module Mode):**
- `Generate-WorkspaceCollector` - Log Analytics collector config
- `Generate-BlobCollector` - Blob storage collector config
- `Generate-FlowLogCollector` - Flow log specific collector config
- `Generate-EventHubSource` - Event Hub source config
- `Generate-QueueSource` - Storage queue source config
- `Generate-ADXDestination` - ADX destination config
- `Export-CriblConfigurations` - Master orchestrator

**Standalone Mode (Lines 491-694):**
- Auto-loads azure-parameters.json
- Discovers deployed resources
- Offers to wait for flow logs (5-10 min after deployment)
- Generates all configs in one run
- Provides next steps for Cribl Stream setup

### [Naming-Engine.ps1](Core/Naming-Engine.ps1)
Centralized resource naming logic.

**Key functions:**
- `Get-ResourceName` - Generates resource name with prefix/suffix
- `Get-StorageAccountName` - Special handling for storage (lowercase, max 24 chars)
- `Get-ResourceNames` - Generates all resource names at once

**Naming pattern**: `{prefix}-{baseObjectName}-{suffix}`
- Prefix: Resource type (e.g., `vnet`, `nsg`, `law`)
- BaseObjectName: From azure-parameters.json
- Suffix: Location-based (automatically set from location field)

### [Menu-Framework.ps1](Core/Menu-Framework.ps1)
Interactive menu system and lab configuration presets.

**Key functions:**
- `Show-MainMenu` - Displays main menu
- `Get-LabConfiguration` - Returns deployment config for each menu option
- `Prompt-LabMode` - Asks for Public/Private mode

**Lab Configurations:**
1. Complete Lab - Everything enabled
2. Complete Lab (Private) - Everything with private endpoints
3. Infrastructure Lab - VNet, VPN, Bastion, NSGs
4. Monitoring Lab - Log Analytics, Sentinel, Flow Logs
5. Analytics Lab - Event Hub, ADX
6. Storage Lab - Storage Account, containers, queues
7. Flow Log Lab - Infrastructure + Monitoring + VMs
8. Cribl Test Lab - Complete minus ADX

### [Validation-Module.ps1](Core/Validation-Module.ps1)
Configuration validation functions.

**Key functions:**
- `Test-AzureParametersConfiguration` - Main validation entry point (called at startup)
- `Test-RequiredFields` - Validates required config fields
- `Test-CIDRNotation` - Validates CIDR format
- `Test-SubnetOverlap` - Checks for subnet IP overlaps
- `Test-StorageAccountName` - Validates storage naming rules
- `Test-ADXClusterSKU` - Validates ADX SKU selection
- `Test-EventHubPartitionCount` - Validates partition count (1-32)

## Menu Override System

### How It Works

The UnifiedLab uses a **menu-first architecture** where menu selections (options 1-9) override the default settings in [operation-parameters.json](operation-parameters.json). This allows the same lab to be deployed in different configurations without manually editing JSON files.

**Flow:**
```

 1. User selects menu option (e.g., [1] Complete Lab) 

 ↓

 2. Get-LabDeploymentConfig returns config for that option 
 (defined in Menu-Framework.ps1, lines 238-319) 

 ↓

 3. Invoke-Deployment receives CustomComponents parameter 
 (Run-AzureUnifiedLab.ps1, line 522, 531, etc.) 

 ↓

 4. Menu override logic merges CustomComponents into 
 operation-parameters.json (lines 210-273) 

 ↓

 5. Deploy-* scripts receive overridden operationParams 
 Menu values take precedence! 

```

### Example: Option 1 (Complete Lab)

When you select **[1] Complete Lab - Public Mode**, the following happens:

1. **Menu config** (Menu-Framework.ps1:250-256):
 ```powershell
 @{
 Infrastructure = @{ DeployVNet = $true; DeployVPN = $true; DeployBastion = $false }
 Storage = @{ Deploy = $true; DeployContainers = $true; DeployQueues = $true }
 Monitoring = @{ DeployLogAnalytics = $true; DeploySentinel = $true; DeployFlowLogs = $true }
 Analytics = @{ DeployEventHub = $true; DeployADX = $true }
 }
 ```

2. **Override logic** (Run-AzureUnifiedLab.ps1:210-273) converts this to:
 ```json
 {
 "deployment": {
 "infrastructure": {
 "deployVNet": true,
 "deployVPNGateway": true,
 "deployBastion": false
 },
 "storage": {
 "deployStorageAccount": true,
 "deployContainers": true,
 "deployQueues": true
 },
 "monitoring": {
 "deployLogAnalytics": true,
 "deploySentinel": true,
 "deployFlowLogs": true
 },
 "analytics": {
 "deployEventHub": true,
 "deployADX": true
 }
 }
 }
 ```

3. **Result**: All components deploy regardless of operation-parameters.json defaults

### When Menu Overrides Apply

- **Options 1-8**: Use predefined lab configurations from `Get-LabDeploymentConfig`
- **Option 9**: User selects custom components interactively
- **Non-Interactive Mode**: Uses operation-parameters.json directly (NO overrides)

### Debugging Menu Overrides

If components aren't deploying as expected:

1. **Check menu config** in [Menu-Framework.ps1](Core/Menu-Framework.ps1) lines 238-319
2. **Watch for override message** during deployment: `"Applying menu configuration overrides..."`
3. **Verify CustomComponents parameter** is being passed to `Invoke-Deployment`
4. **Check override logic** in [Run-AzureUnifiedLab.ps1](Run-AzureUnifiedLab.ps1) lines 210-273

### Menu Configuration Mapping

Each menu option maps to a lab type:

| Menu Option | Lab Type | Key Components |
|-------------|----------|----------------|
| [1] | CompleteLab | Everything (VPN, Storage, Sentinel, Event Hub, ADX) |
| [2] | SentinelLab | VNet, VPN, Log Analytics, Sentinel, Flow Logs |
| [3] | ADXLab | VNet, VPN, Storage, Event Hub, ADX |
| [4] | FlowLogLab | VNet, VPN, Storage, Log Analytics, Flow Logs, VMs |
| [5] | EventHubLab | VNet, VPN, Storage, Event Hub (with capture) |
| [6] | BlobQueueLab | VNet, VPN, Storage, Queues, Event Grid |
| [7] | BlobCollectorLab | VNet, VPN, Storage, Sample Data |
| [8] | BasicInfrastructure | VNet, VPN, NSGs only |
| [9] | Custom | User-selected components |

## Configuration Guide

### Before First Run

1. **Ensure Azure Permissions**:
 - Login to Azure: `Connect-AzAccount`
 - Set subscription: `Set-AzContext -Subscription "Your-Subscription-Name"`
 - **Required Permissions** (choose one):
 - Option A: `Contributor` or `Owner` at **subscription level** (can create resource group)
 - Option B: Create resource group manually, then get `Contributor` at **resource group level**
 - **Recommended**: `Owner` role for full deployment capabilities (includes role assignments)
 - The script will validate your permissions automatically on startup

2. **Edit [azure-parameters.json](azure-parameters.json)**:
 - Set `subscriptionId` to your Azure subscription GUID
 - Set `resourceGroupName` to desired name (will be created if doesn't exist)
 - Set `location` to Azure region (e.g., `eastus`, `westus2`)
 - Set `baseObjectName` to your naming prefix (e.g., `cribllab`, `jpederson`)
 - Update authentication section if using Cribl (tenantId, clientId, clientSecret)

3. **Review [operation-parameters.json](operation-parameters.json)**:
 - Enable/disable components in `deployment` section
 - Set `skipExistingResources: true` for incremental deployment
 - Set `verboseOutput: true` for detailed logging

3. **Connect to Azure**:
 ```powershell
 Connect-AzAccount
 Set-AzContext -Subscription "Your-Subscription-Name"
 ```

### Common Configuration Tasks

**Enable Private Endpoints**:
- In [azure-parameters.json](azure-parameters.json), set lab mode to `private` or use menu option [2]

**Enable TTL Auto-Cleanup**:
```json
"timeToLive": {
 "enabled": true,
 "hours": 48,
 "warningHours": 24,
 "userEmail": "your-email@example.com"
}
```

**Enable VM Deployment**:
```json
"virtualMachines": {
 "enabled": true
}
```

**Add Custom Subnets**:
Add to `infrastructure.subnets` in [azure-parameters.json](azure-parameters.json):
```json
"mysubnet": {
 "name": "MySubnet",
 "addressPrefix": "10.198.30.160/27",
 "description": "Custom subnet description"
}
```
NSG will be auto-created and named `nsg-MySubnet-{location}`

**Configure Flow Log Retention**:
Edit `monitoring.flowLogging.subnetLevel` in [azure-parameters.json](azure-parameters.json):
```json
"security": {
 "enabled": true,
 "retentionDays": 30
}
```

## Troubleshooting

### Permission Errors

**Error**: `Missing 'Contributor' or 'Owner' role`

**Solution**: The script validates your Azure permissions before deployment. You have two options:

**Option A: Subscription-Level Permissions** (Can create resource group automatically)
- Request `Contributor` or `Owner` role at subscription level
- Script will create resource group for you

**Option B: Resource Group-Level Permissions** (If RG already exists)
- Have administrator create the resource group manually
- Request `Contributor` role at the resource group level only
- More restrictive, but sufficient if RG exists

**Recommended**: `Owner` role for full deployment capabilities (includes role assignments)

**Component-Specific Permissions**:
- **Sentinel**: Requires `Azure Sentinel Contributor` or `Security Admin` role
- **Flow Logs**: Requires `Network Contributor` role
- **Private Link/Endpoints**: Requires `Network Contributor` role
- **Role Assignments**: Requires `User Access Administrator` or `Owner` role

**Check your current roles**:
```powershell
$context = Get-AzContext
Get-AzRoleAssignment -SignInName $context.Account.Id | Select-Object RoleDefinitionName, Scope
```

**Warnings vs Errors**:
- **Errors** (red): Block deployment, must be resolved
- **Warnings** (yellow): May allow deployment, but specific features might fail

**Workaround**: If permissions detection is failing but you know you have the right permissions (especially with group-based permissions or complex Azure AD setups), you can skip the permissions check:

Set in [operation-parameters.json](operation-parameters.json):
```json
"validation": {
 "skipPermissionsCheck": true
}
```

This will skip the permissions validation entirely and allow deployment to proceed.

### Not Logged In to Azure

**Error**: `Not logged in to Azure`

**Solution**:
```powershell
Connect-AzAccount
Set-AzContext -Subscription "Your-Subscription-Name"
```

### Subnet Overlap Error

**Error**: `Subnet 'X' is not valid because its IP address range overlaps...`

**Solution**: The infrastructure deployment script automatically handles this now. It removes old subnets before adding new ones. If you still encounter issues:
1. Delete the VNet manually in Azure Portal
2. Re-run deployment - VNet will be recreated with correct subnets

### Flow Logs Not Generating

**Symptom**: Cribl collector generation finds no flow log container

**Solution**: Flow logs take 5-10 minutes to start after infrastructure deployment. Wait and re-run `.\Core\Cribl-Integration.ps1` or use menu option [C].

### VPN Gateway Timeout

**Symptom**: Script times out waiting for VPN Gateway

**Solution**: VPN Gateway takes 30-45 minutes to deploy. This is normal Azure behavior. The script will wait, but if interrupted, re-run the deployment - it will skip existing resources.

### VPN Gateway vs VPN Connection

**VPN Gateway** (always created when enabled):
- Azure resource that accepts VPN connections
- Has a public IP address
- Takes 30-45 minutes to deploy
- Created automatically by UnifiedLab

**VPN Connection** (automatically created if configured):
- Links Azure VPN Gateway to your on-premises network
- **Requires [onprem-connection-parameters.json](onprem-connection-parameters.json) configuration**
- If file exists and is configured, Local Network Gateway and VPN Connection are created automatically
- If file doesn't exist or has placeholder values, VPN Connection is skipped

**To enable automatic VPN Connection creation**:

1. **Edit [onprem-connection-parameters.json](onprem-connection-parameters.json)**:
 - Replace `<YOUR-ONPREM-PUBLIC-IP>` with your on-prem VPN device's public IP
 - Replace `<YOUR-SHARED-KEY-HERE>` with a strong pre-shared key (32+ characters)
 - Update `addressSpace` array with your on-prem network CIDR blocks

2. **Run deployment** - VPN Connection will be created automatically

3. **Configure on-premises device** - Script displays configuration instructions with:
 - Azure VPN Gateway Public IP
 - Phase 1 (IKE) settings
 - Phase 2 (IPsec) settings
 - Encryption/integrity algorithms
 - Network address spaces

**Supported VPN devices**: pfSense, FortiGate, Cisco ASA, Palo Alto, SonicWall, etc.

**To disable VPN Connection**: Delete or rename `onprem-connection-parameters.json`

### ADX Cluster Creation Fails

**Error**: Quota limit or SKU not available

**Solution**:
- Dev SKU requires special subscription permissions
- Try different location
- Check Azure quota limits for ADX in your subscription

### Storage Account Name Too Long

**Error**: Storage account name exceeds 24 characters

**Solution**: Shorten `baseObjectName` in [azure-parameters.json](azure-parameters.json). Storage names are auto-truncated, but may conflict if multiple similar names exist.

### Module Loading Error

**Error**: `Export-ModuleMember cmdlet can only be called from inside a module`

**Solution**: This was fixed by using dot-sourcing (`. script.ps1`) instead of `Import-Module` for .ps1 files. If you see this, ensure all Core scripts use dot-sourcing in [Run-AzureUnifiedLab.ps1](Run-AzureUnifiedLab.ps1#L64-L66).

## Cost Estimates

| Component | Monthly Cost (USD) | Notes |
|-----------|-------------------|-------|
| VNet | Free | Data transfer charges may apply |
| VPN Gateway (Basic) | ~$27 | ~$140 for VpnGw1 |
| Azure Bastion (Basic) | ~$140 | Standard is ~$280 |
| Log Analytics | Variable | Based on data ingestion (first 5GB/day free) |
| Storage (LRS) | ~$2-5 | Based on data volume |
| Event Hub (Standard) | ~$11 | 1 throughput unit |
| ADX (Dev SKU) | ~$240 | Minimum cost even for Dev |
| VM (B1s) | ~$8 | Per VM, with auto-shutdown savings |
| NSG Flow Logs | ~$0.50 | Per GB ingested |

**Complete Lab Estimate**: ~$320-350/month (includes ADX)
**Without ADX**: ~$80-110/month

## Important Notes

### Naming Conventions

- **Resource Groups**: Use `rg-{purpose}-{location}` format
- **VNets**: `vnet-{baseObjectName}-{location}`
- **NSGs**: `nsg-{SubnetName}-{location}` (auto-generated per subnet)
- **Storage**: `st{baseobjectname}{location}` (lowercase, no hyphens, max 24 chars)
- **Event Hub**: `evhns-{baseObjectName}-{location}`
- **ADX**: `adx{baseobjectname}{location}` (lowercase, no hyphens)
- **VMs**: `vm-{subnetname}` (e.g., `vm-security`, `vm-o11y`)

### Subnet Naming Requirements

- **GatewaySubnet**: Required exact name for VPN Gateway (cannot be changed)
- **AzureBastionSubnet**: Required exact name for Azure Bastion (cannot be changed)
- Other subnets can use any name

### Flow Log Hierarchy

VNet Flow Logs support multiple levels:
1. **NIC-level**: Highest priority (not implemented in this lab)
2. **Subnet-level**: Medium priority (implemented with different retention per subnet)
3. **VNet-level**: Lowest priority / fallback (implemented with 7-day retention)

Most specific configuration wins. If a subnet has its own flow log, it overrides the vNet-level setting.

### Private Link Subnet Usage

When lab mode is set to `private`, the PrivateLinkSubnet is used for:
- Azure Monitor Private Link Scope (AMPLS) endpoint
- Storage Account private endpoints (future)
- Event Hub private endpoints (future)
- ADX private endpoints (future)

### TTL Tag Behavior

When TTL is enabled:
- `TTL_Enabled = "true"` tag is applied to Resource Group
- `TTL_ExpirationTime` tag contains UTC timestamp
- `TTL_WarningTime` tag is 24 hours before expiration (sends warning email)
- `TTL_UserEmail` tag contains notification email
- External automation reads these tags to delete Resource Group at expiration

### Auto-Shutdown for VMs

VMs use Azure DevTest Labs auto-shutdown feature:
- Default: 7 PM EST daily
- Configurable in [azure-parameters.json](azure-parameters.json) `virtualMachines.configuration.autoShutdownTime`
- Saves costs when VMs not needed overnight
- VMs do not auto-start - must start manually

## Next Steps / Future Enhancements

### Potential Improvements

1. **Terraform Port**: Convert PowerShell to Terraform for better IaC practices
2. **CI/CD Integration**: Add GitHub Actions workflow for automated testing
3. **Cost Alerting**: Add budget alerts and cost tracking
4. **Health Checks**: Add post-deployment validation scripts
5. **Cleanup Script**: Add script to cleanly tear down entire lab
6. **Private Endpoint Expansion**: Add private endpoints for Storage, Event Hub, ADX
7. **Custom Table Support**: Add support for custom Log Analytics tables
8. **Cribl Pack Integration**: Auto-deploy Cribl packs for Azure sources
9. **Multi-Region Support**: Deploy resources across multiple regions
10. **ARM Template Export**: Export deployment as ARM template for repeatability

### Known Limitations

1. **Single Region**: Currently deploys all resources to one region
2. **Single Subscription**: Doesn't support cross-subscription deployments
3. **Manual Credentials**: Requires manual entry of service principal credentials
4. **No State Management**: Doesn't track state like Terraform (relies on Azure API queries)
5. **Limited Rollback**: No automatic rollback on partial failures
6. **VPN Config**: Creates gateway but doesn't configure on-premises connection

## Development Workflow

### Making Changes

1. **Always test locally first** before committing
2. **Use git branches** for features (e.g., `feature/add-aks-support`)
3. **Update this CLAUDE.md** when making architectural changes
4. **Test both interactive and non-interactive modes**
5. **Validate with multiple Azure regions**

### Testing Checklist

- [ ] Validation passes (`.\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Validate`)
- [ ] Fresh deployment works (new resource group)
- [ ] Incremental deployment works (run twice on same RG)
- [ ] Menu system displays correctly
- [ ] Non-interactive mode works
- [ ] Cribl config generation succeeds
- [ ] Generated configs are valid JSON
- [ ] All NSGs are created and associated with subnets
- [ ] Flow logs are configured correctly
- [ ] Resource naming follows conventions

### Git Workflow

Main branch is protected. All changes via pull requests:

```bash
git checkout main
git pull origin main
git checkout -b feature/your-feature-name

# Make changes
git add .
git commit -m "Add feature description"
git push origin feature/your-feature-name

# Create PR on GitHub
```

## Support and Documentation

- **Main Repo README**: [README.md](README.md)
- **Location-Based Naming**: [docs/Location-Based-Naming.md](docs/Location-Based-Naming.md)
- **TTL Implementation**: [docs/TTL-Implementation.md](docs/TTL-Implementation.md)
- **Quickstart Guide**: [QUICKSTART.md](QUICKSTART.md)
- **Status Document**: [STATUS.md](STATUS.md)

## Dev/Prod Mode Switching

Claude Code can switch between development and production configurations by updating the azure-parameters.json file.

### Available Modes

When the user says "switch to dev mode" or "switch to prod mode", update the azure-parameters.json file with the appropriate configuration.

### Dev Mode Configuration (jpederson)

**Files to update:**
1. `azure-parameters.json` - Main configuration
2. `onprem-connection-parameters.json` - VPN connection settings

#### azure-parameters.json (Dev Mode)

```json
{
  "subscriptionId": "00000000-0000-0000-0000-000000000000",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "clientId": "00000000-0000-0000-0000-000000000000",
  "_authComment": "tenantId and clientId are used for Azure AD authentication in Cribl Stream destinations.",
  "ownerTag": "jpederson@cribl.io",
  "resourceGroupName": "rg-jpederson",
  "location": "eastus",
  "baseObjectName": "jpederson",
  "timeToLive": {
    "userEmail": "jpederson@cribl.io"
  },
  "infrastructure": {
    "onPremisesNetwork": {
      "addressSpaces": ["10.198.32.0/24"],
      "vpnDevicePublicIp": "70.63.82.233",
      "managementSubnets": ["10.198.32.0/24"]
    }
  }
}
```

#### onprem-connection-parameters.json (Dev Mode)

```json
{
  "localNetworkGateway": {
    "name": "lng-onprem",
    "gatewayIpAddress": "70.63.82.233",
    "addressSpace": ["10.198.32.0/24"],
    "description": "On-premises network gateway configuration"
  },
  "vpnConnection": {
    "name": "conn-azure-to-onprem",
    "connectionType": "IPsec",
    "sharedKey": "74e1736fe62147d3a5599e18982100d5a46e8c969289d5cf501c40cb",
    "enableBgp": false,
    "usePolicyBasedTrafficSelectors": false,
    "ipsecPolicies": {
      "enabled": false,
      "saLifeTimeSeconds": 27000,
      "saDataSizeKilobytes": 102400000,
      "ipsecEncryption": "AES256",
      "ipsecIntegrity": "SHA256",
      "ikeEncryption": "AES256",
      "ikeIntegrity": "SHA256",
      "dhGroup": "DHGroup2",
      "pfsGroup": "PFS2"
    }
  }
}
```

### Prod Mode Configuration (Sanitized for GitHub)

Use this configuration to sanitize files before publishing to GitHub. All sensitive values are replaced with generic placeholders.

**Files to sanitize:**
1. `azure-parameters.json` - Main configuration
2. `onprem-connection-parameters.json` - VPN connection settings

#### azure-parameters.json (Prod Mode)

```json
{
  "subscriptionId": "<YOUR-SUBSCRIPTION-ID>",
  "tenantId": "<YOUR-TENANT-ID>",
  "clientId": "<YOUR-CLIENT-ID>",
  "_authComment": "tenantId and clientId are used for Azure AD authentication in Cribl Stream destinations.",
  "ownerTag": "<YOUR-EMAIL>",
  "resourceGroupName": "rg-cribllab-eastus",
  "location": "eastus",
  "baseObjectName": "cribllab",
  "timeToLive": {
    "userEmail": "<YOUR-EMAIL>"
  },
  "infrastructure": {
    "onPremisesNetwork": {
      "addressSpaces": ["<YOUR-ONPREM-CIDR>"],
      "vpnDevicePublicIp": "<YOUR-VPN-DEVICE-PUBLIC-IP>",
      "managementSubnets": ["<YOUR-MANAGEMENT-SUBNET-CIDR>"]
    }
  }
}
```

#### onprem-connection-parameters.json (Prod Mode)

```json
{
  "localNetworkGateway": {
    "name": "lng-onprem",
    "gatewayIpAddress": "<YOUR-ONPREM-PUBLIC-IP>",
    "addressSpace": ["<YOUR-ONPREM-CIDR>"],
    "description": "On-premises network gateway configuration"
  },
  "vpnConnection": {
    "name": "conn-azure-to-onprem",
    "connectionType": "IPsec",
    "sharedKey": "<YOUR-SHARED-KEY-HERE>",
    "enableBgp": false,
    "usePolicyBasedTrafficSelectors": false,
    "ipsecPolicies": {
      "enabled": false,
      "saLifeTimeSeconds": 27000,
      "saDataSizeKilobytes": 102400000,
      "ipsecEncryption": "AES256",
      "ipsecIntegrity": "SHA256",
      "ikeEncryption": "AES256",
      "ikeIntegrity": "SHA256",
      "dhGroup": "DHGroup2",
      "pfsGroup": "PFS2"
    }
  }
}
```

### How to Switch Modes

**User says**: "switch to dev mode" or "use dev configuration"

**Claude action**: Update azure-parameters.json with the Dev Mode Configuration values (jpederson's personal dev settings). The onprem-connection-parameters.json should already have dev values if previously configured.

**User says**: "switch to prod mode" or "sanitize for github" or "prepare for publishing"

**Claude action**: Update BOTH files with the Prod Mode Configuration values:
1. **azure-parameters.json** - Replace all sensitive values with placeholders
2. **onprem-connection-parameters.json** - Replace IP addresses, CIDR blocks, and shared key with placeholders

**Important**: The sharedKey in onprem-connection-parameters.json is particularly sensitive - always replace with `<YOUR-SHARED-KEY-HERE>` before committing.

### Adding New Mode Configurations

To add a new mode (e.g., staging, test), add a new section here with the configuration values:

```markdown
### [Mode Name] Configuration

```json
{
  "subscriptionId": "...",
  "tenantId": "...",
  ...
}
```
```

Then Claude Code can switch to that mode when requested.

## Version History

### Current Version: 2.3 (2025-12-05)

**Major Changes:**
- Fixed logsIngestion endpoint extraction for Direct DCRs (correct property path: `properties.endpoints.logsIngestion`)
- Removed location-based fallback for logsIngestion - now throws error if extraction fails
- Moved DCR-Automation cleanup to `finally` block for resilient cleanup on success or failure
- Fixed PowerShell string multiplication syntax (`$('='*50)` instead of `"="*50`)
- Added `Test-PhaseRequired` function for selective phase invocation based on lab config
- Improved debug logging for REST API response structure
- Fixed empty string parameter binding error in Output-Helper.ps1 Write-DCR* functions

### Previous Versions:
- v2.1 (2025-12-03): Fixed VPN Gateway phase, Event Grid subscription, VM auto-shutdown, dev/prod mode switching
- v2.0: Consolidated Cribl scripts, eliminated prod/ directory, added PrivateLinkSubnet
- v1.0: Initial UnifiedLab consolidation (6 labs into 1)
- v0.x: Individual specialized labs (AzureFlowLogLab, BlobCollectorLab, etc.)

## Contact

For issues, questions, or contributions, see the main repository README or open an issue on GitHub.

---

**Last Updated**: 2025-12-05
**Maintained By**: Cribl-Microsoft Integration Team
**Primary Contributor**: James Pederson

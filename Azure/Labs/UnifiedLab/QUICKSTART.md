# Unified Azure Lab - Quick Start Guide

## What Is This?

The **Unified Azure Lab** is a comprehensive, modular deployment system that consolidates **6 specialized labs** into one cohesive infrastructure:

1. **ADXLab** - Azure Data Explorer
2. **AzureFlowLogLab** - VNet infrastructure with Flow Logs
3. **BlobCollectorLab** - Multi-tier blob storage
4. **BlobAzureQueueLab** - Event-driven queue notifications
5. **EventHubLab** - Event Hub streaming
6. **SentinelLab** - Microsoft Sentinel SIEM

**Key Features**:
- **Aggressive Resource Sharing**: Single VNet, Log Analytics, Storage, Event Hub namespace
- **Incremental Deployment**: Deploy components independently, build on existing infrastructure
- **Idempotent Design**: Safe to run multiple times
- **6 Deployment Phases**: Resource Group, Networking, Storage/Monitoring/Analytics, VMs/DCRs, Cribl Configs, VPN Gateway
- **Auto-Generated Cribl Configs**: Automatically creates Cribl Stream configurations
- **Unified Logging**: All deployment logs written to single timestamped log file

## 5-Minute Setup

### 1. Prerequisites

```powershell
# Install Azure PowerShell modules (if not already installed)
Install-Module -Name Az -AllowClobber -Scope CurrentUser

# Authenticate to Azure
Connect-AzAccount

# Set subscription (if you have multiple)
Set-AzContext -Subscription "<your-subscription-id>"
```

### 2. Configure Settings

**Edit `azure-parameters.json`**:
```json
{
  "subscriptionId": "12345678-1234-1234-1234-123456789abc",
  "tenantId": "your-tenant-id",
  "clientId": "your-client-id-for-cribl",
  "resourceGroupName": "rg-cribllab-eastus",
  "location": "eastus",
  "baseObjectName": "cribllab"
}
```

**Edit `operation-parameters.json`**:
```json
{
  "deployment": {
    "infrastructure": {
      "deployVNet": true,
      "deployVPNGateway": false,
      "deployBastion": false
    },
    "monitoring": {
      "deployLogAnalytics": true,
      "deploySentinel": true,
      "deployFlowLogs": true
    },
    "analytics": {
      "deployADX": false,
      "deployEventHub": true
    },
    "storage": {
      "deployStorageAccount": true
    }
  }
}
```

### 3. Deploy

**Option A: Interactive Mode (Recommended)**
```powershell
cd Azure\dev\LabAutomation\UnifiedLab
.\Run-AzureUnifiedLab.ps1
```

**Option B: Non-Interactive Mode**
```powershell
# Deploy everything enabled in operation-parameters.json
.\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Full

# Or deploy specific components
.\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Infrastructure
.\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Storage
.\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Monitoring
```

## Deployment Phases

The deployment runs in 6 phases:

| Phase | Description | Time | Components |
|-------|-------------|------|------------|
| **1** | Resource Group + TTL Logic App | 1-2 min | RG creation, TTL cleanup automation |
| **2** | Networking | 3-5 min | VNet, Subnets, NSGs |
| **3** | Storage, Monitoring, Analytics | 10-15 min | Parallel deployment of Storage, Log Analytics, Sentinel, Event Hub, ADX |
| **4** | VMs, DCRs | 5-10 min | Test VMs with auto-shutdown, Data Collection Rules |
| **5** | Cribl Configs | 1 min | Auto-generated Cribl Stream configurations |
| **6** | VPN Gateway | 30-45 min | VPN Gateway (optional, runs last due to long deployment time) |

**Example Output**:
```
 PHASE 1: Resource Group + TTL Logic App (~1-2 min) [OK]
 PHASE 2: Networking (VNet, Subnet, NSG) (~3-5 min) [OK]
 PHASE 3: Storage, Monitoring, Analytics (~10-15 min, parallel) [OK]
 PHASE 4: VMs, DCRs (~5-10 min) [OK]
 PHASE 5: Cribl Configs (~1 min) [OK]
 PHASE 6: VPN Gateway (~30-45 min) [OK]
```

## Deployment Modes

| Mode | Description | Components |
|------|-------------|------------|
| **Full** | All enabled components | Everything in operation-parameters.json |
| **Infrastructure** | Networking only | VNet, Subnets, NSGs, VPN, Bastion |
| **Storage** | Storage services | Storage Account, Containers, Queues, Event Grid |
| **Monitoring** | Logging and security | Log Analytics, Sentinel, Flow Logs, Private Link |
| **Analytics** | Data analytics | Event Hub, ADX |
| **Custom** | Interactive selection | User chooses components |
| **Status** | View current state | Shows deployed resources |
| **Validate** | Check configuration | Validates config files |

## Cost Estimates

### Minimal (Recommended for Testing)
```
VNet                  : Free
Log Analytics         : $2.30/GB
Event Hub Standard    : ~$22/month
Storage Account       : ~$5/month

Total: ~$30-50/month
```

### Standard (With Sentinel and Flow Logs)
```
Above +
Sentinel              : $2.46/GB/day
Flow Logs             : Storage costs only
VPN Gateway Basic     : ~$30/month

Total: ~$80-120/month
```

### Full (All Components)
```
Above +
ADX Dev SKU           : ~$240/month
Azure Bastion         : ~$140/month

Total: ~$450-500/month
```

## Common Scenarios

### Scenario 1: First-Time Deployment (Minimal)
```powershell
# 1. Edit configs to disable expensive components
# - deployVPNGateway: false
# - deployBastion: false
# - deployADX: false

# 2. Deploy core components
.\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Full

# Result: VNet + Log Analytics + Event Hub + Storage (~$30-50/month)
```

### Scenario 2: Incremental Build-Out
```powershell
# Week 1: Deploy infrastructure
.\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Infrastructure

# Week 2: Add storage (builds on existing VNet)
.\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Storage

# Week 3: Add monitoring (uses existing VNet and Storage)
.\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Monitoring

# Week 4: Add analytics (uses existing Storage)
.\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Analytics
```

### Scenario 3: Custom Component Selection
```powershell
# Launch interactive menu
.\Run-AzureUnifiedLab.ps1

# Select option [6] Custom Component Selection
# Choose exactly which components you want
# Confirm and deploy
```

## Cribl Integration

After deployment, Cribl configurations are automatically generated in the `Cribl-Configs/` directory:

**Output Files**:
- `cribl-master-config.json` - Master configuration with all settings
- `sources/` - Event Hub, Storage Queue, Blob collectors
- `destinations/` - Log Analytics, ADX destinations

**DCR-Automation Integration**:

For Data Collection Rules (DCRs) to send data to Log Analytics, use the separate DCR-Automation system:

```powershell
# Navigate to DCR-Automation
cd Azure\CustomDeploymentTemplates\DCR-Automation

# Run DCR automation (interactive)
.\Run-DCRAutomation.ps1

# Or non-interactive
.\Run-DCRAutomation.ps1 -NonInteractive -Mode DirectBoth
```

See the [DCR-Automation README](../../CustomDeploymentTemplates/DCR-Automation/README.md) for details.

## What Gets Deployed?

### Infrastructure
- **VNet**: 10.0.0.0/16 with multiple subnets
  - GatewaySubnet (for VPN Gateway)
  - AzureBastionSubnet (for Azure Bastion)
  - SecuritySubnet (for security services)
  - O11ySubnet (for observability)
  - PrivateLinkSubnet (for private endpoints)
- **NSGs**: One per subnet (except Gateway and Bastion)
- **VPN Gateway**: Optional site-to-site connectivity (30-45 min deploy)
- **Azure Bastion**: Optional secure VM access

### Storage
- **Storage Account**: StorageV2, Standard_LRS, Hot tier
- **Blob Containers**: flowlogs, eventhub-capture, adx-ingestion, logs, metrics, events, rawdata
- **Storage Queues**: blob-notifications, event-processing
- **Event Grid**: System Topic + Subscriptions (BlobCreated, BlobDeleted)

### Monitoring
- **Log Analytics Workspace**: PerGB2018 SKU, 90-day retention
- **Microsoft Sentinel**: SIEM solution with data connectors
- **VNet Flow Logs**: Network traffic monitoring with Traffic Analytics
- **Private Link**: Optional AMPLS + Private Endpoint

### Analytics
- **Event Hub Namespace**: Standard tier with multiple hubs
  - logs-hub
  - metrics-hub
  - events-hub
  - capture-hub (with Avro capture to blob)
- **Consumer Groups**: cribl, adx, sentinel
- **Azure Data Explorer**: Optional Dev SKU cluster with CriblLogs database

### Virtual Machines
- **Test VMs**: Ubuntu 22.04 LTS VMs for traffic generation
- **Auto-Shutdown**: Configured for 7 PM EST daily to save costs
- **Subnets**: Deployed to SecuritySubnet and O11ySubnet

## Troubleshooting

### "Resource already exists" error
**Solution**: Set `skipExistingResources: true` in operation-parameters.json

### VPN Gateway taking too long
**Solution**: VPN Gateway deployment takes 30-45 minutes. This is normal Azure behavior. It runs as Phase 6 (last) so it doesn't block other deployments.

### Storage account name conflict
**Solution**: Storage account names must be globally unique. Change `baseObjectName` in azure-parameters.json to something unique (e.g., add your initials).

### ADX deployment failed
**Solution**: Check subscription quota for ADX clusters. Dev SKU requires specific permissions.

### Authentication errors
**Solution**: Ensure you've run `Connect-AzAccount` and `Set-AzContext` to the correct subscription.

### Event Grid subscription errors
**Solution**: Ensure the Az.EventGrid module is installed and up to date:
```powershell
Update-Module Az.EventGrid -Force
```

### VM password prompt blocking deployment
**Solution**: The script now prompts for VM password before deployment starts (pre-deployment phase). Enter the password when prompted.

## Log Files

All deployment logs are written to a single unified log file:
```
logs/unified-lab-YYYYMMDD-HHMMSS.log
```

The log file includes:
- Timestamps for all operations
- Success/Warning/Error levels
- Full error messages and stack traces
- Resource creation details

## Additional Resources

- **README.md** - Complete architecture documentation
- **CLAUDE.md** - AI assistant guidance and dev/prod mode switching
- **azure-parameters.json** - Full configuration reference
- **operation-parameters.json** - Deployment flag reference

## Getting Help

1. **Configuration Issues**: Check [README.md](README.md) Configuration Details section
2. **Deployment Errors**: Review the log file in `logs/` directory
3. **Cost Questions**: See Cost Estimates section above
4. **Cribl Integration**: See [Core/Generate-CriblConfigs.ps1](Core/Generate-CriblConfigs.ps1)

## Success Checklist

After deployment, verify:

- [ ] Resource Group created with expected name
- [ ] VNet with subnets visible in Azure Portal
- [ ] Log Analytics Workspace accessible
- [ ] Storage Account containers visible
- [ ] Event Hub Namespace and hubs created
- [ ] Cribl configurations exported to Cribl-Configs/
- [ ] All deployed resources tagged appropriately
- [ ] No unexpected costs in Azure Cost Management
- [ ] Log file shows all phases completed successfully

---

**Happy Deploying!**

For questions or issues, review the comprehensive [README.md](README.md) or check the log files in `logs/`.

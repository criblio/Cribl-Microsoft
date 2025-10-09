# Azure Flow Log Lab Automation

This PowerShell automation system streamlines the deployment of Azure Virtual Networks (vNets) with VPN Gateway, test VMs, and comprehensive flow logging for Cribl Stream integration. Features an **interactive menu interface** for easy deployment with automatic Cribl collector configuration generation.

## 🆕 Latest Updates (v1.0.0)
- ✅ **Initial Release**: Complete automation for Azure Flow Log Lab infrastructure
- ✅ **Interactive Menu**: User-friendly deployment interface
- ✅ **Dual-Level Flow Logs**: vNet-level and subnet-level flow logging with different retention periods
- ✅ **Cribl Integration**: Automatic generation of Cribl collector configurations
- ✅ **VPN Gateway Support**: Site-to-site VPN with on-premises network integration
- ✅ **Test VM Deployment**: Automated VM creation for flow log generation
- ✅ **Auto-Shutdown**: VMs automatically shut down at 7 PM Eastern to save costs

## 🚀 Key Features

- **Interactive Menu System**: User-friendly interface with deployment confirmations
- **Dual-Level Flow Logging**: vNet-level (7 days) + subnet-level overrides (Security: 30 days, O11y: 90 days)
- **Cribl Collector Generation**: Automatic creation of collector configurations for each flow log
- **VPN Gateway Integration**: Site-to-site VPN with pfSense configuration instructions
- **Test VM Automation**: Deploy Ubuntu VMs in each subnet to generate flow logs
- **Cost Optimization**: Auto-shutdown schedules, no public IPs on VMs, collision-resistant storage naming
- **Smart Validation**: Pre-deployment validation and resource reuse (Network Watcher)
- **Multi-Environment Support**: Separate dev and prod configurations

## 📁 File Structure

```
AzureFlowLogLab/
├── Run-AzureFlowLogLab.ps1           # Main entry point with interactive menu
├── README.md                          # This documentation
├── QUICK_START.md                     # Quick setup guide
├── RELEASE_NOTES/                     # Version history
│   └── v1.0.0.md
└── prod/                              # Production configuration and scripts
    ├── Deploy-AzureFlowLogLab.ps1    # Core deployment engine
    ├── azure-parameters.json          # Azure resource configuration
    ├── operation-parameters.json      # Deployment behavior settings
    ├── onprem-connection-parameters.json  # VPN connection details
    ├── vm-parameters.json             # VM deployment settings
    ├── CollectorExample.json          # Cribl collector template reference
    └── cribl-collectors/              # Generated Cribl collector configs (created by script)
```

## ⚙️ Configuration Files

### 1. azure-parameters.json (MUST CONFIGURE)
```json
{
  "subscriptionId": "your-subscription-id",
  "resourceGroupName": "rg-flowloglab-eastus",
  "location": "eastus",
  "baseObjectName": "jpederson",
  "vnetAddressPrefix": "10.198.30.0/24",
  "subnets": {
    "gateway": {
      "name": "GatewaySubnet",
      "addressPrefix": "10.198.30.0/27"
    },
    "bastion": {
      "name": "BastionSubnet",
      "addressPrefix": "10.198.30.32/27"
    },
    "security": {
      "name": "SecuritySubnet",
      "addressPrefix": "10.198.30.64/27"
    },
    "o11y": {
      "name": "O11ySubnet",
      "addressPrefix": "10.198.30.96/27"
    }
  },
  "flowLogging": {
    "vnetLevel": {
      "enabled": true,
      "retentionDays": 7
    },
    "subnetLevel": {
      "security": {
        "enabled": true,
        "retentionDays": 30
      },
      "o11y": {
        "enabled": true,
        "retentionDays": 90
      }
    }
  }
}
```

**Important:**
- `vnetAddressPrefix` must be a /24 CIDR block
- Subnet prefixes must be /27 and within the vNet address space
- `baseObjectName` is used to generate all resource names with consistent prefixes/suffixes
- Flow logging supports dual-level configuration (vNet + subnet-specific)

### 2. onprem-connection-parameters.json
```json
{
  "localNetworkGateway": {
    "name": "lng-sitename",
    "gatewayIpAddress": "YOUR-ONPREM-PUBLIC-IP",
    "addressSpace": ["192.168.1.0/24"]
  },
  "vpnConnection": {
    "name": "conn-azure-to-onprem",
    "connectionType": "IPsec",
    "sharedKey": "your-shared-key-here"
  }
}
```

### 3. vm-parameters.json
```json
{
  "vmConfiguration": {
    "deployVMs": true,
    "vmSize": "Standard_B1s",
    "publisher": "Canonical",
    "offer": "0001-com-ubuntu-server-jammy",
    "sku": "22_04-lts-gen2",
    "osDiskType": "Standard_LRS",
    "adminUsername": "azureuser"
  },
  "vmDeployment": {
    "bastion": { "deploy": true, "vmName": "vm-bastion" },
    "security": { "deploy": true, "vmName": "vm-security" },
    "o11y": { "deploy": true, "vmName": "vm-o11y" }
  }
}
```

### 4. operation-parameters.json
```json
{
  "deployment": {
    "deployVNet": true,
    "deployVPNGateway": true,
    "deployFlowLogs": true,
    "deployBastion": false
  },
  "scriptBehavior": {
    "templateOnly": false,
    "verboseOutput": true
  }
}
```

## 🎯 Quick Start

### 1. Configure Azure Settings
```powershell
# Edit configuration files in the prod/ directory
notepad prod/azure-parameters.json
notepad prod/onprem-connection-parameters.json
notepad prod/vm-parameters.json
```

### 2. Connect to Azure
```powershell
Connect-AzAccount
Set-AzContext -Subscription "Your-Subscription-Name"
```

### 3. Launch Interactive Menu
```powershell
.\Run-AzureFlowLogLab.ps1
```

### 4. Interactive Menu Options
```
============================================================
         AZURE VNET & VPN DEPLOYMENT MENU
============================================================
📍 Current Configuration:
   Subscription: your-subscription-id
   Resource Group: rg-flowloglab-eastus
   Location: eastus
   vNet: vnet-jpederson (10.198.30.0/24)
   VPN Gateway: vpngw-jpederson (Basic)

📋 DEPLOYMENT OPTIONS:

  [1] ⚡ Full Deployment (vNet + VPN + VMs + Flow Logs)
  [2] Deploy vNet Only
  [3] Deploy VPN Gateway Only
  [4] Deploy Flow Logs Only
  [5] Check Deployment Status
  [6] Validate Configuration
  [Q] Quit
============================================================
```

## 🚀 Usage Examples

### Interactive Menu (Recommended)
```powershell
# Launch interactive menu
.\Run-AzureFlowLogLab.ps1
```

### Command-Line Mode (Advanced)
```powershell
# Full deployment
.\Run-AzureFlowLogLab.ps1 -NonInteractive -Mode Full

# Flow logs only (useful for regenerating Cribl collectors)
.\Run-AzureFlowLogLab.ps1 -NonInteractive -Mode FlowLogsOnly

# vNet only
.\Run-AzureFlowLogLab.ps1 -NonInteractive -Mode VNetOnly
```

## 🌊 Flow Logging Architecture

### Dual-Level Flow Logging
- **vNet-level**: Captures all traffic in the vNet (7-day retention)
- **Subnet-level overrides**:
  - SecuritySubnet: 30-day retention (compliance)
  - O11ySubnet: 90-day retention (observability)
  - BastionSubnet: Inherits vNet-level (7 days)

### Flow Log Hierarchy
Azure enforces: **NIC > Subnet > vNet** (most specific wins)

### Storage Account
- Automatic collision handling with incremental suffixes (00-99)
- Container: `insights-logs-flowlogflowevent`
- Path pattern: `/flowLogResourceID=/{SUBSCRIPTION}/{RESOURCEGROUP}/{FLOWLOGNAME}/`

## 🎨 Cribl Collector Generation

The script automatically generates Cribl Stream collector configurations after deployment:

### Generated Files
```
prod/cribl-collectors/
├── Azure_VNet_vnet-jpederson_FlowLogs.json
├── Azure_Subnet_Security_FlowLogs.json
└── Azure_Subnet_O11y_FlowLogs.json
```

### Collector Features
- Azure Blob storage collectors with connection strings
- Time-based partitioning: `${_time:y=%Y}/${_time:m=%m}/${_time:d=%d}/${_time:h=%H}`
- Automatic path discovery from flow log blobs
- Breaker ruleset: `AzureFlowLogs`

### Flow Log Timing
- **Container creation**: 5-10 minutes after VMs start generating traffic
- **Interactive wait**: Script prompts every 60 seconds to continue waiting or skip
- **Re-run option**: Use FlowLogsOnly mode to regenerate collectors later

## 💰 Cost Optimization Features

1. **VM Auto-Shutdown**: All VMs shut down at 7 PM Eastern (saves ~50% on VM costs)
2. **No Public IPs**: VMs use private IPs only (saves ~$11/month per VM)
3. **Standard_B1s VMs**: Cheapest VM option (~$7.59/month each)
4. **Zone-Redundant Public IP**: Only for VPN Gateway (Standard SKU required)

### Estimated Monthly Costs
- VPN Gateway Basic: ~$27/month
- Storage Account (ZRS): ~$5/month
- 3x VMs (50% uptime): ~$11/month
- Public IP (VPN Gateway): ~$3/month
- **Total**: ~$46/month

## 🔐 VPN Gateway Configuration

### Azure Side (Automated)
- Public IP: Zone-redundant (zones 1,2,3)
- Gateway SKU: Basic (10 tunnels, 100 Mbps)
- VPN Type: RouteBased
- Connection: Site-to-site IPsec

### pfSense Configuration (Manual)
The script outputs pfSense configuration details:
```
PFSENSE FIREWALL CONFIGURATION
================================
Remote Gateway: <Azure VPN Gateway Public IP>
Local Network: 192.168.1.0/24
Remote Network: 10.198.30.0/24
Pre-Shared Key: <from onprem-connection-parameters.json>

Phase 1 (IKE):
- Mode: Main
- Protocol: IKEv2
- Encryption: AES256
- Hash: SHA256
- DH Group: 2

Phase 2 (IPsec):
- Protocol: ESP
- Encryption: AES256
- Hash: SHA256
- PFS Group: None
```

## 📋 Network Security Groups

Automatically created for each subnet with rules:
- **AllowOnPremisesGateway**: Inbound from on-prem public IP (Priority 100)
- **AllowOnPremisesNetwork**: Inbound from on-prem network (Priority 110)
- **AllowVNetInbound**: Inbound from Azure vNet (Priority 120)

## 📈 Best Practices

1. **Start with Template Mode** - Validate configuration before deployment
2. **Use Proper CIDR Planning** - Avoid overlap with on-premises networks
3. **Monitor Flow Log Costs** - 90-day retention can increase storage costs
4. **Test VPN Connection** - Verify site-to-site connectivity before adding workloads
5. **Protect Credentials** - Never commit real values to git
6. **Review Cribl Collectors** - Verify paths before importing to Cribl Stream

## 🚨 Troubleshooting

| Issue | Solution |
|-------|----------|
| "Subscription not found" | Run `Connect-AzAccount` and `Set-AzContext` |
| "Storage account name taken" | Script auto-appends 00-99 suffix |
| "Flow log container not created" | Wait 5-10 minutes for VMs to generate traffic |
| "VPN connection overlapping" | Verify vNet and on-prem networks don't overlap |
| "Gateway deployment slow" | VPN Gateway takes 30-45 minutes (Azure limitation) |

### Validation Commands
```powershell
# Check deployment status
.\Run-AzureFlowLogLab.ps1 -Mode Status

# Validate parameters
.\Run-AzureFlowLogLab.ps1 -Mode Validate

# Regenerate Cribl collectors
.\Run-AzureFlowLogLab.ps1 -Mode FlowLogsOnly
```

## 📊 Expected Output

### Successful Deployment
```
🚀 Deploying Azure Flow Log Lab Infrastructure...
==================================================

--- Step 1: Creating Virtual Network ---
  vNet Name: vnet-jpederson
  Address Space: 10.198.30.0/24
  ✅ vNet created successfully!

--- Step 2: Creating Network Security Groups ---
  ✅ NSG created: nsg-SecuritySubnet
  ✅ NSG created: nsg-O11ySubnet
  ✅ NSG created: nsg-BastionSubnet

--- Step 3: Deploying Storage Account ---
  ✅ Storage Account: sajpedersoneastusflowlogs

--- Step 4: Deploying VNet Flow Logs ---
  ✅ vNet-level flow log enabled (7 days)
  ✅ Subnet-level flow log: SecuritySubnet (30 days)
  ✅ Subnet-level flow log: O11ySubnet (90 days)

--- Step 5: Deploying VPN Gateway ---
  ⏳ Gateway deployment started (30-45 minutes)...
  ✅ VPN Gateway deployed!

--- Step 6: Deploying Test VMs ---
  ✅ VM deployed: vm-bastion (10.198.30.36)
  ✅ VM deployed: vm-security (10.198.30.68)
  ✅ VM deployed: vm-o11y (10.198.30.100)
  ℹ️  Auto-shutdown configured: 7 PM Eastern

--- Step 7: Generating Cribl Collectors ---
  ⚠️  Flow logs typically take 5-10 minutes to start
  ⏳ Waiting for flow log container...
  ✅ Flow log container found!
  📝 Generated: Azure_VNet_vnet-jpederson_FlowLogs.json
  📝 Generated: Azure_Subnet_Security_FlowLogs.json
  📝 Generated: Azure_Subnet_O11y_FlowLogs.json
```

## 🎉 Summary

This automation system provides:
- ✅ **Complete flow log lab** with vNet, VPN, VMs, and flow logging
- ✅ **Cribl integration** with automatic collector generation
- ✅ **Cost optimization** with auto-shutdown and minimal resources
- ✅ **Dual-level flow logging** for different retention requirements
- ✅ **VPN connectivity** for on-premises integration
- ✅ **Interactive deployment** with guided menu interface
- ✅ **Smart resource reuse** (Network Watcher per region)

---

**Getting Started:** Simply run `.\Run-AzureFlowLogLab.ps1` to launch the interactive menu.

For quick setup, see [QUICK_START.md](QUICK_START.md).

# Azure Flow Log Lab - Quick Start

## Prerequisites
- PowerShell 5.1+ with Azure PowerShell modules (Az.Network, Az.Resources, Az.Compute, Az.Storage)
- Azure subscription with appropriate permissions
- Network Contributor role or higher
- Valid CIDR blocks planned for your network (avoid overlap with on-prem)

## 1⃣ Configure Azure Settings

Edit configuration files in the `prod/` directory:

### prod/azure-parameters.json
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
 }
}
```

### prod/onprem-connection-parameters.json
```json
{
 "localNetworkGateway": {
 "name": "lng-onprem",
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

### prod/vm-parameters.json
```json
{
 "vmConfiguration": {
 "deployVMs": true,
 "vmSize": "Standard_B1s",
 "adminUsername": "azureuser"
 },
 "vmDeployment": {
 "bastion": { "deploy": true, "vmName": "vm-bastion" },
 "security": { "deploy": true, "vmName": "vm-security" },
 "o11y": { "deploy": true, "vmName": "vm-o11y" }
 }
}
```

**Important Notes:**
- Use /24 CIDR for vNet (e.g., 10.198.30.0/24)
- Each subnet must be /27 and within vNet address space
- Avoid overlap between Azure vNet and on-prem networks
- `baseObjectName` is used to generate all resource names

## 2⃣ Connect to Azure

```powershell
Connect-AzAccount
Set-AzContext -Subscription "Your-Subscription-Name" # If multiple subscriptions
```

## 3⃣ Launch the Interactive Menu

```powershell
.\Run-AzureFlowLogLab.ps1
```

You'll see an interactive menu like this:

```
============================================================
 AZURE VNET & VPN DEPLOYMENT MENU
============================================================
 Current Configuration:
 Subscription: your-subscription-id
 Resource Group: rg-flowloglab-eastus
 Location: eastus
 vNet: vnet-jpederson (10.198.30.0/24)
 VPN Gateway: vpngw-jpederson (Basic)

 DEPLOYMENT OPTIONS:

 [1] Full Deployment (vNet + VPN + VMs + Flow Logs)
 [2] Deploy vNet Only
 [3] Deploy VPN Gateway Only
 [4] Deploy Flow Logs Only
 [5] Check Deployment Status
 [6] Validate Configuration
 --------------------------------------------------------
 [Q] Quit
============================================================

Select an option:
```

## 4⃣ Menu Options Explained

### Option 1: Full Deployment 
- Creates vNet with 4 subnets (Gateway, Bastion, Security, O11y)
- Creates Network Security Groups for each subnet
- Deploys Storage Account for flow logs
- Enables dual-level flow logging (vNet + subnet-specific)
- Deploys VPN Gateway with zone-redundant Public IP
- Creates on-premises VPN connection
- Deploys 3 test VMs (one per subnet) with auto-shutdown
- Generates Cribl collector configurations
- **Best for:** Complete lab setup
- **Time:** 45-60 minutes (VPN Gateway is slow)

### Option 2: vNet Only
- Creates virtual network with subnets
- Creates Network Security Groups
- **Best for:** Setting up network infrastructure first
- **Time:** 2-3 minutes

### Option 3: VPN Gateway Only
- Requires existing vNet with GatewaySubnet
- Creates Public IP and VPN Gateway
- Creates on-premises connection
- **Best for:** Adding VPN to existing vNet
- **Time:** 30-45 minutes

### Option 4: Flow Logs Only
- Requires existing vNet
- Creates Storage Account
- Enables vNet and subnet-level flow logs
- Generates Cribl collector configurations
- **Best for:** Adding flow logging to existing infrastructure or regenerating collectors
- **Time:** 5-10 minutes + wait for flow log container

### Option 5: Check Deployment Status
- Shows current configuration
- Lists deployed resources
- Verifies resource existence
- **Best for:** Monitoring deployment progress
- **Time:** < 1 minute

### Option 6: Validate Configuration
- Checks parameter files for errors
- Validates CIDR blocks
- Verifies Azure connectivity
- **Best for:** Pre-deployment validation
- **Time:** < 1 minute

## 5⃣ Deployment Workflow

1. **Select an option** (e.g., press `1` for Full Deployment)
2. **Review confirmation** showing what will be deployed
3. **Type `Y`** to proceed or `N` to cancel
4. **Wait for deployment** (VPN Gateway takes 30-45 minutes)
5. **Review output** for connection details and VM IPs
6. **Wait for Cribl collectors** (optional - can skip and regenerate later)

## 6⃣ After Deployment

### Deployment Summary
You'll see a summary like this:
```
 Deployment Summary
==================================================
 Resource Group: rg-flowloglab-eastus
 Virtual Network: vnet-jpederson (10.198.30.0/24)
 VPN Gateway: vpngw-jpederson (Basic)
 VPN Gateway Public IP: 40.117.XXX.XXX
 Storage Account: sajpedersoneastusflowlogs

 Deployed VMs (Auto-shutdown: 7 PM Eastern):
 vm-bastion: 10.198.30.36
 vm-security: 10.198.30.68
 vm-o11y: 10.198.30.100

 Flow Logs:
 vNet-level: 7 days retention
 SecuritySubnet: 30 days retention
 O11ySubnet: 90 days retention

 Cribl Collectors: prod/cribl-collectors/
```

### Configure pfSense VPN
The script outputs pfSense configuration:
```
PFSENSE FIREWALL CONFIGURATION
================================
Remote Gateway: 40.117.XXX.XXX
Local Network: 192.168.1.0/24
Remote Network: 10.198.30.0/24
Pre-Shared Key: <your-shared-key>

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

### Import Cribl Collectors
1. Navigate to `prod/cribl-collectors/`
2. Copy JSON files to Cribl Stream
3. Import collectors in Cribl UI (Data > Sources > Add Source)
4. Verify collector configurations match your environment

### Verify Flow Logs
```powershell
# Check storage account for flow log container
Get-AzStorageAccount -ResourceGroupName "rg-flowloglab-eastus" -Name "sajpedersoneastusflowlogs"

# List flow log blobs (after 5-10 minutes)
$ctx = New-AzStorageContext -StorageAccountName "sajpedersoneastusflowlogs" -UseConnectedAccount
Get-AzStorageBlob -Container "insights-logs-flowlogflowevent" -Context $ctx | Select-Object Name
```

### Test VPN Connection
```powershell
# Check VPN connection status
Get-AzVirtualNetworkGatewayConnection -Name "conn-azure-to-onprem" -ResourceGroupName "rg-flowloglab-eastus"

# Ping Azure VM from on-prem (after VPN connects)
ping 10.198.30.68 # Security subnet VM
```

## Flow Log Container Creation

### Important: Flow logs take time to start!
- **Container creation**: 5-10 minutes after VMs begin generating traffic
- **First blobs appear**: Additional 5-10 minutes
- **Script behavior**: Waits and prompts every 60 seconds
- **User choice**: Continue waiting (Y) or skip (N)

### If you skip the wait:
1. Wait 10-15 minutes for flow logs to start
2. Run the script again in FlowLogsOnly mode:
 ```powershell
 .\Run-AzureFlowLogLab.ps1 -NonInteractive -Mode FlowLogsOnly
 ```
3. Cribl collectors will be regenerated with correct paths

## Cost Management

### Auto-Shutdown Schedule
- All VMs automatically shut down at **7 PM Eastern** (11 PM UTC)
- Saves ~50% on VM costs
- Modify schedule in `prod/vm-parameters.json` or Azure Portal

### Turn VMs On/Off Manually
```powershell
# Start VMs
Start-AzVM -ResourceGroupName "rg-flowloglab-eastus" -Name "vm-security"

# Stop VMs
Stop-AzVM -ResourceGroupName "rg-flowloglab-eastus" -Name "vm-security" -Force
```

### Estimated Costs
- **VPN Gateway Basic**: ~$27/month (runs 24/7)
- **Storage Account**: ~$5/month (flow logs)
- **3x VMs (50% uptime)**: ~$11/month
- **Public IP**: ~$3/month
- **Total**: ~$46/month

## Network Planning

### Example Layout (10.198.30.0/24)
```
vNet: 10.198.30.0/24
 GatewaySubnet: 10.198.30.0/27 (VPN Gateway)
 BastionSubnet: 10.198.30.32/27 (Admin access, 7-day logs)
 SecuritySubnet: 10.198.30.64/27 (Security tools, 30-day logs)
 O11ySubnet: 10.198.30.96/27 (Observability, 90-day logs)
```

### Dual-Level Flow Logging
- **vNet-level**: Default 7-day retention for all subnets
- **Subnet overrides**:
 - SecuritySubnet: 30 days (compliance)
 - O11ySubnet: 90 days (long-term analysis)
 - BastionSubnet: Inherits vNet-level (7 days)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **Menu doesn't appear** | Check PowerShell execution policy: `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` |
| **"Subscription not found"** | Run `Connect-AzAccount` and verify subscription with `Get-AzSubscription` |
| **"Storage account name taken"** | Script auto-appends 00-99 suffix; if all taken, change `baseObjectName` |
| **"Flow log container not found"** | Wait 10-15 minutes for VMs to generate traffic, then re-run FlowLogsOnly mode |
| **"VPN overlapping networks"** | Verify Azure vNet (10.198.30.0/24) doesn't overlap on-prem (192.168.1.0/24) |
| **VPN Gateway slow** | Normal! Takes 30-45 minutes to provision |
| **VM can't SSH** | VMs have no public IPs; use VPN or Azure Bastion service |

## Success Indicators

After successful deployment, you'll have:
- **vNet created** with 4 subnets
- **NSGs created** with on-prem traffic rules
- **Storage Account created** for flow logs
- **Flow logs enabled** at vNet and subnet levels
- **VPN Gateway deployed** (30-45 minutes)
- **VPN connection created** to on-premises
- **3 VMs deployed** with auto-shutdown schedules
- **Cribl collectors generated** (if flow logs started)

## Quick Decision Guide

| Goal | Choose Option | Time |
|------|--------------|------|
| **Complete lab setup** | Option 1 (Full) | 45-60 min |
| **Network infrastructure only** | Option 2 (vNet Only) | 2-3 min |
| **Add VPN to existing vNet** | Option 3 (VPN Only) | 30-45 min |
| **Add flow logging** | Option 4 (Flow Logs Only) | 5-10 min |
| **Regenerate Cribl collectors** | Option 4 (Flow Logs Only) | 5-10 min |
| **Check what's deployed** | Option 5 (Status) | < 1 min |
| **Validate before deploy** | Option 6 (Validate) | < 1 min |

## Important Notes

### VPN Gateway Deployment Time
- **Normal deployment time:** 30-45 minutes
- This is an Azure limitation, not a script issue
- The gateway is being provisioned in Azure's backend
- You can monitor progress in Azure Portal

### Flow Log Container Creation
- **Normal creation time:** 5-10 minutes after VMs start
- Depends on VM network activity generating flow logs
- Script offers interactive wait with 60-second prompts
- You can skip and regenerate collectors later

### Basic VPN SKU Limitations
- Maximum 10 Site-to-Site tunnels
- Maximum throughput: 100 Mbps
- No BGP support
- No active-active configuration
- **Cannot be upgraded** - requires redeployment to change SKU

### VM Access
- **No public IPs** on VMs (cost savings)
- Access via VPN connection or Azure Bastion service
- SSH after VPN is connected: `ssh azureuser@10.198.30.68`

## Next Steps

After deployment:
1. **Configure pfSense** with the VPN settings from script output
2. **Test VPN connectivity** by pinging Azure VMs from on-prem
3. **Wait for flow logs** (5-10 minutes for container creation)
4. **Import Cribl collectors** from `prod/cribl-collectors/` directory
5. **Configure Cribl routes** to process Azure flow logs
6. **Verify flow log data** in Cribl Stream

## Additional Resources

- **Full Documentation:** [README.md](README.md)
- **Azure VNet Flow Logs:** https://learn.microsoft.com/azure/network-watcher/vnet-flow-logs-overview
- **Azure VPN Gateway:** https://learn.microsoft.com/azure/vpn-gateway/
- **Cribl Stream Docs:** https://docs.cribl.io/stream/

---

** Ready to start?** Run `.\Run-AzureFlowLogLab.ps1` and select Option 1 for Full Deployment!

** Remember:**
- VPN Gateway deployment takes 30-45 minutes
- Flow log container creation takes 5-10 minutes after VMs start
- You can skip the wait and regenerate Cribl collectors later

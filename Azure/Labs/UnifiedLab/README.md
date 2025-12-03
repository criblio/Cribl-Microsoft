# Unified Azure Lab for Cribl Integration

## Overview

The **Unified Azure Lab** is a comprehensive, modular deployment system that consolidates six specialized labs into one cohesive infrastructure. It supports incremental deployment, aggressive resource sharing, and flexible component selection.

### Consolidated Labs

This unified system replaces and combines:
- **ADXLab** - Azure Data Explorer with Event Hub integration
- **AzureFlowLogLab** - VNet infrastructure with VPN Gateway and Flow Logs
- **BlobCollectorLab** - Multi-tier blob storage with sample data
- **BlobAzureQueueLab** - Event-driven blob notifications via queues
- **EventHubLab** - Event Hub namespace with capture capabilities
- **SentinelLab** - Microsoft Sentinel with Private Link support

## Architecture

### Resource Sharing Strategy (Aggressive)

**Shared Resources:**
- **Single VNet** - All components use one Virtual Network (10.0.0.0/16)
- **Single Log Analytics Workspace** - Shared by Sentinel, Flow Logs, diagnostics
- **Single Storage Account** - Shared by Flow Logs, Event Hub Capture, ADX ingestion, logs
- **Single Event Hub Namespace** - Multiple hubs for different data types

**Component-Specific Resources:**
- ADX Cluster (if enabled)
- VPN Gateway (if enabled)
- Azure Bastion (if enabled)
- AMPLS + Private Endpoint (if Private Link mode)

### Directory Structure

```
UnifiedLab/
 Run-AzureUnifiedLab.ps1 # Main entry point (TO BE CREATED)
 Core/ # Shared framework modules
 Validation-Module.ps1 # COMPLETED - Validation functions
 Naming-Engine.ps1 # COMPLETED - Resource naming
 Menu-Framework.ps1 # TODO - Interactive menu system
 prod/
 azure-parameters.json # COMPLETED - Unified configuration
 operation-parameters.json # COMPLETED - Deployment flags
 Deploy-Infrastructure.ps1 # TODO - VNet, VPN, NSGs
 Deploy-Monitoring.ps1 # TODO - Sentinel, Log Analytics, Flow Logs
 Deploy-Analytics.ps1 # TODO - ADX, Event Hub
 Deploy-Storage.ps1 # TODO - Blob, Queues, Event Grid
 cribl-configs/ # Auto-generated Cribl configurations
 README.md # This file
```

## Deployment Modes

### Available Modes

1. **Full** - Deploy all enabled components (respects operation-parameters.json flags)
2. **Infrastructure** - VNet + VPN + Bastion + NSGs only
3. **Monitoring** - Log Analytics + Sentinel + Flow Logs + Private Link
4. **Analytics** - ADX + Event Hub
5. **Storage** - Storage Account + Containers + Queues + Event Grid
6. **Custom** - Interactive selection of specific components
7. **Status** - Display current configuration and deployed resources
8. **Validate** - Validate configuration without deploying

### Incremental Deployment

The lab supports running multiple times to build incrementally:

```powershell
# First run: Deploy infrastructure
.\Run-AzureUnifiedLab.ps1 -Mode Infrastructure

# Second run: Add monitoring (reuses existing VNet)
.\Run-AzureUnifiedLab.ps1 -Mode Monitoring

# Third run: Add analytics (reuses existing VNet and Log Analytics)
.\Run-AzureUnifiedLab.ps1 -Mode Analytics
```

## Quick Start

### Prerequisites

1. **Azure Subscription** with sufficient permissions
2. **PowerShell 5.1+** with Azure modules:
 ```powershell
 Install-Module -Name Az -AllowClobber -Scope CurrentUser
 ```
3. **Azure Authentication**:
 ```powershell
 Connect-AzAccount
 Set-AzContext -Subscription "<your-subscription-id>"
 ```

### Configuration

1. **Edit `prod/azure-parameters.json`:**
 ```json
 {
 "subscriptionId": "your-subscription-id-guid",
 "resourceGroupName": "rg-cribllab-eastus",
 "location": "eastus",
 "baseObjectName": "cribllab"
 }
 ```

2. **Edit `prod/operation-parameters.json`** to enable/disable components:
 ```json
 {
 "deployment": {
 "infrastructure": {
 "deployVNet": true,
 "deployVPNGateway": false, // Takes 30-45 min, ~$30/month
 "deployBastion": false // ~$140/month
 },
 "monitoring": {
 "deployLogAnalytics": true,
 "deploySentinel": true,
 "deployFlowLogs": true
 },
 "analytics": {
 "deployADX": false, // WARNING: ~$240/month minimum
 "deployEventHub": true
 },
 "storage": {
 "deployStorageAccount": true,
 "deployEventGrid": true
 }
 }
 }
 ```

### Deployment

```powershell
# Interactive mode
.\Run-AzureUnifiedLab.ps1

# Non-interactive mode
.\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Full

# Deploy specific component
.\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Infrastructure
```

## Cost Estimates

### Minimal Configuration (VNet + Event Hub + Log Analytics)
- VNet: Free
- Event Hub Standard: ~$22/month
- Log Analytics: $2.30/GB ingested
- **Total: ~$30-50/month** (depends on data volume)

### Standard Configuration (+ Sentinel + Flow Logs)
- Above +
- Sentinel: $2.46/GB ingested/day
- Flow Logs: Storage costs only (~$5/month)
- **Total: ~$50-100/month** (depends on data volume)

### Full Configuration (+ VPN + ADX)
- Above +
- VPN Gateway Basic: ~$30/month
- ADX Dev SKU: ~$240/month
- **Total: ~$350-400/month**

### Optional Components
- Azure Bastion: ~$140/month
- VPN Gateway VpnGw1: ~$140/month (vs $30 for Basic)
- ADX Standard_D11_v2: ~$730/month (vs $240 for Dev)

## Components

### Infrastructure
- **VNet**: 10.0.0.0/16 address space
- **6 Subnets**: Gateway, Bastion, PrivateLink, Compute, Data, Monitoring
- **NSGs**: Per-subnet security policies
- **VPN Gateway**: Optional site-to-site connectivity
- **Azure Bastion**: Optional secure VM access

### Monitoring
- **Log Analytics Workspace**: Shared workspace (PerGB2018 SKU, 90-day retention)
- **Microsoft Sentinel**: SIEM/SOAR solution with data connectors
- **VNet Flow Logs**: Network traffic analysis with Traffic Analytics
- **Private Link**: Optional AMPLS + Private Endpoint for on-prem
- **Diagnostic Settings**: Subscription and resource-level logging

### Analytics
- **Azure Data Explorer (ADX)**:
 - Dev SKU cluster (optional, ~$240/month)
 - CriblLogs database with sample tables
 - Event Hub and Blob Storage data connections
 - Streaming ingestion enabled
- **Event Hub Namespace**:
 - Standard tier, configurable TU capacity
 - 4 Event Hubs: logs-hub, metrics-hub, events-hub, capture-hub
 - Consumer groups: cribl, adx, sentinel
 - Capture to blob storage enabled for capture-hub

### Storage
- **Storage Account**: StorageV2, Standard_LRS, Hot tier
- **7 Blob Containers**:
 - `insights-logs-flowlogs` - VNet Flow Logs
 - `eventhub-capture` - Event Hub Capture files (Avro)
 - `adx-ingestion` - ADX batch ingestion files
 - `logs` - General log files (JSON, CSV, text)
 - `metrics` - Metrics data
 - `events` - Event data
 - `rawdata` - Unstructured data
- **2 Storage Queues**:
 - `blob-notifications` - Blob lifecycle notifications
 - `event-processing` - Event processing pipeline
- **Event Grid**: Blob created/deleted notifications → queues

## Configuration Details

### VNet Subnets

| Subnet | CIDR | Size | Purpose |
|--------|------|------|---------|
| GatewaySubnet | 10.0.0.0/27 | 32 | VPN Gateway (required name) |
| AzureBastionSubnet | 10.0.0.32/27 | 32 | Azure Bastion (required name) |
| PrivateLinkSubnet | 10.0.0.64/27 | 32 | Private Link endpoints |
| ComputeSubnet | 10.0.1.0/24 | 256 | VMs and containers |
| DataSubnet | 10.0.2.0/24 | 256 | ADX and data services |
| MonitoringSubnet | 10.0.3.0/24 | 256 | Sentinel and monitoring |

**Total Used**: ~900 addresses out of 65,536 available

### Naming Conventions

All resources follow this pattern:
```
ResourceName = prefix + baseObjectName + suffix
```

Examples:
- VNet: `vnet-cribllab-eastus`
- Log Analytics: `law-cribllab-eastus`
- Storage: `sacriblabcribl` (no hyphens, lowercase only)
- Event Hub Namespace: `evhns-cribllab-eastus`
- ADX Cluster: `adxcribllabeastus` (alphanumeric only)

### Resource Dependencies

```
Resource Group
 VNet
 Subnets
 NSGs (per subnet)
 Private Endpoints (if Private Link enabled)
 VPN Gateway (optional)
 Azure Bastion (optional)
 Log Analytics Workspace
 Sentinel Solution
 Diagnostic Settings
 Storage Account
 Blob Containers
 Queues
 Event Grid System Topic
 Event Grid Subscriptions
 Event Hub Namespace
 Event Hubs
 Consumer Groups
 Shared Access Policies
 ADX Cluster (optional)
 ADX Database
 Tables
 Data Connections
 Network Watcher
 VNet Flow Logs
```

## Idempotent Design

All deployment scripts check for existing resources and:
- **Skip** if resource exists and `skipExistingResources` is true
- **Update** if resource exists but missing components (e.g., add missing subnets)
- **Fail** if resource exists and `skipExistingResources` is false

This enables safe re-runs and incremental deployments.

## Cribl Integration

### Auto-Generated Configurations

The lab automatically generates Cribl Stream configurations in `prod/cribl-configs/`:

1. **Log Analytics Workspace Collector** (`workspace-collector.json`)
 - Connects to shared workspace
 - Sample queries for SecurityEvent, AzureActivity, etc.

2. **Blob Storage Collector** (`blob-collector.json`)
 - SAS token authentication
 - Path expressions for different containers
 - Supports JSON, CSV, text formats

3. **Event Hub Source** (`eventhub-source.json`)
 - Connection strings for each hub
 - Consumer group configurations
 - Checkpoint settings

4. **Storage Queue Source** (`queue-source.json`)
 - Connection strings
 - Message visibility timeout
 - Batch settings

5. **Flow Log Collector** (`flowlog-collector.json`)
 - Blob path expressions for Flow Logs
 - JSON parsing configurations

6. **ADX Destination** (`adx-destination.json`) (if ADX enabled)
 - Cluster URI
 - Database and table mappings
 - Authentication settings

## Private vs Public Lab Mode

The Unified Lab supports two deployment modes controlled by the `labMode` setting in `azure-parameters.json`:

### Public Lab Mode (Default)
```json
"labMode": "public"
```
- All resources accessible via public endpoints
- Suitable for quick testing and POC deployments
- No DNS configuration required
- Lower complexity, faster deployment

### Private Lab Mode
```json
"labMode": "private"
```
- All resources accessible only via private endpoints within VNet
- Suitable for production, hybrid environments, and compliance requirements
- **Requires Active Directory DNS configuration** (see below)
- Higher security, network-isolated resources

When `labMode` is set to `"private"`, the deployment automatically:
- Creates private endpoints for Storage Account (blob, queue, table, file)
- Creates private endpoint for Event Hub namespace
- Creates private endpoint for ADX cluster (if enabled)
- Deploys Azure Monitor Private Link Scope (AMPLS) for Log Analytics
- Creates all necessary Azure Private DNS Zones
- Links Private DNS Zones to the VNet

## Active Directory DNS Configuration for Private Labs

### Overview

When deploying in **private mode**, Azure resources use private IP addresses instead of public endpoints. For on-premises or hybrid environments to resolve these private addresses, you must configure **conditional forwarders** on your Active Directory DNS servers.

### Why DNS Configuration is Required

Private endpoints use Azure Private DNS Zones that resolve to private IPs (e.g., `10.0.0.x`). Without DNS forwarding:
- On-premises clients cannot resolve Azure private endpoint FQDNs
- Hybrid VPN/ExpressRoute connections fail to connect to private resources
- Cribl Stream cannot connect to private storage/Event Hub/Log Analytics

### Architecture Diagram

```
On-Premises Network Azure VNet (10.0.0.0/16)
 
 
 Cribl Worker Private Endpoints 
 10.1.1.10 (PrivateLinkSubnet) 
 VPN/ER 
 DNS Query: pe-sa-blob 
 sacribllabeastus IP: 10.0.0.5 
 .blob.core. 
 windows.net pe-evhns 
 IP: 10.0.0.6 
 
 pe-law-ampls 
 AD DNS Server IP: 10.0.0.7 
 10.1.1.2 
 
 Conditional Azure Private DNS 
 Forwarders 
 privatelink.blob. 
 *.blob.core. core.windows.net 
 windows.net 
 → 168.63. A Record: 
 129.16 sacribllabeastus → 
 10.0.0.5 
 
 
```

### Required Private DNS Zones

The following Azure Private DNS Zones are automatically created when `labMode` is `"private"`:

| Azure Service | Private DNS Zone | Purpose |
|---------------|------------------|---------|
| **Storage - Blob** | `privatelink.blob.core.windows.net` | Blob storage containers |
| **Storage - Queue** | `privatelink.queue.core.windows.net` | Storage queues |
| **Storage - Table** | `privatelink.table.core.windows.net` | Table storage |
| **Storage - File** | `privatelink.file.core.windows.net` | File shares |
| **Event Hub** | `privatelink.servicebus.windows.net` | Event Hub namespace |
| **Azure Monitor** | `privatelink.monitor.azure.com` | Azure Monitor |
| **Log Analytics - OMS** | `privatelink.oms.opinsights.azure.com` | Log Analytics workspace |
| **Log Analytics - ODS** | `privatelink.ods.opinsights.azure.com` | Log Analytics data ingestion |
| **Automation - AgentSvc** | `privatelink.agentsvc.azure-automation.net` | Automation agents |
| **ADX (if enabled)** | `privatelink.<region>.kusto.windows.net` | Azure Data Explorer |

### Step-by-Step: Configure Active Directory DNS

#### Prerequisites
- Active Directory Domain Controller with DNS Server role
- Domain Admin or DNS Admin permissions
- VPN or ExpressRoute connection between on-premises and Azure VNet
- Lab deployed with `labMode: "private"`

#### Step 1: Identify the Azure DNS Forwarder IP

Azure provides a **virtual DNS service** at a well-known IP address:
```
168.63.129.16
```

This IP address:
- Exists in all Azure regions
- Resolves Azure Private DNS Zone records
- Is only accessible from within Azure VNets
- Requires VPN/ExpressRoute for on-premises access

#### Step 2: Create Conditional Forwarders on AD DNS

**On each Active Directory DNS Server**, create conditional forwarders for each Private DNS Zone.

##### Using DNS Manager GUI

1. Open **DNS Manager** (`dnsmgmt.msc`)
2. Expand **DNS Server** → **Conditional Forwarders**
3. Right-click **Conditional Forwarders** → **New Conditional Forwarder**
4. Configure each zone:

 **For Blob Storage:**
 - DNS Domain: `blob.core.windows.net`
 - Master Servers: `168.63.129.16`
 - Store this conditional forwarder in Active Directory
 - Replicate to: **All DNS servers in this forest**

 **For Queue Storage:**
 - DNS Domain: `queue.core.windows.net`
 - Master Servers: `168.63.129.16`
 - Store this conditional forwarder in Active Directory
 - Replicate to: **All DNS servers in this forest**

 **For Event Hub:**
 - DNS Domain: `servicebus.windows.net`
 - Master Servers: `168.63.129.16`
 - Store this conditional forwarder in Active Directory
 - Replicate to: **All DNS servers in this forest**

 **For Log Analytics (OMS):**
 - DNS Domain: `oms.opinsights.azure.com`
 - Master Servers: `168.63.129.16`
 - Store this conditional forwarder in Active Directory
 - Replicate to: **All DNS servers in this forest**

 **For Log Analytics (ODS):**
 - DNS Domain: `ods.opinsights.azure.com`
 - Master Servers: `168.63.129.16`
 - Store this conditional forwarder in Active Directory
 - Replicate to: **All DNS servers in this forest**

 **For Azure Monitor:**
 - DNS Domain: `monitor.azure.com`
 - Master Servers: `168.63.129.16`
 - Store this conditional forwarder in Active Directory
 - Replicate to: **All DNS servers in this forest**

 **For Azure Automation (AgentSvc):**
 - DNS Domain: `agentsvc.azure-automation.net`
 - Master Servers: `168.63.129.16`
 - Store this conditional forwarder in Active Directory
 - Replicate to: **All DNS servers in this forest**

5. **If deploying ADX**, also add:
 - DNS Domain: `kusto.windows.net`
 - Master Servers: `168.63.129.16`

##### Using PowerShell (Recommended for Multiple Servers)

```powershell
# Run this on a Domain Controller with DNS Admin rights

# Define the Azure DNS forwarder
$AzureDNS = "168.63.129.16"

# Define all required DNS zones
$DnsZones = @(
 "blob.core.windows.net",
 "queue.core.windows.net",
 "table.core.windows.net",
 "file.core.windows.net",
 "servicebus.windows.net",
 "monitor.azure.com",
 "oms.opinsights.azure.com",
 "ods.opinsights.azure.com",
 "agentsvc.azure-automation.net"
 # Add this if deploying ADX:
 # "kusto.windows.net"
)

# Create conditional forwarders for each zone
foreach ($zone in $DnsZones) {
 Write-Host "Creating conditional forwarder for: $zone" -ForegroundColor Cyan

 try {
 Add-DnsServerConditionalForwarderZone `
 -Name $zone `
 -MasterServers $AzureDNS `
 -ReplicationScope "Forest" `
 -PassThru

 Write-Host " Success: $zone" -ForegroundColor Green
 } catch {
 Write-Host " Warning: $zone may already exist or error occurred" -ForegroundColor Yellow
 Write-Host " $($_.Exception.Message)" -ForegroundColor Gray
 }
}

Write-Host "`n Conditional forwarders created!" -ForegroundColor Green
Write-Host "Allow 15 minutes for AD replication across all DNS servers" -ForegroundColor Yellow
```

#### Step 3: Verify DNS Resolution

After creating conditional forwarders, verify DNS resolution from an on-premises machine:

```powershell
# Test blob storage endpoint resolution
nslookup sacribllabeastus.blob.core.windows.net

# Expected output should show:
# Name: sacribllabeastus.privatelink.blob.core.windows.net
# Address: 10.0.0.5 (private IP, not public IP)

# Test Event Hub namespace resolution
nslookup evhns-cribllab-eastus.servicebus.windows.net

# Expected output should show:
# Name: evhns-cribllab-eastus.privatelink.servicebus.windows.net
# Address: 10.0.0.6 (private IP)

# Test Log Analytics workspace resolution
nslookup <workspace-id>.oms.opinsights.azure.com

# Expected output should show private IP from PrivateLinkSubnet
```

#### Step 4: Test Connectivity from Cribl Stream

After DNS is configured, test connectivity:

```powershell
# From Cribl Worker or on-premises machine

# Test blob storage connectivity
Test-NetConnection -ComputerName sacribllabeastus.blob.core.windows.net -Port 443

# Expected:
# TcpTestSucceeded : True
# RemoteAddress : 10.0.0.5

# Test Event Hub connectivity
Test-NetConnection -ComputerName evhns-cribllab-eastus.servicebus.windows.net -Port 443

# Expected:
# TcpTestSucceeded : True
# RemoteAddress : 10.0.0.6
```

### Troubleshooting DNS Issues

#### Issue: DNS queries still resolve to public IPs

**Cause**: Conditional forwarders not replicated or misconfigured

**Solution**:
```powershell
# Check if conditional forwarder exists
Get-DnsServerZone -Name "blob.core.windows.net"

# Verify master servers
Get-DnsServerZone -Name "blob.core.windows.net" | Select-Object ZoneName, MasterServers

# Force AD replication
repadmin /syncall /AeP
```

#### Issue: Cannot reach 168.63.129.16 from on-premises

**Cause**: VPN/ExpressRoute not routing properly

**Solution**:
1. Verify VPN/ExpressRoute connection is active
2. Check route tables allow traffic to Azure VNet
3. Verify NSG rules allow DNS (UDP/TCP 53) from on-premises
4. Test connectivity: `Test-NetConnection -ComputerName 168.63.129.16 -Port 53`

#### Issue: Private endpoint not resolving

**Cause**: Azure Private DNS Zone not linked to VNet

**Solution**:
```powershell
# Check Private DNS Zone VNet links
Get-AzPrivateDnsVirtualNetworkLink -ResourceGroupName "<your-rg>" -ZoneName "privatelink.blob.core.windows.net"

# If missing, create link:
New-AzPrivateDnsVirtualNetworkLink `
 -ResourceGroupName "<your-rg>" `
 -ZoneName "privatelink.blob.core.windows.net" `
 -Name "link-to-vnet" `
 -VirtualNetworkId "<vnet-resource-id>" `
 -EnableRegistration:$false
```

#### Issue: Cribl Stream cannot connect after DNS configured

**Cause**: Firewall or NSG blocking traffic

**Solution**:
1. Verify NSG on PrivateLinkSubnet allows inbound 443 from Cribl subnet
2. Check Azure Firewall (if deployed) allows traffic
3. Verify on-premises firewall allows outbound to Azure private IPs

### Alternative: Azure DNS Private Resolver

For environments without Active Directory or requiring simpler DNS, consider **Azure DNS Private Resolver**:

1. Deploy DNS Private Resolver in Azure VNet
2. Configure on-premises DNS to forward to Private Resolver IP
3. Private Resolver automatically resolves Private DNS Zones

**Deployment:**
```powershell
# Create DNS Private Resolver
$resolver = New-AzDnsResolver `
 -ResourceGroupName "<your-rg>" `
 -Name "dns-resolver-cribllab" `
 -Location "eastus" `
 -VirtualNetworkId "<vnet-id>"

# Create inbound endpoint (receives queries from on-premises)
$inboundEndpoint = New-AzDnsResolverInboundEndpoint `
 -DnsResolverName "dns-resolver-cribllab" `
 -ResourceGroupName "<your-rg>" `
 -Name "inbound-endpoint" `
 -Location "eastus" `
 -IpConfiguration @{SubnetId="<PrivateLinkSubnet-id>"}

# On-premises DNS: Create conditional forwarder to $inboundEndpoint.IpAddress
```

### Summary: Private Lab DNS Checklist

Before deploying private lab, ensure:

- [ ] Set `"labMode": "private"` in `azure-parameters.json`
- [ ] VPN or ExpressRoute connection established
- [ ] AD DNS servers can route to Azure VNet
- [ ] Conditional forwarders created for all zones (use PowerShell script above)
- [ ] Wait 15 minutes for AD replication
- [ ] Test DNS resolution with `nslookup`
- [ ] Test connectivity with `Test-NetConnection`
- [ ] Verify NSG rules allow traffic from on-premises to PrivateLinkSubnet
- [ ] Configure Cribl Stream to use private endpoint FQDNs

## Additional Resources

### Documentation
- [Azure Virtual Networks](https://docs.microsoft.com/en-us/azure/virtual-network/)
- [Microsoft Sentinel](https://docs.microsoft.com/en-us/azure/sentinel/)
- [Azure Data Explorer](https://docs.microsoft.com/en-us/azure/data-explorer/)
- [Event Hubs](https://docs.microsoft.com/en-us/azure/event-hubs/)
- [VNet Flow Logs](https://docs.microsoft.com/en-us/azure/network-watcher/vnet-flow-logs-overview)

### Troubleshooting

**VPN Gateway deployment taking too long:**
- VPN Gateway typically takes 30-45 minutes to deploy
- This is normal Azure behavior
- Consider deploying without VPN initially

**ADX cluster cost concerns:**
- Use Dev SKU for testing (~$240/month)
- Enable autoStop feature to pause cluster
- Consider deploying ADX last after testing other components

**Private Link not working:**
- Ensure DNS is configured (Azure Private DNS Zones or on-prem DNS)
- Check NSG rules allow 443 from on-prem to PrivateLinkSubnet
- Verify VPN/ExpressRoute routing

**Storage account naming errors:**
- Must be 3-24 characters, lowercase, alphanumeric only
- Globally unique across all of Azure
- Try different baseObjectName if conflicts occur

## Current Status

### Completed Components
- **Main Entry Point**: `Run-AzureUnifiedLab.ps1` - Full interactive and non-interactive deployment
- **Configuration System**: `azure-parameters.json` and `operation-parameters.json`
- **Core Deployment Scripts**:
  - `Deploy-Networking.ps1` - VNet, Subnets, NSGs
  - `Deploy-Storage.ps1` - Storage Account, Containers, Queues, Event Grid
  - `Deploy-Monitoring.ps1` - Log Analytics, Sentinel, Flow Logs, AMPLS
  - `Deploy-Analytics.ps1` - Event Hub, ADX
  - `Deploy-VMs.ps1` - Test VMs with auto-shutdown
  - `Deploy-VPN.ps1` - VPN Gateway (separate phase due to 30-45 min deployment)
  - `Deploy-DCRs.ps1` - Data Collection Rules integration
  - `Generate-CriblConfigs.ps1` - Cribl Stream configuration generation
- **Supporting Modules**:
  - `Menu-Framework.ps1` - Interactive menu system
  - `Naming-Engine.ps1` - Centralized resource naming
  - `Validation-Module.ps1` - Configuration validation
  - `Output-Helper.ps1` - Unified logging

### Deployment Phases
The deployment runs in 6 phases:
1. **Resource Group + TTL** (~1-2 min) - Creates RG and TTL cleanup Logic App
2. **Networking** (~3-5 min) - VNet, Subnets, NSGs
3. **Storage/Monitoring/Analytics** (~10-15 min) - Parallel deployment
4. **VMs/DCRs** (~5-10 min) - Test VMs and Data Collection Rules
5. **Cribl Configs** (~1 min) - Auto-generated configurations
6. **VPN Gateway** (~30-45 min) - Optional, runs last due to long deployment time

### Recent Fixes (December 2025)
- Fixed VPN Gateway phase not showing (property name mismatch)
- Fixed Event Grid subscription to use PowerShell cmdlets instead of Azure CLI
- Added VM auto-shutdown configuration for both new and existing VMs
- Added pre-deployment password collection to prevent blocking
- Added orphaned job cleanup to prevent duplicate log files
- Moved VPN Gateway to Phase 6 to avoid blocking other deployments
- Renamed Deploy-Infrastructure.ps1 to Deploy-Networking.ps1

## Contributing

This is an internal Cribl project. For questions or issues, contact the Azure integration team.

## License

Internal use only - Cribl Inc.

---

**Last Updated**: 2025-12-03
**Version**: 2.1.0
**Status**: Production Ready

# Azure Private Link Configuration for On-Premises Cribl Workers

Complete guide for enabling Azure Private Link on Log Analytics workspace and configuring DCR/DCE for secure data ingestion from on-premises Cribl worker nodes.

## Executive Summary

This guide enables secure, private connectivity between on-premises Cribl Stream worker nodes and Azure Log Analytics/Sentinel using Azure Private Link. By implementing Azure Private Link Scope (AMPLS), you can send logs over private connections instead of public internet, meeting compliance requirements for data sovereignty and network isolation.

## Why Private Link for Cribl?

**Use Cases:**
- **Compliance Requirements**: Keep data flows off public internet
- **Security Posture**: Eliminate public endpoint exposure
- **Network Policies**: Meet corporate network isolation requirements
- **Regulated Industries**: Healthcare, finance, government data sovereignty

**Benefits:**
- Traffic flows over Microsoft backbone network
- No public endpoint exposure
- Integration with on-premises networks via ExpressRoute/VPN
- DNS-based routing to private IPs
- Compatible with DCR/DCE architecture

## Architecture Overview

```
On-Premises Network Azure Private Link Azure Services
 
 
 Cribl Worker ER/VPN> Private |> Log Analytics 
 Node Endpoint Workspace 
 (10.x.x.x) 
 
 DNS Resolution: Azure Private Data Collection 
 - AD DNS Server Link Scope Rule (DCR) 
 - Azure Private (AMPLS) 
 DNS Resolver Data Collection 
 Endpoint (DCE) 
 
 
 
 DNS Query for DCEReturns Private IP
 <dce-name>.<region>-1.ingest.private.monitor.azure.com
```

## Prerequisites

### Azure Environment
- Log Analytics workspace (existing or new)
- Virtual Network with subnet for Private Endpoints
- Permissions to create:
 - Azure Private Link Scope (AMPLS)
 - Private Endpoints
 - Data Collection Rules (DCR)
 - Data Collection Endpoints (DCE)
- Azure subscription with ExpressRoute or Site-to-Site VPN configured

### On-Premises Environment
- Cribl Stream 4.14
- Network connectivity to Azure via ExpressRoute or VPN
- DNS infrastructure:
 - Active Directory DNS Servers (Option 1), OR
 - Azure Private DNS Resolver access (Option 2)
- Firewall rules allowing outbound HTTPS (port 443) to private endpoint IPs

### Required Tools
- PowerShell 5.1+ with Azure modules:
 ```powershell
 Install-Module -Name Az.Accounts
 Install-Module -Name Az.Resources
 Install-Module -Name Az.OperationalInsights
 Install-Module -Name Az.Monitor
 Install-Module -Name Az.Network
 ```
- DCR Automation Tool from this repository

## Step-by-Step Configuration

### Step 1: Create Azure Private Link Scope (AMPLS)

The Azure Monitor Private Link Scope is the container that groups your Log Analytics workspaces and DCEs for private access.

#### Via Azure Portal

1. Navigate to **Azure Portal** → Search for **"Azure Monitor Private Link Scopes"**
2. Click **+ Create**
3. Configure basics:
 - **Subscription**: Your subscription
 - **Resource Group**: Choose or create (e.g., `rg-monitoring-private`)
 - **Name**: `ampls-cribl-onprem`
 - **Region**: Same as your Log Analytics workspace
4. Click **Review + Create** → **Create**

#### Via PowerShell

```powershell
# Connect to Azure
Connect-AzAccount
Set-AzContext -Subscription "<Your-Subscription-Name>"

# Define parameters
$resourceGroupName = "rg-monitoring-private"
$location = "eastus"
$amplsName = "ampls-cribl-onprem"

# Create resource group if needed
New-AzResourceGroup -Name $resourceGroupName -Location $location -ErrorAction SilentlyContinue

# Create Azure Monitor Private Link Scope
New-AzInsightsPrivateLinkScope `
 -ResourceGroupName $resourceGroupName `
 -Name $amplsName `
 -Location $location
```

### Step 2: Add Log Analytics Workspace to AMPLS

Link your existing Log Analytics workspace to the Private Link Scope.

#### Via Azure Portal

1. Open your **Azure Monitor Private Link Scope** (`ampls-cribl-onprem`)
2. Under **Settings** → **Azure Monitor Resources**
3. Click **+ Add**
4. Select your **Log Analytics Workspace**
5. Click **Add**

#### Via PowerShell

```powershell
# Get workspace resource ID
$workspaceName = "your-workspace-name"
$workspace = Get-AzOperationalInsightsWorkspace `
 -ResourceGroupName $resourceGroupName `
 -Name $workspaceName

# Add workspace to AMPLS
New-AzInsightsPrivateLinkScopedResource `
 -ResourceGroupName $resourceGroupName `
 -ScopeName $amplsName `
 -Name "$workspaceName-connection" `
 -LinkedResourceId $workspace.ResourceId
```

### Step 3: Create Data Collection Endpoint (DCE) with Private Link

The DCE is the ingestion endpoint that Cribl will send data to. We'll create it with Private Link support.

#### Option A: Using DCR Automation Tool (Recommended)

**New Feature**: The DCR Automation tool now supports creating DCEs with Private Link configuration!

1. Navigate to DCR Automation directory:
 ```powershell
 cd Azure\CustomDeploymentTemplates\DCR-Automation\prod
 ```

2. Configure `operation-parameters.json` for Private Link:
 ```json
 {
 "deployment": {
 "createDCE": true,
 "skipExistingDCRs": true,
 "skipExistingDCEs": true
 },
 "privateLink": {
 "enabled": true,
 "dcePublicNetworkAccess": "Disabled",
 "amplsResourceGroupName": "rg-monitoring-private",
 "amplsName": "ampls-cribl-onprem"
 }
 }
 ```

 **OR** Use the interactive menu:
 ```powershell
 .\Run-DCRAutomation.ps1
 # Select option [6] "Configure Private Link for DCE"
 ```

 The interactive menu will guide you through:
 - Enabling/disabling Private Link
 - Setting DCE public network access (Enabled/Disabled)
 - Configuring AMPLS association (Resource ID or Name/RG)

3. **What the automation does**:
 - Creates DCE with `publicNetworkAccess: Disabled`
 - Automatically associates DCE with your specified AMPLS
 - Validates AMPLS exists before association
 - Provides clear status messages for troubleshooting

#### Option B: Manual DCE Creation via Azure Portal

If you prefer manual creation:

1. Navigate to **Azure Portal** → **Monitor** → **Data Collection Endpoints**
2. Click **+ Create**
3. Configure:
 - **Basics**:
 - Resource Group: `rg-monitoring-private`
 - Name: `dce-cribl-private`
 - Region: Same as workspace
 - **Networking**:
 - **Public network access**: **Disabled** Critical setting
4. Click **Review + Create** → **Create**

#### Option C: Manual DCE Creation via Azure CLI

```bash
# Create DCE with private network access only
az monitor data-collection endpoint create \
 --name "dce-cribl-private" \
 --resource-group "rg-monitoring-private" \
 --location "eastus" \
 --public-network-access "Disabled"

# Get DCE resource ID for next step
az monitor data-collection endpoint show \
 --name "dce-cribl-private" \
 --resource-group "rg-monitoring-private" \
 --query "id" -o tsv
```

### Step 4: Add DCE to AMPLS

Link the Data Collection Endpoint to the Private Link Scope.

#### Via Azure Portal

1. Open your **Azure Monitor Private Link Scope** (`ampls-cribl-onprem`)
2. Under **Settings** → **Azure Monitor Resources**
3. Click **+ Add**
4. Select your **Data Collection Endpoint** (`dce-cribl-private`)
5. Click **Add**

#### Via PowerShell

```powershell
# Get DCE resource ID
$dceName = "dce-cribl-private"
$dce = Get-AzDataCollectionEndpoint `
 -ResourceGroupName $resourceGroupName `
 -Name $dceName

# Add DCE to AMPLS
New-AzInsightsPrivateLinkScopedResource `
 -ResourceGroupName $resourceGroupName `
 -ScopeName $amplsName `
 -Name "$dceName-connection" `
 -LinkedResourceId $dce.Id
```

### Step 5: Create Private Endpoint

Create the Private Endpoint in your Azure VNet that on-premises network can reach via ExpressRoute/VPN.

#### Via Azure Portal

1. Navigate to your **Azure Monitor Private Link Scope** (`ampls-cribl-onprem`)
2. Under **Settings** → **Private endpoint connections**
3. Click **+ Private endpoint**
4. Configure:
 - **Basics**:
 - Name: `pe-ampls-cribl-onprem`
 - Region: Same as your VNet
 - **Resource**:
 - Resource type: `Microsoft.Insights/privateLinkScopes`
 - Resource: Select your AMPLS
 - Target sub-resource: `azuremonitor`
 - **Virtual Network**:
 - Virtual network: Select your VNet (must be accessible from on-prem)
 - Subnet: Select subnet for private endpoints
 - **DNS**:
 - Integrate with private DNS zone: **Yes** (creates required DNS zones)
5. Click **Review + Create** → **Create**

#### Via PowerShell

```powershell
# Define network parameters
$vnetName = "vnet-hub"
$subnetName = "subnet-private-endpoints"
$privateEndpointName = "pe-ampls-cribl-onprem"

# Get VNet and Subnet
$vnet = Get-AzVirtualNetwork -Name $vnetName -ResourceGroupName $resourceGroupName
$subnet = $vnet | Select-Object -ExpandProperty Subnets | Where-Object {$_.Name -eq $subnetName}

# Get AMPLS resource ID
$ampls = Get-AzInsightsPrivateLinkScope `
 -ResourceGroupName $resourceGroupName `
 -Name $amplsName

# Create private endpoint connection
$privateEndpointConnection = New-AzPrivateLinkServiceConnection `
 -Name "$privateEndpointName-connection" `
 -PrivateLinkServiceId $ampls.Id `
 -GroupId "azuremonitor"

# Create private endpoint
$privateEndpoint = New-AzPrivateEndpoint `
 -Name $privateEndpointName `
 -ResourceGroupName $resourceGroupName `
 -Location $location `
 -Subnet $subnet `
 -PrivateLinkServiceConnection $privateEndpointConnection

# Output private IP for DNS configuration
$privateEndpoint.CustomDnsConfigs | ForEach-Object {
 Write-Host "FQDN: $($_.Fqdn)"
 Write-Host "IP Address: $($_.IpAddresses -join ', ')"
 Write-Host ""
}
```

**Important**: Note the private IP addresses output - you'll need these for DNS configuration.

### Step 6: Configure DNS Resolution

On-premises Cribl workers must resolve Azure Monitor and DCE endpoints to private IPs. Choose one of two DNS options:

---

## DNS Configuration Options

### Option 1: Active Directory DNS (On-Premises DNS Servers)

**Best for**: Organizations with existing AD DNS infrastructure and ExpressRoute/VPN.

#### DNS Zones Required

Create conditional forwarders for these Azure Monitor private DNS zones:

**Required for Cribl DCE/DCR ingestion:**
```
privatelink.monitor.azure.com # DCE ingestion endpoints (REQUIRED)
privatelink.oms.opinsights.azure.com # Log Analytics workspace queries (REQUIRED)
privatelink.ods.opinsights.azure.com # Log Analytics data collection (REQUIRED)
```

**Optional (only if using these services):**
```
privatelink.agentsvc.azure-automation.net # Azure Automation (optional)
privatelink.blob.core.windows.net # Storage Account diagnostic logs (optional)
```

**Note**: All these zones are served by a **single Private Endpoint** with multiple private IPs (typically 3-5 IPs) for different services.

#### Implementation Steps

**On your Active Directory DNS Server:**

1. Open **DNS Manager** (`dnsmgmt.msc`)
2. Expand your DNS server → **Conditional Forwarders**
3. Right-click → **New Conditional Forwarder**

**For each DNS zone above**, configure:

4. **DNS Domain**: Enter the zone name (e.g., `privatelink.monitor.azure.com`)
5. **IP addresses of the master servers**:
 - Add Azure Private DNS IP: `168.63.129.16`
 - OR point to Azure Private DNS Resolver (if deployed)
6. Check **Store this conditional forwarder in Active Directory**
7. Select **All DNS servers in this domain**
8. Click **OK**

#### Alternative: Direct A Records (Without Conditional Forwarders)

If you prefer not to use conditional forwarders, you can create direct A records using the Private Endpoint IPs:

**Step 1: Get Private Endpoint IPs**

1. Navigate to your **Private Endpoint** in Azure Portal
2. Go to **DNS configuration** blade
3. Note the private IPs assigned to each FQDN

Example output:
```
ods.opinsights.azure.com → 10.1.0.4
*.ods.opinsights.azure.com → 10.1.0.4
*.oms.opinsights.azure.com → 10.1.0.5
global.handler.control.monitor.azure.com → 10.1.0.6
eastus-1.handler.control.monitor.azure.com → 10.1.0.6
eastus-1.ingest.monitor.azure.com → 10.1.0.6
```

**Step 2: Create Forward Lookup Zones**

1. Open **DNS Manager** (`dnsmgmt.msc`)
2. Right-click **Forward Lookup Zones** → **New Zone**
3. Create zones as needed:
 - `monitor.azure.com`
 - `oms.opinsights.azure.com`
 - `ods.opinsights.azure.com`
4. Store in Active Directory, replicate to all DNS servers

**Step 3: Create A Records**

For each endpoint needed by Cribl, create an A record:

1. Right-click the appropriate zone → **New Host (A or AAAA)**
2. **Name**: Enter the hostname portion
 - For `eastus-1.ingest.monitor.azure.com` → enter `eastus-1.ingest`
3. **IP address**: Enter the private IP from Step 1
4. Click **Add Host**

**Important Notes:**
- **168.63.129.16** is only used for conditional forwarders to Azure DNS
- **For direct A records**, use the actual private IPs from your Private Endpoint
- Create records for all endpoints your Cribl workers will access:
 - `<region>-1.ingest.monitor.azure.com` (DCE ingestion)
 - `<region>-1.handler.control.monitor.azure.com` (DCE control)
 - `global.handler.control.monitor.azure.com` (global control)

#### Detailed Configuration for DCE Ingestion

**Critical DNS Record**: Your DCE ingestion endpoint needs specific DNS resolution.

**DCE Endpoint Format:**
```
<dce-name>.<region>-1.ingest.private.monitor.azure.com
```

**Example DCE endpoints:**
```
dce-cribl-private.eastus-1.ingest.private.monitor.azure.com
dce-cribl-private.westus2-1.ingest.private.monitor.azure.com
```

**Create DNS A Records in AD DNS:**

1. Open **DNS Manager**
2. Expand **Forward Lookup Zones**
3. Right-click **Conditional Forwarders** → Ensure `privatelink.monitor.azure.com` forwards to `168.63.129.16`
4. Alternatively, create a local forward lookup zone:
 - Right-click **Forward Lookup Zones** → **New Zone**
 - Zone name: `<region>-1.ingest.private.monitor.azure.com` (e.g., `eastus-1.ingest.private.monitor.azure.com`)
 - Create new **A Record**:
 - Name: `<dce-name>` (e.g., `dce-cribl-private`)
 - IP address: Private IP of your Private Endpoint (from Step 5)

#### PowerShell Script for AD DNS Configuration

```powershell
# Run on Windows DNS Server
# Requires: DNS Server role, Administrator privileges

# Define parameters
$dnsServer = "dc01.yourdomain.local" # Your AD DNS server
$azurePrivateDnsIp = "168.63.129.16" # Azure recursive resolver

# DNS zones for Azure Monitor Private Link
$zones = @(
 "privatelink.monitor.azure.com",
 "privatelink.oms.opinsights.azure.com",
 "privatelink.ods.opinsights.azure.com",
 "privatelink.agentsvc.azure-automation.net",
 "privatelink.blob.core.windows.net"
)

# Create conditional forwarders
foreach ($zone in $zones) {
 Write-Host "Creating conditional forwarder for $zone..."

 Add-DnsServerConditionalForwarderZone `
 -Name $zone `
 -MasterServers $azurePrivateDnsIp `
 -ReplicationScope "Domain" `
 -PassThru
}

Write-Host "Conditional forwarders created successfully!"

# Create DCE-specific A record (adjust to your environment)
$dceZone = "eastus-1.ingest.private.monitor.azure.com"
$dceName = "dce-cribl-private"
$privateEndpointIp = "10.0.1.5" # Replace with your Private Endpoint IP

# Create forward lookup zone
Add-DnsServerPrimaryZone -Name $dceZone -ReplicationScope "Domain"

# Add A record for DCE
Add-DnsServerResourceRecordA `
 -Name $dceName `
 -ZoneName $dceZone `
 -IPv4Address $privateEndpointIp `
 -TimeToLive 01:00:00

Write-Host "DCE DNS record created: $dceName.$dceZone -> $privateEndpointIp"
```

#### Verify AD DNS Resolution

From an on-premises machine (or Cribl worker node):

```powershell
# Test DCE endpoint resolution
nslookup dce-cribl-private.eastus-1.ingest.private.monitor.azure.com

# Expected output should show private IP (10.x.x.x), NOT public IP
```

---

### Option 2: Azure Private DNS Resolver

**Best for**: Hybrid environments wanting centralized Azure DNS management, or organizations without AD DNS infrastructure.

Azure Private DNS Resolver provides DNS resolution from on-premises to Azure Private DNS zones over ExpressRoute/VPN.

#### Architecture

```
On-Premises Azure Virtual Network Azure Private DNS
 
 Private DNS privatelink. 
 Cribl Resolver monitor. 
 Worker DNS> Inbound > azure.com 
 Node Query Endpoint Lookup 
 (10.0.2.4) A Records: 
 dce-cribl-* 
 
```

#### Deployment Steps

**1. Create Private DNS Resolver**

Via Azure Portal:

1. Navigate to **Azure Portal** → **Create a resource** → Search **"DNS Private Resolver"**
2. Click **Create**
3. Configure:
 - **Subscription**: Your subscription
 - **Resource Group**: `rg-monitoring-private`
 - **Name**: `dns-resolver-cribl`
 - **Region**: Same as VNet
 - **Virtual Network**: Select your VNet
4. **Inbound Endpoint**:
 - Name: `inbound-endpoint`
 - Subnet: Dedicated subnet for resolver (e.g., `/28` subnet)
 - Private IP: Static or dynamic
5. Click **Review + Create** → **Create**

**2. Link Private DNS Zones**

Private DNS zones are automatically created when you enable Private Endpoint DNS integration (Step 5). Link them to your VNet:

1. Navigate to **Private DNS zones** in Azure Portal
2. For each zone (e.g., `privatelink.monitor.azure.com`):
 - Open the zone
 - **Settings** → **Virtual network links**
 - Click **+ Add**
 - Link name: `link-vnet-hub`
 - Virtual network: Select your VNet
 - Enable auto-registration: **No**
 - Click **OK**

**3. Configure On-Premises DNS**

Point your on-premises DNS servers or Cribl worker node DNS to the **Inbound Endpoint IP** of the Azure Private DNS Resolver.

**Option A: DNS Server Level (Recommended)**

Configure conditional forwarders on your on-premises DNS:

```powershell
# On on-premises DNS server
$resolverIp = "10.0.2.4" # Your Azure DNS Resolver Inbound Endpoint IP

$zones = @(
 "privatelink.monitor.azure.com",
 "privatelink.oms.opinsights.azure.com",
 "privatelink.ods.opinsights.azure.com",
 "eastus-1.ingest.private.monitor.azure.com" # Adjust region
)

foreach ($zone in $zones) {
 Add-DnsServerConditionalForwarderZone `
 -Name $zone `
 -MasterServers $resolverIp `
 -ReplicationScope "Domain"
}
```

**Option B: Cribl Worker Node Level**

If you can't modify DNS infrastructure, configure DNS directly on Cribl worker nodes:

**Linux (Ubuntu/RHEL):**
```bash
# Edit /etc/resolv.conf (or use systemd-resolved)
sudo nano /etc/resolv.conf

# Add Azure DNS Resolver as first nameserver
nameserver 10.0.2.4 # Azure Private DNS Resolver IP
nameserver 8.8.8.8 # Fallback
```

**Windows:**
```powershell
# Set DNS server on network adapter
$adapterName = "Ethernet"
$resolverIp = "10.0.2.4"

Set-DnsClientServerAddress -InterfaceAlias $adapterName -ServerAddresses $resolverIp,"8.8.8.8"
```

#### Verify Azure Private DNS Resolver

From Cribl worker node:

```bash
# Test DCE endpoint resolution
nslookup dce-cribl-private.eastus-1.ingest.private.monitor.azure.com 10.0.2.4

# Expected: Returns private IP (10.x.x.x)
```

---

### DNS Verification Checklist

Before proceeding, verify DNS resolution is working:

| Test | Command | Expected Result |
|------|---------|-----------------|
| **DCE Ingestion Endpoint** | `nslookup dce-cribl-private.eastus-1.ingest.private.monitor.azure.com` | Private IP (10.x.x.x) |
| **Log Analytics Workspace** | `nslookup <workspace-id>.ods.opinsights.azure.com` | Private IP (10.x.x.x) |
| **General Monitor Endpoint** | `nslookup global.in.ai.monitor.azure.com` | Private IP (10.x.x.x) |

**If DNS returns public IPs**, your DNS configuration needs adjustment. Review the DNS setup for your chosen option.

---

### Step 7: Run DCR Automation with Private Link

Now that Private Link and DNS are configured, use the DCR Automation tool to create DCRs with your private DCE.

#### Configure DCR Automation with Private Link Support

The DCR Automation tool now has **built-in Private Link support** that automates DCE creation and AMPLS association!

1. Navigate to DCR Automation:
 ```powershell
 cd Azure\CustomDeploymentTemplates\DCR-Automation\prod
 ```

2. Edit `azure-parameters.json`:
 ```json
 {
 "resourceGroupName": "rg-monitoring-private",
 "workspaceName": "your-workspace-name",
 "location": "eastus",
 "dcePrefix": "dce-cribl-",
 "dcrPrefix": "dcr-cribl-",
 "tenantId": "<YOUR-TENANT-ID>",
 "clientId": "<YOUR-CLIENT-ID>"
 }
 ```

3. Edit `operation-parameters.json`:
 ```json
 {
 "deployment": {
 "createDCE": true,
 "skipExistingDCRs": true,
 "skipExistingDCEs": false
 },
 "privateLink": {
 "enabled": true,
 "dcePublicNetworkAccess": "Disabled",
 "amplsResourceGroupName": "rg-monitoring-private",
 "amplsName": "ampls-cribl-onprem"
 },
 "customTableSettings": {
 "enabled": true,
 "customTableListFile": "CustomTableList.json"
 }
 }
 ```

 **Key Private Link settings**:
 - `"enabled": true` - Enables Private Link features
 - `"dcePublicNetworkAccess": "Disabled"` - Creates DCE with private-only access
 - `"amplsResourceGroupName"` and `"amplsName"` - Automatically associates DCE with AMPLS

 **Alternative**: Use full AMPLS Resource ID:
 ```json
 "privateLink": {
 "enabled": true,
 "dcePublicNetworkAccess": "Disabled",
 "amplsResourceId": "/subscriptions/<sub-id>/resourceGroups/rg-monitoring-private/providers/Microsoft.Insights/privateLinkScopes/ampls-cribl-onprem"
 }
 ```

#### Interactive Configuration (Easier Method)

Use the built-in menu for guided setup:

```powershell
.\Run-DCRAutomation.ps1

# From the menu, select option [6] "Configure Private Link for DCE"
```

The interactive wizard will:
1. Show current Private Link configuration
2. Ask if you want to enable Private Link
3. Let you choose DCE network access (Enabled/Disabled)
4. Guide you through AMPLS configuration
5. Save the configuration to `operation-parameters.json`

4. Edit `CustomTableList.json` with your tables:
 ```json
 [
 "FirewallLogs_CL",
 "Syslog",
 "SecurityEvent"
 ]
 ```

5. Run automation:
 ```powershell
 # Connect to Azure
 Connect-AzAccount

 # Run automation
 .\Run-DCRAutomation.ps1 -NonInteractive -Mode DCEBoth
 ```

6. **Outputs**: The script generates Cribl configurations in `cribl-dcr-configs/`:
 - `cribl-dcr-config.json`: Master configuration
 - `destinations/*.json`: Individual destination configs

#### Review Generated Cribl Configs

Example `destinations/FirewallLogs_CL-destination.json`:

```json
{
 "destinationName": "FirewallLogs_CL",
 "dcrImmutableId": "dcr-1234567890abcdef1234567890abcdef",
 "dceEndpoint": "https://dce-cribl-private.eastus-1.ingest.private.monitor.azure.com",
 "streamName": "Custom-FirewallLogs_CL",
 "clientId": "<YOUR-CLIENT-ID>",
 "tenantId": "<YOUR-TENANT-ID>",
 "clientSecret": "<YOUR-CLIENT-SECRET>",
 "authEndpoint": "https://login.microsoftonline.com/<YOUR-TENANT-ID>/oauth2/v2.0/token"
}
```

**Key Point**: The `dceEndpoint` will use the **private FQDN**. When resolved from on-premises, it will return the **private IP**.

---

### Step 8: Configure Cribl Stream Destination

Configure Cribl Stream to send data via the private DCE endpoint.

#### Add Microsoft Sentinel Destination

1. **Cribl Stream UI** → **Manage** → **Data** → **Destinations**
2. Click **+ Add Destination** → **Microsoft Sentinel**
3. Configure destination:

**General Settings:**
- **Destination Name**: `FirewallLogs_CL` (match table name)
- **Description**: `Private Link ingestion for firewall logs`

**Authentication:**
- **Client ID**: `<YOUR-CLIENT-ID>` (from App Registration)
- **Tenant ID**: `<YOUR-TENANT-ID>`
- **Client Secret**: `<YOUR-CLIENT-SECRET>` (use Cribl Secrets)

**Ingestion Settings:**
- **DCR Immutable ID**: `dcr-1234567890abcdef1234567890abcdef` (from generated config)
- **DCE Endpoint**: `https://dce-cribl-private.eastus-1.ingest.private.monitor.azure.com`
- **Stream Name**: `Custom-FirewallLogs_CL`

**Advanced Settings (Optional):**
- **Timeout**: `30s`
- **Flush Interval**: `10s`
- **Compression**: `gzip` (recommended)

4. Click **Save**

#### Update Pipeline Routing

Ensure your pipeline routes data to the new destination:

1. **Pipelines** → Select your pipeline
2. Add **Destination** function or update existing routing
3. **Destination**: Select `FirewallLogs_CL`
4. **Output**: Ensure data structure matches DCR schema

---

### Step 9: Test Data Flow

Verify data flows through Private Link to Azure.

#### Send Test Event

1. In Cribl Stream, send sample data through the pipeline
2. Use **Live Data Preview** to verify output format

#### Check Azure Log Analytics

Query your table in Azure Portal:

```kusto
// Check recent data ingestion
FirewallLogs_CL
| where TimeGenerated > ago(15m)
| summarize Count = count(), LatestRecord = max(TimeGenerated)
| extend Status = iff(Count > 0, " Data flowing via Private Link", " No data received")
```

#### Verify Private Network Path

From Cribl worker node, verify traffic uses private IP:

```bash
# Trace network path (Linux)
traceroute dce-cribl-private.eastus-1.ingest.private.monitor.azure.com

# Expected: Should show private IP (10.x.x.x), NOT public IPs

# Test HTTPS connectivity
curl -v https://dce-cribl-private.eastus-1.ingest.private.monitor.azure.com

# Expected: SSL handshake with private IP
```

---

## Troubleshooting Guide

### Issue: DNS Resolves to Public IP

**Symptoms:**
- `nslookup` returns public IP instead of private IP
- Cribl connects via public internet

**Solution:**
1. Verify DNS forwarder configuration (AD DNS or Azure DNS Resolver)
2. Check Private DNS zone is linked to VNet
3. Verify Private Endpoint status is "Approved"
4. Clear DNS cache:
 ```bash
 # Windows
 ipconfig /flushdns

 # Linux
 sudo systemd-resolve --flush-caches
 ```

### Issue: Connection Timeout from Cribl

**Symptoms:**
- Cribl destination shows connection timeout
- DNS resolves correctly but no connectivity

**Solution:**
1. Verify ExpressRoute/VPN connectivity from on-prem to Azure VNet
2. Check NSG rules on Private Endpoint subnet allow port 443
3. Verify route tables on both on-prem and Azure side
4. Test basic connectivity:
 ```bash
 # From Cribl worker node
 nc -zv dce-cribl-private.eastus-1.ingest.private.monitor.azure.com 443
 ```

### Issue: Authentication Failures

**Symptoms:**
- 401 Unauthorized errors in Cribl logs
- "Invalid client secret" errors

**Solution:**
1. Verify App Registration client ID and secret are correct
2. Check App Registration has "Monitoring Metrics Publisher" role on DCR:
 ```powershell
 # Assign role to App Registration
 $dcrId = "/subscriptions/<sub-id>/resourceGroups/<rg>/providers/Microsoft.Insights/dataCollectionRules/<dcr-name>"
 $appId = "<YOUR-CLIENT-ID>"

 New-AzRoleAssignment `
 -ObjectId (Get-AzADServicePrincipal -ApplicationId $appId).Id `
 -RoleDefinitionName "Monitoring Metrics Publisher" `
 -Scope $dcrId
 ```

### Issue: DCE Not in AMPLS

**Symptoms:**
- DCE resolves to public IP even with Private Link configured
- Data flows via public internet

**Solution:**
1. Verify DCE is added to AMPLS:
 ```powershell
 Get-AzInsightsPrivateLinkScopedResource `
 -ResourceGroupName "rg-monitoring-private" `
 -ScopeName "ampls-cribl-onprem"
 ```
2. If missing, add DCE to AMPLS (see Step 4)

### Issue: Schema Mismatch Errors

**Symptoms:**
- 400 Bad Request with "schema validation failed"
- Data not appearing in Log Analytics

**Solution:**
1. Verify Cribl pipeline output matches DCR schema exactly
2. Check column names and data types
3. Review DCR transformation in Azure Portal
4. Use Cribl's **Live Data** feature to inspect output format

### Issue: Private Endpoint Not Approved

**Symptoms:**
- Private Endpoint shows "Pending" status
- No connectivity via private IP

**Solution:**
1. Navigate to Private Endpoint in Azure Portal
2. Check **Private endpoint connections** status
3. If pending, manually approve:
 - Go to AMPLS → **Private endpoint connections**
 - Select pending connection
 - Click **Approve**

---

## Network Security Considerations

### Firewall Rules

**On-Premises Firewall:**
Allow outbound HTTPS (port 443) to:
- Private Endpoint IP address(es)
- Azure AD endpoints for authentication:
 - `login.microsoftonline.com`
 - `login.windows.net`

**Azure Network Security Groups:**
Private Endpoint subnet NSG should allow:
- Inbound: Port 443 from on-premises CIDR ranges
- Outbound: Allow to Azure Monitor services

### ExpressRoute/VPN Requirements

**Bandwidth Recommendations:**
- Small deployment (< 1 GB/day): 10 Mbps minimum
- Medium deployment (1-10 GB/day): 50 Mbps minimum
- Large deployment (> 10 GB/day): 100+ Mbps recommended

**Route Advertisement:**
Ensure Azure VNet routes are advertised to on-premises via BGP (ExpressRoute) or static routes (VPN).

### Monitoring Private Link Connectivity

**Azure Monitor Workbook Query:**

```kusto
// Monitor DCR ingestion via Private Link
DCRLogErrors
| where TimeGenerated > ago(1h)
| where ErrorCode != ""
| summarize ErrorCount = count() by ErrorCode, bin(TimeGenerated, 5m)
| render timechart
```

---

## Best Practices

### Security
- Use Cribl Secrets to store Azure AD client secrets
- Implement least-privilege RBAC on DCRs (Monitoring Metrics Publisher only)
- Disable public network access on DCE (`"publicNetworkAccess": "Disabled"`)
- Use separate App Registrations per environment (dev/prod)
- Rotate client secrets regularly (every 90 days)

### Network
- Use dedicated subnet for Private Endpoints (`/28` minimum)
- Implement NSG rules to restrict access to known on-prem ranges
- Monitor ExpressRoute/VPN health and bandwidth utilization
- Use Azure Private DNS Resolver for centralized DNS management
- Document private IP assignments for troubleshooting

### Operations
- Test failover scenarios (VPN/ExpressRoute failure)
- Monitor DCR ingestion metrics in Azure Monitor
- Set up alerts for authentication failures and connection timeouts
- Maintain documentation of DNS records and IP allocations
- Use DCR Automation tool for consistent DCR/DCE deployments

---

## Migration from Public to Private Ingestion

If you have existing Cribl destinations using public endpoints, follow this gradual cutover process:

### Phase 1: Parallel Configuration (Week 1)
1. Deploy Private Link infrastructure (Steps 1-6)
2. Create new DCR/DCE with Private Link (Step 7)
3. Add new Cribl destinations alongside existing ones
4. Route 10% of traffic to private destinations for testing

### Phase 2: Validation (Week 2)
5. Validate data integrity between public and private paths
6. Monitor latency and throughput
7. Increase traffic to 50% private ingestion

### Phase 3: Full Cutover (Week 3)
8. Route 100% traffic to private destinations
9. Monitor for 72 hours
10. Disable public network access on DCE
11. Remove old public destinations from Cribl

---

## Cost Considerations

**Azure Private Link Costs:**
- **Private Endpoint**: ~$7.50/month per endpoint
- **Azure DNS Private Resolver**: ~$0.40/hour (~$290/month) for inbound + outbound endpoints
- **Data Processing**: $0.01 per GB processed (first 1 TB free per month)

**Cost Optimization Tips:**
- Use single AMPLS for multiple workspaces and DCEs
- Consolidate Private Endpoints where possible
- Leverage free data processing tier (1 TB/month)

---

## Reference: DCR Automation Parameters for Private Link

### Complete Private Link Configuration (Now Fully Supported!)

**azure-parameters.json:**
```json
{
 "resourceGroupName": "rg-monitoring-private",
 "workspaceName": "law-cribl-prod",
 "location": "eastus",
 "dcePrefix": "dce-cribl-",
 "dcrPrefix": "dcr-cribl-",
 "tenantId": "<YOUR-TENANT-ID>",
 "clientId": "<YOUR-CLIENT-ID>"
}
```

**operation-parameters.json:**
```json
{
 "deployment": {
 "createDCE": true,
 "skipExistingDCRs": true,
 "skipExistingDCEs": false
 },
 "privateLink": {
 "enabled": true,
 "dcePublicNetworkAccess": "Disabled",
 "amplsResourceGroupName": "rg-monitoring-private",
 "amplsName": "ampls-cribl-onprem"
 },
 "customTableSettings": {
 "enabled": true,
 "customTableListFile": "CustomTableList.json"
 }
}
```

### Private Link Configuration Options

**Option 1: Using AMPLS Name and Resource Group**
```json
"privateLink": {
 "enabled": true,
 "dcePublicNetworkAccess": "Disabled",
 "amplsResourceGroupName": "rg-monitoring-private",
 "amplsName": "ampls-cribl-onprem"
}
```

**Option 2: Using Full AMPLS Resource ID**
```json
"privateLink": {
 "enabled": true,
 "dcePublicNetworkAccess": "Disabled",
 "amplsResourceId": "/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/rg-monitoring-private/providers/Microsoft.Insights/privateLinkScopes/ampls-cribl-onprem"
}
```

**Option 3: Private DCE without AMPLS (Manual Association Required)**
```json
"privateLink": {
 "enabled": true,
 "dcePublicNetworkAccess": "Disabled"
}
```
**Note**: Without AMPLS configuration, DCE is created with private-only access but not associated with AMPLS. You must manually add it in Azure Portal.

### Automated Workflow

With Private Link enabled, the DCR Automation tool automatically:

1. **Creates DCE** with `publicNetworkAccess: Disabled`
2. **Validates AMPLS** exists and is accessible
3. **Associates DCE with AMPLS** (creates scoped resource)
4. **Creates DCRs** that reference the private DCE
5. **Exports Cribl configurations** with private ingestion endpoints
6. **Provides status feedback** at each step

### Interactive Menu Configuration

Alternatively, use the interactive menu for guided setup:

```powershell
.\Run-DCRAutomation.ps1
# Select option [6] "Configure Private Link for DCE"
```

The menu provides:
- Current configuration display
- Step-by-step configuration wizard
- Input validation
- Configuration preview before saving
- Next steps guidance

---

## Support and Resources

### Documentation
- [Azure Private Link Documentation](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/private-link-security)
- [DCR Automation Quick Start](../../Azure/CustomDeploymentTemplates/DCR-Automation/QUICK_START.md)
- [Cribl Sentinel Destination Docs](https://docs.cribl.io/stream/destinations-sentinel/)

### Community Support
- **Cribl Community Slack**: [#azure-everything](https://cribl-community.slack.com/archives/C089V3GCFV0)
- **Repository Issues**: [GitHub Issues](https://github.com/criblio/Cribl-Microsoft/issues)

### Contact
- **Tool Issues**: James Pederson - jpederson@cribl.io
- **Architecture Questions**: Cribl Solutions Architects

---

**Last Updated**: 2025-01-24
**Version**: 1.0
**Tested With**: Cribl Stream 4.14+, Azure PowerShell 10.0+

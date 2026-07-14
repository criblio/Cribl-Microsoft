# Azure Flow Log Lab Deployment Engine
# Core deployment script for creating Azure Flow Log Lab infrastructure including vNet, VPN Gateway, NSGs, and Flow Logging

param(
 [Parameter(Mandatory=$true)]
 [ValidateSet("Full", "VNetOnly", "VPNOnly", "BastionOnly", "FlowLogsOnly", "CriblCollectorsOnly", "TemplateOnly")]
 [string]$Mode
)

# Import configuration files
$ScriptRoot = $PSScriptRoot
$azParams = Get-Content (Join-Path $ScriptRoot "azure-parameters.json") | ConvertFrom-Json
$opParams = Get-Content (Join-Path $ScriptRoot "operation-parameters.json") | ConvertFrom-Json

# Import on-prem connection parameters if file exists
$onPremParamsFile = Join-Path $ScriptRoot "onprem-connection-parameters.json"
$onPremParams = $null
if (Test-Path $onPremParamsFile) {
 $onPremParams = Get-Content $onPremParamsFile | ConvertFrom-Json
}

# Import VM parameters if file exists
$vmParamsFile = Join-Path $ScriptRoot "vm-parameters.json"
$vmParams = $null
if (Test-Path $vmParamsFile) {
 $vmParams = Get-Content $vmParamsFile | ConvertFrom-Json
}

# Build resource names using naming conventions
function Get-ResourceName {
 param(
 [string]$ResourceType,
 [string]$Suffix = ""
 )

 $prefix = $azParams.naming.$ResourceType.prefix
 $namingSuffix = $azParams.naming.$ResourceType.suffix
 $baseName = $azParams.baseObjectName

 if ($Suffix) {
 return "$prefix$baseName-$Suffix$namingSuffix"
 } else {
 return "$prefix$baseName$namingSuffix"
 }
}

# Extract core parameters
$SubscriptionId = $azParams.subscriptionId
$ResourceGroupName = $azParams.resourceGroupName
$Location = $azParams.location
$VNetName = Get-ResourceName -ResourceType "vnet"
$VNetAddressPrefix = $azParams.vnetAddressPrefix

# Build specific resource names
$VpnGatewayName = Get-ResourceName -ResourceType "vpnGateway"
$VpnPublicIpName = Get-ResourceName -ResourceType "publicIp" -Suffix "gateway"
$BastionName = Get-ResourceName -ResourceType "bastion"
$BastionPublicIpName = Get-ResourceName -ResourceType "publicIp" -Suffix "bastion"

# Storage account name (no hyphens, lowercase only)
$StorageAccountName = ($azParams.naming.storageAccount.prefix + $azParams.baseObjectName + $azParams.naming.storageAccount.suffix).ToLower() -replace '[^a-z0-9]', ''
# Ensure storage account name is between 3-24 characters
if ($StorageAccountName.Length -gt 24) {
 $StorageAccountName = $StorageAccountName.Substring(0, 24)
}

$LogAnalyticsName = Get-ResourceName -ResourceType "logAnalyticsWorkspace"
$NetworkWatcherRG = $azParams.networkWatcherResourceGroup
$NetworkWatcherName = Get-ResourceName -ResourceType "networkWatcher"

# Operational parameters
$TemplateOnly = $opParams.scriptBehavior.templateOnly -or ($Mode -eq "TemplateOnly")
$VerboseOutput = $opParams.scriptBehavior.verboseOutput
$SkipExisting = $opParams.validation.skipExistingResources

Write-Host "`n$('='*80)" -ForegroundColor Cyan
Write-Host "AZURE VNET & VPN INFRASTRUCTURE DEPLOYMENT" -ForegroundColor White
Write-Host "$('='*80)" -ForegroundColor Cyan
Write-Host "`n Deployment Mode: $Mode" -ForegroundColor Yellow
Write-Host " Resource Group: $ResourceGroupName" -ForegroundColor White
Write-Host " Location: $Location" -ForegroundColor White
Write-Host " Base Name: $($azParams.baseObjectName)" -ForegroundColor White
if ($TemplateOnly) {
 Write-Host " Template-Only Mode: No resources will be deployed" -ForegroundColor Cyan
}

# Ensure Azure context is set
try {
 Write-Host "`n Setting Azure subscription context..." -ForegroundColor Cyan
 Set-AzContext -SubscriptionId $SubscriptionId -ErrorAction Stop | Out-Null
 Write-Host " Connected to subscription: $SubscriptionId" -ForegroundColor Green
} catch {
 Write-Host " Failed to set Azure context. Please run Connect-AzAccount first." -ForegroundColor Red
 Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Yellow
 exit 1
}

# Function to validate existing resources
function Test-ExistingResources {
 Write-Host "`n--- Validating Existing Resources ---" -ForegroundColor Yellow

 $validation = @{
 ResourceGroup = $null
 VNet = $null
 Subnets = @{}
 NSGs = @()
 VPNGateway = $null
 Bastion = $null
 StorageAccount = $null
 LogAnalytics = $null
 NetworkWatcher = $null
 }

 # Check Resource Group
 $validation.ResourceGroup = Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction SilentlyContinue
 if ($null -ne $validation.ResourceGroup) {
 Write-Host " Resource Group exists: $ResourceGroupName" -ForegroundColor Green
 } else {
 Write-Host " ℹ Resource Group will be created: $ResourceGroupName" -ForegroundColor Cyan
 }

 # Check Virtual Network
 $validation.VNet = Get-AzVirtualNetwork -Name $VNetName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
 if ($null -ne $validation.VNet) {
 Write-Host " Virtual Network exists: $VNetName" -ForegroundColor Green
 Write-Host " Address Space: $($validation.VNet.AddressSpace.AddressPrefixes -join ', ')" -ForegroundColor Gray

 # Check subnets
 foreach ($subnetKey in $azParams.subnets.PSObject.Properties.Name) {
 $subnetDef = $azParams.subnets.$subnetKey
 $existingSubnet = $validation.VNet.Subnets | Where-Object { $_.Name -eq $subnetDef.name }

 if ($null -ne $existingSubnet) {
 $validation.Subnets[$subnetDef.name] = $existingSubnet
 Write-Host " Subnet exists: $($subnetDef.name) ($($existingSubnet.AddressPrefix))" -ForegroundColor Green
 } else {
 Write-Host " Subnet missing: $($subnetDef.name)" -ForegroundColor Yellow
 }
 }
 } else {
 Write-Host " ℹ Virtual Network will be created: $VNetName" -ForegroundColor Cyan
 }

 # Check Network Security Groups
 foreach ($subnetKey in $azParams.subnets.PSObject.Properties.Name) {
 $subnet = $azParams.subnets.$subnetKey

 # Skip special subnets that don't support NSGs
 if ($subnet.name -eq "GatewaySubnet" -or $subnet.name -eq "AzureBastionSubnet") {
 continue
 }

 $nsgName = Get-ResourceName -ResourceType "nsg" -Suffix $subnetKey
 $existingNSG = Get-AzNetworkSecurityGroup -Name $nsgName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue

 if ($null -ne $existingNSG) {
 $validation.NSGs += $existingNSG
 Write-Host " NSG exists: $nsgName" -ForegroundColor Green
 }
 }

 # Check VPN Gateway
 $validation.VPNGateway = Get-AzVirtualNetworkGateway -Name $VpnGatewayName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
 if ($null -ne $validation.VPNGateway) {
 Write-Host " VPN Gateway exists: $VpnGatewayName" -ForegroundColor Green
 Write-Host " SKU: $($validation.VPNGateway.Sku.Name)" -ForegroundColor Gray
 Write-Host " Type: $($validation.VPNGateway.VpnType)" -ForegroundColor Gray
 } else {
 Write-Host " ℹ VPN Gateway will be created: $VpnGatewayName" -ForegroundColor Cyan
 }

 # Check Azure Bastion
 $validation.Bastion = Get-AzBastion -ResourceGroupName $ResourceGroupName -Name $BastionName -ErrorAction SilentlyContinue
 if ($null -ne $validation.Bastion) {
 Write-Host " Azure Bastion exists: $BastionName" -ForegroundColor Green
 } else {
 if ($azParams.bastion.deploy) {
 Write-Host " ℹ Azure Bastion will be created: $BastionName" -ForegroundColor Cyan
 }
 }

 # Check Storage Account
 $validation.StorageAccount = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $StorageAccountName -ErrorAction SilentlyContinue
 if ($null -ne $validation.StorageAccount) {
 Write-Host " Storage Account exists: $StorageAccountName" -ForegroundColor Green
 } else {
 if ($opParams.flowLogging.createStorageAccount) {
 Write-Host " ℹ Storage Account will be created: $StorageAccountName" -ForegroundColor Cyan
 }
 }

 # Check Log Analytics Workspace
 $validation.LogAnalytics = Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -Name $LogAnalyticsName -ErrorAction SilentlyContinue
 if ($null -ne $validation.LogAnalytics) {
 Write-Host " Log Analytics Workspace exists: $LogAnalyticsName" -ForegroundColor Green
 } else {
 if ($opParams.flowLogging.createLogAnalyticsWorkspace) {
 Write-Host " ℹ Log Analytics Workspace will be created: $LogAnalyticsName" -ForegroundColor Cyan
 }
 }

 # Check Network Watcher (special handling - one per region)
 Write-Host "`n Checking for Network Watcher in region '$Location'..." -ForegroundColor Cyan
 $validation.NetworkWatcher = Get-AzNetworkWatcher -Location $Location -ErrorAction SilentlyContinue

 if ($null -ne $validation.NetworkWatcher) {
 Write-Host " Network Watcher found in region: $($validation.NetworkWatcher.Name)" -ForegroundColor Green
 Write-Host " Resource Group: $($validation.NetworkWatcher.ResourceGroupName)" -ForegroundColor Gray
 Write-Host " Location: $($validation.NetworkWatcher.Location)" -ForegroundColor Gray
 Write-Host " ℹ Will use existing Network Watcher (only one per region allowed)" -ForegroundColor Cyan
 } else {
 Write-Host " ℹ No Network Watcher found in region '$Location'" -ForegroundColor Cyan
 Write-Host " Will create new Network Watcher for this region" -ForegroundColor Cyan
 }

 Write-Host "`n Resource validation complete!" -ForegroundColor Green

 return $validation
}

# Run validation if not in template-only mode
if (-not $TemplateOnly) {
 $ExistingResources = Test-ExistingResources
}

# Function to create or verify resource group
function Ensure-ResourceGroup {
 Write-Host "`n--- Checking Resource Group ---" -ForegroundColor Yellow

 $rg = Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction SilentlyContinue

 if ($null -eq $rg) {
 if ($TemplateOnly) {
 Write-Host " ℹ Resource Group '$ResourceGroupName' will be created during deployment" -ForegroundColor Cyan
 } else {
 Write-Host " Creating Resource Group: $ResourceGroupName" -ForegroundColor White
 try {
 New-AzResourceGroup -Name $ResourceGroupName -Location $Location -ErrorAction Stop | Out-Null
 Write-Host " Resource Group created successfully!" -ForegroundColor Green
 } catch {
 Write-Host " Failed to create Resource Group" -ForegroundColor Red
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 throw
 }
 }
 } else {
 Write-Host " Resource Group '$ResourceGroupName' already exists" -ForegroundColor Green
 }
}

# Function to create virtual network with all subnets
function Deploy-VirtualNetwork {
 Write-Host "`n--- Step 1: Creating Virtual Network with Subnets ---" -ForegroundColor Yellow

 if ($TemplateOnly) {
 Write-Host " Template mode: Skipping actual vNet deployment" -ForegroundColor Cyan
 Write-Host " Planned subnets:" -ForegroundColor Cyan
 foreach ($subnetKey in $azParams.subnets.PSObject.Properties.Name) {
 $subnet = $azParams.subnets.$subnetKey
 Write-Host " • $($subnet.name): $($subnet.addressPrefix)" -ForegroundColor Gray
 }
 return
 }

 # Check if vNet already exists
 $existingVNet = Get-AzVirtualNetwork -Name $VNetName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue

 if ($null -ne $existingVNet) {
 if ($SkipExisting) {
 Write-Host " ℹ Virtual Network '$VNetName' already exists" -ForegroundColor Cyan

 # Check if subnets need to be added
 $existingSubnets = $existingVNet.Subnets | Select-Object -ExpandProperty Name
 $missingSubnets = @()

 foreach ($subnetKey in $azParams.subnets.PSObject.Properties.Name) {
 $subnet = $azParams.subnets.$subnetKey
 if ($subnet.name -notin $existingSubnets) {
 $missingSubnets += $subnet
 }
 }

 if ($missingSubnets.Count -gt 0) {
 Write-Host " Adding missing subnets:" -ForegroundColor Yellow
 foreach ($subnet in $missingSubnets) {
 Write-Host " • $($subnet.name): $($subnet.addressPrefix)" -ForegroundColor White
 Add-AzVirtualNetworkSubnetConfig `
 -Name $subnet.name `
 -VirtualNetwork $existingVNet `
 -AddressPrefix $subnet.addressPrefix `
 -ErrorAction Stop | Out-Null
 }
 $existingVNet | Set-AzVirtualNetwork -ErrorAction Stop | Out-Null
 Write-Host " Missing subnets added successfully!" -ForegroundColor Green

 # Reload vNet to get updated subnet configurations
 $existingVNet = Get-AzVirtualNetwork -Name $VNetName -ResourceGroupName $ResourceGroupName
 } else {
 Write-Host " All subnets already exist" -ForegroundColor Green
 }

 return $existingVNet
 } else {
 Write-Host " Virtual Network '$VNetName' already exists!" -ForegroundColor Red
 throw "Virtual Network already exists"
 }
 }

 Write-Host " Creating Virtual Network: $VNetName" -ForegroundColor White
 Write-Host " Address Space: $VNetAddressPrefix" -ForegroundColor Gray

 try {
 # Create vNet first
 $vnet = New-AzVirtualNetwork `
 -Name $VNetName `
 -ResourceGroupName $ResourceGroupName `
 -Location $Location `
 -AddressPrefix $VNetAddressPrefix `
 -ErrorAction Stop

 Write-Host " Virtual Network created!" -ForegroundColor Green

 # Add all subnets
 Write-Host "`n Creating Subnets:" -ForegroundColor Yellow
 foreach ($subnetKey in $azParams.subnets.PSObject.Properties.Name) {
 $subnet = $azParams.subnets.$subnetKey
 Write-Host " • $($subnet.name): $($subnet.addressPrefix)" -ForegroundColor White

 Add-AzVirtualNetworkSubnetConfig `
 -Name $subnet.name `
 -VirtualNetwork $vnet `
 -AddressPrefix $subnet.addressPrefix `
 -ErrorAction Stop | Out-Null
 }

 # Commit all subnet changes
 $vnet | Set-AzVirtualNetwork -ErrorAction Stop | Out-Null
 Write-Host " All subnets created successfully!" -ForegroundColor Green

 return $vnet
 } catch {
 Write-Host " Failed to create Virtual Network" -ForegroundColor Red
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 throw
 }
}

# Function to create Network Security Groups
function Deploy-NetworkSecurityGroups {
 if (-not $opParams.deployment.deployNSGs) {
 Write-Host "`n ⏭ NSG deployment disabled in operation-parameters.json" -ForegroundColor DarkGray
 return
 }

 Write-Host "`n--- Step 2: Creating Network Security Groups ---" -ForegroundColor Yellow

 if ($TemplateOnly) {
 Write-Host " Template mode: Skipping actual NSG deployment" -ForegroundColor Cyan
 return
 }

 $createdNSGs = @()

 foreach ($subnetKey in $azParams.subnets.PSObject.Properties.Name) {
 $subnet = $azParams.subnets.$subnetKey

 # Skip GatewaySubnet only (VPN Gateway doesn't support NSGs)
 if ($subnet.name -eq "GatewaySubnet") {
 Write-Host " ⏭ Skipping NSG for $($subnet.name) (not supported)" -ForegroundColor DarkGray
 continue
 }

 $nsgName = Get-ResourceName -ResourceType "nsg" -Suffix $subnetKey

 # Check if NSG exists
 $existingNSG = Get-AzNetworkSecurityGroup -Name $nsgName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue

 if ($null -ne $existingNSG) {
 Write-Host " ℹ NSG '$nsgName' already exists - skipping" -ForegroundColor Cyan
 $createdNSGs += $existingNSG
 continue
 }

 Write-Host " Creating NSG: $nsgName" -ForegroundColor White

 try {
 # Create baseline security rules
 $rules = @()

 # Allow traffic from on-premises gateway IP if configured
 if ($null -ne $onPremParams -and $onPremParams.localNetworkGateway.gatewayIpAddress -notlike "*YOUR-ONPREM-PUBLIC-IP*") {
 $onPremIp = $onPremParams.localNetworkGateway.gatewayIpAddress
 Write-Host " Adding rule: Allow from on-prem IP ($onPremIp)" -ForegroundColor Gray

 $rules += New-AzNetworkSecurityRuleConfig `
 -Name "AllowOnPremisesGateway" `
 -Priority 100 `
 -Direction Inbound `
 -Access Allow `
 -Protocol * `
 -SourceAddressPrefix $onPremIp `
 -SourcePortRange * `
 -DestinationAddressPrefix * `
 -DestinationPortRange * `
 -ErrorAction Stop
 }

 # Allow traffic from on-premises networks if configured
 if ($null -ne $onPremParams -and $onPremParams.localNetworkGateway.addressSpace.Count -gt 0) {
 Write-Host " Adding rule: Allow from on-prem networks" -ForegroundColor Gray

 $rules += New-AzNetworkSecurityRuleConfig `
 -Name "AllowOnPremisesNetworks" `
 -Priority 110 `
 -Direction Inbound `
 -Access Allow `
 -Protocol * `
 -SourceAddressPrefix $onPremParams.localNetworkGateway.addressSpace `
 -SourcePortRange * `
 -DestinationAddressPrefix * `
 -DestinationPortRange * `
 -ErrorAction Stop
 }

 # Allow Azure services if configured
 if ($opParams.networkSecurity.allowAzureServices) {
 $rules += New-AzNetworkSecurityRuleConfig `
 -Name "AllowAzureServices" `
 -Priority 120 `
 -Direction Inbound `
 -Access Allow `
 -Protocol * `
 -SourceAddressPrefix AzureCloud `
 -SourcePortRange * `
 -DestinationAddressPrefix * `
 -DestinationPortRange * `
 -ErrorAction Stop
 }

 # Deny internet by default if configured
 if ($opParams.networkSecurity.denyInternetByDefault) {
 $rules += New-AzNetworkSecurityRuleConfig `
 -Name "DenyInternetOutbound" `
 -Priority 4000 `
 -Direction Outbound `
 -Access Deny `
 -Protocol * `
 -SourceAddressPrefix * `
 -SourcePortRange * `
 -DestinationAddressPrefix Internet `
 -DestinationPortRange * `
 -ErrorAction Stop
 }

 # Create NSG
 $nsg = New-AzNetworkSecurityGroup `
 -Name $nsgName `
 -ResourceGroupName $ResourceGroupName `
 -Location $Location `
 -SecurityRules $rules `
 -ErrorAction Stop

 Write-Host " NSG '$nsgName' created!" -ForegroundColor Green
 $createdNSGs += $nsg

 # Associate NSG with subnet
 $vnet = Get-AzVirtualNetwork -Name $VNetName -ResourceGroupName $ResourceGroupName
 $subnetConfig = Get-AzVirtualNetworkSubnetConfig -Name $subnet.name -VirtualNetwork $vnet
 $subnetConfig.NetworkSecurityGroup = $nsg
 $vnet | Set-AzVirtualNetwork -ErrorAction Stop | Out-Null

 Write-Host " NSG associated with subnet '$($subnet.name)'" -ForegroundColor Green

 } catch {
 Write-Host " Failed to create NSG '$nsgName'" -ForegroundColor Red
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 }
 }

 return $createdNSGs
}

# Function to create Storage Account for Flow Logs
function Deploy-StorageAccount {
 if (-not $opParams.flowLogging.createStorageAccount) {
 Write-Host "`n ⏭ Storage Account creation disabled" -ForegroundColor DarkGray
 return $null
 }

 Write-Host "`n--- Step 3: Creating Storage Account for Flow Logs ---" -ForegroundColor Yellow

 if ($TemplateOnly) {
 Write-Host " Template mode: Skipping actual Storage Account deployment" -ForegroundColor Cyan
 return $null
 }

 # Check if storage account exists in the resource group
 $existingSA = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $StorageAccountName -ErrorAction SilentlyContinue

 if ($null -ne $existingSA) {
 Write-Host " ℹ Storage Account '$StorageAccountName' already exists - skipping" -ForegroundColor Cyan
 return $existingSA
 }

 # Try to create storage account with incremental suffix if name is taken globally
 $baseName = $StorageAccountName
 $attemptNumber = 0
 $maxAttempts = 100
 $createdAccount = $null

 while ($attemptNumber -lt $maxAttempts -and $null -eq $createdAccount) {
 $currentName = $baseName

 if ($attemptNumber -gt 0) {
 $suffix = "{0:D2}" -f $attemptNumber
 # Ensure storage account name doesn't exceed 24 characters with suffix
 if (($baseName.Length + 2) -gt 24) {
 $currentName = $baseName.Substring(0, 22) + $suffix
 } else {
 $currentName = $baseName + $suffix
 }
 }

 Write-Host " Creating Storage Account: $currentName" -ForegroundColor White

 try {
 $sa = New-AzStorageAccount `
 -ResourceGroupName $ResourceGroupName `
 -Name $currentName `
 -Location $Location `
 -SkuName Standard_LRS `
 -Kind StorageV2 `
 -ErrorAction Stop

 Write-Host " Storage Account created successfully!" -ForegroundColor Green
 $createdAccount = $sa

 } catch {
 # Check if error is due to name already taken globally
 if ($_.Exception.Message -like "*AlreadyExists*" -or $_.Exception.Message -like "*already taken*" -or $_.Exception.Message -like "*not available*") {
 $attemptNumber++
 if ($attemptNumber -lt $maxAttempts) {
 Write-Host " Storage Account name '$currentName' is already taken globally" -ForegroundColor Yellow
 Write-Host " Trying with suffix: $("{0:D2}" -f $attemptNumber)" -ForegroundColor Cyan
 } else {
 Write-Host " Failed to create Storage Account after $maxAttempts attempts" -ForegroundColor Red
 throw "Unable to find available storage account name after $maxAttempts attempts"
 }
 } else {
 # Different error - fail immediately
 Write-Host " Failed to create Storage Account" -ForegroundColor Red
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 throw
 }
 }
 }

 return $createdAccount
}

# Function to create Log Analytics Workspace
function Deploy-LogAnalyticsWorkspace {
 if (-not $opParams.flowLogging.createLogAnalyticsWorkspace) {
 Write-Host "`n ⏭ Log Analytics Workspace creation disabled" -ForegroundColor DarkGray
 return $null
 }

 Write-Host "`n--- Step 4: Creating Log Analytics Workspace ---" -ForegroundColor Yellow

 if ($TemplateOnly) {
 Write-Host " Template mode: Skipping actual Log Analytics deployment" -ForegroundColor Cyan
 return $null
 }

 # Check if workspace exists
 $existingLAW = Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -Name $LogAnalyticsName -ErrorAction SilentlyContinue

 if ($null -ne $existingLAW) {
 Write-Host " ℹ Log Analytics Workspace '$LogAnalyticsName' already exists - skipping" -ForegroundColor Cyan
 return $existingLAW
 }

 Write-Host " Creating Log Analytics Workspace: $LogAnalyticsName" -ForegroundColor White

 try {
 $law = New-AzOperationalInsightsWorkspace `
 -ResourceGroupName $ResourceGroupName `
 -Name $LogAnalyticsName `
 -Location $Location `
 -Sku PerGB2018 `
 -ErrorAction Stop

 Write-Host " Log Analytics Workspace created successfully!" -ForegroundColor Green
 return $law
 } catch {
 Write-Host " Failed to create Log Analytics Workspace" -ForegroundColor Red
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 throw
 }
}

# Function to ensure Network Watcher exists
function Ensure-NetworkWatcher {
 Write-Host "`n--- Ensuring Network Watcher ---" -ForegroundColor Yellow

 if ($TemplateOnly) {
 Write-Host " Template mode: Skipping Network Watcher check" -ForegroundColor Cyan
 return $null
 }

 try {
 # IMPORTANT: Only one Network Watcher is allowed per region per subscription
 # First, check if one already exists in this region
 $nw = Get-AzNetworkWatcher -Location $Location -ErrorAction SilentlyContinue

 if ($null -ne $nw) {
 Write-Host " Using existing Network Watcher in region '$Location'" -ForegroundColor Green
 Write-Host " Name: $($nw.Name)" -ForegroundColor Gray
 Write-Host " Resource Group: $($nw.ResourceGroupName)" -ForegroundColor Gray
 Write-Host " ℹ Note: Only one Network Watcher per region is allowed" -ForegroundColor Cyan
 return $nw
 }

 # No Network Watcher found - create a new one
 Write-Host " ℹ No Network Watcher found in region '$Location'" -ForegroundColor Cyan
 Write-Host " Creating new Network Watcher for region: $Location" -ForegroundColor White

 # Determine target resource group
 # If "USE_MAIN_RG", use the main resource group; otherwise use specified RG
 if ($NetworkWatcherRG -eq "USE_MAIN_RG") {
 $targetRG = $ResourceGroupName
 Write-Host " ℹ Network Watcher will be created in main resource group: $targetRG" -ForegroundColor Cyan
 } else {
 $targetRG = $NetworkWatcherRG
 Write-Host " ℹ Network Watcher will be created in: $targetRG" -ForegroundColor Cyan

 # Ensure target resource group exists
 $nwRG = Get-AzResourceGroup -Name $targetRG -ErrorAction SilentlyContinue
 if ($null -eq $nwRG) {
 Write-Host " Creating Resource Group for Network Watcher: $targetRG" -ForegroundColor White
 New-AzResourceGroup -Name $targetRG -Location $Location -ErrorAction Stop | Out-Null
 Write-Host " Resource Group created: $targetRG" -ForegroundColor Green
 }
 }

 # Generate a unique name for Network Watcher (typically NetworkWatcher_<region>)
 # Azure's default format is NetworkWatcher_<region>
 $nwName = "NetworkWatcher_$Location"

 Write-Host " Creating Network Watcher: $nwName" -ForegroundColor White

 $nw = New-AzNetworkWatcher `
 -Name $nwName `
 -ResourceGroupName $targetRG `
 -Location $Location `
 -ErrorAction Stop

 Write-Host " Network Watcher created successfully!" -ForegroundColor Green
 Write-Host " Name: $($nw.Name)" -ForegroundColor Gray
 Write-Host " Resource Group: $($nw.ResourceGroupName)" -ForegroundColor Gray

 return $nw
 } catch {
 Write-Host " Network Watcher operation failed" -ForegroundColor Yellow
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 Write-Host " ℹ Flow Logs may not be available without Network Watcher" -ForegroundColor Cyan
 return $null
 }
}

# NOTE: NSG Flow Logs are deprecated as of 2024
# VNet Flow Logs replace NSG Flow Logs and provide comprehensive network-wide visibility
# The Deploy-NSGFlowLogs function has been removed

# Function to configure VNet Flow Logs (supports both vNet-level and subnet-level)
function Deploy-VNetFlowLogs {
 param($StorageAccount, $LogAnalytics, $NetworkWatcher)

 if (-not $opParams.flowLogging.enableVNetFlowLogs) {
 Write-Host "`n ⏭ VNet Flow Logs disabled" -ForegroundColor DarkGray
 return
 }

 Write-Host "`n--- Step 5: Configuring VNet Flow Logs ---" -ForegroundColor Yellow
 Write-Host " ℹ VNet Flow Logs replace deprecated NSG Flow Logs (as of 2024)" -ForegroundColor Cyan
 Write-Host " Supports vNet-level (default) and subnet-level (override) configuration" -ForegroundColor Cyan
 Write-Host " Hierarchy: NIC > Subnet > VNet (most specific wins)" -ForegroundColor Cyan

 if ($TemplateOnly) {
 Write-Host " Template mode: Skipping actual VNet Flow Log deployment" -ForegroundColor Cyan
 return
 }

 if ($null -eq $NetworkWatcher) {
 Write-Host " Network Watcher not available - skipping VNet Flow Logs" -ForegroundColor Yellow
 return
 }

 # Get vNet for subnet lookups
 $vnet = Get-AzVirtualNetwork -Name $VNetName -ResourceGroupName $ResourceGroupName

 # Deploy vNet-level flow log (if enabled)
 if ($azParams.flowLogging.vnetLevel.enabled) {
 Write-Host "`n Configuring vNet-Level Flow Log" -ForegroundColor White
 Write-Host " Target: $VNetName (all subnets by default)" -ForegroundColor Gray
 Write-Host " Retention: $($azParams.flowLogging.vnetLevel.retentionDays) days" -ForegroundColor Gray

 try {
 $flowLogConfig = @{
 TargetResourceId = $vnet.Id
 StorageId = $StorageAccount.Id
 Enabled = $true
 RetentionPolicyDays = $azParams.flowLogging.vnetLevel.retentionDays
 }

 if ($opParams.flowLogging.enableTrafficAnalytics -and $null -ne $LogAnalytics) {
 $flowLogConfig.EnableTrafficAnalytics = $true
 $flowLogConfig.TrafficAnalyticsWorkspaceId = $LogAnalytics.ResourceId
 $flowLogConfig.TrafficAnalyticsInterval = $azParams.flowLogging.trafficAnalyticsInterval
 }

 Set-AzNetworkWatcherFlowLog `
 -NetworkWatcher $NetworkWatcher `
 -Name "FlowLog-$VNetName" `
 @flowLogConfig `
 -ErrorAction Stop | Out-Null

 Write-Host " VNet-level Flow Log configured!" -ForegroundColor Green

 } catch {
 if ($_.Exception.Message -like "*CannotCreateMoreThanOneFlowLogPerTargetResource*") {
 Write-Host " ℹ VNet-level Flow Log already exists - skipping" -ForegroundColor Cyan
 } else {
 Write-Host " Failed to configure vNet-level Flow Log" -ForegroundColor Yellow
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor DarkGray
 }
 }
 } else {
 Write-Host "`n ⏭ VNet-level Flow Log disabled" -ForegroundColor DarkGray
 }

 # Deploy subnet-level flow logs (if any enabled)
 Write-Host "`n Checking Subnet-Level Flow Log Configurations" -ForegroundColor White

 $subnetFlowLogsDeployed = 0

 foreach ($subnetKey in $azParams.subnets.PSObject.Properties.Name) {
 $subnetDef = $azParams.subnets.$subnetKey
 $subnetFlowConfig = $azParams.flowLogging.subnetLevel.$subnetKey

 if ($null -eq $subnetFlowConfig -or -not $subnetFlowConfig.enabled) {
 Write-Host " ⏭ $($subnetDef.name): Subnet-level disabled (uses vNet-level if enabled)" -ForegroundColor DarkGray
 continue
 }

 # Get subnet resource
 $subnet = Get-AzVirtualNetworkSubnetConfig -Name $subnetDef.name -VirtualNetwork $vnet -ErrorAction SilentlyContinue

 if ($null -eq $subnet) {
 Write-Host " $($subnetDef.name): Subnet not found, skipping" -ForegroundColor Yellow
 continue
 }

 Write-Host "`n Configuring Subnet-Level Flow Log" -ForegroundColor Cyan
 Write-Host " Subnet: $($subnetDef.name)" -ForegroundColor Gray
 Write-Host " Retention: $($subnetFlowConfig.retentionDays) days (overrides vNet-level)" -ForegroundColor Gray

 try {
 $flowLogConfig = @{
 TargetResourceId = $subnet.Id
 StorageId = $StorageAccount.Id
 Enabled = $true
 RetentionPolicyDays = $subnetFlowConfig.retentionDays
 }

 if ($opParams.flowLogging.enableTrafficAnalytics -and $null -ne $LogAnalytics) {
 $flowLogConfig.EnableTrafficAnalytics = $true
 $flowLogConfig.TrafficAnalyticsWorkspaceId = $LogAnalytics.ResourceId
 $flowLogConfig.TrafficAnalyticsInterval = $azParams.flowLogging.trafficAnalyticsInterval
 }

 $flowLogName = "FlowLog-$VNetName-$($subnetDef.name)"

 Set-AzNetworkWatcherFlowLog `
 -NetworkWatcher $NetworkWatcher `
 -Name $flowLogName `
 @flowLogConfig `
 -ErrorAction Stop | Out-Null

 Write-Host " Subnet-level Flow Log configured!" -ForegroundColor Green
 $subnetFlowLogsDeployed++

 } catch {
 if ($_.Exception.Message -like "*CannotCreateMoreThanOneFlowLogPerTargetResource*") {
 Write-Host " ℹ Subnet-level Flow Log already exists - skipping" -ForegroundColor Cyan
 } else {
 Write-Host " Failed to configure subnet-level Flow Log" -ForegroundColor Yellow
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor DarkGray
 }
 }
 }

 # Summary
 Write-Host "`n Flow Logs Deployment Summary:" -ForegroundColor Cyan
 if ($azParams.flowLogging.vnetLevel.enabled) {
 Write-Host " VNet-level: Enabled (default for all subnets)" -ForegroundColor Green
 }
 if ($subnetFlowLogsDeployed -gt 0) {
 Write-Host " Subnet-level: $subnetFlowLogsDeployed overrides configured" -ForegroundColor Green
 Write-Host " ℹ Subnet-level overrides vNet-level for specific subnets" -ForegroundColor Cyan
 }
 Write-Host " VNet Flow Logs configuration complete!" -ForegroundColor Green
}

# Function to create VPN Gateway Public IP
function Deploy-VPNPublicIP {
 Write-Host "`n--- Step 6: Creating Public IP for VPN Gateway ---" -ForegroundColor Yellow

 if ($TemplateOnly) {
 Write-Host " Template mode: Skipping actual Public IP deployment" -ForegroundColor Cyan
 return $null
 }

 $existingPip = Get-AzPublicIpAddress -Name $VpnPublicIpName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue

 if ($null -ne $existingPip) {
 if ($SkipExisting) {
 Write-Host " ℹ Public IP '$VpnPublicIpName' already exists - skipping" -ForegroundColor Cyan
 return $existingPip
 } else {
 Write-Host " Public IP '$VpnPublicIpName' already exists!" -ForegroundColor Red
 throw "Public IP already exists"
 }
 }

 Write-Host " Creating Public IP: $VpnPublicIpName" -ForegroundColor White

 try {
 $pip = New-AzPublicIpAddress `
 -Name $VpnPublicIpName `
 -ResourceGroupName $ResourceGroupName `
 -Location $Location `
 -AllocationMethod Static `
 -Sku Standard `
 -Zone 1,2,3 `
 -ErrorAction Stop

 Write-Host " Public IP created successfully!" -ForegroundColor Green
 return $pip
 } catch {
 Write-Host " Failed to create Public IP" -ForegroundColor Red
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 throw
 }
}

# Function to create VPN Gateway
function Deploy-VPNGateway {
 Write-Host "`n--- Step 7: Creating VPN Gateway ---" -ForegroundColor Yellow

 if ($TemplateOnly) {
 Write-Host " Template mode: Skipping actual VPN Gateway deployment" -ForegroundColor Cyan
 return $null
 }

 $existingGw = Get-AzVirtualNetworkGateway -Name $VpnGatewayName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue

 if ($null -ne $existingGw) {
 if ($SkipExisting) {
 Write-Host " ℹ VPN Gateway '$VpnGatewayName' already exists - skipping" -ForegroundColor Cyan
 return $existingGw
 } else {
 Write-Host " VPN Gateway '$VpnGatewayName' already exists!" -ForegroundColor Red
 throw "VPN Gateway already exists"
 }
 }

 Write-Host " Creating VPN Gateway: $VpnGatewayName" -ForegroundColor White
 Write-Host " SKU: $($azParams.vpnGateway.sku)" -ForegroundColor Gray
 Write-Host " Type: $($azParams.vpnGateway.type)" -ForegroundColor Gray
 Write-Host " ⏳ This will take 30-45 minutes..." -ForegroundColor Yellow

 try {
 $vnet = Get-AzVirtualNetwork -Name $VNetName -ResourceGroupName $ResourceGroupName
 $subnet = Get-AzVirtualNetworkSubnetConfig -Name "GatewaySubnet" -VirtualNetwork $vnet
 $pip = Get-AzPublicIpAddress -Name $VpnPublicIpName -ResourceGroupName $ResourceGroupName

 $ipConfig = New-AzVirtualNetworkGatewayIpConfig `
 -Name "gwipconfig" `
 -Subnet $subnet `
 -PublicIpAddress $pip

 Write-Host "`n Starting VPN Gateway deployment..." -ForegroundColor Cyan
 Write-Host " ⏰ Start time: $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Gray

 $gateway = New-AzVirtualNetworkGateway `
 -Name $VpnGatewayName `
 -ResourceGroupName $ResourceGroupName `
 -Location $Location `
 -IpConfigurations $ipConfig `
 -GatewayType Vpn `
 -VpnType $azParams.vpnGateway.type `
 -GatewaySku $azParams.vpnGateway.sku `
 -ErrorAction Stop

 Write-Host "`n ⏰ End time: $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Gray
 Write-Host " VPN Gateway created successfully!" -ForegroundColor Green

 return $gateway
 } catch {
 Write-Host " Failed to create VPN Gateway" -ForegroundColor Red
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 throw
 }
}

# Function to create Azure Bastion
function Deploy-Bastion {
 if (-not $azParams.bastion.deploy) {
 Write-Host "`n ⏭ Bastion deployment disabled in azure-parameters.json" -ForegroundColor DarkGray
 return $null
 }

 Write-Host "`n--- Step 8: Creating Azure Bastion ---" -ForegroundColor Yellow

 if ($TemplateOnly) {
 Write-Host " Template mode: Skipping actual Bastion deployment" -ForegroundColor Cyan
 return $null
 }

 # Check if Bastion exists
 $existingBastion = Get-AzBastion -ResourceGroupName $ResourceGroupName -Name $BastionName -ErrorAction SilentlyContinue

 if ($null -ne $existingBastion) {
 if ($SkipExisting) {
 Write-Host " ℹ Bastion '$BastionName' already exists - skipping" -ForegroundColor Cyan
 return $existingBastion
 } else {
 Write-Host " Bastion '$BastionName' already exists!" -ForegroundColor Red
 throw "Bastion already exists"
 }
 }

 Write-Host " Creating Bastion Public IP: $BastionPublicIpName" -ForegroundColor White

 try {
 # Create Public IP for Bastion
 $bastionPip = New-AzPublicIpAddress `
 -Name $BastionPublicIpName `
 -ResourceGroupName $ResourceGroupName `
 -Location $Location `
 -AllocationMethod Static `
 -Sku Standard `
 -ErrorAction Stop

 Write-Host " Bastion Public IP created!" -ForegroundColor Green

 # Get VNet and Bastion subnet
 $vnet = Get-AzVirtualNetwork -Name $VNetName -ResourceGroupName $ResourceGroupName

 Write-Host " Creating Azure Bastion: $BastionName" -ForegroundColor White
 Write-Host " ⏳ This will take 10-15 minutes..." -ForegroundColor Yellow

 $bastion = New-AzBastion `
 -ResourceGroupName $ResourceGroupName `
 -Name $BastionName `
 -PublicIpAddress $bastionPip `
 -VirtualNetwork $vnet `
 -Sku $azParams.bastion.sku `
 -ErrorAction Stop

 Write-Host " Azure Bastion created successfully!" -ForegroundColor Green
 return $bastion

 } catch {
 Write-Host " Failed to create Azure Bastion" -ForegroundColor Red
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 throw
 }
}

# Function to create Local Network Gateway for on-premises connection
function Deploy-LocalNetworkGateway {
 if ($null -eq $onPremParams) {
 Write-Host "`n ℹ No on-premises connection configuration found - skipping Local Network Gateway" -ForegroundColor Cyan
 return $null
 }

 Write-Host "`n--- Step 8: Creating Local Network Gateway (On-Premises) ---" -ForegroundColor Yellow

 if ($TemplateOnly) {
 Write-Host " Template mode: Skipping actual Local Network Gateway deployment" -ForegroundColor Cyan
 return $null
 }

 $lngName = $onPremParams.localNetworkGateway.name

 # Check if Local Network Gateway exists
 $existingLng = Get-AzLocalNetworkGateway -Name $lngName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue

 if ($null -ne $existingLng) {
 if ($SkipExisting) {
 Write-Host " ℹ Local Network Gateway '$lngName' already exists - skipping" -ForegroundColor Cyan
 return $existingLng
 } else {
 Write-Host " Local Network Gateway '$lngName' already exists!" -ForegroundColor Red
 throw "Local Network Gateway already exists"
 }
 }

 # Validate configuration
 if ($onPremParams.localNetworkGateway.gatewayIpAddress -like "*YOUR-ONPREM-PUBLIC-IP*") {
 Write-Host " WARNING: On-premises public IP not configured in onprem-connection-parameters.json" -ForegroundColor Yellow
 Write-Host " Please update 'gatewayIpAddress' before creating connection" -ForegroundColor Yellow
 return $null
 }

 Write-Host " Creating Local Network Gateway: $lngName" -ForegroundColor White
 Write-Host " On-Prem Public IP: $($onPremParams.localNetworkGateway.gatewayIpAddress)" -ForegroundColor Gray
 Write-Host " On-Prem Networks: $($onPremParams.localNetworkGateway.addressSpace -join ', ')" -ForegroundColor Gray

 try {
 $lng = New-AzLocalNetworkGateway `
 -Name $lngName `
 -ResourceGroupName $ResourceGroupName `
 -Location $Location `
 -GatewayIpAddress $onPremParams.localNetworkGateway.gatewayIpAddress `
 -AddressPrefix $onPremParams.localNetworkGateway.addressSpace `
 -ErrorAction Stop

 Write-Host " Local Network Gateway created successfully!" -ForegroundColor Green
 return $lng

 } catch {
 Write-Host " Failed to create Local Network Gateway" -ForegroundColor Red
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 throw
 }
}

# Function to create VPN Connection between Azure and On-Premises
function Deploy-VPNConnection {
 param($VpnGateway, $LocalNetworkGateway)

 if ($null -eq $onPremParams) {
 Write-Host "`n ℹ No on-premises connection configuration found - skipping VPN Connection" -ForegroundColor Cyan
 return $null
 }

 if ($null -eq $VpnGateway) {
 Write-Host "`n VPN Gateway not available - cannot create connection" -ForegroundColor Yellow
 return $null
 }

 if ($null -eq $LocalNetworkGateway) {
 Write-Host "`n Local Network Gateway not available - cannot create connection" -ForegroundColor Yellow
 return $null
 }

 Write-Host "`n--- Step 9: Creating VPN Connection (Azure to On-Premises) ---" -ForegroundColor Yellow

 if ($TemplateOnly) {
 Write-Host " Template mode: Skipping actual VPN Connection deployment" -ForegroundColor Cyan
 return $null
 }

 $connName = $onPremParams.vpnConnection.name

 # Check if connection exists
 $existingConn = Get-AzVirtualNetworkGatewayConnection -Name $connName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue

 if ($null -ne $existingConn) {
 if ($SkipExisting) {
 Write-Host " ℹ VPN Connection '$connName' already exists - skipping" -ForegroundColor Cyan
 return $existingConn
 } else {
 Write-Host " VPN Connection '$connName' already exists!" -ForegroundColor Red
 throw "VPN Connection already exists"
 }
 }

 # Validate shared key
 if ($onPremParams.vpnConnection.sharedKey -like "*YOUR-SHARED-KEY-HERE*") {
 Write-Host " WARNING: Shared key not configured in onprem-connection-parameters.json" -ForegroundColor Yellow
 Write-Host " Please update 'sharedKey' before creating connection" -ForegroundColor Yellow
 return $null
 }

 Write-Host " Creating VPN Connection: $connName" -ForegroundColor White
 Write-Host " Type: $($onPremParams.vpnConnection.connectionType)" -ForegroundColor Gray
 Write-Host " BGP Enabled: $($onPremParams.vpnConnection.enableBgp)" -ForegroundColor Gray

 try {
 $connectionParams = @{
 Name = $connName
 ResourceGroupName = $ResourceGroupName
 Location = $Location
 VirtualNetworkGateway1 = $VpnGateway
 LocalNetworkGateway2 = $LocalNetworkGateway
 ConnectionType = $onPremParams.vpnConnection.connectionType
 SharedKey = $onPremParams.vpnConnection.sharedKey
 EnableBgp = $onPremParams.vpnConnection.enableBgp
 UsePolicyBasedTrafficSelectors = $onPremParams.vpnConnection.usePolicyBasedTrafficSelectors
 ErrorAction = "Stop"
 }

 # Add custom IPsec policies if enabled
 if ($onPremParams.vpnConnection.ipsecPolicies.enabled) {
 Write-Host " Custom IPsec Policy: Enabled" -ForegroundColor Gray

 $ipsecPolicy = New-AzIpsecPolicy `
 -SALifeTimeSeconds $onPremParams.vpnConnection.ipsecPolicies.saLifeTimeSeconds `
 -SADataSizeKilobytes $onPremParams.vpnConnection.ipsecPolicies.saDataSizeKilobytes `
 -IpsecEncryption $onPremParams.vpnConnection.ipsecPolicies.ipsecEncryption `
 -IpsecIntegrity $onPremParams.vpnConnection.ipsecPolicies.ipsecIntegrity `
 -IkeEncryption $onPremParams.vpnConnection.ipsecPolicies.ikeEncryption `
 -IkeIntegrity $onPremParams.vpnConnection.ipsecPolicies.ikeIntegrity `
 -DhGroup $onPremParams.vpnConnection.ipsecPolicies.dhGroup `
 -PfsGroup $onPremParams.vpnConnection.ipsecPolicies.pfsGroup

 $connectionParams.IpsecPolicies = $ipsecPolicy
 }

 $conn = New-AzVirtualNetworkGatewayConnection @connectionParams

 Write-Host " VPN Connection created successfully!" -ForegroundColor Green

 # Get the Azure VPN Gateway Public IP
 $azureGatewayIp = $null
 try {
 $pip = Get-AzPublicIpAddress -Name $VpnPublicIpName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
 if ($null -ne $pip -and $null -ne $pip.IpAddress) {
 $azureGatewayIp = $pip.IpAddress
 }
 } catch { }

 # Display pfSense configuration instructions
 Write-Host "`n$('='*80)" -ForegroundColor Green
 Write-Host "PFSENSE FIREWALL CONFIGURATION" -ForegroundColor Green
 Write-Host "$('='*80)" -ForegroundColor Green

 Write-Host "`n Configure your pfSense firewall with these settings:" -ForegroundColor Yellow
 Write-Host ""

 Write-Host " 1⃣ Navigate to: VPN > IPsec > Tunnels > Add P1" -ForegroundColor White
 Write-Host ""

 Write-Host " Phase 1 (IKE) Settings:" -ForegroundColor Cyan
 Write-Host " Remote Gateway: " -NoNewline -ForegroundColor Gray
 if ($null -ne $azureGatewayIp) {
 Write-Host "$azureGatewayIp" -ForegroundColor Yellow
 } else {
 Write-Host "<AZURE-VPN-GATEWAY-IP>" -ForegroundColor Red
 }
 Write-Host " Description: Azure VPN Gateway" -ForegroundColor Gray
 Write-Host " Authentication Method: Mutual PSK" -ForegroundColor Gray
 Write-Host " My Identifier: My IP address" -ForegroundColor Gray
 Write-Host " Peer Identifier: Peer IP address" -ForegroundColor Gray
 Write-Host " Pre-Shared Key: " -NoNewline -ForegroundColor Gray
 Write-Host "<USE-THE-SAME-KEY-FROM-PARAMETERS-FILE>" -ForegroundColor Yellow

 if ($onPremParams.vpnConnection.ipsecPolicies.enabled) {
 Write-Host "`n Encryption Algorithm: $($onPremParams.vpnConnection.ipsecPolicies.ikeEncryption)" -ForegroundColor Gray
 Write-Host " Hash Algorithm: $($onPremParams.vpnConnection.ipsecPolicies.ikeIntegrity)" -ForegroundColor Gray
 Write-Host " DH Group: $($onPremParams.vpnConnection.ipsecPolicies.dhGroup)" -ForegroundColor Gray
 } else {
 Write-Host "`n Encryption Algorithm: AES 256" -ForegroundColor Gray
 Write-Host " Hash Algorithm: SHA256" -ForegroundColor Gray
 Write-Host " DH Group: 2 (1024 bit)" -ForegroundColor Gray
 }
 Write-Host " Lifetime: 28800 seconds" -ForegroundColor Gray
 Write-Host ""

 Write-Host " 2⃣ Add Phase 2 (IPsec) Entry:" -ForegroundColor White
 Write-Host ""
 Write-Host " Phase 2 Settings:" -ForegroundColor Cyan
 Write-Host " Mode: Tunnel IPv4" -ForegroundColor Gray
 Write-Host " Local Network: " -NoNewline -ForegroundColor Gray
 Write-Host "$($onPremParams.localNetworkGateway.addressSpace -join ', ')" -ForegroundColor Yellow
 Write-Host " Remote Network: " -NoNewline -ForegroundColor Gray
 Write-Host "$VNetAddressPrefix" -ForegroundColor Yellow
 Write-Host " Protocol: ESP" -ForegroundColor Gray

 if ($onPremParams.vpnConnection.ipsecPolicies.enabled) {
 Write-Host " Encryption Algorithm: $($onPremParams.vpnConnection.ipsecPolicies.ipsecEncryption)" -ForegroundColor Gray
 Write-Host " Hash Algorithm: $($onPremParams.vpnConnection.ipsecPolicies.ipsecIntegrity)" -ForegroundColor Gray
 Write-Host " PFS Key Group: $($onPremParams.vpnConnection.ipsecPolicies.pfsGroup)" -ForegroundColor Gray
 } else {
 Write-Host " Encryption Algorithm: AES 256" -ForegroundColor Gray
 Write-Host " Hash Algorithm: SHA256" -ForegroundColor Gray
 Write-Host " PFS Key Group: 2 (1024 bit)" -ForegroundColor Gray
 }
 Write-Host " Lifetime: 27000 seconds" -ForegroundColor Gray
 Write-Host ""

 Write-Host " 3⃣ Create Firewall Rules:" -ForegroundColor White
 Write-Host ""
 Write-Host " Navigate to: Firewall > Rules > IPsec" -ForegroundColor Gray
 Write-Host " Add rule: Allow traffic from Azure vNet ($VNetAddressPrefix) to your on-prem networks" -ForegroundColor Gray
 Write-Host ""

 Write-Host " 4⃣ Apply and Connect:" -ForegroundColor White
 Write-Host ""
 Write-Host " • Save all settings" -ForegroundColor Gray
 Write-Host " • Navigate to: Status > IPsec > Connect" -ForegroundColor Gray
 Write-Host " • Connection should establish automatically" -ForegroundColor Gray
 Write-Host ""

 Write-Host "$('='*80)" -ForegroundColor Green

 if ($null -ne $azureGatewayIp) {
 Write-Host "`n Azure VPN Gateway Public IP: $azureGatewayIp" -ForegroundColor Green
 } else {
 Write-Host "`n Azure VPN Gateway Public IP not yet available - check Azure Portal" -ForegroundColor Yellow
 }
 Write-Host ""

 return $conn

 } catch {
 Write-Host " Failed to create VPN Connection" -ForegroundColor Red
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 throw
 }
}

# Function to deploy test VMs in subnets
function Deploy-TestVMs {
 if ($null -eq $vmParams -or -not $vmParams.vmConfiguration.deployVMs) {
 Write-Host "`n ℹ VM deployment disabled or no VM configuration found" -ForegroundColor Cyan
 return
 }

 Write-Host "`n--- Step 10: Deploying Test VMs (Flow Log Generation) ---" -ForegroundColor Yellow

 if ($TemplateOnly) {
 Write-Host " Template mode: Skipping actual VM deployment" -ForegroundColor Cyan
 return
 }

 # Get or prompt for admin password
 $adminPassword = $null
 if ($vmParams.vmConfiguration.authenticationType -eq "password") {
 Write-Host "`n VM Admin Credentials Required" -ForegroundColor Yellow
 Write-Host " Username: $($vmParams.vmConfiguration.adminUsername)" -ForegroundColor Gray
 $securePassword = Read-Host " Enter Password for VMs" -AsSecureString
 $adminPassword = $securePassword
 }

 $deployedVMs = @()
 $vmIpAddresses = @()

 foreach ($subnetKey in @("bastion", "security", "o11y")) {
 $vmConfig = $vmParams.vmDeployment.$subnetKey

 if (-not $vmConfig.deploy) {
 Write-Host "`n ⏭ Skipping VM deployment in $subnetKey subnet" -ForegroundColor DarkGray
 continue
 }

 $subnetDef = $azParams.subnets.$subnetKey
 $vmName = "$($azParams.baseObjectName)-$($vmConfig.vmName)"
 $nicName = "$vmName-nic"

 Write-Host "`n Deploying VM: $vmName" -ForegroundColor White
 Write-Host " Subnet: $($subnetDef.name)" -ForegroundColor Gray
 Write-Host " Size: $($vmParams.vmConfiguration.vmSize)" -ForegroundColor Gray
 Write-Host " OS: Ubuntu 22.04 LTS" -ForegroundColor Gray

 try {
 # Check if VM already exists
 $existingVM = Get-AzVM -ResourceGroupName $ResourceGroupName -Name $vmName -ErrorAction SilentlyContinue
 if ($null -ne $existingVM -and $SkipExisting) {
 Write-Host " ℹ VM '$vmName' already exists - skipping" -ForegroundColor Cyan
 $deployedVMs += $existingVM
 continue
 }

 # Get vNet and subnet
 $vnet = Get-AzVirtualNetwork -Name $VNetName -ResourceGroupName $ResourceGroupName
 $subnet = Get-AzVirtualNetworkSubnetConfig -Name $subnetDef.name -VirtualNetwork $vnet

 # Create Network Interface
 Write-Host " Creating Network Interface..." -ForegroundColor Gray
 $nic = New-AzNetworkInterface `
 -Name $nicName `
 -ResourceGroupName $ResourceGroupName `
 -Location $Location `
 -SubnetId $subnet.Id `
 -ErrorAction Stop

 # Create VM configuration
 $vmConfigObj = New-AzVMConfig `
 -VMName $vmName `
 -VMSize $vmParams.vmConfiguration.vmSize `
 -ErrorAction Stop

 # Set OS image
 $vmConfigObj = Set-AzVMOperatingSystem `
 -VM $vmConfigObj `
 -Linux `
 -ComputerName $vmName `
 -Credential (New-Object System.Management.Automation.PSCredential($vmParams.vmConfiguration.adminUsername, $adminPassword)) `
 -DisablePasswordAuthentication:$false `
 -ErrorAction Stop

 $vmConfigObj = Set-AzVMSourceImage `
 -VM $vmConfigObj `
 -PublisherName $vmParams.vmConfiguration.publisher `
 -Offer $vmParams.vmConfiguration.offer `
 -Skus $vmParams.vmConfiguration.sku `
 -Version $vmParams.vmConfiguration.version `
 -ErrorAction Stop

 # Add NIC
 $vmConfigObj = Add-AzVMNetworkInterface `
 -VM $vmConfigObj `
 -Id $nic.Id `
 -ErrorAction Stop

 # Set OS disk
 $vmConfigObj = Set-AzVMOSDisk `
 -VM $vmConfigObj `
 -CreateOption FromImage `
 -StorageAccountType $vmParams.vmConfiguration.osDiskType `
 -ErrorAction Stop

 # Disable boot diagnostics to save costs
 $vmConfigObj = Set-AzVMBootDiagnostic `
 -VM $vmConfigObj `
 -Disable `
 -ErrorAction Stop

 # Create the VM
 Write-Host " Creating VM (this may take 3-5 minutes)..." -ForegroundColor Gray
 $vm = New-AzVM `
 -ResourceGroupName $ResourceGroupName `
 -Location $Location `
 -VM $vmConfigObj `
 -ErrorAction Stop

 Write-Host " VM '$vmName' created successfully!" -ForegroundColor Green
 $privateIp = $nic.IpConfigurations[0].PrivateIpAddress
 Write-Host " Private IP: $privateIp" -ForegroundColor Cyan

 # Store VM info for summary
 $vmIpAddresses += [PSCustomObject]@{
 Name = $vmName
 Subnet = $subnetDef.name
 PrivateIP = $privateIp
 }

 # Configure auto-shutdown at 7 PM Eastern (convert to UTC)
 # Eastern Time is UTC-5 (EST) or UTC-4 (EDT)
 # Using 7 PM EST = 00:00 UTC (midnight UTC)
 # Using 7 PM EDT = 23:00 UTC (11 PM UTC)
 # Setting to 23:00 UTC to cover EDT, which is more common during work months
 try {
 Write-Host " Configuring auto-shutdown (7 PM Eastern)..." -ForegroundColor Gray

 $shutdownTime = "2300" # 11:00 PM UTC = 7:00 PM EDT
 $timeZoneId = "Eastern Standard Time"

 # Create auto-shutdown schedule
 $scheduleProperties = @{
 status = "Enabled"
 taskType = "ComputeVmShutdownTask"
 dailyRecurrence = @{
 time = $shutdownTime
 }
 timeZoneId = $timeZoneId
 notificationSettings = @{
 status = "Disabled"
 }
 targetResourceId = $vm.Id
 }

 $shutdownResourceId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/microsoft.devtestlab/schedules/shutdown-computevm-$vmName"

 New-AzResource `
 -ResourceId $shutdownResourceId `
 -Location $Location `
 -Properties $scheduleProperties `
 -Force `
 -ErrorAction Stop | Out-Null

 Write-Host " Auto-shutdown configured: 7 PM Eastern (11 PM UTC)" -ForegroundColor Green

 } catch {
 Write-Host " Failed to configure auto-shutdown" -ForegroundColor Yellow
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor DarkGray
 }

 $deployedVMs += $vm

 } catch {
 Write-Host " Failed to create VM '$vmName'" -ForegroundColor Red
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 }
 }

 if ($deployedVMs.Count -gt 0) {
 Write-Host "`n VM Deployment Summary:" -ForegroundColor Cyan
 Write-Host " Total VMs deployed: $($deployedVMs.Count)" -ForegroundColor Green
 Write-Host " Auto-shutdown: 7:00 PM Eastern (daily)" -ForegroundColor Cyan
 Write-Host " Public IPs: Disabled (private only)" -ForegroundColor Cyan
 Write-Host " Estimated cost: ~$([math]::Round($deployedVMs.Count * 7.59, 2))/month (if running 24/7)" -ForegroundColor Yellow
 Write-Host " With auto-shutdown: ~$([math]::Round($deployedVMs.Count * 7.59 * 0.5, 2))/month (estimated)" -ForegroundColor Green

 # Display VM IP addresses
 if ($vmIpAddresses.Count -gt 0) {
 Write-Host "`n VM Private IP Addresses:" -ForegroundColor Cyan
 foreach ($vmInfo in $vmIpAddresses) {
 Write-Host " • $($vmInfo.Name.PadRight(30)) | $($vmInfo.Subnet.PadRight(20)) | $($vmInfo.PrivateIP)" -ForegroundColor White
 }
 }

 Write-Host "`n Cost Saving Tips:" -ForegroundColor Yellow
 Write-Host " • Auto-shutdown runs daily at 7 PM Eastern" -ForegroundColor Gray
 Write-Host " • Manually stop VMs: az vm deallocate --resource-group $ResourceGroupName --name <vm-name>" -ForegroundColor Gray
 Write-Host " • Start VMs: az vm start --resource-group $ResourceGroupName --name <vm-name>" -ForegroundColor Gray
 Write-Host " • View/modify auto-shutdown: Azure Portal > VM > Auto-shutdown" -ForegroundColor Gray
 }
}

# Function to generate Cribl collector configurations for flow logs
function Generate-CriblCollectors {
 param(
 $StorageAccount,
 $NetworkWatcher,
 [switch]$SkipWait
 )

 if ($null -eq $StorageAccount) {
 Write-Host "`n ℹ Storage Account not available - skipping Cribl collector generation" -ForegroundColor Cyan
 return
 }

 Write-Host "`n--- Generating Cribl Collector Configurations ---" -ForegroundColor Yellow

 if ($TemplateOnly) {
 Write-Host " Template mode: Skipping Cribl collector generation" -ForegroundColor Cyan
 return
 }

 # Create output directory for collectors
 $collectorsDir = Join-Path $ScriptRoot "cribl-collectors"
 if (-not (Test-Path $collectorsDir)) {
 New-Item -Path $collectorsDir -ItemType Directory -Force | Out-Null
 Write-Host " Created directory: cribl-collectors\" -ForegroundColor Gray
 }

 # Get storage account key
 Write-Host " Retrieving Storage Account access key..." -ForegroundColor Gray
 try {
 $storageKeys = Get-AzStorageAccountKey -ResourceGroupName $ResourceGroupName -Name $StorageAccount.StorageAccountName -ErrorAction Stop
 $storageKey = $storageKeys[0].Value
 $connectionString = "DefaultEndpointsProtocol=https;AccountName=$($StorageAccount.StorageAccountName);AccountKey=$storageKey;EndpointSuffix=core.windows.net"
 } catch {
 Write-Host " Failed to retrieve storage account key" -ForegroundColor Red
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 return
 }

 # Standard container name for flow logs
 $containerName = "insights-logs-flowlogflowevent"

 # Wait for flow logs to start generating (check if container exists)
 $storageContext = New-AzStorageContext -StorageAccountName $StorageAccount.StorageAccountName -StorageAccountKey $storageKey
 $containerExists = $false

 if (-not $SkipWait) {
 Write-Host "`n NOTICE: Flow logs typically take 5-10 minutes to start after VMs begin generating traffic" -ForegroundColor Yellow
 Write-Host " ⏳ Waiting for flow log container to be created..." -ForegroundColor Gray
 Write-Host " Press Ctrl+C at any time to skip waiting and exit" -ForegroundColor DarkGray

 $waitInterval = 60
 $elapsed = 0
 $userSkipped = $false

 while (-not $containerExists -and -not $userSkipped) {
 try {
 $container = Get-AzStorageContainer -Name $containerName -Context $storageContext -ErrorAction SilentlyContinue
 if ($null -ne $container) {
 $containerExists = $true
 Write-Host "`n Flow log container found!" -ForegroundColor Green
 } else {
 if ($elapsed -gt 0) {
 Write-Host "`n Waited $elapsed seconds - container not yet created" -ForegroundColor DarkGray
 Write-Host " Continue waiting? (Y/N) [Y]: " -ForegroundColor Cyan -NoNewline

 $timeout = New-TimeSpan -Seconds 10
 $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
 $response = $null

 while ($stopwatch.Elapsed -lt $timeout -and $null -eq $response) {
 if ([Console]::KeyAvailable) {
 $key = [Console]::ReadKey($true)
 $response = $key.KeyChar
 break
 }
 Start-Sleep -Milliseconds 100
 }

 if ($null -eq $response -or $response -eq 'Y' -or $response -eq 'y' -or $response -eq "`r") {
 Write-Host "Y" -ForegroundColor Green
 Write-Host " Continuing to wait..." -ForegroundColor Gray
 } else {
 Write-Host "N" -ForegroundColor Yellow
 $userSkipped = $true
 break
 }
 }

 Write-Host " Checking again in $waitInterval seconds..." -ForegroundColor DarkGray
 Start-Sleep -Seconds $waitInterval
 $elapsed += $waitInterval
 }
 } catch {
 Start-Sleep -Seconds $waitInterval
 $elapsed += $waitInterval
 }
 }

 if (-not $containerExists) {
 if ($userSkipped) {
 Write-Host "`n ⏭ Skipped waiting for flow logs" -ForegroundColor Yellow
 }
 Write-Host " Flow log container not created yet - this is normal if VMs just started" -ForegroundColor Yellow
 Write-Host " You can re-run the script in CriblCollectorsOnly mode later to generate collectors" -ForegroundColor Gray
 }
 } else {
 # Skip wait mode - just check if container exists
 Write-Host "`n Checking for flow log container..." -ForegroundColor Gray
 try {
 $container = Get-AzStorageContainer -Name $containerName -Context $storageContext -ErrorAction SilentlyContinue
 if ($null -ne $container) {
 $containerExists = $true
 Write-Host " Flow log container found!" -ForegroundColor Green
 } else {
 Write-Host " Flow log container not found - flow logs may not have started yet" -ForegroundColor Yellow
 Write-Host " Wait 5-10 minutes after VMs start generating traffic, then try again" -ForegroundColor Gray
 }
 } catch {
 Write-Host " Could not access storage container: $($_.Exception.Message)" -ForegroundColor Yellow
 }
 }

 # Discover flow log paths by listing blobs
 Write-Host " Discovering flow log paths from blob storage..." -ForegroundColor Gray
 $flowLogPaths = @{}

 if ($containerExists) {
 try {
 Write-Host " Retrieving blob list (this may take a moment)..." -ForegroundColor DarkGray

 # Get blobs without displaying progress
 $ProgressPreference = 'SilentlyContinue'
 $blobs = @(Get-AzStorageBlob -Container $containerName -Context $storageContext -ErrorAction Stop)
 $ProgressPreference = 'Continue'

 Write-Host " Found $($blobs.Count) blobs, analyzing paths..." -ForegroundColor DarkGray

 $blobCount = 0
 foreach ($blob in $blobs) {
 $blobCount++

 # Get just the Name property
 $blobName = $blob.Name

 # Extract full path including flowLogResourceID prefix
 # Pattern: flowLogResourceID=/GUID_RESOURCEGROUP/NETWORKWATCHER_REGION_FLOWLOGNAME/y=2025/m=10/...
 if ($blobName -match '(flowLogResourceID=/[^/]+/[^/]+)') {
 $flowLogResourcePath = $matches[1]

 # Extract the flow log name from the path for identification
 # Format: flowLogResourceID=/GUID_RESOURCEGROUP/NETWORKWATCHER_REGION_FLOWLOGNAME
 if ($flowLogResourcePath -match 'flowLogResourceID=/[^/]+/(.+)') {
 $flowLogFullName = $matches[1] # NETWORKWATCHER_REGION_FLOWLOGNAME

 # Extract the flow log name after NETWORKWATCHER_REGION_ prefix
 # Pattern: NETWORKWATCHER_EASTUS_FLOWLOG-VNET-JPEDERSON-EASTUS -> FLOWLOG-VNET-JPEDERSON-EASTUS
 if ($flowLogFullName -match 'NETWORKWATCHER_[^_]+_(.+)') {
 $flowLogName = $matches[1]

 # Check if this matches our expected flow log names (case insensitive)
 # Expected: FlowLog-$VNetName or FlowLog-$VNetName-$SubnetName
 if ($flowLogName -match "^FlowLog-" -or $flowLogName -match "^FLOWLOG-") {
 if (-not $flowLogPaths.ContainsKey($flowLogName)) {
 $flowLogPaths[$flowLogName] = $flowLogResourcePath
 Write-Host " Discovered: $flowLogName" -ForegroundColor Green
 Write-Host " Path: $flowLogResourcePath" -ForegroundColor DarkGray
 }
 }
 }
 }
 }

 # Only process first 20 blobs to save time
 if ($blobCount -ge 20) { break }
 }

 if ($flowLogPaths.Count -gt 0) {
 Write-Host " Found $($flowLogPaths.Count) unique flow log path(s)" -ForegroundColor Green
 } else {
 Write-Host " No flow log paths discovered yet" -ForegroundColor Yellow
 Write-Host " Checked $blobCount blobs but none matched expected pattern" -ForegroundColor Gray
 Write-Host " Expected pattern: NETWORKWATCHER_REGION_FlowLog-* or NETWORKWATCHER_REGION_FLOWLOG-*" -ForegroundColor Gray
 }
 } catch {
 Write-Host " Could not discover flow log paths: $($_.Exception.Message)" -ForegroundColor Yellow
 }
 }

 # Generate collectors
 $collectorConfigs = @()

 # Since all flow logs share the same path, we only need to find one path
 # Determine which flow log path to use (prefer vNet-level if enabled, otherwise first subnet-level)
 $primaryFlowLogPath = "/<FLOW_LOG_RESOURCE_PATH_TBD>"
 $primaryFlowLogName = $null

 if ($azParams.flowLogging.vnetLevel.enabled) {
 $primaryFlowLogName = "FlowLog-$VNetName"
 if ($flowLogPaths.ContainsKey($primaryFlowLogName)) {
 $primaryFlowLogPath = $flowLogPaths[$primaryFlowLogName]
 }
 } else {
 # Use first available subnet flow log path
 foreach ($key in $flowLogPaths.Keys) {
 $primaryFlowLogPath = $flowLogPaths[$key]
 $primaryFlowLogName = $key
 break
 }
 }

 Write-Host "`n Generating Cribl collector configurations..." -ForegroundColor Cyan
 Write-Host " Using flow log path: $primaryFlowLogPath" -ForegroundColor DarkGray

 # Collector 1: Hourly - collects previous hour's data
 # Runs at 15 minutes past each hour, collects from -75m to -15m
 $collector1 = @{
 id = "Azure_FlowLogs_Hourly"
 type = "collection"
 ttl = "4h"
 removeFields = @()
 resumeOnBoot = $false
 schedule = @{
 cronSchedule = "15 * * * *"
 maxConcurrentRuns = 10
 skippable = $false
 resumeMissed = $true
 run = @{
 rescheduleDroppedTasks = $true
 maxTaskReschedule = 1
 logLevel = "info"
 jobTimeout = "0"
 mode = "run"
 timeRangeType = "relative"
 timeWarning = @{}
 expression = "true"
 minTaskSize = "1MB"
 maxTaskSize = "10MB"
 timestampTimezone = "UTC"
 earliest = "-75m"
 latest = "-15m"
 }
 enabled = $true
 }
 streamtags = @()
 workerAffinity = $false
 collector = @{
 conf = @{
 authType = "manual"
 recurse = $true
 includeMetadata = $true
 includeTags = $true
 maxBatchSize = 10
 parquetChunkSizeMB = 5
 parquetChunkDownloadTimeout = 600
 containerName = $containerName
 connectionString = $connectionString
 path = "$primaryFlowLogPath/`${_time:y=%Y}/`${_time:m=%m}/`${_time:d=%d}/`${_time:h=%H}"
 }
 destructive = $false
 encoding = "utf8"
 type = "azure_blob"
 }
 input = @{
 type = "collection"
 staleChannelFlushMs = 10000
 sendToRoutes = $true
 preprocess = @{
 disabled = $true
 }
 throttleRatePerSec = "0"
 breakerRulesets = @("AzureFlowLogs")
 }
 savedState = @{}
 }

 # Collector 2: Real-time - collects recent data every 15 minutes
 # Runs every 15 minutes, collects from -15m to now
 $collector2 = @{
 id = "Azure_FlowLogs_Realtime"
 type = "collection"
 ttl = "4h"
 removeFields = @()
 resumeOnBoot = $false
 schedule = @{
 cronSchedule = "*/15 * * * *"
 maxConcurrentRuns = 10
 skippable = $false
 resumeMissed = $true
 run = @{
 rescheduleDroppedTasks = $true
 maxTaskReschedule = 1
 logLevel = "info"
 jobTimeout = "0"
 mode = "run"
 timeRangeType = "relative"
 timeWarning = @{}
 expression = "true"
 minTaskSize = "1MB"
 maxTaskSize = "10MB"
 timestampTimezone = "UTC"
 earliest = "-15m"
 }
 enabled = $true
 }
 streamtags = @()
 workerAffinity = $false
 collector = @{
 conf = @{
 authType = "manual"
 recurse = $true
 includeMetadata = $true
 includeTags = $true
 maxBatchSize = 10
 parquetChunkSizeMB = 5
 parquetChunkDownloadTimeout = 600
 containerName = $containerName
 connectionString = $connectionString
 path = "$primaryFlowLogPath/`${_time:y=%Y}/`${_time:m=%m}/`${_time:d=%d}/`${_time:h=%H}"
 }
 destructive = $false
 encoding = "utf8"
 type = "azure_blob"
 }
 input = @{
 type = "collection"
 staleChannelFlushMs = 10000
 sendToRoutes = $true
 preprocess = @{
 disabled = $true
 }
 throttleRatePerSec = "0"
 breakerRulesets = @("AzureFlowLogs")
 }
 savedState = @{}
 }

 $collectorConfigs += $collector1
 $collectorConfigs += $collector2

 # Write collector files
 Write-Host "`n Writing Cribl collector configuration files..." -ForegroundColor Cyan
 foreach ($collector in $collectorConfigs) {
 $fileName = "$($collector.id).json"
 $filePath = Join-Path $collectorsDir $fileName

 try {
 $collector | ConvertTo-Json -Depth 10 | Set-Content -Path $filePath -Force
 Write-Host " Created: $fileName" -ForegroundColor Green
 } catch {
 Write-Host " Failed to create: $fileName" -ForegroundColor Red
 }
 }

 Write-Host "`n Cribl Collector Summary:" -ForegroundColor Cyan
 Write-Host " Total collectors generated: $($collectorConfigs.Count)" -ForegroundColor Green
 Write-Host " • Hourly collector (15 min past hour, -75m to -15m)" -ForegroundColor Gray
 Write-Host " • Real-time collector (every 15 min, -15m to now)" -ForegroundColor Gray
 Write-Host " Output directory: cribl-collectors\" -ForegroundColor Cyan
 Write-Host " Storage Account: $($StorageAccount.StorageAccountName)" -ForegroundColor Gray
 Write-Host " Container: $containerName" -ForegroundColor Gray

 if ($primaryFlowLogPath -eq "/<FLOW_LOG_RESOURCE_PATH_TBD>") {
 Write-Host "`n Flow log paths not yet available - collectors contain placeholder paths" -ForegroundColor Yellow
 Write-Host " Re-run with CriblCollectorsOnly mode to update paths once flow logs are writing" -ForegroundColor Gray
 } else {
 Write-Host "`n Flow log path discovered and configured in collectors" -ForegroundColor Green
 }
}

# Function to display deployment summary
function Show-DeploymentSummary {
 Write-Host "`n$('='*80)" -ForegroundColor Cyan
 Write-Host "DEPLOYMENT SUMMARY" -ForegroundColor Cyan
 Write-Host "$('='*80)" -ForegroundColor Cyan

 Write-Host "`n Resources Deployed:" -ForegroundColor Yellow
 Write-Host " Virtual Network: $VNetName ($VNetAddressPrefix)" -ForegroundColor Green

 Write-Host "`n Subnets:" -ForegroundColor Yellow
 foreach ($subnetKey in $azParams.subnets.PSObject.Properties.Name) {
 $subnet = $azParams.subnets.$subnetKey
 Write-Host " • $($subnet.name): $($subnet.addressPrefix)" -ForegroundColor Gray
 }

 if ($opParams.deployment.deployNSGs) {
 Write-Host "`n Network Security Groups created for applicable subnets" -ForegroundColor Green
 }

 if ($opParams.flowLogging.createStorageAccount) {
 Write-Host " Storage Account: $StorageAccountName (Flow Logs)" -ForegroundColor Green
 }

 if ($opParams.flowLogging.createLogAnalyticsWorkspace) {
 Write-Host " Log Analytics: $LogAnalyticsName (Traffic Analytics)" -ForegroundColor Green
 }

 if ($opParams.flowLogging.enableVNetFlowLogs) {
 Write-Host " VNet Flow Logs: Enabled (replaces deprecated NSG Flow Logs)" -ForegroundColor Green
 }

 if ($opParams.deployment.deployVPNGateway -and ($Mode -eq "Full" -or $Mode -eq "VPNOnly")) {
 Write-Host " VPN Gateway: $VpnGatewayName ($($azParams.vpnGateway.sku))" -ForegroundColor Green
 Write-Host " VPN Public IP: $VpnPublicIpName" -ForegroundColor Green

 if (-not $TemplateOnly) {
 try {
 $pip = Get-AzPublicIpAddress -Name $VpnPublicIpName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
 if ($null -ne $pip -and $null -ne $pip.IpAddress) {
 Write-Host " IP Address: $($pip.IpAddress)" -ForegroundColor Cyan
 }
 } catch { }
 }
 }

 if ($azParams.bastion.deploy -and ($Mode -eq "Full" -or $Mode -eq "BastionOnly")) {
 Write-Host " Azure Bastion: $BastionName" -ForegroundColor Green
 }

 Write-Host "`n Resource Group: $ResourceGroupName" -ForegroundColor White
 Write-Host " Location: $Location" -ForegroundColor White

 if ($TemplateOnly) {
 Write-Host "`n Mode: Template Generation Only (no resources deployed)" -ForegroundColor Cyan
 }

 Write-Host "`n Deployment completed successfully!" -ForegroundColor Green
}

# Main execution logic
try {
 Ensure-ResourceGroup

 # Execute based on mode
 switch ($Mode) {
 "Full" {
 $vnet = Deploy-VirtualNetwork
 $nsgs = Deploy-NetworkSecurityGroups

 if ($opParams.deployment.deployFlowLogs) {
 $sa = Deploy-StorageAccount
 $law = Deploy-LogAnalyticsWorkspace
 $nw = Ensure-NetworkWatcher
 # NSG Flow Logs are deprecated - only deploy VNet Flow Logs
 Deploy-VNetFlowLogs -StorageAccount $sa -LogAnalytics $law -NetworkWatcher $nw
 }

 if ($opParams.deployment.deployVPNGateway) {
 Deploy-VPNPublicIP
 $vpnGw = Deploy-VPNGateway

 # Create on-premises connection if configured
 if ($null -ne $onPremParams) {
 $lng = Deploy-LocalNetworkGateway
 Deploy-VPNConnection -VpnGateway $vpnGw -LocalNetworkGateway $lng
 }
 }

 if ($opParams.deployment.deployBastion) {
 Deploy-Bastion
 }

 # Deploy test VMs for flow log generation
 Deploy-TestVMs

 # Generate Cribl collectors after VMs are deployed and summary is shown
 if ($opParams.deployment.deployFlowLogs -and $null -ne $sa) {
 Generate-CriblCollectors -StorageAccount $sa -NetworkWatcher $nw
 }
 }

 "VNetOnly" {
 $vnet = Deploy-VirtualNetwork
 $nsgs = Deploy-NetworkSecurityGroups
 }

 "VPNOnly" {
 # Verify vNet exists
 $vnet = Get-AzVirtualNetwork -Name $VNetName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
 if ($null -eq $vnet) {
 Write-Host " Virtual Network '$VNetName' not found!" -ForegroundColor Red
 exit 1
 }

 Deploy-VPNPublicIP
 $vpnGw = Deploy-VPNGateway

 # Create on-premises connection if configured
 if ($null -ne $onPremParams) {
 $lng = Deploy-LocalNetworkGateway
 Deploy-VPNConnection -VpnGateway $vpnGw -LocalNetworkGateway $lng
 }
 }

 "BastionOnly" {
 # Verify vNet exists
 $vnet = Get-AzVirtualNetwork -Name $VNetName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
 if ($null -eq $vnet) {
 Write-Host " Virtual Network '$VNetName' not found!" -ForegroundColor Red
 exit 1
 }

 Deploy-Bastion
 }

 "FlowLogsOnly" {
 $sa = Deploy-StorageAccount
 $law = Deploy-LogAnalyticsWorkspace
 $nw = Ensure-NetworkWatcher
 # NSG Flow Logs are deprecated - only deploy VNet Flow Logs
 Deploy-VNetFlowLogs -StorageAccount $sa -LogAnalytics $law -NetworkWatcher $nw
 Generate-CriblCollectors -StorageAccount $sa -NetworkWatcher $nw
 }

 "CriblCollectorsOnly" {
 # Find existing storage account using the same naming logic as creation
 # Storage account name: prefix + baseName + suffix, lowercase, no hyphens
 $baseStorageAccountName = ($azParams.naming.storageAccount.prefix + $azParams.baseObjectName + $azParams.naming.storageAccount.suffix).ToLower() -replace '[^a-z0-9]', ''
 if ($baseStorageAccountName.Length -gt 24) {
 $baseStorageAccountName = $baseStorageAccountName.Substring(0, 24)
 }

 $sa = $null

 # Try base name first
 $sa = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $baseStorageAccountName -ErrorAction SilentlyContinue

 # If not found, search for storage accounts with numeric suffixes (00-99)
 if ($null -eq $sa) {
 Write-Host " Storage account '$baseStorageAccountName' not found, checking for variants with suffixes..." -ForegroundColor Gray
 for ($i = 0; $i -lt 100; $i++) {
 $suffix = "{0:D2}" -f $i
 $testName = if (($baseStorageAccountName.Length + 2) -gt 24) {
 $baseStorageAccountName.Substring(0, 22) + $suffix
 } else {
 $baseStorageAccountName + $suffix
 }

 $sa = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $testName -ErrorAction SilentlyContinue
 if ($null -ne $sa) {
 Write-Host " Found storage account: $testName" -ForegroundColor Green
 break
 }
 }
 } else {
 Write-Host " Found storage account: $baseStorageAccountName" -ForegroundColor Green
 }

 if ($null -eq $sa) {
 Write-Host " No storage account found in resource group '$ResourceGroupName'" -ForegroundColor Red
 Write-Host " Looked for: $baseStorageAccountName and variants with 00-99 suffixes" -ForegroundColor Yellow
 Write-Host " Please deploy flow logs first using FlowLogsOnly or Full deployment mode." -ForegroundColor Yellow
 exit 1
 }

 $nw = Ensure-NetworkWatcher
 Generate-CriblCollectors -StorageAccount $sa -NetworkWatcher $nw -SkipWait
 }

 "TemplateOnly" {
 Write-Host "`n Validating configuration..." -ForegroundColor Cyan
 Deploy-VirtualNetwork
 Deploy-NetworkSecurityGroups
 Deploy-StorageAccount
 Deploy-LogAnalyticsWorkspace
 Deploy-VPNPublicIP
 Deploy-VPNGateway
 if ($azParams.bastion.deploy) {
 Deploy-Bastion
 }
 }
 }

 Show-DeploymentSummary

} catch {
 Write-Host "`n Deployment failed!" -ForegroundColor Red
 Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Yellow
 exit 1
}

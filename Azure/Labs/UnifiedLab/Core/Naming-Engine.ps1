# Naming-Engine.ps1
# Shared resource naming functions for Unified Azure Lab

# Function to convert Azure location to short suffix format
function Get-LocationSuffix {
 param(
 [Parameter(Mandatory=$true)]
 [string]$Location
 )

 # Azure location naming conventions - convert to short suffix
 # Examples: eastus -> -eastus, westus2 -> -westus2, uksouth -> -uksouth
 # For storage/ADX (no hyphens): eastus -> eastus

 return "-$Location"
}

# Function to apply location-based suffixes to naming configuration
function Update-NamingSuffixes {
 param(
 [Parameter(Mandatory=$true)]
 [PSCustomObject]$AzureParams
 )

 $locationSuffix = Get-LocationSuffix -Location $AzureParams.location
 $locationSuffixNoHyphen = $AzureParams.location # For storage/ADX

 # Resource types that should automatically get location suffix (with hyphen)
 $resourceTypesWithLocationSuffix = @(
 'vnet', 'subnet', 'nsg', 'vpnGateway', 'bastion', 'publicIp',
 'logAnalyticsWorkspace', 'networkWatcher', 'eventHubNamespace'
 )

 # Update location-based suffixes
 foreach ($resourceType in $resourceTypesWithLocationSuffix) {
 if ($AzureParams.naming.$resourceType) {
 $currentSuffix = $AzureParams.naming.$resourceType.suffix

 # Update if suffix is empty or appears to be a location-based suffix
 if ([string]::IsNullOrEmpty($currentSuffix) -or
 $currentSuffix -match '^-?(eastus|westus|centralus|northcentralus|southcentralus|westus2|westus3|eastus2|northeurope|westeurope|uksouth|ukwest|francecentral|germanywestcentral|norwayeast|switzerlandnorth|uaenorth|brazilsouth|southafricanorth|australiaeast|australiasoutheast|centralindia|japaneast|japanwest|koreacentral|southeastasia|eastasia)$') {
 $AzureParams.naming.$resourceType.suffix = $locationSuffix
 }
 # Otherwise, preserve the custom suffix
 }
 }

 # Special case: ADX Cluster (location without hyphen, alphanumeric only)
 if ($AzureParams.naming.adxCluster) {
 $currentSuffix = $AzureParams.naming.adxCluster.suffix

 # Update if empty or appears to be a location
 if ([string]::IsNullOrEmpty($currentSuffix) -or
 $currentSuffix -match '^-?(eastus|westus|centralus|northcentralus|southcentralus|westus2|westus3|eastus2|northeurope|westeurope|uksouth|ukwest|francecentral|germanywestcentral|norwayeast|switzerlandnorth|uaenorth|brazilsouth|southafricanorth|australiaeast|australiasoutheast|centralindia|japaneast|japanwest|koreacentral|southeastasia|eastasia)$') {
 $AzureParams.naming.adxCluster.suffix = $locationSuffixNoHyphen
 }
 # Otherwise, preserve custom suffix (e.g., "prod", "dev", etc.)
 }

 # Note: Storage Account suffix is intentionally NOT auto-updated
 # It's typically a custom identifier (e.g., "cribl", "prod"), not location-based

 return $AzureParams
}

# Function to build resource name using naming conventions
function Get-ResourceName {
 param(
 [Parameter(Mandatory=$true)]
 [PSCustomObject]$AzureParams,

 [Parameter(Mandatory=$true)]
 [string]$ResourceType,

 [Parameter(Mandatory=$false)]
 [string]$Suffix = ""
 )

 $prefix = $AzureParams.naming.$ResourceType.prefix
 $namingSuffix = $AzureParams.naming.$ResourceType.suffix
 $baseName = $AzureParams.baseObjectName

 if ($Suffix) {
 return "$prefix$baseName-$Suffix$namingSuffix"
 } else {
 return "$prefix$baseName$namingSuffix"
 }
}

# Function to get storage account name (special rules)
function Get-StorageAccountName {
 param(
 [Parameter(Mandatory=$true)]
 [PSCustomObject]$AzureParams
 )

 $saName = ($AzureParams.naming.storageAccount.prefix + $AzureParams.baseObjectName + $AzureParams.naming.storageAccount.suffix).ToLower() -replace '[^a-z0-9]', ''

 # Ensure storage account name is between 3-24 characters
 if ($saName.Length -gt 24) {
 $saName = $saName.Substring(0, 24)
 }

 return $saName
}

# Function to get ADX cluster name (special rules: alphanumeric, lowercase only, globally unique)
function Get-ADXClusterName {
 param(
 [Parameter(Mandatory=$true)]
 [PSCustomObject]$AzureParams
 )

 # Generate a short unique suffix based on subscription ID to ensure global uniqueness
 $subscriptionHash = ($AzureParams.subscriptionId).GetHashCode().ToString("x").Substring(0, 4).ToLower()

 $clusterName = ($AzureParams.naming.adxCluster.prefix + $AzureParams.baseObjectName + $subscriptionHash + $AzureParams.naming.adxCluster.suffix).ToLower() -replace '[^a-z0-9]', ''

 # ADX cluster names must be 4-22 characters
 if ($clusterName.Length -lt 4) {
 $clusterName = $clusterName + "cluster"
 }

 if ($clusterName.Length -gt 22) {
 $clusterName = $clusterName.Substring(0, 22)
 }

 return $clusterName
}

# Function to get all resource names for the lab
function Get-AllResourceNames {
 param(
 [Parameter(Mandatory=$true)]
 [PSCustomObject]$AzureParams
 )

 $names = @{
 # Infrastructure
 VNet = Get-ResourceName -AzureParams $AzureParams -ResourceType "vnet"
 VPNGateway = Get-ResourceName -AzureParams $AzureParams -ResourceType "vpnGateway"
 Bastion = Get-ResourceName -AzureParams $AzureParams -ResourceType "bastion"
 VPNPublicIP = Get-ResourceName -AzureParams $AzureParams -ResourceType "publicIp" -Suffix "vpn"
 BastionPublicIP = Get-ResourceName -AzureParams $AzureParams -ResourceType "publicIp" -Suffix "bastion"

 # Monitoring
 LogAnalytics = Get-ResourceName -AzureParams $AzureParams -ResourceType "logAnalyticsWorkspace"
 NetworkWatcher = Get-ResourceName -AzureParams $AzureParams -ResourceType "networkWatcher"

 # Analytics
 EventHubNamespace = Get-ResourceName -AzureParams $AzureParams -ResourceType "eventHubNamespace"
 ADXCluster = Get-ADXClusterName -AzureParams $AzureParams

 # Storage
 StorageAccount = Get-StorageAccountName -AzureParams $AzureParams
 }

 # Add NSG names for each subnet (named after the subnet itself)
 if ($AzureParams.infrastructure.subnets) {
 foreach ($subnetKey in $AzureParams.infrastructure.subnets.PSObject.Properties.Name) {
 $subnet = $AzureParams.infrastructure.subnets.$subnetKey

 # Skip special subnets that don't support NSGs
 if ($subnet.name -notin @("GatewaySubnet", "AzureBastionSubnet")) {
 # Use subnet name as suffix (e.g., nsg-PrivateLinkSubnet-eastus, nsg-ComputeSubnet-eastus)
 $nsgName = Get-ResourceName -AzureParams $AzureParams -ResourceType "nsg" -Suffix $subnet.name
 $names["NSG_$subnetKey"] = $nsgName
 }
 }
 }

 # Add Event Hub names
 if ($AzureParams.analytics.eventHub.hubs) {
 foreach ($hubKey in $AzureParams.analytics.eventHub.hubs.PSObject.Properties.Name) {
 $hub = $AzureParams.analytics.eventHub.hubs.$hubKey
 $names["EventHub_$hubKey"] = $hub.name
 }
 }

 return $names
}

# Function to display all resource names
function Show-ResourceNames {
 param(
 [Parameter(Mandatory=$true)]
 [hashtable]$Names
 )

 Write-Host "`n Planned Resource Names:" -ForegroundColor Cyan
 $separator = '=' * 60
 Write-Host $separator -ForegroundColor Cyan

 Write-Host "`n Infrastructure:" -ForegroundColor Yellow
 if ($Names.VNet) { Write-Host " VNet: $($Names.VNet)" -ForegroundColor White }
 if ($Names.VPNGateway) { Write-Host " VPN Gateway: $($Names.VPNGateway)" -ForegroundColor White }
 if ($Names.Bastion) { Write-Host " Bastion: $($Names.Bastion)" -ForegroundColor White }

 Write-Host "`n Monitoring:" -ForegroundColor Yellow
 if ($Names.LogAnalytics) { Write-Host " Log Analytics: $($Names.LogAnalytics)" -ForegroundColor White }
 if ($Names.NetworkWatcher) { Write-Host " Network Watcher: $($Names.NetworkWatcher)" -ForegroundColor White }

 Write-Host "`n Analytics:" -ForegroundColor Yellow
 if ($Names.EventHubNamespace) { Write-Host " Event Hub Namespace: $($Names.EventHubNamespace)" -ForegroundColor White }
 if ($Names.ADXCluster) { Write-Host " ADX Cluster: $($Names.ADXCluster)" -ForegroundColor White }

 Write-Host "`n Storage:" -ForegroundColor Yellow
 if ($Names.StorageAccount) { Write-Host " Storage Account: $($Names.StorageAccount)" -ForegroundColor White }

 Write-Host "`n Network Security Groups:" -ForegroundColor Yellow
 foreach ($key in $Names.Keys | Where-Object { $_ -like "NSG_*" } | Sort-Object) {
 $subnetName = $key -replace "^NSG_", ""
 Write-Host " $subnetName`: $($Names[$key])" -ForegroundColor White
 }

 Write-Host "`n Event Hubs:" -ForegroundColor Yellow
 foreach ($key in $Names.Keys | Where-Object { $_ -like "EventHub_*" } | Sort-Object) {
 $hubName = $key -replace "^EventHub_", ""
 Write-Host " $hubName`: $($Names[$key])" -ForegroundColor White
 }

 Write-Host ("`n" + ("=" * 60)) -ForegroundColor Cyan
}

# Functions are available via dot-sourcing
# No Export-ModuleMember needed for .ps1 script files

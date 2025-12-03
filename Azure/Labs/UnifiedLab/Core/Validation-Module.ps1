# Validation-Module.ps1
# Shared validation functions for Unified Azure Lab

# Function to validate required configuration fields
function Test-RequiredFields {
 param(
 [Parameter(Mandatory=$true)]
 [PSCustomObject]$Config,

 [Parameter(Mandatory=$true)]
 [hashtable]$RequiredFields
 )

 $missingFields = @()
 $defaultFields = @()

 foreach ($field in $RequiredFields.Keys) {
 $value = $Config.$field

 if (-not $value -or [string]::IsNullOrWhiteSpace($value)) {
 $missingFields += $field
 } elseif ($RequiredFields[$field] -contains $value) {
 $defaultFields += $field
 }
 }

 if ($missingFields.Count -gt 0 -or $defaultFields.Count -gt 0) {
 Write-Host "`n CONFIGURATION VALIDATION FAILED" -ForegroundColor Yellow
 $separator = '=' * 60
 Write-Host $separator -ForegroundColor Yellow

 if ($missingFields.Count -gt 0) {
 Write-Host " Missing required fields:" -ForegroundColor Red
 foreach ($field in $missingFields) {
 Write-Host " - $field" -ForegroundColor Red
 }
 }

 if ($defaultFields.Count -gt 0) {
 Write-Host " Fields still have default/placeholder values:" -ForegroundColor Yellow
 foreach ($field in $defaultFields) {
 $currentValue = $Config.$field
 Write-Host " - $field`: '$currentValue'" -ForegroundColor Yellow
 }
 }

 return $false
 }

 return $true
}

# Function to validate CIDR notation
function Test-CIDRNotation {
 param(
 [Parameter(Mandatory=$true)]
 [string]$CIDR
 )

 $cidrPattern = '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$'

 if ($CIDR -notmatch $cidrPattern) {
 return $false
 }

 # Validate IP octets
 $parts = $CIDR -split '/'
 $ip = $parts[0]
 $prefix = [int]$parts[1]

 if ($prefix -lt 0 -or $prefix -gt 32) {
 return $false
 }

 $octets = $ip -split '\.'
 foreach ($octet in $octets) {
 $num = [int]$octet
 if ($num -lt 0 -or $num -gt 255) {
 return $false
 }
 }

 return $true
}

# Function to validate storage account name
function Test-StorageAccountName {
 param(
 [Parameter(Mandatory=$true)]
 [string]$Name
 )

 # Storage account rules: 3-24 chars, lowercase, alphanumeric only
 if ($Name.Length -lt 3 -or $Name.Length -gt 24) {
 Write-Host " Storage account name must be 3-24 characters" -ForegroundColor Red
 return $false
 }

 if ($Name -cne $Name.ToLower()) {
 Write-Host " Storage account name must be lowercase" -ForegroundColor Red
 return $false
 }

 if ($Name -notmatch '^[a-z0-9]+$') {
 Write-Host " Storage account name can only contain lowercase letters and numbers" -ForegroundColor Red
 return $false
 }

 return $true
}

# Function to validate Event Hub partition count
function Test-EventHubPartitionCount {
 param(
 [Parameter(Mandatory=$true)]
 [int]$PartitionCount
 )

 if ($PartitionCount -lt 1 -or $PartitionCount -gt 32) {
 Write-Host " Event Hub partition count must be between 1 and 32" -ForegroundColor Red
 return $false
 }

 return $true
}

# Function to validate ADX SKU
function Test-ADXClusterSKU {
 param(
 [Parameter(Mandatory=$true)]
 [string]$SKU
 )

 $validSKUs = @(
 "Dev(No SLA)_Standard_E2a_v4",
 "Dev(No SLA)_Standard_D11_v2",
 "Standard_D11_v2",
 "Standard_D12_v2",
 "Standard_D13_v2",
 "Standard_D14_v2",
 "Standard_E2a_v4",
 "Standard_E4a_v4",
 "Standard_E8a_v4",
 "Standard_E16a_v4"
 )

 if ($SKU -notin $validSKUs) {
 Write-Host " Invalid ADX cluster SKU: $SKU" -ForegroundColor Red
 Write-Host " Valid SKUs: $($validSKUs -join ', ')" -ForegroundColor Gray
 return $false
 }

 if ($SKU -like "Dev(No SLA)*") {
 Write-Host " WARNING: Dev SKU has no SLA and is for testing only!" -ForegroundColor Yellow
 Write-Host " Cost: ~$240/month minimum even for Dev SKU" -ForegroundColor Yellow
 }

 return $true
}

# Function to check if subnet CIDR ranges overlap
function Test-SubnetOverlap {
 param(
 [Parameter(Mandatory=$true)]
 [string]$VNetCIDR,

 [Parameter(Mandatory=$true)]
 [hashtable]$Subnets
 )

 # Convert CIDR to IP range for comparison
 function Get-IPRange {
 param([string]$CIDR)

 $parts = $CIDR -split '/'
 $ip = $parts[0]
 $prefix = [int]$parts[1]

 $ipBytes = [System.Net.IPAddress]::Parse($ip).GetAddressBytes()
 [Array]::Reverse($ipBytes)
 $ipNum = [System.BitConverter]::ToUInt32($ipBytes, 0)

 $mask = [uint32]([Math]::Pow(2, 32) - [Math]::Pow(2, 32 - $prefix))
 $networkNum = $ipNum -band $mask
 $broadcastNum = $networkNum -bor (-bnot $mask)

 return @{
 Start = $networkNum
 End = $broadcastNum
 }
 }

 function Test-RangeOverlap {
 param($Range1, $Range2)

 return ($Range1.Start -le $Range2.End) -and ($Range2.Start -le $Range1.End)
 }

 # Check if all subnets are within VNet range
 $vnetRange = Get-IPRange -CIDR $VNetCIDR
 $subnetRanges = @{}

 foreach ($subnetKey in $Subnets.Keys) {
 $subnet = $Subnets[$subnetKey]
 $subnetCIDR = $subnet.addressPrefix

 if (-not (Test-CIDRNotation -CIDR $subnetCIDR)) {
 Write-Host " Invalid CIDR notation for subnet '$subnetKey': $subnetCIDR" -ForegroundColor Red
 return $false
 }

 $subnetRange = Get-IPRange -CIDR $subnetCIDR

 # Check if subnet is within VNet
 if ($subnetRange.Start -lt $vnetRange.Start -or $subnetRange.End -gt $vnetRange.End) {
 Write-Host " Subnet '$subnetKey' ($subnetCIDR) is outside VNet range ($VNetCIDR)" -ForegroundColor Red
 return $false
 }

 $subnetRanges[$subnetKey] = $subnetRange
 }

 # Check for overlaps between subnets
 $subnetKeys = @($subnetRanges.Keys)
 for ($i = 0; $i -lt $subnetKeys.Count; $i++) {
 for ($j = $i + 1; $j -lt $subnetKeys.Count; $j++) {
 $subnet1 = $subnetKeys[$i]
 $subnet2 = $subnetKeys[$j]

 if (Test-RangeOverlap -Range1 $subnetRanges[$subnet1] -Range2 $subnetRanges[$subnet2]) {
 $cidr1 = $Subnets[$subnet1].addressPrefix
 $cidr2 = $Subnets[$subnet2].addressPrefix
 Write-Host " Subnets overlap: '$subnet1' ($cidr1) and '$subnet2' ($cidr2)" -ForegroundColor Red
 return $false
 }
 }
 }

 return $true
}

# Function to validate azure-parameters.json
function Test-AzureParametersConfiguration {
 param(
 [Parameter(Mandatory=$true)]
 [string]$ConfigPath,

 [Parameter(Mandatory=$false)]
 [PSCustomObject]$OperationParams
 )

 if (-not (Test-Path $ConfigPath)) {
 Write-Host "`n ERROR: azure-parameters.json file not found!" -ForegroundColor Red
 Write-Host " Expected path: $ConfigPath" -ForegroundColor Yellow
 return $false
 }

 try {
 $azParams = Get-Content $ConfigPath | ConvertFrom-Json
 } catch {
 Write-Host "`n ERROR: azure-parameters.json is not valid JSON!" -ForegroundColor Red
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 return $false
 }

 # Define required fields and their placeholder values
 $requiredFields = @{
 "subscriptionId" = @("<YOUR-SUBSCRIPTION-ID-HERE>", "your-subscription-id", "")
 "resourceGroupName" = @("<YOUR-RG-NAME-HERE>", "your-rg-name", "")
 "location" = @("<YOUR-AZURE-REGION-HERE>")
 "baseObjectName" = @("", "cribllab")
 }

 if (-not (Test-RequiredFields -Config $azParams -RequiredFields $requiredFields)) {
 Write-Host "`n Please update azure-parameters.json with your values:" -ForegroundColor Cyan
 Write-Host " subscriptionId: Your Azure subscription ID (GUID)" -ForegroundColor Gray
 Write-Host " resourceGroupName: Your resource group name" -ForegroundColor Gray
 Write-Host " location: Azure region (eg eastus, westus2)" -ForegroundColor Gray
 Write-Host " baseObjectName: Base name for resources (eg cribllab, prod)" -ForegroundColor Gray
 $separator = '=' * 60
 Write-Host $separator -ForegroundColor Yellow
 return $false
 }

 # Validate VNet and subnets if infrastructure is enabled
 if ($azParams.infrastructure) {
 $vnetCIDR = $azParams.infrastructure.vnetAddressPrefix

 if (-not (Test-CIDRNotation -CIDR $vnetCIDR)) {
 Write-Host "`n Invalid vNet address prefix: $vnetCIDR" -ForegroundColor Red
 Write-Host " Must be in CIDR notation (eg 10.0.0.0/16)" -ForegroundColor Yellow
 return $false
 }

 # Check subnet overlaps
 if ($azParams.infrastructure.subnets) {
 $subnetsHash = @{}
 foreach ($property in $azParams.infrastructure.subnets.PSObject.Properties) {
 $subnetsHash[$property.Name] = $property.Value
 }

 if (-not (Test-SubnetOverlap -VNetCIDR $vnetCIDR -Subnets $subnetsHash)) {
 return $false
 }
 }
 }

 # Validate storage account naming if storage is configured
 if ($azParams.naming.storageAccount) {
 $saName = ($azParams.naming.storageAccount.prefix + $azParams.baseObjectName + $azParams.naming.storageAccount.suffix).ToLower() -replace '[^a-z0-9]', ''
 if ($saName.Length -gt 24) {
 $saName = $saName.Substring(0, 24)
 }

 if (-not (Test-StorageAccountName -Name $saName)) {
 return $false
 }
 }

 # Validate ADX configuration if enabled
 if ($azParams.analytics.adx.enabled) {
 $adxSKU = $azParams.analytics.adx.cluster.sku.name
 if (-not (Test-ADXClusterSKU -SKU $adxSKU)) {
 return $false
 }
 }

 # Validate Event Hub configuration if enabled
 if ($azParams.analytics.eventHub.enabled) {
 foreach ($hubProperty in $azParams.analytics.eventHub.hubs.PSObject.Properties) {
 $hub = $hubProperty.Value
 if ($hub.partitionCount) {
 if (-not (Test-EventHubPartitionCount -PartitionCount $hub.partitionCount)) {
 Write-Host " Hub: $($hubProperty.Name)" -ForegroundColor Gray
 return $false
 }
 }
 }
 }

 # Validate Azure permissions (unless explicitly skipped)
 $skipPermissions = $false
 if ($OperationParams -and $OperationParams.validation -and $OperationParams.validation.skipPermissionsCheck) {
 $skipPermissions = $OperationParams.validation.skipPermissionsCheck
 Write-Host "`n Skipping permissions validation (skipPermissionsCheck = true)" -ForegroundColor Yellow
 }

 if (-not $skipPermissions) {
 if (-not (Test-AzurePermissions -SubscriptionId $azParams.subscriptionId -ResourceGroupName $azParams.resourceGroupName -AzureParams $azParams)) {
 return $false
 }
 }

 Write-Host "`n[OK] Configuration validation passed!" -ForegroundColor Green
 return $true
}

# Function to validate Azure permissions
function Test-AzurePermissions {
 param(
 [Parameter(Mandatory=$true)]
 [string]$SubscriptionId,

 [Parameter(Mandatory=$true)]
 [string]$ResourceGroupName,

 [Parameter(Mandatory=$true)]
 [PSCustomObject]$AzureParams
 )

 Write-Host "`n Validating Azure permissions..." -ForegroundColor Cyan

 # Check if user is logged in to Azure
 try {
 $context = Get-AzContext -ErrorAction Stop
 if ($null -eq $context -or $null -eq $context.Account) {
 Write-Host " ERROR: Not logged in to Azure" -ForegroundColor Red
 Write-Host " Please run: Connect-AzAccount" -ForegroundColor Yellow
 return $false
 }
 Write-Host " Logged in as: $($context.Account.Id)" -ForegroundColor Gray
 } catch {
 Write-Host " ERROR: Unable to get Azure context" -ForegroundColor Red
 Write-Host " Please run: Connect-AzAccount" -ForegroundColor Yellow
 return $false
 }

 # Check if subscription is accessible
 try {
 $subscription = Get-AzSubscription -SubscriptionId $SubscriptionId -ErrorAction Stop
 Write-Host " Subscription: $($subscription.Name)" -ForegroundColor Gray
 } catch {
 Write-Host " ERROR: Cannot access subscription: $SubscriptionId" -ForegroundColor Red
 Write-Host " Verify subscription ID and permissions" -ForegroundColor Yellow
 return $false
 }

 # Set context to the subscription
 try {
 Set-AzContext -SubscriptionId $SubscriptionId -ErrorAction Stop | Out-Null
 } catch {
 Write-Host " ERROR: Cannot set context to subscription: $SubscriptionId" -ForegroundColor Red
 return $false
 }

 # Get current user's role assignments at subscription level
 # Use simpler approach - get all assignments for current user
 $currentUserObjectId = $null
 try {
 $currentUser = Get-AzADUser -UserPrincipalName $context.Account.Id -ErrorAction SilentlyContinue
 if ($currentUser) {
 $currentUserObjectId = $currentUser.Id
 }
 } catch {
 # User lookup may fail, continue with other methods
 }

 $subRoleAssignments = Get-AzRoleAssignment -Scope "/subscriptions/$SubscriptionId" -ErrorAction SilentlyContinue

 # Filter for current user using multiple properties
 $userSubAssignments = $subRoleAssignments | Where-Object {
 ($_.SignInName -and $_.SignInName -eq $context.Account.Id) -or
 ($_.DisplayName -and $_.DisplayName -eq $context.Account.Id) -or
 ($currentUserObjectId -and $_.ObjectId -eq $currentUserObjectId)
 }

 $subRoles = $userSubAssignments | Select-Object -ExpandProperty RoleDefinitionName -Unique

 if ($subRoles.Count -gt 0) {
 Write-Host " Subscription roles: $($subRoles -join ', ')" -ForegroundColor Gray
 } else {
 Write-Host " Subscription roles: None" -ForegroundColor Gray
 }

 # Check if resource group exists and get RG-level permissions
 $resourceGroup = Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction SilentlyContinue
 $rgRoles = @()

 if ($resourceGroup) {
 Write-Host " Resource Group exists: $ResourceGroupName" -ForegroundColor Gray

 # Get ALL role assignments for the RG (including inherited from subscription)
 $rgRoleAssignments = Get-AzRoleAssignment -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue

 Write-Host " Debug: Total RG assignments: $($rgRoleAssignments.Count)" -ForegroundColor DarkGray
 Write-Host " Debug: Current user: $($context.Account.Id)" -ForegroundColor DarkGray
 Write-Host " Debug: Current user ObjectId: $currentUserObjectId" -ForegroundColor DarkGray

 # Show assignments that might match current user (direct or group)
 Write-Host " Debug: Checking for group memberships..." -ForegroundColor DarkGray

 # Get user's group memberships
 $userGroups = @()
 try {
 $userGroupMemberships = Get-AzADUser -UserPrincipalName $context.Account.Id -ErrorAction SilentlyContinue |
 Get-AzADGroup -ErrorAction SilentlyContinue
 if ($userGroupMemberships) {
 $userGroups = $userGroupMemberships | Select-Object -ExpandProperty Id
 Write-Host " Debug: User is member of $($userGroups.Count) groups" -ForegroundColor DarkGray
 }
 } catch {
 Write-Host " Debug: Could not retrieve group memberships" -ForegroundColor DarkGray
 }

 # Filter to current user (direct assignment OR group assignment)
 $userRgAssignments = $rgRoleAssignments | Where-Object {
 # Direct user assignment
 (($_.SignInName -and $_.SignInName -eq $context.Account.Id) -or
 ($_.DisplayName -and $_.DisplayName -eq $context.Account.Id) -or
 ($currentUserObjectId -and $_.ObjectId -eq $currentUserObjectId)) -or
 # Group assignment
 ($_.ObjectType -eq 'Group' -and $userGroups -contains $_.ObjectId)
 }

 Write-Host " Debug: Found $($userRgAssignments.Count) RG role assignments (direct or via groups)" -ForegroundColor DarkGray

 if ($userRgAssignments -and $userRgAssignments.Count -gt 0) {
 foreach ($assignment in $userRgAssignments) {
 Write-Host " Debug: - Role: $($assignment.RoleDefinitionName), Type: $($assignment.ObjectType), Display: $($assignment.DisplayName)" -ForegroundColor DarkGray
 }
 }

 if ($userRgAssignments -and $userRgAssignments.Count -gt 0) {
 $rgRoles = $userRgAssignments | Select-Object -ExpandProperty RoleDefinitionName -Unique
 Write-Host " RG-level roles: $($rgRoles -join ', ')" -ForegroundColor Gray
 } else {
 Write-Host " RG-level roles: None found" -ForegroundColor Gray
 }
 } else {
 Write-Host " Resource Group will be created: $ResourceGroupName" -ForegroundColor Gray
 }

 # Combine subscription and RG roles
 $allRoles = @()
 if ($subRoles) { $allRoles += $subRoles }
 if ($rgRoles) { $allRoles += $rgRoles }
 $allRoles = $allRoles | Select-Object -Unique

 # Required permissions for deployment
 $permissionIssues = @()
 $warnings = @()

 # Check for Owner or Contributor role (at subscription OR resource group level)
 $hasContributor = ($allRoles -contains "Owner") -or ($allRoles -contains "Contributor")

 # Debug output
 Write-Host " Debug: allRoles = $($allRoles -join ', ')" -ForegroundColor DarkGray
 Write-Host " Debug: hasContributor = $hasContributor" -ForegroundColor DarkGray

 # If RG doesn't exist, need subscription-level permissions to create it
 if (-not $resourceGroup) {
 $canCreateRG = $subRoles -contains "Owner" -or $subRoles -contains "Contributor"
 if (-not $canCreateRG) {
 $permissionIssues += "Resource Group doesn't exist - need 'Contributor' or 'Owner' at subscription level to create it"
 }
 }

 # If RG exists but no contributor access anywhere
 if (-not $hasContributor) {
 $permissionIssues += "Missing 'Contributor' or 'Owner' role at subscription or resource group level"
 }

 # Check for User Access Administrator (required for role assignments)
 $hasUserAccessAdmin = $allRoles -contains "Owner" -or $allRoles -contains "User Access Administrator"
 if (-not $hasUserAccessAdmin) {
 $warnings += "Missing 'User Access Administrator' role - cannot assign roles to managed identities"
 }

 # Check for Network Contributor (helpful for VNet/VPN operations)
 if (-not ($allRoles -contains "Owner" -or $allRoles -contains "Contributor" -or $allRoles -contains "Network Contributor")) {
 $warnings += "Consider 'Network Contributor' role for VNet/VPN operations"
 }

 # Validate specific component permissions based on what's enabled

 # ADX requires specific permissions
 if ($AzureParams.analytics.adx.enabled) {
 # ADX deployment requires Contributor at minimum
 if (-not $hasContributor) {
 $permissionIssues += "Azure Data Explorer deployment requires 'Contributor' role"
 }
 }

 # Sentinel requires Security Admin or specific Sentinel roles
 if ($AzureParams.monitoring.sentinel.enabled) {
 $hasSentinelRole = $allRoles -contains "Owner" -or
 $allRoles -contains "Contributor" -or
 $allRoles -contains "Azure Sentinel Contributor" -or
 $allRoles -contains "Security Admin"

 if (-not $hasSentinelRole) {
 $warnings += "Sentinel deployment may require 'Azure Sentinel Contributor' or 'Security Admin' role"
 }
 }

 # Flow Logs require Network Contributor
 if ($AzureParams.monitoring.flowLogging.enabled) {
 $hasNetworkRole = $allRoles -contains "Owner" -or
 $allRoles -contains "Contributor" -or
 $allRoles -contains "Network Contributor"

 if (-not $hasNetworkRole) {
 $warnings += "Flow Logs deployment may require 'Network Contributor' role"
 }
 }

 # Private Link requires Network Contributor and DNS Zone Contributor
 if ($AzureParams.monitoring.privateLink.enabled -or
 ($AzureParams.analytics.eventHub.privateEndpoints -and $AzureParams.analytics.eventHub.privateEndpoints.enabled) -or
 ($AzureParams.storage.privateEndpoints -and $AzureParams.storage.privateEndpoints.enabled)) {

 $hasNetworkRole = $allRoles -contains "Owner" -or
 $allRoles -contains "Contributor" -or
 $allRoles -contains "Network Contributor"

 if (-not $hasNetworkRole) {
 $warnings += "Private Link/Endpoints deployment may require 'Network Contributor' role"
 }
 }

 # Display results
 if ($permissionIssues.Count -gt 0) {
 Write-Host "`n PERMISSION ERRORS:" -ForegroundColor Red
 foreach ($issue in $permissionIssues) {
 Write-Host " - $issue" -ForegroundColor Red
 }
 Write-Host "`n Required Actions:" -ForegroundColor Yellow
 Write-Host " 1. Contact your Azure administrator" -ForegroundColor White
 if (-not $resourceGroup) {
 Write-Host " 2. Request 'Contributor' role at subscription level (to create resource group)" -ForegroundColor White
 Write-Host " 3. Or create the resource group manually, then request 'Contributor' at RG level" -ForegroundColor White
 } else {
 Write-Host " 2. Request 'Contributor' role at resource group level: $ResourceGroupName" -ForegroundColor White
 }
 Write-Host " Alternatively: Request 'Owner' role for full deployment capabilities" -ForegroundColor White
 return $false
 }

 if ($warnings.Count -gt 0) {
 Write-Host "`n PERMISSION WARNINGS:" -ForegroundColor Yellow
 foreach ($warning in $warnings) {
 Write-Host " - $warning" -ForegroundColor Yellow
 }
 Write-Host "`n These warnings may not prevent deployment, but some features might fail." -ForegroundColor Gray
 Write-Host " If you encounter errors, request the additional roles mentioned above." -ForegroundColor Gray
 }

 Write-Host "`n[OK] Permissions validation passed!" -ForegroundColor Green
 return $true
}

# Functions are available via dot-sourcing
# No Export-ModuleMember needed for .ps1 script files

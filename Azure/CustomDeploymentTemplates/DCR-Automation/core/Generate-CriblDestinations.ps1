# Generate Cribl Sentinel Destination Configuration Files - FIXED VERSION
# This script creates individual Cribl destination configs for each DCR
# Based on dst-cribl-template.json with auth from azure-parameters.json and naming from cribl-parameters.json
# Maintains exact template structure and field order
# FIXED: Properly handles DCE endpoints and removes handler.control

[CmdletBinding()]
param(
 [Parameter(Mandatory=$false)]
 [string]$CriblConfigFile = "cribl-dcr-configs\cribl-dcr-config.json",

 [Parameter(Mandatory=$false)]
 [string]$TemplateFile = "dst-cribl-template.json",

 [Parameter(Mandatory=$false)]
 [string]$AzureParametersFile = "azure-parameters.json",

 [Parameter(Mandatory=$false)]
 [string]$CriblParametersFile = "cribl-parameters.json",

 [Parameter(Mandatory=$false)]
 [string]$OutputDirectory = "cribl-dcr-configs",

 [Parameter(Mandatory=$false)]
 [switch]$ShowConfig = $false,

 [Parameter(Mandatory=$false)]
 [switch]$ShowDebug = $false
)

# Import Output-Helper for consistent verbosity control
. (Join-Path $PSScriptRoot "Output-Helper.ps1")

# Set verbose output mode based on PowerShell's built-in VerbosePreference
$isVerbose = ($VerbosePreference -eq 'Continue') -or ($PSBoundParameters.ContainsKey('Verbose'))
Set-DCRVerboseOutput -Enabled $isVerbose

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Function to fix handler.control endpoints
function Fix-HandlerControlEndpoint {
 param(
 [string]$Endpoint,
 [string]$DCEName,
 [string]$Location
 )
 
 if ($Endpoint -match "handler\.control") {
 Write-DCRWarning " Detected handler.control endpoint, fixing..."
 
 # Pattern 1: https://dce-jp-cloudflare-eastus-5som.eastus-1.handler.control.monitor.azure.com
 if ($Endpoint -match "https://([^.]+)\.([^.]+)-[0-9]+\.handler\.control\.monitor\.azure\.com") {
 $dceFullName = $matches[1]
 $locationBase = $matches[2]
 # Construct the correct ingestion endpoint
 $fixedEndpoint = "https://$dceFullName.$locationBase-1.ingest.monitor.azure.com"
 Write-DCRSuccess " Fixed to: $fixedEndpoint"
 return $fixedEndpoint
 }
 # Pattern 2: Without -1 in location
 elseif ($Endpoint -match "https://([^.]+)\.([^.]+)\.handler\.control\.monitor\.azure\.com") {
 $dceFullName = $matches[1]
 $locationPart = $matches[2]
 # Remove any -N suffix and add -1 for ingest
 $locationBase = $locationPart -replace '-[0-9]+$', ''
 $fixedEndpoint = "https://$dceFullName.$locationBase-1.ingest.monitor.azure.com"
 Write-DCRSuccess " Fixed to: $fixedEndpoint"
 return $fixedEndpoint
 }
 }
 
 # If not a handler.control endpoint or couldn't fix, return original
 return $Endpoint
}

# Function to get Direct DCR ingestion endpoint
function Get-DirectDCRIngestionEndpoint {
 param(
 [string]$SubscriptionId,
 [string]$ResourceGroupName,
 [string]$DCRName,
 [bool]$Debug = $false
 )
 
 try {
 # Build the resource ID
 $resourceId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.Insights/dataCollectionRules/$DCRName"
 
 # Use Invoke-AzRestMethod to get the full DCR details
 $restPath = "$resourceId`?api-version=2023-03-11"
 
 if ($Debug) {
 Write-DCRVerbose " Debug: Using Invoke-AzRestMethod with path: $restPath"
 }
 
 $restResponse = Invoke-AzRestMethod -Path $restPath -Method GET
 
 if ($restResponse.StatusCode -eq 200) {
 $dcrData = $restResponse.Content | ConvertFrom-Json
 
 # First check if this is actually a Direct DCR
 if ($dcrData.kind -ne "Direct") {
 if ($dcrData.properties -and $dcrData.properties.dataCollectionEndpointId) {
 return @{
 Success = $false
 IsDCEBased = $true
 DCEId = $dcrData.properties.dataCollectionEndpointId
 Kind = $dcrData.kind
 }
 }
 }
 
 # For Direct DCRs, the endpoint should be in properties.endpoints.logsIngestion
 $endpoint = $null
 
 # Try multiple possible locations for the endpoint
 $possiblePaths = @(
 { $dcrData.properties.endpoints.logsIngestion },
 { $dcrData.properties.logsIngestion.endpoint },
 { $dcrData.properties.destinations.logAnalytics[0].endpoint }
 )
 
 foreach ($pathFunc in $possiblePaths) {
 try {
 $testEndpoint = & $pathFunc
 if ($testEndpoint) {
 $endpoint = $testEndpoint
 if ($Debug) {
 Write-DCRSuccess " Debug: Found endpoint: $endpoint"
 }
 break
 }
 } catch {
 # Path doesn't exist, continue
 }
 }
 
 if ($endpoint) {
 # Check if this is a generic regional endpoint
 $location = $dcrData.location.Replace(' ', '').ToLower()
 $genericEndpoint = "https://${location}.ingest.monitor.azure.com"
 
 if ($endpoint -eq $genericEndpoint) {
 return @{
 Success = $false
 Message = "Retrieved endpoint is generic regional, not Direct DCR specific"
 GenericEndpoint = $endpoint
 }
 }
 
 return @{
 Success = $true
 Endpoint = $endpoint
 IsDCEBased = $false
 }
 } else {
 return @{
 Success = $false
 Message = "No ingestion endpoint found in Direct DCR properties"
 }
 }
 
 } else {
 return @{
 Success = $false
 Message = "API returned status $($restResponse.StatusCode)"
 }
 }
 
 } catch {
 return @{
 Success = $false
 Message = $_.Exception.Message
 }
 }
}

# Function to generate Cribl destination config from template
function New-CriblDestinationConfig {
 param(
 [object]$DCRInfo,
 [string]$TemplateContent,
 [object]$AzureParams,
 [object]$CriblParams,
 [bool]$DebugMode = $false
 )
 
 # Generate the destination ID using Cribl parameters
 # Extract actual table name from DCR name (format: dcr-<TableName>-<Location>)
 $actualTableName = if ($DCRInfo.TableName -and $DCRInfo.TableName -ne '') {
 $DCRInfo.TableName -replace '_CL$', '' -replace '[^a-zA-Z0-9]', '_'
 } else {
 # Extract from DCR name if table name not available
 $parts = $DCRInfo.DCRName -split '-'
 if ($parts.Count -ge 2) {
 # For dcr-SecurityEvent-eastus, extract SecurityEvent
 $parts[1]
 } else {
 $DCRInfo.DCRName
 }
 }

 # Create unique destination ID per table (not per region)
 $destinationId = "$($CriblParams.IDprefix)$($actualTableName)$($CriblParams.IDsuffix)"
 
 # Work directly with the template string to preserve order
 $configContent = $TemplateContent
 
 if ($DebugMode) {
 Write-DCRInfo " Debug: Starting replacements for $destinationId" -Color Magenta
 }
 
 # Fix handler.control in ingestion endpoint if present
 if ($DCRInfo.IngestionEndpoint -match "handler\.control") {
 $DCRInfo.IngestionEndpoint = Fix-HandlerControlEndpoint -Endpoint $DCRInfo.IngestionEndpoint -DCEName "" -Location ""
 }
 
 # Replace placeholders in the template
 $configContent = $configContent -replace '<CriblSentinelDestinationName>', $destinationId
 $configContent = $configContent -replace '<Ingestion URL>', $DCRInfo.IngestionEndpoint
 $configContent = $configContent -replace '<dcr Immutable ID>', $DCRInfo.DCRImmutableId
 $configContent = $configContent -replace '<Stream Name>', $DCRInfo.StreamName
 
 # Extract just the host from the ingestion endpoint
 $endpointUri = [System.Uri]$DCRInfo.IngestionEndpoint
 $endpointHost = $endpointUri.Host
 
 # Replace the <dce ingestion url> placeholder with the actual host
 $configContent = $configContent -replace '<dce ingestion url>', $endpointHost
 
 # Replace the <dcr immutable id> in the URL
 $configContent = $configContent -replace '<dcr immutable id>', $DCRInfo.DCRImmutableId
 
 # Replace the <stream name> in the URL
 $configContent = $configContent -replace '<stream name>', $DCRInfo.StreamName
 
 # Handle authentication parameters from Azure parameters
 # Client ID
 if ($AzureParams.clientId -and $AzureParams.clientId -ne "YOUR-CLIENT-ID-HERE") {
 $configContent = $configContent -replace "'replaceme'", "'$($AzureParams.clientId)'"
 }
 
 # Client Secret - Always use <replace me> placeholder
 $configContent = $configContent -replace '"secret":\s*"replaceme"', '"secret": "<replace me>"'
 
 # Tenant ID
 if ($AzureParams.tenantId -and $AzureParams.tenantId -ne "YOUR-TENANT-ID-HERE") {
 $configContent = $configContent -replace '<TenantID>', $AzureParams.tenantId
 }
 
 # Create metadata for separate file
 $metadata = @{
 GeneratedFrom = @{
 DCRName = $DCRInfo.DCRName
 TableName = $DCRInfo.TableName
 Type = $DCRInfo.Type
 GeneratedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
 }
 }
 
 return @{
 ConfigContent = $configContent
 Metadata = $metadata
 FileName = "$destinationId.json"
 }
}

Write-DCRInfo "Starting Cribl Sentinel Destination Configuration Generation (FIXED VERSION)..." -Color Cyan
Write-Host $("="*60) -ForegroundColor Cyan

if ($ShowDebug) {
 Write-DCRInfo "Debug mode enabled" -Color Magenta
}

# Load the DCR configuration
$criblConfigPath = Join-Path $ScriptDirectory $CriblConfigFile
if (-not (Test-Path $criblConfigPath)) {
 Write-DCRError " Cribl DCR configuration file not found: $criblConfigPath"
 Write-DCRWarning "Run deployment first: .\Run-DCRAutomation.ps1 -Mode DirectBoth"
 exit 1
}

Write-DCRWarning "Loading DCR configuration..."
$criblConfig = Get-Content $criblConfigPath -Raw | ConvertFrom-Json

# Load the template as raw text to preserve structure
$templatePath = Join-Path $ScriptDirectory $TemplateFile
if (-not (Test-Path $templatePath)) {
 Write-DCRError " Template file not found: $templatePath"
 exit 1
}

Write-DCRWarning "Loading template..."
$templateContent = Get-Content $templatePath -Raw

# Load Azure parameters
$azureParamsPath = Join-Path $ScriptDirectory $AzureParametersFile
if (-not (Test-Path $azureParamsPath)) {
 Write-DCRError " Azure parameters file not found: $azureParamsPath"
 exit 1
}

Write-DCRWarning "Loading Azure parameters..."
$azureParams = Get-Content $azureParamsPath -Raw | ConvertFrom-Json

# Load Cribl parameters
$criblParamsPath = Join-Path $ScriptDirectory $CriblParametersFile
if (-not (Test-Path $criblParamsPath)) {
 Write-DCRError " Cribl parameters file not found: $criblParamsPath"
 exit 1
}

Write-DCRWarning "Loading Cribl parameters..."
$criblParams = Get-Content $criblParamsPath -Raw | ConvertFrom-Json

# Display loaded parameters
Write-DCRInfo "`nLoaded Configuration:" -Color Cyan
Write-DCRProgress " Azure Parameters:"
Write-DCRVerbose " Resource Group: $($azureParams.resourceGroupName)"
Write-DCRVerbose " Workspace: $($azureParams.workspaceName)"
Write-DCRVerbose " Location: $($azureParams.location)"
Write-Host " Tenant ID: $(if ($azureParams.tenantId -and $azureParams.tenantId -ne 'YOUR-TENANT-ID-HERE') { "Configured " } else { 'Not configured ' })" -ForegroundColor Gray
Write-Host " Client ID: $(if ($azureParams.clientId -and $azureParams.clientId -ne 'YOUR-CLIENT-ID-HERE') { "Configured " } else { 'Not configured ' })" -ForegroundColor Gray
Write-DCRVerbose " Client Secret: <replace me> placeholder (configured in Cribl Stream)"

# Check for required authentication parameters
$authWarning = $false
if ($azureParams.tenantId -eq "YOUR-TENANT-ID-HERE" -or [string]::IsNullOrWhiteSpace($azureParams.tenantId)) {
 Write-DCRWarning "`n Tenant ID not configured in azure-parameters.json"
 $authWarning = $true
}
if ($azureParams.clientId -eq "YOUR-CLIENT-ID-HERE" -or [string]::IsNullOrWhiteSpace($azureParams.clientId)) {
 Write-DCRWarning " Client ID not configured in azure-parameters.json"
 $authWarning = $true
}
# Client Secret is now always set to <replace me> placeholder
Write-DCRInfo " Client Secret will be set to '<replace me>' placeholder for manual configuration in Cribl Stream" -Color Cyan

# Create output directories
$outputPath = Join-Path $ScriptDirectory $OutputDirectory
if (-not (Test-Path $outputPath)) {
 New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
 Write-DCRSuccess "Created output directory: $OutputDirectory"
}

$destConfigPath = Join-Path $outputPath "destinations"
if (-not (Test-Path $destConfigPath)) {
 New-Item -ItemType Directory -Path $destConfigPath -Force | Out-Null
 Write-DCRSuccess "Created destinations directory: $OutputDirectory\destinations"
}

Write-DCRInfo "`nGenerating Cribl destination configurations..." -Color Cyan
Write-Host $("-"*60) -ForegroundColor Gray

# Check Azure context
$context = Get-AzContext
if (-not $context) {
 Write-DCRWarning " No Azure context. Run Connect-AzAccount first."
 Write-DCRVerbose " Will use endpoints from config file (may need fixing)"
}

$successCount = 0
$skipCount = 0
$configs = @()
$allMetadata = @{}

foreach ($dcr in $criblConfig.DCRs) {
 Write-DCRProgress "`n Processing: $($dcr.DCRName)"
 Write-DCRVerbose " Type: $($dcr.Type)"

 # Fix missing StreamName/TableName by extracting from DCR name
 if (-not $dcr.StreamName -or -not $dcr.TableName) {
 Write-DCRWarning " Missing StreamName/TableName, attempting to extract from DCR name..."

 # Extract table name from DCR name (e.g., "dcr-jp-SecurityEvent-eastus" -> "SecurityEvent")
 $tableName = ""
 if ($dcr.DCRName -match '^dcr-[^-]+-([^-]+)-[^-]+$') {
 $tableName = $matches[1]
 Write-DCRSuccess " Extracted table name: $tableName"
 } elseif ($dcr.DCRName -match '^dcr-[^-]+-(.+)-[^-]+$') {
 # Handle abbreviated names like CSL
 $tableName = $matches[1]
 Write-DCRSuccess " Extracted abbreviated name: $tableName"
 } else {
 # Last resort: use full DCR name minus prefix/suffix
 $tableName = $dcr.DCRName -replace '^dcr-[^-]+-', '' -replace '-[^-]+$', ''
 Write-DCRWarning " Using fallback name: $tableName"
 }

 if (-not $dcr.StreamName -and $tableName) {
 $dcr.StreamName = "Custom-$tableName"
 Write-DCRSuccess " Generated StreamName: $($dcr.StreamName)"
 }

 if (-not $dcr.TableName -and $tableName) {
 $dcr.TableName = $tableName
 Write-DCRSuccess " Generated TableName: $($dcr.TableName)"
 }
 }

 # Skip DCRs with missing critical information
 if (-not $dcr.DCRImmutableId -or -not $dcr.StreamName) {
 Write-DCRWarning "⏭ Skipping - missing required information"
 $skipCount++
 continue
 }
 
 try {
 # Try to get the actual ingestion endpoint
 $actualEndpoint = $dcr.IngestionEndpoint
 
 if ($dcr.Type -eq "Direct" -and $context) {
 Write-DCRInfo " Retrieving actual ingestion endpoint for Direct DCR..." -Color Cyan
 
 try {
 $endpointResult = Get-DirectDCRIngestionEndpoint -SubscriptionId $context.Subscription.Id -ResourceGroupName $azureParams.resourceGroupName -DCRName $dcr.DCRName -Debug $ShowDebug
 
 if ($endpointResult.Success) {
 $actualEndpoint = $endpointResult.Endpoint
 Write-DCRSuccess " Retrieved Direct DCR endpoint: $actualEndpoint"
 } elseif ($endpointResult.IsDCEBased) {
 Write-DCRWarning " This appears to be a DCE-based DCR, not Direct"
 $dcr.Type = "DCE-based"
 }
 } catch {
 Write-DCRWarning " Failed to retrieve endpoint: $($_.Exception.Message)"
 }
 } elseif ($dcr.Type -eq "DCE-based") {
 # For DCE-based DCRs, we need to get the DCE's ingestion endpoint
 Write-DCRInfo " Retrieving DCE ingestion endpoint..." -Color Cyan
 
 # First check if we need to fix handler.control
 if ($actualEndpoint -match "handler\.control") {
 $actualEndpoint = Fix-HandlerControlEndpoint -Endpoint $actualEndpoint -DCEName "" -Location ""
 } elseif ($actualEndpoint -eq "[NEEDS MANUAL CONFIGURATION]" -or $actualEndpoint -eq "[DCE RETRIEVAL FAILED]") {
 # Try to retrieve from Azure if we have context
 if ($context) {
 # Extract DCE name from DCR name pattern
 if ($dcr.DCRName -match "dcr-.*-([^-]+)-") {
 $tablePart = $matches[1]
 $dcePrefix = if ($azureParams.dcePrefix) { $azureParams.dcePrefix } else { "dce-jp-" }
 $location = if ($azureParams.location) { $azureParams.location } else { "eastus" }
 
 # Try common DCE naming patterns
 $possibleDCENames = @(
 "$dcePrefix$tablePart-$location",
 "$dcePrefix$($tablePart.ToLower())-$location",
 "$dcePrefix$($dcr.TableName -replace '_CL$', '')-$location"
 )
 
 foreach ($dceName in $possibleDCENames) {
 try {
 Write-DCRVerbose " Trying DCE: $dceName"
 $restPath = "/subscriptions/$($context.Subscription.Id)/resourceGroups/$($azureParams.resourceGroupName)/providers/Microsoft.Insights/dataCollectionEndpoints/$dceName`?api-version=2023-03-11"
 $restResponse = Invoke-AzRestMethod -Path $restPath -Method GET
 
 if ($restResponse.StatusCode -eq 200) {
 $dceData = $restResponse.Content | ConvertFrom-Json
 
 # Get the logs ingestion endpoint
 if ($dceData.properties.logsIngestion.endpoint) {
 $actualEndpoint = $dceData.properties.logsIngestion.endpoint
 
 # Fix if it's a handler.control endpoint
 if ($actualEndpoint -match "handler\.control") {
 $actualEndpoint = Fix-HandlerControlEndpoint -Endpoint $actualEndpoint -DCEName $dceName -Location $location
 }
 
 Write-DCRSuccess " Found DCE endpoint: $actualEndpoint"
 break
 }
 }
 } catch {
 # Continue to next possible name
 }
 }
 }
 }
 }
 }
 
 # Final check - if endpoint still has handler.control, fix it
 if ($actualEndpoint -match "handler\.control") {
 Write-DCRWarning " Fixing handler.control endpoint..."
 $actualEndpoint = Fix-HandlerControlEndpoint -Endpoint $actualEndpoint -DCEName "" -Location ""
 }
 
 # Check if we have a valid endpoint
 if ($actualEndpoint -eq "[NEEDS MANUAL CONFIGURATION]" -or 
 $actualEndpoint -eq "[DCE RETRIEVAL FAILED]" -or 
 [string]::IsNullOrWhiteSpace($actualEndpoint)) {
 Write-DCRWarning "⏭ Skipping - ingestion endpoint not available"
 $skipCount++
 continue
 }
 
 # Update DCR info with actual endpoint
 $dcrInfoWithActualEndpoint = $dcr.PSObject.Copy()
 $dcrInfoWithActualEndpoint.IngestionEndpoint = $actualEndpoint
 
 # Generate the configuration
 $result = New-CriblDestinationConfig -DCRInfo $dcrInfoWithActualEndpoint -TemplateContent $templateContent -AzureParams $azureParams -CriblParams $criblParams -DebugMode $ShowDebug
 
 # Save the configuration file
 $configFilePath = Join-Path $destConfigPath $result.FileName
 Set-Content -Path $configFilePath -Value $result.ConfigContent -Encoding UTF8
 
 Write-DCRSuccess " Generated: $($result.FileName)"
 Write-DCRVerbose " Table: $($dcr.TableName)"
 Write-DCRVerbose " Stream: $($dcr.StreamName)"
 Write-DCRVerbose " Endpoint: $actualEndpoint"
 
 # Store metadata
 $destinationId = $result.FileName -replace '\.json$', ''
 $allMetadata[$destinationId] = $result.Metadata
 $allMetadata[$destinationId].GeneratedFrom.ActualEndpoint = $actualEndpoint
 
 $configs += @{
 FileName = $result.FileName
 DestinationId = $destinationId
 TableName = $dcr.TableName
 DCRName = $dcr.DCRName
 Endpoint = $actualEndpoint
 }
 
 $successCount++
 } catch {
 Write-DCRError " Failed to generate config for $($dcr.DCRName): $($_.Exception.Message)"
 }
}

# Create metadata files
$metadataPath = Join-Path $destConfigPath "destinations-metadata.json"
$metadataContent = @{
 GeneratedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
 TotalConfigs = $successCount
 SkippedConfigs = $skipCount
 Parameters = @{
 IDPrefix = $criblParams.IDprefix
 IDSuffix = $criblParams.IDsuffix
 TenantConfigured = ($azureParams.tenantId -ne "YOUR-TENANT-ID-HERE")
 ClientIdConfigured = ($azureParams.clientId -ne "YOUR-CLIENT-ID-HERE")
 ClientSecretConfigured = $true # Always true since we use <replace me> placeholder
 }
 Destinations = $allMetadata
}

$metadataContent | ConvertTo-Json -Depth 10 | Set-Content $metadataPath -Encoding UTF8

# Create summary file
$summaryPath = Join-Path $destConfigPath "destinations-summary.json"
$summary = @{
 GeneratedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
 TotalConfigs = $successCount
 SkippedConfigs = $skipCount
 ConfiguredAuthentication = (-not $authWarning)
 Destinations = $configs
}

$summary | ConvertTo-Json -Depth 10 | Set-Content $summaryPath -Encoding UTF8

Write-Host "`n"
Write-Host $("="*60) -ForegroundColor Cyan
Write-DCRInfo "SUMMARY" -Color Cyan
Write-Host $("="*60) -ForegroundColor Cyan
Write-DCRSuccess " Successfully generated: $successCount configuration(s)"
if ($skipCount -gt 0) {
 Write-DCRWarning "⏭ Skipped: $skipCount configuration(s)"
}
Write-DCRInfo "`n Output location: $destConfigPath" -Color Cyan

Write-DCRInfo "`n Authentication Status:" -Color Cyan
if (-not $authWarning) {
 Write-DCRSuccess " All authentication parameters configured"
} else {
 Write-DCRWarning " Authentication parameters need configuration"
 Write-DCRVerbose " Update azure-parameters.json and re-run this script"
}

Write-DCRInfo "`n Note: This fixed version properly handles DCE endpoints" -Color Cyan
Write-DCRVerbose " - Removes handler.control from endpoints"
Write-DCRVerbose " - Constructs correct ingest.monitor.azure.com URLs"

Write-DCRSuccess "`n Done!"

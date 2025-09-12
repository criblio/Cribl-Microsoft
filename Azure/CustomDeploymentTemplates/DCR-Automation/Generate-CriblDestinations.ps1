# Generate Cribl Sentinel Destination Configuration Files - FIXED VERSION
# This script creates individual Cribl destination configs for each DCR
# Based on dst-cribl-template.json with auth from azure-parameters.json and naming from cribl-parameters.json
# Maintains exact template structure and field order
# FIXED: Properly handles DCE endpoints and removes handler.control

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

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Function to fix handler.control endpoints
function Fix-HandlerControlEndpoint {
    param(
        [string]$Endpoint,
        [string]$DCEName,
        [string]$Location
    )
    
    if ($Endpoint -match "handler\.control") {
        Write-Host "      ⚠ Detected handler.control endpoint, fixing..." -ForegroundColor Yellow
        
        # Pattern 1: https://dce-jp-cloudflare-eastus-5som.eastus-1.handler.control.monitor.azure.com
        if ($Endpoint -match "https://([^.]+)\.([^.]+)-[0-9]+\.handler\.control\.monitor\.azure\.com") {
            $dceFullName = $matches[1]
            $locationBase = $matches[2]
            # Construct the correct ingestion endpoint
            $fixedEndpoint = "https://$dceFullName.$locationBase-1.ingest.monitor.azure.com"
            Write-Host "      ✓ Fixed to: $fixedEndpoint" -ForegroundColor Green
            return $fixedEndpoint
        }
        # Pattern 2: Without -1 in location
        elseif ($Endpoint -match "https://([^.]+)\.([^.]+)\.handler\.control\.monitor\.azure\.com") {
            $dceFullName = $matches[1]
            $locationPart = $matches[2]
            # Remove any -N suffix and add -1 for ingest
            $locationBase = $locationPart -replace '-[0-9]+$', ''
            $fixedEndpoint = "https://$dceFullName.$locationBase-1.ingest.monitor.azure.com"
            Write-Host "      ✓ Fixed to: $fixedEndpoint" -ForegroundColor Green
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
            Write-Host "   Debug: Using Invoke-AzRestMethod with path: $restPath" -ForegroundColor DarkGray
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
                            Write-Host "   Debug: Found endpoint: $endpoint" -ForegroundColor Green
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
    $tableName = if ($DCRInfo.TableName) { 
        $DCRInfo.TableName -replace '_CL$', '' -replace '[^a-zA-Z0-9]', '_'
    } else {
        # Extract from DCR name if table name not available
        $parts = $DCRInfo.DCRName -split '-'
        if ($parts.Count -ge 3) { $parts[2] } else { $DCRInfo.DCRName }
    }
    
    $destinationId = "$($CriblParams.IDprefix)$($tableName.ToLower())$($CriblParams.IDsuffix)"
    
    # Work directly with the template string to preserve order
    $configContent = $TemplateContent
    
    if ($DebugMode) {
        Write-Host "   Debug: Starting replacements for $destinationId" -ForegroundColor Magenta
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
        $configContent = $configContent -replace "'replaceme'", $AzureParams.clientId
    }
    
    # Client Secret
    if ($AzureParams.clientSecret -and $AzureParams.clientSecret -ne "YOUR-CLIENT-SECRET-HERE") {
        $configContent = $configContent -replace '"secret":\s*"replaceme"', "`"secret`": `"$($AzureParams.clientSecret)`""
    }
    
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

Write-Host "Starting Cribl Sentinel Destination Configuration Generation (FIXED VERSION)..." -ForegroundColor Cyan
Write-Host "="*60 -ForegroundColor Cyan

if ($ShowDebug) {
    Write-Host "Debug mode enabled" -ForegroundColor Magenta
}

# Load the DCR configuration
$criblConfigPath = Join-Path $ScriptDirectory $CriblConfigFile
if (-not (Test-Path $criblConfigPath)) {
    Write-Host "❌ Cribl DCR configuration file not found: $criblConfigPath" -ForegroundColor Red
    Write-Host "Run deployment first: .\Run-DCRAutomation.ps1 -Mode DirectBoth" -ForegroundColor Yellow
    exit 1
}

Write-Host "Loading DCR configuration..." -ForegroundColor Yellow
$criblConfig = Get-Content $criblConfigPath -Raw | ConvertFrom-Json

# Load the template as raw text to preserve structure
$templatePath = Join-Path $ScriptDirectory $TemplateFile
if (-not (Test-Path $templatePath)) {
    Write-Host "❌ Template file not found: $templatePath" -ForegroundColor Red
    exit 1
}

Write-Host "Loading template..." -ForegroundColor Yellow
$templateContent = Get-Content $templatePath -Raw

# Load Azure parameters
$azureParamsPath = Join-Path $ScriptDirectory $AzureParametersFile
if (-not (Test-Path $azureParamsPath)) {
    Write-Host "❌ Azure parameters file not found: $azureParamsPath" -ForegroundColor Red
    exit 1
}

Write-Host "Loading Azure parameters..." -ForegroundColor Yellow
$azureParams = Get-Content $azureParamsPath -Raw | ConvertFrom-Json

# Load Cribl parameters
$criblParamsPath = Join-Path $ScriptDirectory $CriblParametersFile
if (-not (Test-Path $criblParamsPath)) {
    Write-Host "❌ Cribl parameters file not found: $criblParamsPath" -ForegroundColor Red
    exit 1
}

Write-Host "Loading Cribl parameters..." -ForegroundColor Yellow
$criblParams = Get-Content $criblParamsPath -Raw | ConvertFrom-Json

# Display loaded parameters
Write-Host "`nLoaded Configuration:" -ForegroundColor Cyan
Write-Host "  Azure Parameters:" -ForegroundColor White
Write-Host "    Resource Group: $($azureParams.resourceGroupName)" -ForegroundColor Gray
Write-Host "    Workspace: $($azureParams.workspaceName)" -ForegroundColor Gray
Write-Host "    Location: $($azureParams.location)" -ForegroundColor Gray
Write-Host "    Tenant ID: $(if ($azureParams.tenantId -and $azureParams.tenantId -ne 'YOUR-TENANT-ID-HERE') { "Configured ✓" } else { 'Not configured ⚠️' })" -ForegroundColor Gray
Write-Host "    Client ID: $(if ($azureParams.clientId -and $azureParams.clientId -ne 'YOUR-CLIENT-ID-HERE') { "Configured ✓" } else { 'Not configured ⚠️' })" -ForegroundColor Gray
Write-Host "    Client Secret: $(if ($azureParams.clientSecret -and $azureParams.clientSecret -ne 'YOUR-CLIENT-SECRET-HERE') { 'Configured ✓' } else { 'Not configured ⚠️' })" -ForegroundColor Gray

# Check for required authentication parameters
$authWarning = $false
if ($azureParams.tenantId -eq "YOUR-TENANT-ID-HERE" -or [string]::IsNullOrWhiteSpace($azureParams.tenantId)) {
    Write-Host "`n⚠️  Tenant ID not configured in azure-parameters.json" -ForegroundColor Yellow
    $authWarning = $true
}
if ($azureParams.clientId -eq "YOUR-CLIENT-ID-HERE" -or [string]::IsNullOrWhiteSpace($azureParams.clientId)) {
    Write-Host "⚠️  Client ID not configured in azure-parameters.json" -ForegroundColor Yellow
    $authWarning = $true
}
if ($azureParams.clientSecret -eq "YOUR-CLIENT-SECRET-HERE" -or [string]::IsNullOrWhiteSpace($azureParams.clientSecret)) {
    Write-Host "⚠️  Client Secret not configured in azure-parameters.json" -ForegroundColor Yellow
    $authWarning = $true
}

# Create output directories
$outputPath = Join-Path $ScriptDirectory $OutputDirectory
if (-not (Test-Path $outputPath)) {
    New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
    Write-Host "Created output directory: $OutputDirectory" -ForegroundColor Green
}

$destConfigPath = Join-Path $outputPath "destinations"
if (-not (Test-Path $destConfigPath)) {
    New-Item -ItemType Directory -Path $destConfigPath -Force | Out-Null
    Write-Host "Created destinations directory: $OutputDirectory\destinations" -ForegroundColor Green
}

Write-Host "`nGenerating Cribl destination configurations..." -ForegroundColor Cyan
Write-Host "-"*60 -ForegroundColor Gray

# Check Azure context
$context = Get-AzContext
if (-not $context) {
    Write-Host "⚠️  No Azure context. Run Connect-AzAccount first." -ForegroundColor Yellow
    Write-Host "   Will use endpoints from config file (may need fixing)" -ForegroundColor Gray
}

$successCount = 0
$skipCount = 0
$configs = @()
$allMetadata = @{}

foreach ($dcr in $criblConfig.DCRs) {
    Write-Host "`n📌 Processing: $($dcr.DCRName)" -ForegroundColor White
    Write-Host "   Type: $($dcr.Type)" -ForegroundColor Gray
    
    # Skip DCRs with missing critical information
    if (-not $dcr.DCRImmutableId -or -not $dcr.StreamName) {
        Write-Host "⏭️  Skipping - missing required information" -ForegroundColor Yellow
        $skipCount++
        continue
    }
    
    try {
        # Try to get the actual ingestion endpoint
        $actualEndpoint = $dcr.IngestionEndpoint
        
        if ($dcr.Type -eq "Direct" -and $context) {
            Write-Host "   🔍 Retrieving actual ingestion endpoint for Direct DCR..." -ForegroundColor Cyan
            
            try {
                $endpointResult = Get-DirectDCRIngestionEndpoint -SubscriptionId $context.Subscription.Id -ResourceGroupName $azureParams.resourceGroupName -DCRName $dcr.DCRName -Debug $ShowDebug
                
                if ($endpointResult.Success) {
                    $actualEndpoint = $endpointResult.Endpoint
                    Write-Host "   ✅ Retrieved Direct DCR endpoint: $actualEndpoint" -ForegroundColor Green
                } elseif ($endpointResult.IsDCEBased) {
                    Write-Host "   ⚠ This appears to be a DCE-based DCR, not Direct" -ForegroundColor Yellow
                    $dcr.Type = "DCE-based"
                }
            } catch {
                Write-Host "   ⚠ Failed to retrieve endpoint: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        } elseif ($dcr.Type -eq "DCE-based") {
            # For DCE-based DCRs, we need to get the DCE's ingestion endpoint
            Write-Host "   🔍 Retrieving DCE ingestion endpoint..." -ForegroundColor Cyan
            
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
                                Write-Host "   Trying DCE: $dceName" -ForegroundColor DarkGray
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
                                        
                                        Write-Host "   ✓ Found DCE endpoint: $actualEndpoint" -ForegroundColor Green
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
            Write-Host "   ⚠ Fixing handler.control endpoint..." -ForegroundColor Yellow
            $actualEndpoint = Fix-HandlerControlEndpoint -Endpoint $actualEndpoint -DCEName "" -Location ""
        }
        
        # Check if we have a valid endpoint
        if ($actualEndpoint -eq "[NEEDS MANUAL CONFIGURATION]" -or 
            $actualEndpoint -eq "[DCE RETRIEVAL FAILED]" -or 
            [string]::IsNullOrWhiteSpace($actualEndpoint)) {
            Write-Host "⏭️  Skipping - ingestion endpoint not available" -ForegroundColor Yellow
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
        
        Write-Host "✅ Generated: $($result.FileName)" -ForegroundColor Green
        Write-Host "   Table: $($dcr.TableName)" -ForegroundColor Gray
        Write-Host "   Stream: $($dcr.StreamName)" -ForegroundColor Gray
        Write-Host "   Endpoint: $actualEndpoint" -ForegroundColor Gray
        
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
        Write-Host "❌ Failed to generate config for $($dcr.DCRName): $($_.Exception.Message)" -ForegroundColor Red
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
        ClientSecretConfigured = ($azureParams.clientSecret -ne "YOUR-CLIENT-SECRET-HERE")
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
Write-Host "="*60 -ForegroundColor Cyan
Write-Host "SUMMARY" -ForegroundColor Cyan
Write-Host "="*60 -ForegroundColor Cyan
Write-Host "✅ Successfully generated: $successCount configuration(s)" -ForegroundColor Green
if ($skipCount -gt 0) {
    Write-Host "⏭️  Skipped: $skipCount configuration(s)" -ForegroundColor Yellow
}
Write-Host "`n📁 Output location: $destConfigPath" -ForegroundColor Cyan

Write-Host "`n🔐 Authentication Status:" -ForegroundColor Cyan
if (-not $authWarning) {
    Write-Host "✅ All authentication parameters configured" -ForegroundColor Green
} else {
    Write-Host "⚠️  Authentication parameters need configuration" -ForegroundColor Yellow
    Write-Host "   Update azure-parameters.json and re-run this script" -ForegroundColor Gray
}

Write-Host "`n💡 Note: This fixed version properly handles DCE endpoints" -ForegroundColor Cyan
Write-Host "   - Removes handler.control from endpoints" -ForegroundColor Gray
Write-Host "   - Constructs correct ingest.monitor.azure.com URLs" -ForegroundColor Gray

Write-Host "`n✨ Done!" -ForegroundColor Green

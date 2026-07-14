<#
.SYNOPSIS
    Generates Cribl Stream source configurations for Azure Event Hubs.

.DESCRIPTION
    This script discovers Event Hub namespaces created by this solution and generates
    Cribl Stream source configurations for each Event Hub found. The configurations
    use secret references for connection strings - users must create these secrets
    in Cribl Stream manually.

.PARAMETER OutputPath
    Directory where Cribl source configurations will be saved.
    Default: core/cribl-configs/sources

.PARAMETER NamespaceFilter
    Optional filter to limit which namespaces are processed.
    Supports wildcards (e.g., "cribl-*").

.EXAMPLE
    .\Generate-CriblEventHubSources.ps1
    Discovers all Event Hubs and generates Cribl source configurations.

.EXAMPLE
    .\Generate-CriblEventHubSources.ps1 -NamespaceFilter "jp-cribl-diag-*"
    Only processes namespaces matching the filter pattern.

.NOTES
    Secrets Management: This script generates references to secrets that must be
    created manually in Cribl Stream. The secret name format is the namespace name
    (e.g., "jp-cribl-diag-fe6f9921").
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$OutputPath = "",

    [Parameter(Mandatory=$false)]
    [string]$NamespaceFilter = ""
)

# Script variables
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ScriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path

# Import logging helper
$OutputHelperPath = Join-Path $ScriptPath "Output-Helper.ps1"
if (Test-Path $OutputHelperPath) {
    . $OutputHelperPath
}

#region Configuration

# Load azure-parameters.json
$azureParamsFile = Join-Path $ScriptPath "azure-parameters.json"
if (-not (Test-Path $azureParamsFile)) {
    Write-Error "azure-parameters.json not found at: $azureParamsFile"
    exit 1
}

try {
    $azureParams = Get-Content $azureParamsFile -Raw | ConvertFrom-Json
} catch {
    Write-Error "Failed to parse azure-parameters.json: $_"
    exit 1
}

# Set default output path
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $ScriptPath "cribl-configs" "sources"
}

#endregion

#region Helper Functions

function Get-EventHubNamespaces {
    <#
    .SYNOPSIS
        Discovers Event Hub namespaces created by this solution.
    .DESCRIPTION
        Only returns namespaces that match the configured prefix from azure-parameters.json.
        This ensures we only discover namespaces managed by this solution, not unrelated ones.
    #>
    param(
        [Parameter(Mandatory=$false)]
        [string]$Filter = ""
    )

    $resourceGroup = $azureParams.eventHubResourceGroup
    $subscriptionId = $azureParams.eventHubSubscriptionId
    $configuredPrefix = $azureParams.eventHubNamespacePrefix

    # Build list of valid prefixes (configured prefix + XDR prefix for multi-region)
    $validPrefixes = @($configuredPrefix)

    # Check if XDR might use a separate namespace (multi-region mode)
    $resourceCoverageFile = Join-Path $ScriptPath "resource-coverage.json"
    if (Test-Path $resourceCoverageFile) {
        try {
            $coverage = Get-Content $resourceCoverageFile -Raw | ConvertFrom-Json
            if ($coverage.deploymentSettings.mode -eq "MultiRegion") {
                # In multi-region mode, XDR uses separate "cribl-xdr" prefix
                $validPrefixes += "cribl-xdr"
            }
        } catch {
            # Ignore parsing errors
        }
    }

    Write-Step "Discovering Event Hub Namespaces..."
    Write-SubStep "Subscription:   $subscriptionId" "Gray"
    Write-SubStep "Resource Group: $resourceGroup" "Gray"
    Write-SubStep "Namespace Prefixes: $($validPrefixes -join ', ')" "Gray"

    # Set subscription context
    try {
        Set-AzContext -SubscriptionId $subscriptionId -ErrorAction Stop | Out-Null
    }
    catch {
        Write-ErrorMsg "Failed to set subscription context: $_"
        return @()
    }

    # Get Event Hub namespaces matching our configured prefixes
    try {
        # Wrap with @() to ensure array even for single results
        $allNamespaces = @(Get-AzEventHubNamespace -ResourceGroupName $resourceGroup -ErrorAction Stop)

        # Filter to only namespaces matching our prefixes (wrap with @() for consistent array)
        $namespaces = @($allNamespaces | Where-Object {
            $ns = $_
            $matchesPrefix = $false
            foreach ($prefix in $validPrefixes) {
                if ($ns.Name -like "$prefix*") {
                    $matchesPrefix = $true
                    break
                }
            }
            $matchesPrefix
        })

        # Apply additional user filter if provided
        if ($Filter) {
            $namespaces = @($namespaces | Where-Object { $_.Name -like $Filter })
            Write-SubStep "Additional filter applied: $Filter" "Yellow"
        }

        $skippedCount = $allNamespaces.Count - $namespaces.Count
        if ($skippedCount -gt 0) {
            Write-SubStep "Skipped $skippedCount namespace(s) not matching configured prefixes" "DarkGray"
        }

        Write-Success "Found $($namespaces.Count) namespace(s) managed by this solution"
        return $namespaces
    }
    catch {
        Write-ErrorMsg "Failed to get namespaces: $_"
        return @()
    }
}

function Get-EventHubsInNamespace {
    <#
    .SYNOPSIS
        Gets all Event Hubs within a namespace.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$NamespaceName,

        [Parameter(Mandatory=$true)]
        [string]$ResourceGroup
    )

    try {
        # Wrap with @() to ensure array even for single results
        $eventHubs = @(Get-AzEventHub -ResourceGroupName $ResourceGroup -NamespaceName $NamespaceName -ErrorAction Stop)
        return $eventHubs
    }
    catch {
        Write-Warning "Could not get Event Hubs from namespace $NamespaceName : $_"
        return @()
    }
}

function New-CriblEventHubSource {
    <#
    .SYNOPSIS
        Creates a Cribl source configuration for an Event Hub.
    .DESCRIPTION
        Generates a Cribl Stream Event Hub source configuration in the native Kafka-based format.
        The configuration uses SASL/PLAIN authentication - user must paste the connection string.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$NamespaceName,

        [Parameter(Mandatory=$true)]
        [string]$EventHubName,

        [Parameter(Mandatory=$false)]
        [string]$GroupId = "Cribl"
    )

    # Sanitize namespace name for IDs (replace non-alphanumeric with underscore)
    $sanitizedNamespace = $NamespaceName -replace '[^a-zA-Z0-9]', '_'
    $sanitizedEventHub = $EventHubName -replace '[^a-zA-Z0-9]', '_'

    # Generate unique source ID and secret name
    $sourceId = "eh_${sanitizedNamespace}_${sanitizedEventHub}"
    $secretName = "eh_${sanitizedNamespace}_connectionString"

    # Build the broker endpoint (Event Hub namespace FQDN with Kafka port)
    $brokerEndpoint = "$NamespaceName.servicebus.windows.net:9093"

    # Create the Cribl Event Hub source configuration (native Kafka format)
    $sourceConfig = [ordered]@{
        disabled = $false
        sendToRoutes = $true
        pqEnabled = $false
        streamtags = @()
        brokers = @($brokerEndpoint)
        topics = @($EventHubName)
        groupId = $GroupId
        fromBeginning = $true
        connectionTimeout = 10000
        requestTimeout = 60000
        maxRetries = 5
        maxBackOff = 30000
        initialBackoff = 300
        backoffRate = 2
        authenticationTimeout = 10000
        reauthenticationThreshold = 10000
        sasl = [ordered]@{
            disabled = $false
            mechanism = "plain"
            authType = "secret"
            username = "`$ConnectionString"
            password = "<PASTE_CONNECTION_STRING_HERE>"
            textSecret = $secretName
        }
        tls = [ordered]@{
            disabled = $false
            rejectUnauthorized = $true
        }
        sessionTimeout = 30000
        rebalanceTimeout = 60000
        heartbeatInterval = 3000
        maxBytesPerPartition = 1048576
        maxBytes = 10485760
        maxSocketErrors = 0
        minimizeDuplicates = $false
        id = $sourceId
        type = "eventhub"
        _metadata = [ordered]@{
            namespace = $NamespaceName
            eventHub = $EventHubName
            description = "Event Hub: $EventHubName from $NamespaceName"
        }
    }

    return $sourceConfig
}

function Export-CriblSourceConfigs {
    <#
    .SYNOPSIS
        Exports Cribl source configurations to JSON files.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [array]$Sources,

        [Parameter(Mandatory=$true)]
        [string]$OutputDirectory,

        [Parameter(Mandatory=$true)]
        [hashtable]$SecretInfo
    )

    # Create output directory if it doesn't exist
    if (-not (Test-Path $OutputDirectory)) {
        New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    }

    # Export individual source files
    $sourcesDir = Join-Path $OutputDirectory "individual"
    if (-not (Test-Path $sourcesDir)) {
        New-Item -ItemType Directory -Path $sourcesDir -Force | Out-Null
    }

    foreach ($source in $Sources) {
        $fileName = "$($source.id).json"
        $filePath = Join-Path $sourcesDir $fileName
        $source | ConvertTo-Json -Depth 10 | Set-Content -Path $filePath -Encoding UTF8
    }

    # Export combined sources file
    $combinedFile = Join-Path $OutputDirectory "all-event-hub-sources.json"
    $combinedConfig = [ordered]@{
        _comment = "Cribl Event Hub Sources - Generated by Azure Log Collection"
        _generatedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        _secretsRequired = $SecretInfo.Keys | Sort-Object
        sources = $Sources
    }
    $combinedConfig | ConvertTo-Json -Depth 10 | Set-Content -Path $combinedFile -Encoding UTF8

    # Export connection string reference file
    $secretsFile = Join-Path $OutputDirectory "connection-strings.json"
    $connStringRef = [ordered]@{
        _comment = "Cribl Worker Group secrets needed for Event Hub sources"
        _instructions = @(
            "1. In Cribl Stream, go to your Worker Group > Settings > Secrets",
            "2. Create a secret for each namespace using the 'secretName' shown below",
            "3. Get the connection string from Azure Portal:",
            "   Azure Portal > Event Hub Namespace > Shared access policies > RootManageSharedAccessKey",
            "4. Copy 'Connection string-primary key' as the secret value"
        )
        secrets = @($SecretInfo.GetEnumerator() | Sort-Object Key | ForEach-Object {
            $sanitizedNs = $_.Key -replace '[^a-zA-Z0-9]', '_'
            [ordered]@{
                secretName = "eh_${sanitizedNs}_connectionString"
                namespace = $_.Key
                broker = $_.Value.Endpoint + ":9093"
                eventHubCount = $_.Value.EventHubCount
                connectionStringFormat = "Endpoint=sb://$($_.Value.Endpoint)/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=<KEY>"
            }
        })
    }
    $connStringRef | ConvertTo-Json -Depth 10 | Set-Content -Path $secretsFile -Encoding UTF8

    return @{
        CombinedFile = $combinedFile
        SecretsFile = $secretsFile
        IndividualDir = $sourcesDir
        SourceCount = $Sources.Count
    }
}

#endregion

#region Main Execution

function Start-CriblSourceGeneration {
    Write-Host "`n$('='*80)" -ForegroundColor Cyan
    Write-Host "  CRIBL EVENT HUB SOURCE GENERATION" -ForegroundColor Cyan
    Write-Host "$('='*80)" -ForegroundColor Cyan

    # Discover namespaces (wrap with @() to ensure array even for single results)
    $namespaces = @(Get-EventHubNamespaces -Filter $NamespaceFilter)

    if ($namespaces.Count -eq 0) {
        Write-Host "`n  No Event Hub namespaces found." -ForegroundColor Yellow
        Write-Host "  Run [1] Deploy All Logging first to create Event Hub infrastructure." -ForegroundColor Gray
        return
    }

    # Collect all sources and secret info
    $allSources = @()
    $secretInfo = @{}
    $totalEventHubs = 0

    Write-Step "Discovering Event Hubs in each namespace..."

    foreach ($ns in $namespaces) {
        Write-Host "`n    Namespace: " -NoNewline -ForegroundColor White
        Write-Host $ns.Name -ForegroundColor Green

        # Wrap with @() to ensure array even for single results
        $eventHubs = @(Get-EventHubsInNamespace -NamespaceName $ns.Name -ResourceGroup $azureParams.eventHubResourceGroup)

        if ($eventHubs.Count -eq 0) {
            Write-SubStep "No Event Hubs found (logs may not be flowing yet)" "Yellow"
            continue
        }

        Write-SubStep "Found $($eventHubs.Count) Event Hub(s)" "Gray"

        # Track namespace info for connection string reference
        $secretInfo[$ns.Name] = @{
            Endpoint = "$($ns.Name).servicebus.windows.net"
            EventHubCount = $eventHubs.Count
        }

        # Create source config for each Event Hub
        foreach ($eh in $eventHubs) {
            $source = New-CriblEventHubSource `
                -NamespaceName $ns.Name `
                -EventHubName $eh.Name

            $allSources += $source
            $totalEventHubs++

            Write-SubStep "  - $($eh.Name)" "Cyan"
        }
    }

    if ($allSources.Count -eq 0) {
        Write-Host "`n  No Event Hubs discovered." -ForegroundColor Yellow
        Write-Host "  Event Hubs are auto-created when logs start flowing." -ForegroundColor Gray
        Write-Host "  Run remediation tasks in Azure Policy to trigger log flow, then re-run this." -ForegroundColor Gray
        return
    }

    # Export configurations
    Write-Step "Exporting Cribl source configurations..."

    $exportResult = Export-CriblSourceConfigs `
        -Sources $allSources `
        -OutputDirectory $OutputPath `
        -SecretInfo $secretInfo

    # Summary
    Write-Host "`n$('='*80)" -ForegroundColor Green
    Write-Host "  GENERATION COMPLETE" -ForegroundColor Green
    Write-Host "$('='*80)" -ForegroundColor Green

    Write-Host "`n  Summary:" -ForegroundColor White
    Write-Host "    Namespaces processed: $($namespaces.Count)" -ForegroundColor Cyan
    Write-Host "    Event Hubs discovered: $totalEventHubs" -ForegroundColor Cyan
    Write-Host "    Cribl sources created: $($allSources.Count)" -ForegroundColor Cyan

    Write-Host "`n  Output Files:" -ForegroundColor White
    Write-Host "    Combined sources: $($exportResult.CombinedFile)" -ForegroundColor Gray
    Write-Host "    Secrets reference: $($exportResult.SecretsFile)" -ForegroundColor Gray
    Write-Host "    Individual sources: $($exportResult.IndividualDir)" -ForegroundColor Gray

    Write-Host "`n  Next Steps:" -ForegroundColor Yellow
    Write-Host "    1. Review secrets-reference.json for required secrets" -ForegroundColor White
    Write-Host "    2. Create secrets in Cribl Stream (Settings > Secrets)" -ForegroundColor White
    Write-Host "    3. Import source configurations into Cribl Stream" -ForegroundColor White

    # Show secrets that need to be created
    Write-Host "`n  Secrets to create in Cribl Stream:" -ForegroundColor Cyan
    foreach ($secret in ($secretInfo.Keys | Sort-Object)) {
        Write-Host "    - $secret" -ForegroundColor White
    }

    return $exportResult
}

# Run the generation
Start-CriblSourceGeneration

#endregion

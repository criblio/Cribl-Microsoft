# Generate Cribl Source and Destination Configurations
# This module generates Cribl Stream configuration files for all deployed Azure resources

param(
    [Parameter(Mandatory=$true)]
    [PSCustomObject]$AzureParams,

    [Parameter(Mandatory=$true)]
    [PSCustomObject]$OperationParams,

    [Parameter(Mandatory=$true)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory=$true)]
    [string]$Location,

    [Parameter(Mandatory=$true)]
    [hashtable]$ResourceNames,

    [Parameter(Mandatory=$true)]
    [string]$OutputDirectory
)

$adxDestDir = Join-Path $OutputDirectory "destinations\adx"
$sourcesDir = Join-Path $OutputDirectory "sources"

if (-not (Test-Path $adxDestDir)) {
    New-Item -ItemType Directory -Path $adxDestDir -Force | Out-Null
}
if (-not (Test-Path $sourcesDir)) {
    New-Item -ItemType Directory -Path $sourcesDir -Force | Out-Null
}

$generatedConfigs = @{
    ADXDestinations = @()
    EventHubSources = @()
    StorageQueueSources = @()
    StorageBlobSources = @()
}

# Discover actual deployed resource names (may differ from planned names due to uniqueness constraints)
$actualStorageAccount = $null
$actualADXCluster = $null

# Find Storage Account - may have random suffix appended for uniqueness
$storageAccounts = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
if ($storageAccounts) {
    # Prefer exact match, fallback to partial match based on base name
    $baseStorageName = $ResourceNames.StorageAccount
    $actualStorageAccount = $storageAccounts | Where-Object { $_.StorageAccountName -eq $baseStorageName } | Select-Object -First 1
    if (-not $actualStorageAccount) {
        # Look for storage account that starts with our expected prefix
        $actualStorageAccount = $storageAccounts | Where-Object { $_.StorageAccountName -like "$baseStorageName*" } | Select-Object -First 1
    }
    if (-not $actualStorageAccount -and $storageAccounts.Count -eq 1) {
        # If only one storage account in RG, use it
        $actualStorageAccount = $storageAccounts[0]
    }
}

# Find ADX Cluster - may have hash suffix for global uniqueness
$adxClusters = Get-AzKustoCluster -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
if ($adxClusters) {
    $baseADXName = $ResourceNames.ADXCluster
    $actualADXCluster = $adxClusters | Where-Object { $_.Name -eq $baseADXName } | Select-Object -First 1
    if (-not $actualADXCluster) {
        $actualADXCluster = $adxClusters | Where-Object { $_.Name -like "$baseADXName*" } | Select-Object -First 1
    }
    if (-not $actualADXCluster -and $adxClusters.Count -eq 1) {
        $actualADXCluster = $adxClusters[0]
    }
}

# Generate ADX Destination Configurations
if ($OperationParams.deployment.analytics.deployADX) {
    try {
        if (-not $actualADXCluster) {
            throw "ADX Cluster not found in resource group"
        }
        $adxCluster = $actualADXCluster

        $adxDatabase = $AzureParams.analytics.adx.database.name
        $adxTable = "CommonSecurityLog"

        $adxConfig = @{
            id = "adx:$($ResourceNames.ADXCluster)-$adxTable"
            type = "azure_data_explorer"
            systemFields = @()
            conf = @{
                cluster = $adxCluster.Uri
                database = $adxDatabase
                table = $adxTable
                authType = "clientCredentials"
                tenantId = $AzureParams.tenantId
                clientId = $AzureParams.clientId
                clientTextSecret = "Azure_Client_Secret"
                ingestionMapping = "CriblMapping"
                format = "json"
                compression = "gzip"
                batchSize = 1000
                flushPeriodSec = 30
                maxPayloadSizeKB = 4096
            }
        }

        $configFile = Join-Path $adxDestDir "adx-$adxTable.json"
        $adxConfig | ConvertTo-Json -Depth 10 | Set-Content $configFile -Force
        Write-ToLog -Message "ADX destination created: adx-$adxTable.json" -Level "SUCCESS"

        $generatedConfigs.ADXDestinations += $adxConfig

    } catch {
        Write-ToLog -Message "Failed to generate ADX destination config: $($_.Exception.Message)" -Level "WARNING"
    }
}

# Generate Event Hub Source Configurations
if ($OperationParams.deployment.analytics.deployEventHub) {
    try {
        $ehNamespace = Get-AzEventHubNamespace `
            -ResourceGroupName $ResourceGroupName `
            -Name $ResourceNames.EventHubNamespace `
            -ErrorAction Stop

        if (-not $actualStorageAccount) {
            throw "Storage Account not found in resource group"
        }
        $storageAccount = $actualStorageAccount

        $authRule = Get-AzEventHubAuthorizationRule `
            -ResourceGroupName $ResourceGroupName `
            -Namespace $ehNamespace.Name `
            -Name "RootManageSharedAccessKey" `
            -ErrorAction Stop

        foreach ($hubKey in $AzureParams.analytics.eventHub.hubs.PSObject.Properties.Name) {
            $hubConfig = $AzureParams.analytics.eventHub.hubs.$hubKey

            $ehSourceConfig = @{
                id = "eventhub:$($hubConfig.name)"
                type = "azure_event_hub"
                systemFields = @()
                conf = @{
                    connectionString = "`${C.secrets.Azure_EventHub_ConnectionString}"
                    eventHubName = $hubConfig.name
                    consumerGroup = $hubConfig.consumerGroups[0]
                    storageAccountName = $storageAccount.StorageAccountName
                    storageContainerName = "eventhub-checkpoints"
                    storageAccountKey = "`${C.secrets.Azure_Storage_AccountKey}"
                    maxBatchSize = 1000
                    idleTimeSec = 300
                }
            }

            $configFile = Join-Path $sourcesDir "eventhub-$($hubConfig.name).json"
            $ehSourceConfig | ConvertTo-Json -Depth 10 | Set-Content $configFile -Force
            Write-ToLog -Message "Event Hub source created: eventhub-$($hubConfig.name).json" -Level "SUCCESS"

            $generatedConfigs.EventHubSources += $ehSourceConfig
        }

    } catch {
        Write-ToLog -Message "Failed to generate Event Hub source configs: $($_.Exception.Message)" -Level "WARNING"
    }
}

# Generate Storage Queue Source Configurations
if ($OperationParams.deployment.storage.deployQueues) {
    try {
        if (-not $actualStorageAccount) {
            throw "Storage Account not found in resource group"
        }
        $storageAccount = $actualStorageAccount

        foreach ($queueKey in $AzureParams.storage.queues.definitions.PSObject.Properties.Name) {
            $queueConfig = $AzureParams.storage.queues.definitions.$queueKey

            $queueSourceConfig = @{
                id = "azurequeue:$($queueConfig.name)"
                type = "azure_queue"
                systemFields = @()
                conf = @{
                    storageAccountName = $storageAccount.StorageAccountName
                    queueName = $queueConfig.name
                    authType = "accessKey"
                    accessKey = "`${C.secrets.Azure_Storage_AccountKey}"
                    visibilityTimeoutSec = 30
                    maxMessages = 32
                    pollIntervalSec = 5
                    deleteAfterRead = $true
                }
            }

            $configFile = Join-Path $sourcesDir "queue-$($queueConfig.name).json"
            $queueSourceConfig | ConvertTo-Json -Depth 10 | Set-Content $configFile -Force
            Write-ToLog -Message "Storage Queue source created: queue-$($queueConfig.name).json" -Level "SUCCESS"

            $generatedConfigs.StorageQueueSources += $queueSourceConfig
        }

    } catch {
        Write-ToLog -Message "Failed to generate Storage Queue source configs: $($_.Exception.Message)" -Level "WARNING"
    }
}

# Generate Storage Blob Collector Source Configurations
if ($OperationParams.deployment.storage.deployContainers) {
    try {
        if (-not $actualStorageAccount) {
            throw "Storage Account not found in resource group"
        }
        $storageAccount = $actualStorageAccount

        foreach ($containerKey in $AzureParams.storage.containers.PSObject.Properties.Name) {
            $containerConfig = $AzureParams.storage.containers.$containerKey

            $isFlowLogs = $containerConfig.name -like "*flowlog*"

            if ($isFlowLogs) {
                $blobSourceConfig = @{
                    id = "Azure_vNet_FlowLogs_$($storageAccount.StorageAccountName)"
                    type = "collection"
                    ttl = "4h"
                    ignoreGroupJobsLimit = $false
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
                            authType = "clientSecret"
                            recurse = $true
                            includeMetadata = $true
                            includeTags = $false
                            maxBatchSize = 10
                            parquetChunkSizeMB = 5
                            parquetChunkDownloadTimeout = 600
                            azureCloud = "azure"
                            containerName = $containerConfig.name
                            path = "flowLogResourceID=/`${*}/`${*}/`${_time:y=%Y}/`${_time:m=%m}/`${_time:d=%d}/`${_time:h=%H}"
                            extractors = @()
                            clientId = $AzureParams.clientId
                            tenantId = $AzureParams.tenantId
                            storageAccountName = $storageAccount.StorageAccountName
                            clientTextSecret = "Azure_vNet_Flowlogs_Secret"
                        }
                        destructive = $false
                        type = "azure_blob"
                        encoding = "utf8"
                    }
                    input = @{
                        type = "collection"
                        staleChannelFlushMs = 10000
                        sendToRoutes = $true
                        preprocess = @{
                            disabled = $true
                        }
                        throttleRatePerSec = "0"
                        breakerRulesets = @("Azure_vNet_FlowLogs")
                        pipeline = "Azure_vNet_FlowLogs_PreProcessing"
                    }
                    savedState = @{}
                }
            } else {
                $associatedQueue = $null
                foreach ($subKey in $AzureParams.storage.eventGrid.subscriptions.PSObject.Properties.Name) {
                    $subConfig = $AzureParams.storage.eventGrid.subscriptions.$subKey
                    if ($subConfig.filters.subjectBeginsWith -like "*containers/$($containerConfig.name)/*") {
                        $associatedQueue = $subConfig.destination
                        break
                    }
                }

                $blobSourceConfig = @{
                    id = "azureblob:$($containerConfig.name)"
                    type = "azure_blob"
                    systemFields = @()
                    conf = @{
                        storageAccountName = $storageAccount.StorageAccountName
                        containerName = $containerConfig.name
                        authType = "clientSecret"
                        clientId = $AzureParams.clientId
                        tenantId = $AzureParams.tenantId
                        clientTextSecret = "Azure_Client_Secret"
                        azureCloud = "azure"
                        recurse = $true
                        maxBatchSize = 10
                        parquetChunkSizeMB = 5
                        deleteAfterRead = $false
                    }
                }

                if ($associatedQueue) {
                    $blobSourceConfig.conf.queue = $associatedQueue
                }
            }

            $configFile = Join-Path $sourcesDir "blob-$($containerConfig.name).json"
            $blobSourceConfig | ConvertTo-Json -Depth 10 | Set-Content $configFile -Force
            Write-ToLog -Message "Storage Blob source created: blob-$($containerConfig.name).json" -Level "SUCCESS"

            $generatedConfigs.StorageBlobSources += $blobSourceConfig
        }

    } catch {
        Write-ToLog -Message "Failed to generate Storage Blob source configs: $($_.Exception.Message)" -Level "WARNING"
    }
}

# Generate Summary README
$readmeContent = @"
# Cribl Stream Configuration Files

Generated: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Lab Mode: $($AzureParams.labMode)
Resource Group: $ResourceGroupName
Location: $Location

## Directory Structure

``````
Cribl-Configs/
    destinations/
        sentinel/    # DCR-based destinations for Microsoft Sentinel
        adx/         # Azure Data Explorer destinations
    sources/         # Azure data sources (Event Hubs, Storage Queues, Blob Collectors)
``````

## Configuration Summary

### Destinations

**Sentinel (DCR-based):**
- See ``destinations/sentinel/`` for individual DCR destination configs
- These use Azure Monitor Data Collection Rules for ingestion
- Authentication: Azure AD (Client ID/Secret)

**Azure Data Explorer:**
"@

if ($generatedConfigs.ADXDestinations.Count -gt 0) {
    $readmeContent += "`n- $($generatedConfigs.ADXDestinations.Count) ADX destination(s) configured"
    foreach ($adxDest in $generatedConfigs.ADXDestinations) {
        $readmeContent += "`n  - Table: $($adxDest.conf.table)"
    }
} else {
    $readmeContent += "`n- No ADX destinations (ADX not deployed)"
}

$readmeContent += @"


### Sources

**Event Hubs:**
"@

if ($generatedConfigs.EventHubSources.Count -gt 0) {
    $readmeContent += "`n- $($generatedConfigs.EventHubSources.Count) Event Hub source(s) configured"
    foreach ($ehSource in $generatedConfigs.EventHubSources) {
        $readmeContent += "`n  - $($ehSource.conf.eventHubName)"
    }
} else {
    $readmeContent += "`n- No Event Hub sources (Event Hub not deployed)"
}

$readmeContent += @"


**Storage Queues:**
"@

if ($generatedConfigs.StorageQueueSources.Count -gt 0) {
    $readmeContent += "`n- $($generatedConfigs.StorageQueueSources.Count) Storage Queue source(s) configured"
    foreach ($queueSource in $generatedConfigs.StorageQueueSources) {
        $readmeContent += "`n  - $($queueSource.conf.queueName)"
    }
} else {
    $readmeContent += "`n- No Storage Queue sources (Queues not deployed)"
}

$readmeContent += @"


**Storage Blob Collectors:**
"@

if ($generatedConfigs.StorageBlobSources.Count -gt 0) {
    $readmeContent += "`n- $($generatedConfigs.StorageBlobSources.Count) Blob Collector source(s) configured"
    foreach ($blobSource in $generatedConfigs.StorageBlobSources) {
        $readmeContent += "`n  - $($blobSource.conf.containerName)"
    }
} else {
    $readmeContent += "`n- No Blob Collector sources (Containers not deployed)"
}

$readmeContent += @"


## Cribl Stream Workspace Secrets Required

The generated configurations use Cribl workspace secrets for sensitive credentials.

### Required Secrets

| Secret Name | Type | Used By |
|-------------|------|---------|
| ``Azure_Client_Secret`` | Text | ADX, Blob Sources |
| ``Azure_EventHub_ConnectionString`` | Text | Event Hub Sources |
| ``Azure_Storage_AccountKey`` | Text | Storage Queue Sources |
| ``Azure_vNet_Flowlogs_Secret`` | Text | Flow Logs Collection |

"@

$readmePath = Join-Path $OutputDirectory "README.md"
$readmeContent | Set-Content $readmePath -Force

Write-ToLog -Message "Cribl configuration generation completed" -Level "SUCCESS"

return $generatedConfigs

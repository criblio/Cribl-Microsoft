# Generate-CriblConfigs.ps1
# Phase 9, SubPhase 9.1: Generate Cribl Source and Destination Configurations
# Dependencies: Storage Account (Phase 3.1), Event Hub (Phase 5.1), ADX (Phase 5.2)

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

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    OutputDirectory = $OutputDirectory
    DeployADX = $OperationParams.deployment.analytics.deployADX
    DeployEventHub = $OperationParams.deployment.analytics.deployEventHub
    DeployQueues = $OperationParams.deployment.storage.deployQueues
    DeployContainers = $OperationParams.deployment.storage.deployContainers
} -Context "Generate-CriblConfigs"

$mainSw = Start-DebugOperation -Operation "Generate-CriblConfigs"

try {
    Write-DebugLog -Message "Starting Cribl configuration generation..." -Context "Generate-CriblConfigs"

    # Create output directories
    $adxDestDir = Join-Path $OutputDirectory "destinations\adx"
    $sourcesDir = Join-Path $OutputDirectory "sources"

    if (-not (Test-Path $adxDestDir)) {
        Write-DebugLog -Message "Creating directory: $adxDestDir" -Context "Generate-CriblConfigs"
        New-Item -ItemType Directory -Path $adxDestDir -Force | Out-Null
    }
    if (-not (Test-Path $sourcesDir)) {
        Write-DebugLog -Message "Creating directory: $sourcesDir" -Context "Generate-CriblConfigs"
        New-Item -ItemType Directory -Path $sourcesDir -Force | Out-Null
    }

    $generatedConfigs = @{
        ADXDestinations = @()
        EventHubSources = @()
        StorageQueueSources = @()
        StorageBlobSources = @()
    }

    # Discover actual deployed resources
    $actualStorageAccount = $null
    $actualADXCluster = $null

    # Find Storage Account
    Write-DebugLog -Message "Looking for Storage Account in resource group..." -Context "Generate-CriblConfigs"
    $storageAccounts = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
    if ($storageAccounts) {
        $baseStorageName = $ResourceNames.StorageAccount
        $actualStorageAccount = $storageAccounts | Where-Object { $_.StorageAccountName -eq $baseStorageName } | Select-Object -First 1
        if (-not $actualStorageAccount) {
            $actualStorageAccount = $storageAccounts | Where-Object { $_.StorageAccountName -like "$baseStorageName*" } | Select-Object -First 1
        }
        if (-not $actualStorageAccount -and $storageAccounts.Count -eq 1) {
            $actualStorageAccount = $storageAccounts[0]
        }
        if ($actualStorageAccount) {
            Write-DebugLog -Message "Found Storage Account: $($actualStorageAccount.StorageAccountName)" -Context "Generate-CriblConfigs"
        }
    }

    # Find ADX Cluster
    Write-DebugLog -Message "Looking for ADX Cluster in resource group..." -Context "Generate-CriblConfigs"
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
        if ($actualADXCluster) {
            Write-DebugLog -Message "Found ADX Cluster: $($actualADXCluster.Name)" -Context "Generate-CriblConfigs"
        }
    }

    # Generate ADX Destination Configurations
    if ($OperationParams.deployment.analytics.deployADX) {
        Write-DebugLog -Message "Generating ADX destination configurations..." -Context "Generate-CriblConfigs"
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
            Write-DebugLog -Message "ADX destination config written to: $configFile" -Context "Generate-CriblConfigs"

            $generatedConfigs.ADXDestinations += $adxConfig

        } catch {
            Write-ToLog -Message "Failed to generate ADX destination config: $($_.Exception.Message)" -Level "WARNING"
            Write-DebugException -Exception $_.Exception -Context "Generate-CriblConfigs"
        }
    }

    # Generate Event Hub Source Configurations (Kafka-compatible format)
    if ($OperationParams.deployment.analytics.deployEventHub) {
        Write-DebugLog -Message "Generating Event Hub source configurations..." -Context "Generate-CriblConfigs"
        try {
            $ehNamespace = Get-AzEventHubNamespace `
                -ResourceGroupName $ResourceGroupName `
                -Name $ResourceNames.EventHubNamespace `
                -ErrorAction Stop

            # Get the broker endpoint from the namespace
            $brokerEndpoint = "$($ehNamespace.Name).servicebus.windows.net:9093"

            foreach ($hubKey in $AzureParams.analytics.eventHub.hubs.PSObject.Properties.Name) {
                $hubConfig = $AzureParams.analytics.eventHub.hubs.$hubKey

                $ehSourceConfig = [ordered]@{
                    disabled = $false
                    sendToRoutes = $true
                    pqEnabled = $false
                    streamtags = @()
                    brokers = @($brokerEndpoint)
                    topics = @($hubConfig.name)
                    groupId = $hubConfig.consumerGroups[0]
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
                        textSecret = "EventHub_$($ehNamespace.Name)_ConnectionString"
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
                    id = "EventHub_$($hubConfig.name)"
                    type = "eventhub"
                }

                $configFile = Join-Path $sourcesDir "eventhub-$($hubConfig.name).json"
                $ehSourceConfig | ConvertTo-Json -Depth 10 | Set-Content $configFile -Force
                Write-ToLog -Message "Event Hub source created: eventhub-$($hubConfig.name).json" -Level "SUCCESS"

                $generatedConfigs.EventHubSources += $ehSourceConfig
            }

        } catch {
            Write-ToLog -Message "Failed to generate Event Hub source configs: $($_.Exception.Message)" -Level "WARNING"
            Write-DebugException -Exception $_.Exception -Context "Generate-CriblConfigs"
        }
    }

    # Generate Azure Blob Source with Queue-based Discovery (Event Grid pattern)
    # This creates a blob source that uses the queue for blob discovery instead of polling
    if ($OperationParams.deployment.storage.deployQueues -and $OperationParams.deployment.storage.deployEventGrid) {
        Write-DebugLog -Message "Generating Azure Blob source with queue-based discovery..." -Context "Generate-CriblConfigs"
        try {
            if (-not $actualStorageAccount) {
                throw "Storage Account not found in resource group"
            }
            $storageAccount = $actualStorageAccount

            # Get the container and queue configurations
            $containerConfig = $AzureParams.storage.containers.criblqueuesource
            $queueConfig = $AzureParams.storage.queues.definitions.blobNotifications

            if ($containerConfig -and $queueConfig) {
                # Flat structure matching Cribl's azure_blob source format
                $blobQueueSourceConfig = [ordered]@{
                    id = "azure_blob_queue_$($containerConfig.name)"
                    disabled = $false
                    sendToRoutes = $true
                    pqEnabled = $false
                    streamtags = @()
                    fileFilter = "/.*/gm"
                    visibilityTimeout = 600
                    numReceivers = 1
                    maxMessages = 1
                    servicePeriodSecs = 5
                    skipOnError = $false
                    staleChannelFlushMs = 10000
                    parquetChunkSizeMB = 5
                    parquetChunkDownloadTimeout = 600
                    authType = "clientSecret"
                    type = "azure_blob"
                    queueName = $queueConfig.name
                    tenantId = $AzureParams.tenantId
                    clientId = $AzureParams.clientId
                    clientTextSecret = "Azure_Blob_Queue_Secret"
                    storageAccountName = $storageAccount.StorageAccountName
                }

                $configFile = Join-Path $sourcesDir "blob-queue-$($containerConfig.name).json"
                $blobQueueSourceConfig | ConvertTo-Json -Depth 10 | Set-Content $configFile -Force
                Write-ToLog -Message "Azure Blob source with queue discovery created: blob-queue-$($containerConfig.name).json" -Level "SUCCESS"

                $generatedConfigs.StorageBlobSources += $blobQueueSourceConfig
            }

        } catch {
            Write-ToLog -Message "Failed to generate Azure Blob queue source config: $($_.Exception.Message)" -Level "WARNING"
            Write-DebugException -Exception $_.Exception -Context "Generate-CriblConfigs"
        }
    }

    # Generate Flow Logs Blob Collector Source Configuration
    # Only generate when Flow Logs are deployed (not for queue-based or general blob collection)
    if ($OperationParams.deployment.monitoring.deployFlowLogs) {
        Write-DebugLog -Message "Generating Flow Logs Blob Collector source configuration..." -Context "Generate-CriblConfigs"
        try {
            if (-not $actualStorageAccount) {
                throw "Storage Account not found in resource group"
            }
            $storageAccount = $actualStorageAccount

            # Get the flowlogs container configuration
            $containerConfig = $AzureParams.storage.containers.flowlogs
            if ($containerConfig) {
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

                $configFile = Join-Path $sourcesDir "blob-$($containerConfig.name).json"
                $blobSourceConfig | ConvertTo-Json -Depth 10 | Set-Content $configFile -Force
                Write-ToLog -Message "Flow Logs Blob Collector source created: blob-$($containerConfig.name).json" -Level "SUCCESS"

                $generatedConfigs.StorageBlobSources += $blobSourceConfig
            }

        } catch {
            Write-ToLog -Message "Failed to generate Flow Logs Blob Collector source config: $($_.Exception.Message)" -Level "WARNING"
            Write-DebugException -Exception $_.Exception -Context "Generate-CriblConfigs"
        }
    }

    # Generate Blob Collector Source Configuration (BlobCollectorLab - Option 7)
    # Only generate when containers are deployed but NOT using Event Grid queue pattern
    # (Event Grid pattern uses azure_blob with queue discovery, not blob collector)
    if ($OperationParams.deployment.storage.deployContainers -and -not $OperationParams.deployment.storage.deployEventGrid -and -not $OperationParams.deployment.monitoring.deployFlowLogs) {
        Write-DebugLog -Message "Generating Blob Collector source configuration (BlobCollectorLab)..." -Context "Generate-CriblConfigs"
        try {
            if (-not $actualStorageAccount) {
                throw "Storage Account not found in resource group"
            }
            $storageAccount = $actualStorageAccount

            # Get the criblblobcollector container configuration (BlobCollectorLab)
            $containerConfig = $AzureParams.storage.containers.criblblobcollector
            if ($containerConfig) {
                # Flat structure matching Cribl's azure_blob source format for scheduled polling
                $blobSourceConfig = [ordered]@{
                    id = "azure_blob_collector_$($containerConfig.name)"
                    disabled = $false
                    sendToRoutes = $true
                    pqEnabled = $false
                    streamtags = @()
                    fileFilter = "/.*/gm"
                    recurse = $true
                    maxBatchSize = 10
                    collectForever = $true
                    servicePeriodSecs = 60
                    skipOnError = $false
                    staleChannelFlushMs = 10000
                    parquetChunkSizeMB = 5
                    parquetChunkDownloadTimeout = 600
                    authType = "clientSecret"
                    type = "azure_blob"
                    containerName = $containerConfig.name
                    tenantId = $AzureParams.tenantId
                    clientId = $AzureParams.clientId
                    clientTextSecret = "Azure_Blob_Collector_Secret"
                    storageAccountName = $storageAccount.StorageAccountName
                }

                $configFile = Join-Path $sourcesDir "blob-collector-$($containerConfig.name).json"
                $blobSourceConfig | ConvertTo-Json -Depth 10 | Set-Content $configFile -Force
                Write-ToLog -Message "Blob Collector source created: blob-collector-$($containerConfig.name).json" -Level "SUCCESS"

                $generatedConfigs.StorageBlobSources += $blobSourceConfig
            }

        } catch {
            Write-ToLog -Message "Failed to generate Blob Collector source config: $($_.Exception.Message)" -Level "WARNING"
            Write-DebugException -Exception $_.Exception -Context "Generate-CriblConfigs"
        }
    }

    # Generate Summary README
    Write-DebugLog -Message "Generating README summary..." -Context "Generate-CriblConfigs"
    $readmeContent = @"
# Cribl Stream Configuration Files

Generated: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Lab Mode: $($AzureParams.labMode)
Resource Group: $ResourceGroupName
Location: $Location

## Directory Structure

```
Cribl-Configs/
    destinations/
        sentinel/    # DCR-based destinations for Microsoft Sentinel
        adx/         # Azure Data Explorer destinations
    sources/         # Azure data sources (Event Hubs, Storage Queues, Blob Collectors)
```

## Configuration Summary

### Destinations

- ADX Destinations: $($generatedConfigs.ADXDestinations.Count)

### Sources

- Event Hub Sources: $($generatedConfigs.EventHubSources.Count)
- Storage Queue Sources: $($generatedConfigs.StorageQueueSources.Count)
- Storage Blob Sources: $($generatedConfigs.StorageBlobSources.Count)

## Required Cribl Workspace Secrets

| Secret Name | Type | Used By |
|-------------|------|---------|
| Azure_Client_Secret | Text | ADX Destinations |
| Azure_EventHub_ConnectionString | Text | Event Hub Sources |
| Azure_Blob_Queue_Secret | Text | Blob Queue Source (Event Grid pattern) |
| Azure_Blob_Collector_Secret | Text | Blob Collector Source (scheduled polling) |
| Azure_vNet_Flowlogs_Secret | Text | Flow Logs Collection |
"@

    $readmePath = Join-Path $OutputDirectory "README.md"
    $readmeContent | Set-Content $readmePath -Force

    Write-ToLog -Message "Cribl configuration generation completed" -Level "SUCCESS"
    Write-DebugLog -Message "Cribl configuration generation completed successfully" -Context "Generate-CriblConfigs"
    Stop-DebugOperation -Operation "Generate-CriblConfigs" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "Cribl configurations generated successfully"
        Data = $generatedConfigs
    }

} catch {
    Write-ToLog -Message "Cribl configuration generation failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Generate-CriblConfigs"
    Stop-DebugOperation -Operation "Generate-CriblConfigs" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}

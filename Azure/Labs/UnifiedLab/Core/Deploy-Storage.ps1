# Deploy-Storage.ps1
# Deploys Storage Account, Blob Containers, Queues, and Event Grid for Unified Azure Lab

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
    [hashtable]$ResourceNames
)

$SkipExisting = $OperationParams.validation.skipExistingResources

function Get-RandomSuffix {
    param([int]$Length = 4)
    $chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    $suffix = -join ((1..$Length) | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
    return $suffix
}

function Deploy-StorageAccount {
    if (-not $OperationParams.deployment.storage.deployStorageAccount) {
        return $null
    }

    $baseStorageAccountName = $ResourceNames.StorageAccount
    $storageAccountName = $baseStorageAccountName
    $storageConfig = $AzureParams.storage.accounts.primary

    $existingStorage = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $storageAccountName -ErrorAction SilentlyContinue

    if ($null -ne $existingStorage) {
        if ($SkipExisting) {
            return $existingStorage
        } else {
            throw "Storage Account already exists"
        }
    }

    $maxRetries = 5
    $retryCount = 0
    $storageAccount = $null

    while ($null -eq $storageAccount -and $retryCount -lt $maxRetries) {
        try {
            $storageAccount = New-AzStorageAccount `
                -ResourceGroupName $ResourceGroupName `
                -Name $storageAccountName `
                -Location $Location `
                -SkuName $storageConfig.sku `
                -Kind $storageConfig.kind `
                -AccessTier $storageConfig.accessTier `
                -EnableHttpsTrafficOnly $true `
                -ErrorAction Stop

            Write-ToLog -Message "Storage Account created: $storageAccountName" -Level "SUCCESS"

            if ($storageAccountName -ne $baseStorageAccountName) {
                $script:ResourceNames.StorageAccount = $storageAccountName
            }

        } catch {
            if ($_.Exception.Message -like "*already taken*" -or $_.Exception.Message -like "*is not available*") {
                $retryCount++

                if ($retryCount -lt $maxRetries) {
                    $suffix = Get-RandomSuffix -Length 4
                    $storageAccountName = ($baseStorageAccountName + $suffix).ToLower() -replace '[^a-z0-9]', ''
                    if ($storageAccountName.Length -gt 24) {
                        $storageAccountName = $storageAccountName.Substring(0, 24)
                    }
                } else {
                    Write-ToLog -Message "Failed to create Storage Account after $maxRetries attempts" -Level "ERROR"
                    throw "Unable to find available storage account name after $maxRetries attempts"
                }
            } else {
                Write-ToLog -Message "Failed to create Storage Account: $($_.Exception.Message)" -Level "ERROR"
                throw
            }
        }
    }

    if ($storageConfig.enableBlobVersioning) {
        Enable-AzStorageBlobDeleteRetentionPolicy `
            -ResourceGroupName $ResourceGroupName `
            -StorageAccountName $storageAccountName `
            -RetentionDays 7 `
            -ErrorAction SilentlyContinue
    }

    if ($storageConfig.enableBlobChangeFeed) {
        Update-AzStorageBlobServiceProperty `
            -ResourceGroupName $ResourceGroupName `
            -StorageAccountName $storageAccountName `
            -EnableChangeFeed $true `
            -ErrorAction SilentlyContinue
    }

    return $storageAccount
}

function Deploy-BlobContainers {
    param($StorageAccount)

    if (-not $OperationParams.deployment.storage.deployContainers -or $null -eq $StorageAccount) {
        return @()
    }

    $storageContext = $StorageAccount.Context
    $createdContainers = @()

    foreach ($containerKey in $AzureParams.storage.containers.PSObject.Properties.Name) {
        $containerConfig = $AzureParams.storage.containers.$containerKey
        $containerName = $containerConfig.name

        $existingContainer = Get-AzStorageContainer -Name $containerName -Context $storageContext -ErrorAction SilentlyContinue

        if ($null -ne $existingContainer) {
            $createdContainers += $existingContainer
            continue
        }

        try {
            $container = New-AzStorageContainer `
                -Name $containerName `
                -Context $storageContext `
                -Permission Off `
                -ErrorAction Stop

            Write-ToLog -Message "Container created: $containerName" -Level "SUCCESS"
            $createdContainers += $container

        } catch {
            Write-ToLog -Message "Failed to create container $containerName : $($_.Exception.Message)" -Level "ERROR"
        }
    }

    return $createdContainers
}

function Deploy-StorageQueues {
    param($StorageAccount)

    if (-not $OperationParams.deployment.storage.deployQueues -or -not $AzureParams.storage.queues.enabled -or $null -eq $StorageAccount) {
        return @()
    }

    $storageContext = $StorageAccount.Context
    $createdQueues = @()

    foreach ($queueKey in $AzureParams.storage.queues.definitions.PSObject.Properties.Name) {
        $queueConfig = $AzureParams.storage.queues.definitions.$queueKey
        $queueName = $queueConfig.name

        $existingQueue = Get-AzStorageQueue -Name $queueName -Context $storageContext -ErrorAction SilentlyContinue

        if ($null -ne $existingQueue) {
            $createdQueues += $existingQueue
            continue
        }

        try {
            $queue = New-AzStorageQueue `
                -Name $queueName `
                -Context $storageContext `
                -ErrorAction Stop

            Write-ToLog -Message "Queue created: $queueName" -Level "SUCCESS"
            $createdQueues += $queue

        } catch {
            Write-ToLog -Message "Failed to create queue $queueName : $($_.Exception.Message)" -Level "ERROR"
        }
    }

    return $createdQueues
}

function Deploy-EventGridSystemTopic {
    param($StorageAccount)

    if (-not $OperationParams.deployment.storage.deployEventGrid -or -not $AzureParams.storage.eventGrid.enabled -or $null -eq $StorageAccount) {
        return $null
    }

    $eventGridProvider = Get-AzResourceProvider -ProviderNamespace Microsoft.EventGrid

    if ($eventGridProvider.RegistrationState -ne "Registered") {
        try {
            Register-AzResourceProvider -ProviderNamespace Microsoft.EventGrid | Out-Null

            $timeout = 120
            $elapsed = 0
            $interval = 5

            while ($elapsed -lt $timeout) {
                $status = (Get-AzResourceProvider -ProviderNamespace Microsoft.EventGrid).RegistrationState
                if ($status -eq "Registered") {
                    Write-ToLog -Message "Microsoft.EventGrid provider registered" -Level "SUCCESS"
                    break
                }
                Start-Sleep -Seconds $interval
                $elapsed += $interval
            }
        } catch {
            Write-ToLog -Message "Failed to register Microsoft.EventGrid provider: $($_.Exception.Message)" -Level "ERROR"
            throw
        }
    }

    $topicName = "$($StorageAccount.StorageAccountName)-events"

    $existingTopic = Get-AzEventGridSystemTopic -ResourceGroupName $ResourceGroupName -Name $topicName -ErrorAction SilentlyContinue

    if ($null -ne $existingTopic) {
        return $existingTopic
    }

    try {
        $systemTopic = New-AzEventGridSystemTopic `
            -ResourceGroupName $ResourceGroupName `
            -Name $topicName `
            -Location $Location `
            -TopicType "Microsoft.Storage.StorageAccounts" `
            -Source $StorageAccount.Id `
            -ErrorAction Stop

        Write-ToLog -Message "Event Grid System Topic created: $topicName" -Level "SUCCESS"
        return $systemTopic

    } catch {
        Write-ToLog -Message "Failed to create Event Grid System Topic: $($_.Exception.Message)" -Level "ERROR"
        throw
    }
}

function Deploy-EventGridSubscriptions {
    param($StorageAccount, $SystemTopic)

    if (-not $OperationParams.deployment.storage.deployEventGrid -or -not $AzureParams.storage.eventGrid.enabled -or $null -eq $StorageAccount -or $null -eq $SystemTopic) {
        return @()
    }

    $createdSubscriptions = @()

    foreach ($subKey in $AzureParams.storage.eventGrid.subscriptions.PSObject.Properties.Name) {
        $subConfig = $AzureParams.storage.eventGrid.subscriptions.$subKey
        $subscriptionName = "eg-sub-$subKey"
        $queueName = $subConfig.destination

        $existingSub = Get-AzEventGridSystemTopicEventSubscription `
            -ResourceGroupName $ResourceGroupName `
            -SystemTopicName $SystemTopic.Name `
            -EventSubscriptionName $subscriptionName `
            -ErrorAction SilentlyContinue

        if ($null -ne $existingSub) {
            $createdSubscriptions += $existingSub
            continue
        }

        try {
            # Use subscription ID from AzureParams (configured by user) to ensure consistency
            $targetSubId = $AzureParams.subscriptionId
            $storageQueueId = "/subscriptions/$targetSubId/resourceGroups/$ResourceGroupName/providers/Microsoft.Storage/storageAccounts/$($StorageAccount.StorageAccountName)/queueServices/default/queues/$queueName"

            Write-ToLog -Message "Creating Event Grid subscription with queue endpoint: $storageQueueId" -Level "INFO"

            # Create the Storage Queue endpoint object
            $endpoint = New-AzEventGridStorageQueueEventSubscriptionDestinationObject `
                -QueueName $queueName `
                -ResourceId $StorageAccount.Id

            # Build subscription parameters
            $subParams = @{
                ResourceGroupName = $ResourceGroupName
                SystemTopicName = $SystemTopic.Name
                EventSubscriptionName = $subscriptionName
                Destination = $endpoint
                FilterIncludedEventType = $subConfig.eventTypes
                ErrorAction = "Stop"
            }

            # Add filters if configured
            if ($subConfig.filters.subjectBeginsWith) {
                $subParams.FilterSubjectBeginsWith = $subConfig.filters.subjectBeginsWith
            }
            if ($subConfig.filters.subjectEndsWith) {
                $subParams.FilterSubjectEndsWith = $subConfig.filters.subjectEndsWith
            }

            $subscription = New-AzEventGridSystemTopicEventSubscription @subParams

            Write-ToLog -Message "Event Grid Subscription created: $subscriptionName" -Level "SUCCESS"
            $createdSubscriptions += $subscription

        } catch {
            Write-ToLog -Message "Failed to create Event Grid Subscription $subscriptionName : $($_.Exception.Message)" -Level "ERROR"
        }
    }

    return $createdSubscriptions
}

function Generate-SampleData {
    param($StorageAccount)

    if (-not $AzureParams.storage.sampleData.generate -or $null -eq $StorageAccount) {
        return
    }

    $storageContext = $StorageAccount.Context
    $recordCount = $AzureParams.storage.sampleData.recordCount
    $formats = $AzureParams.storage.sampleData.formats
    $daysBack = $AzureParams.storage.sampleData.timePeriodDays

    try {
        if ("json" -in $formats) {
            for ($day = 0; $day -lt $daysBack; $day++) {
                $date = (Get-Date).AddDays(-$day)
                $dateStr = $date.ToString("yyyy/MM/dd")

                $records = @()
                for ($i = 0; $i -lt ($recordCount / $daysBack); $i++) {
                    $records += @{
                        timestamp = $date.AddHours($i % 24).ToString("o")
                        eventId = [guid]::NewGuid().ToString()
                        source = "unified-lab"
                        level = @("INFO", "WARNING", "ERROR")[(Get-Random -Maximum 3)]
                        message = "Sample log message $i"
                    }
                }

                $jsonContent = $records | ConvertTo-Json
                $blobName = "$dateStr/sample-$($date.ToString('yyyyMMdd')).json"

                Set-AzStorageBlobContent `
                    -Container "logs" `
                    -Blob $blobName `
                    -Content $jsonContent `
                    -Context $storageContext `
                    -Force `
                    -ErrorAction SilentlyContinue | Out-Null
            }

            Write-ToLog -Message "JSON sample data generated" -Level "SUCCESS"
        }

        if ("csv" -in $formats) {
            $csvContent = "Timestamp,EventId,Source,Level,Message`n"
            for ($i = 0; $i -lt $recordCount; $i++) {
                $timestamp = (Get-Date).AddMinutes(-$i).ToString("o")
                $eventId = [guid]::NewGuid().ToString()
                $level = @("INFO", "WARNING", "ERROR")[(Get-Random -Maximum 3)]
                $csvContent += "$timestamp,$eventId,unified-lab,$level,Sample message $i`n"
            }

            Set-AzStorageBlobContent `
                -Container "logs" `
                -Blob "sample-data.csv" `
                -Content $csvContent `
                -Context $storageContext `
                -Force `
                -ErrorAction SilentlyContinue | Out-Null

            Write-ToLog -Message "CSV sample data generated" -Level "SUCCESS"
        }

    } catch {
        Write-ToLog -Message "Sample data generation failed: $($_.Exception.Message)" -Level "WARNING"
    }
}

# Main execution
try {
    $storageAccount = Deploy-StorageAccount
    $containers = Deploy-BlobContainers -StorageAccount $storageAccount
    $queues = Deploy-StorageQueues -StorageAccount $storageAccount
    $systemTopic = Deploy-EventGridSystemTopic -StorageAccount $storageAccount
    $subscriptions = Deploy-EventGridSubscriptions -StorageAccount $storageAccount -SystemTopic $systemTopic
    Generate-SampleData -StorageAccount $storageAccount

    Write-ToLog -Message "Storage deployment completed" -Level "SUCCESS"

    return @{
        StorageAccount = $storageAccount
        Containers = $containers
        Queues = $queues
        EventGridSystemTopic = $systemTopic
        EventGridSubscriptions = $subscriptions
    }

} catch {
    Write-ToLog -Message "Storage deployment failed: $($_.Exception.Message)" -Level "ERROR"
    throw
}

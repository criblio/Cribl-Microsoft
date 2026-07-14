# Deploy-EventGrid.ps1
# Phase 3, SubPhase 3.4: Deploy Event Grid System Topic and Subscriptions
# Dependencies: Storage Account (Phase 3.1), Storage Queues (Phase 3.3)

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

    [Parameter(Mandatory=$false)]
    [object]$StorageAccount = $null
)

# Early exit check - skip before any debug logging to reduce noise
if (-not $OperationParams.deployment.storage.deployEventGrid -or -not $AzureParams.storage.eventGrid.enabled) {
    return @{
        Status = "Skipped"
        Message = "Event Grid deployment disabled"
        Data = $null
    }
}

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    DeployEventGrid = $OperationParams.deployment.storage.deployEventGrid
    EventGridEnabled = $AzureParams.storage.eventGrid.enabled
    StorageAccountProvided = ($null -ne $StorageAccount)
} -Context "Deploy-EventGrid"

$mainSw = Start-DebugOperation -Operation "Deploy-EventGrid"

try {
    Write-DebugLog -Message "Starting Event Grid deployment..." -Context "Deploy-EventGrid"

    # Get Storage Account if not provided
    if ($null -eq $StorageAccount) {
        Write-DebugLog -Message "Storage Account not provided, looking up: $($ResourceNames.StorageAccount)" -Context "Deploy-EventGrid"
        Write-DebugAzureCall -Cmdlet "Get-AzStorageAccount" -Parameters @{
            ResourceGroupName = $ResourceGroupName
            Name = $ResourceNames.StorageAccount
        } -Context "Deploy-EventGrid"
        $StorageAccount = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $ResourceNames.StorageAccount -ErrorAction SilentlyContinue

        if ($null -eq $StorageAccount) {
            Write-DebugLog -Message "SKIP REASON: Storage Account not found" -Context "Deploy-EventGrid"
            Stop-DebugOperation -Operation "Deploy-EventGrid" -Stopwatch $mainSw -Success $true
            return @{
                Status = "Skipped"
                Message = "Storage Account not available"
                Data = $null
            }
        }
    }

    # Register Event Grid provider if needed
    Write-DebugAzureCall -Cmdlet "Get-AzResourceProvider" -Parameters @{
        ProviderNamespace = "Microsoft.EventGrid"
    } -Context "Deploy-EventGrid"

    $eventGridProvider = Get-AzResourceProvider -ProviderNamespace Microsoft.EventGrid
    Write-DebugLog -Message "EventGrid provider registration state: $($eventGridProvider.RegistrationState)" -Context "Deploy-EventGrid"

    if ($eventGridProvider.RegistrationState -ne "Registered") {
        Write-DebugLog -Message "EventGrid provider not registered, initiating registration" -Context "Deploy-EventGrid"
        try {
            Write-DebugAzureCall -Cmdlet "Register-AzResourceProvider" -Parameters @{
                ProviderNamespace = "Microsoft.EventGrid"
            } -Context "Deploy-EventGrid"

            Register-AzResourceProvider -ProviderNamespace Microsoft.EventGrid | Out-Null

            $timeout = 120
            $elapsed = 0
            $interval = 5

            while ($elapsed -lt $timeout) {
                $status = (Get-AzResourceProvider -ProviderNamespace Microsoft.EventGrid).RegistrationState
                Write-DebugLog -Message "Provider registration status check: $status (elapsed: ${elapsed}s)" -Context "Deploy-EventGrid"
                if ($status -eq "Registered") {
                    Write-ToLog -Message "Microsoft.EventGrid provider registered" -Level "SUCCESS"
                    break
                }
                Start-Sleep -Seconds $interval
                $elapsed += $interval
            }
        } catch {
            Write-DebugException -Exception $_.Exception -Context "Deploy-EventGrid"
            Write-ToLog -Message "Failed to register Microsoft.EventGrid provider: $($_.Exception.Message)" -Level "ERROR"
            Stop-DebugOperation -Operation "Deploy-EventGrid" -Stopwatch $mainSw -Success $false
            throw
        }
    }

    # Create System Topic
    $topicName = "$($StorageAccount.StorageAccountName)-events"
    Write-DebugLog -Message "System topic name: $topicName" -Context "Deploy-EventGrid"

    Write-DebugAzureCall -Cmdlet "Get-AzEventGridSystemTopic" -Parameters @{
        ResourceGroupName = $ResourceGroupName
        Name = $topicName
    } -Context "Deploy-EventGrid"

    $systemTopic = Get-AzEventGridSystemTopic -ResourceGroupName $ResourceGroupName -Name $topicName -ErrorAction SilentlyContinue

    if ($null -eq $systemTopic) {
        Write-DebugAzureCall -Cmdlet "New-AzEventGridSystemTopic" -Parameters @{
            ResourceGroupName = $ResourceGroupName
            Name = $topicName
            Location = $Location
            TopicType = "Microsoft.Storage.StorageAccounts"
            Source = $StorageAccount.Id
        } -Context "Deploy-EventGrid"

        $systemTopic = New-AzEventGridSystemTopic `
            -ResourceGroupName $ResourceGroupName `
            -Name $topicName `
            -Location $Location `
            -TopicType "Microsoft.Storage.StorageAccounts" `
            -Source $StorageAccount.Id `
            -ErrorAction Stop

        Write-ToLog -Message "Event Grid System Topic created: $topicName" -Level "SUCCESS"
    } else {
        Write-DebugLog -Message "System topic already exists: $topicName" -Context "Deploy-EventGrid"
    }

    Write-DebugResource -ResourceType "EventGridSystemTopic" -ResourceName $topicName -Properties @{
        Id = $systemTopic.Id
        TopicType = $systemTopic.TopicType
    } -Context "Deploy-EventGrid"

    # Create Subscriptions
    $createdSubscriptions = @()
    $subscriptionKeys = @($AzureParams.storage.eventGrid.subscriptions.PSObject.Properties.Name)
    Write-DebugLog -Message "Subscription keys to process: $($subscriptionKeys -join ', ')" -Context "Deploy-EventGrid"

    foreach ($subKey in $subscriptionKeys) {
        $subConfig = $AzureParams.storage.eventGrid.subscriptions.$subKey
        $subscriptionName = "eg-sub-$subKey"
        $queueName = $subConfig.destination

        Write-DebugLog -Message "Processing subscription: $subscriptionName (destination queue: $queueName)" -Context "Deploy-EventGrid"

        Write-DebugAzureCall -Cmdlet "Get-AzEventGridSystemTopicEventSubscription" -Parameters @{
            ResourceGroupName = $ResourceGroupName
            SystemTopicName = $systemTopic.Name
            EventSubscriptionName = $subscriptionName
        } -Context "Deploy-EventGrid"

        $existingSub = Get-AzEventGridSystemTopicEventSubscription `
            -ResourceGroupName $ResourceGroupName `
            -SystemTopicName $systemTopic.Name `
            -EventSubscriptionName $subscriptionName `
            -ErrorAction SilentlyContinue

        if ($null -ne $existingSub) {
            Write-DebugLog -Message "Subscription already exists: $subscriptionName" -Context "Deploy-EventGrid"
            $createdSubscriptions += $existingSub
            continue
        }

        try {
            $targetSubId = $AzureParams.subscriptionId
            $storageQueueId = "/subscriptions/$targetSubId/resourceGroups/$ResourceGroupName/providers/Microsoft.Storage/storageAccounts/$($StorageAccount.StorageAccountName)/queueServices/default/queues/$queueName"

            Write-DebugLog -Message "Target subscription ID: $targetSubId" -Context "Deploy-EventGrid"
            Write-DebugLog -Message "Storage queue ID: $storageQueueId" -Context "Deploy-EventGrid"

            Write-DebugAzureCall -Cmdlet "New-AzEventGridStorageQueueEventSubscriptionDestinationObject" -Parameters @{
                QueueName = $queueName
                ResourceId = $StorageAccount.Id
            } -Context "Deploy-EventGrid"

            $endpoint = New-AzEventGridStorageQueueEventSubscriptionDestinationObject `
                -QueueName $queueName `
                -ResourceId $StorageAccount.Id

            $subParams = @{
                ResourceGroupName = $ResourceGroupName
                SystemTopicName = $systemTopic.Name
                EventSubscriptionName = $subscriptionName
                Destination = $endpoint
                FilterIncludedEventType = $subConfig.eventTypes
            }

            if ($subConfig.filters.subjectBeginsWith) {
                $subParams.FilterSubjectBeginsWith = $subConfig.filters.subjectBeginsWith
                Write-DebugLog -Message "Filter SubjectBeginsWith: $($subConfig.filters.subjectBeginsWith)" -Context "Deploy-EventGrid"
            }
            if ($subConfig.filters.subjectEndsWith) {
                $subParams.FilterSubjectEndsWith = $subConfig.filters.subjectEndsWith
                Write-DebugLog -Message "Filter SubjectEndsWith: $($subConfig.filters.subjectEndsWith)" -Context "Deploy-EventGrid"
            }

            Write-DebugLog -Message "Event types: $($subConfig.eventTypes -join ', ')" -Context "Deploy-EventGrid"
            Write-DebugAzureCall -Cmdlet "New-AzEventGridSystemTopicEventSubscription" -Parameters $subParams -Context "Deploy-EventGrid"

            $subscription = New-AzEventGridSystemTopicEventSubscription @subParams

            Write-ToLog -Message "Event Grid Subscription created: $subscriptionName" -Level "SUCCESS"
            $createdSubscriptions += $subscription

        } catch {
            Write-DebugException -Exception $_.Exception -Context "Deploy-EventGrid" -AdditionalInfo @{
                SubscriptionName = $subscriptionName
                QueueName = $queueName
            }
            Write-ToLog -Message "Failed to create Event Grid subscription $subscriptionName : $($_.Exception.Message)" -Level "ERROR"
        }
    }

    Write-DebugLog -Message "Event Grid deployment completed. Topic: $topicName, Subscriptions: $($createdSubscriptions.Count)" -Context "Deploy-EventGrid"
    Stop-DebugOperation -Operation "Deploy-EventGrid" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "Event Grid deployed successfully"
        Data = @{
            SystemTopic = $systemTopic
            Subscriptions = $createdSubscriptions
            SubscriptionCount = $createdSubscriptions.Count
        }
    }

} catch {
    Write-ToLog -Message "Event Grid deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Deploy-EventGrid"
    Stop-DebugOperation -Operation "Deploy-EventGrid" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}

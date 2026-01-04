# Deploy-StorageQueues.ps1
# Phase 3, SubPhase 3.3: Deploy Storage Queues
# Dependencies: Storage Account (Phase 3.1)

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
if (-not $OperationParams.deployment.storage.deployQueues -or -not $AzureParams.storage.queues.enabled) {
    return @{
        Status = "Skipped"
        Message = "Queue deployment disabled"
        Data = $null
    }
}

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    DeployQueues = $OperationParams.deployment.storage.deployQueues
    QueuesEnabled = $AzureParams.storage.queues.enabled
    StorageAccountProvided = ($null -ne $StorageAccount)
} -Context "Deploy-StorageQueues"

$mainSw = Start-DebugOperation -Operation "Deploy-StorageQueues"

try {
    Write-DebugLog -Message "Starting Storage Queues deployment..." -Context "Deploy-StorageQueues"

    # Get Storage Account if not provided
    if ($null -eq $StorageAccount) {
        Write-DebugLog -Message "Storage Account not provided, looking up: $($ResourceNames.StorageAccount)" -Context "Deploy-StorageQueues"
        Write-DebugAzureCall -Cmdlet "Get-AzStorageAccount" -Parameters @{
            ResourceGroupName = $ResourceGroupName
            Name = $ResourceNames.StorageAccount
        } -Context "Deploy-StorageQueues"
        $StorageAccount = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $ResourceNames.StorageAccount -ErrorAction SilentlyContinue

        if ($null -eq $StorageAccount) {
            Write-DebugLog -Message "SKIP REASON: Storage Account not found" -Context "Deploy-StorageQueues"
            Stop-DebugOperation -Operation "Deploy-StorageQueues" -Stopwatch $mainSw -Success $true
            return @{
                Status = "Skipped"
                Message = "Storage Account not available"
                Data = $null
            }
        }
    }

    $storageContext = $StorageAccount.Context
    $createdQueues = @()

    $queueKeys = @($AzureParams.storage.queues.definitions.PSObject.Properties.Name)
    Write-DebugLog -Message "Queue keys to process: $($queueKeys -join ', ')" -Context "Deploy-StorageQueues"

    foreach ($queueKey in $queueKeys) {
        $queueConfig = $AzureParams.storage.queues.definitions.$queueKey
        $queueName = $queueConfig.name

        Write-DebugLog -Message "Processing queue: $queueName (key: $queueKey)" -Context "Deploy-StorageQueues"

        Write-DebugAzureCall -Cmdlet "Get-AzStorageQueue" -Parameters @{
            Name = $queueName
            Context = "StorageAccountContext"
        } -Context "Deploy-StorageQueues"

        $existingQueue = Get-AzStorageQueue -Name $queueName -Context $storageContext -ErrorAction SilentlyContinue

        if ($null -ne $existingQueue) {
            Write-DebugLog -Message "Queue already exists: $queueName" -Context "Deploy-StorageQueues"
            $createdQueues += $existingQueue
            continue
        }

        try {
            Write-DebugAzureCall -Cmdlet "New-AzStorageQueue" -Parameters @{
                Name = $queueName
            } -Context "Deploy-StorageQueues"

            $queue = New-AzStorageQueue `
                -Name $queueName `
                -Context $storageContext `
                -ErrorAction Stop

            Write-ToLog -Message "Queue created: $queueName" -Level "SUCCESS"
            Write-DebugLog -Message "Queue created successfully: $queueName" -Context "Deploy-StorageQueues"
            $createdQueues += $queue

        } catch {
            Write-DebugException -Exception $_.Exception -Context "Deploy-StorageQueues" -AdditionalInfo @{
                QueueName = $queueName
            }
            Write-ToLog -Message "Failed to create queue $queueName : $($_.Exception.Message)" -Level "ERROR"
        }
    }

    Write-DebugLog -Message "Total queues processed: $($createdQueues.Count)" -Context "Deploy-StorageQueues"
    Stop-DebugOperation -Operation "Deploy-StorageQueues" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "Storage Queues deployed successfully"
        Data = @{
            Queues = $createdQueues
            Count = $createdQueues.Count
        }
    }

} catch {
    Write-ToLog -Message "Storage Queues deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Deploy-StorageQueues"
    Stop-DebugOperation -Operation "Deploy-StorageQueues" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}

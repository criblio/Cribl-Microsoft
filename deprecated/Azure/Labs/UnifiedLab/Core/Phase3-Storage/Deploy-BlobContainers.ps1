# Deploy-BlobContainers.ps1
# Phase 3, SubPhase 3.2: Deploy Blob Containers
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
if (-not $OperationParams.deployment.storage.deployContainers) {
    return @{
        Status = "Skipped"
        Message = "Container deployment disabled"
        Data = $null
    }
}

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    DeployContainers = $OperationParams.deployment.storage.deployContainers
    StorageAccountProvided = ($null -ne $StorageAccount)
} -Context "Deploy-BlobContainers"

$mainSw = Start-DebugOperation -Operation "Deploy-BlobContainers"

try {
    Write-DebugLog -Message "Starting Blob Containers deployment..." -Context "Deploy-BlobContainers"

    # Get Storage Account if not provided
    if ($null -eq $StorageAccount) {
        Write-DebugLog -Message "Storage Account not provided, looking up: $($ResourceNames.StorageAccount)" -Context "Deploy-BlobContainers"
        Write-DebugAzureCall -Cmdlet "Get-AzStorageAccount" -Parameters @{
            ResourceGroupName = $ResourceGroupName
            Name = $ResourceNames.StorageAccount
        } -Context "Deploy-BlobContainers"
        $StorageAccount = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $ResourceNames.StorageAccount -ErrorAction SilentlyContinue

        if ($null -eq $StorageAccount) {
            Write-DebugLog -Message "SKIP REASON: Storage Account not found" -Context "Deploy-BlobContainers"
            Stop-DebugOperation -Operation "Deploy-BlobContainers" -Stopwatch $mainSw -Success $true
            return @{
                Status = "Skipped"
                Message = "Storage Account not available"
                Data = $null
            }
        }
    }

    $storageContext = $StorageAccount.Context
    $createdContainers = @()

    $containerKeys = @($AzureParams.storage.containers.PSObject.Properties.Name)
    Write-DebugLog -Message "Container keys to process: $($containerKeys -join ', ')" -Context "Deploy-BlobContainers"

    foreach ($containerKey in $containerKeys) {
        $containerConfig = $AzureParams.storage.containers.$containerKey
        $containerName = $containerConfig.name

        # Skip flowlogs container if Flow Logs are not being deployed
        # The flowlogs container is auto-created by Azure when Flow Logs are enabled
        if ($containerKey -eq "flowlogs" -and -not $OperationParams.deployment.monitoring.deployFlowLogs) {
            Write-DebugLog -Message "Skipping flowlogs container (Flow Logs not deployed)" -Context "Deploy-BlobContainers"
            continue
        }

        # Skip criblqueuesource container if Event Grid is not being deployed (BlobQueueLab only)
        if ($containerKey -eq "criblqueuesource" -and -not $OperationParams.deployment.storage.deployEventGrid) {
            Write-DebugLog -Message "Skipping criblqueuesource container (Event Grid not deployed - not BlobQueueLab)" -Context "Deploy-BlobContainers"
            continue
        }

        # Skip criblblobcollector container if Event Grid IS being deployed (BlobCollectorLab only)
        if ($containerKey -eq "criblblobcollector" -and $OperationParams.deployment.storage.deployEventGrid) {
            Write-DebugLog -Message "Skipping criblblobcollector container (Event Grid deployed - not BlobCollectorLab)" -Context "Deploy-BlobContainers"
            continue
        }

        Write-DebugLog -Message "Processing container: $containerName (key: $containerKey)" -Context "Deploy-BlobContainers"

        Write-DebugAzureCall -Cmdlet "Get-AzStorageContainer" -Parameters @{
            Name = $containerName
            Context = "StorageAccountContext"
        } -Context "Deploy-BlobContainers"

        $existingContainer = Get-AzStorageContainer -Name $containerName -Context $storageContext -ErrorAction SilentlyContinue

        if ($null -ne $existingContainer) {
            Write-DebugLog -Message "Container already exists: $containerName" -Context "Deploy-BlobContainers"
            $createdContainers += $existingContainer
            continue
        }

        try {
            Write-DebugAzureCall -Cmdlet "New-AzStorageContainer" -Parameters @{
                Name = $containerName
                Permission = "Off"
            } -Context "Deploy-BlobContainers"

            $container = New-AzStorageContainer `
                -Name $containerName `
                -Context $storageContext `
                -Permission Off `
                -ErrorAction Stop

            Write-ToLog -Message "Container created: $containerName" -Level "SUCCESS"
            Write-DebugLog -Message "Container created successfully: $containerName" -Context "Deploy-BlobContainers"
            $createdContainers += $container

        } catch {
            Write-DebugException -Exception $_.Exception -Context "Deploy-BlobContainers" -AdditionalInfo @{
                ContainerName = $containerName
            }
            Write-ToLog -Message "Failed to create container $containerName : $($_.Exception.Message)" -Level "ERROR"
        }
    }

    Write-DebugLog -Message "Total containers processed: $($createdContainers.Count)" -Context "Deploy-BlobContainers"
    Stop-DebugOperation -Operation "Deploy-BlobContainers" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "Blob Containers deployed successfully"
        Data = @{
            Containers = $createdContainers
            Count = $createdContainers.Count
        }
    }

} catch {
    Write-ToLog -Message "Blob Containers deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Deploy-BlobContainers"
    Stop-DebugOperation -Operation "Deploy-BlobContainers" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}

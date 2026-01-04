# Deploy-StorageAccount.ps1
# Phase 3, SubPhase 3.1: Deploy Azure Storage Account
# Dependencies: Resource Group (Phase 1.1)

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

# Early exit check - skip before any debug logging to reduce noise
if (-not $OperationParams.deployment.storage.deployStorageAccount) {
    return @{
        Status = "Skipped"
        Message = "Storage Account deployment disabled"
        Data = $null
    }
}

$SkipExisting = $OperationParams.validation.skipExistingResources

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    SkipExisting = $SkipExisting
    DeployStorageAccount = $OperationParams.deployment.storage.deployStorageAccount
    StorageAccountName = $ResourceNames.StorageAccount
} -Context "Deploy-StorageAccount"

function Get-RandomSuffix {
    param([int]$Length = 4)
    $chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    $suffix = -join ((1..$Length) | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
    return $suffix
}

$mainSw = Start-DebugOperation -Operation "Deploy-StorageAccount"

try {
    Write-DebugLog -Message "Starting Storage Account deployment..." -Context "Deploy-StorageAccount"

    $baseStorageAccountName = $ResourceNames.StorageAccount
    $storageAccountName = $baseStorageAccountName
    $storageConfig = $AzureParams.storage.accounts.primary

    Write-DebugLog -Message "Base storage account name: $baseStorageAccountName" -Context "Deploy-StorageAccount"
    Write-DebugLog -Message "Storage config - SKU: $($storageConfig.sku), Kind: $($storageConfig.kind), AccessTier: $($storageConfig.accessTier)" -Context "Deploy-StorageAccount"

    Write-DebugAzureCall -Cmdlet "Get-AzStorageAccount" -Parameters @{
        ResourceGroupName = $ResourceGroupName
        Name = $storageAccountName
    } -Context "Deploy-StorageAccount"

    $existingStorage = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $storageAccountName -ErrorAction SilentlyContinue

    if ($null -ne $existingStorage) {
        Write-DebugLog -Message "Existing storage account found: $storageAccountName" -Context "Deploy-StorageAccount"
        Write-DebugResource -ResourceType "StorageAccount" -ResourceName $storageAccountName -ResourceId $existingStorage.Id -Properties @{
            Sku = $existingStorage.Sku.Name
            Kind = $existingStorage.Kind
            AccessTier = $existingStorage.AccessTier
        } -Context "Deploy-StorageAccount"

        if ($SkipExisting) {
            Write-ToLog -Message "Storage Account exists: $storageAccountName" -Level "SUCCESS"
            Stop-DebugOperation -Operation "Deploy-StorageAccount" -Stopwatch $mainSw -Success $true
            return @{
                Status = "Success"
                Message = "Storage Account already exists"
                Data = @{
                    StorageAccount = $existingStorage
                    Name = $storageAccountName
                }
            }
        } else {
            Write-DebugLog -Message "ERROR: Storage Account exists and SkipExisting is false" -Context "Deploy-StorageAccount"
            Stop-DebugOperation -Operation "Deploy-StorageAccount" -Stopwatch $mainSw -Success $false
            throw "Storage Account already exists"
        }
    }

    # Create new Storage Account with retry logic for name conflicts
    $maxRetries = 5
    $retryCount = 0
    $storageAccount = $null

    while ($null -eq $storageAccount -and $retryCount -lt $maxRetries) {
        Write-DebugLog -Message "Creation attempt $($retryCount + 1) of $maxRetries with name: $storageAccountName" -Context "Deploy-StorageAccount"

        try {
            Write-DebugAzureCall -Cmdlet "New-AzStorageAccount" -Parameters @{
                ResourceGroupName = $ResourceGroupName
                Name = $storageAccountName
                Location = $Location
                SkuName = $storageConfig.sku
                Kind = $storageConfig.kind
                AccessTier = $storageConfig.accessTier
            } -Context "Deploy-StorageAccount"

            $storageAccount = New-AzStorageAccount `
                -ResourceGroupName $ResourceGroupName `
                -Name $storageAccountName `
                -Location $Location `
                -SkuName $storageConfig.sku `
                -Kind $storageConfig.kind `
                -AccessTier $storageConfig.accessTier `
                -ErrorAction Stop

            Write-ToLog -Message "Storage Account created: $storageAccountName" -Level "SUCCESS"
            Write-DebugResource -ResourceType "StorageAccount" -ResourceName $storageAccountName -ResourceId $storageAccount.Id -Properties @{
                Sku = $storageAccount.Sku.Name
                Kind = $storageAccount.Kind
                AccessTier = $storageAccount.AccessTier
            } -Context "Deploy-StorageAccount"

        } catch {
            $retryCount++
            Write-DebugLog -Message "Attempt $retryCount failed: $($_.Exception.Message)" -Context "Deploy-StorageAccount"

            if ($_.Exception.Message -like "*already taken*" -or $_.Exception.Message -like "*already in use*") {
                $storageAccountName = $baseStorageAccountName.Substring(0, [Math]::Min(20, $baseStorageAccountName.Length)) + (Get-RandomSuffix)
                if ($storageAccountName.Length -gt 24) {
                    $storageAccountName = $storageAccountName.Substring(0, 24)
                }
                Write-DebugLog -Message "Name conflict, retrying with new name: $storageAccountName" -Context "Deploy-StorageAccount"
            } else {
                Write-ToLog -Message "Failed to create Storage Account: $($_.Exception.Message)" -Level "ERROR"
                Write-DebugException -Exception $_.Exception -Context "Deploy-StorageAccount"
                Stop-DebugOperation -Operation "Deploy-StorageAccount" -Stopwatch $mainSw -Success $false
                throw
            }
        }
    }

    if ($null -eq $storageAccount) {
        Write-ToLog -Message "Failed to create Storage Account after $maxRetries attempts" -Level "ERROR"
        Stop-DebugOperation -Operation "Deploy-StorageAccount" -Stopwatch $mainSw -Success $false
        throw "Unable to find available storage account name after $maxRetries attempts"
    }

    # Enable optional features
    if ($storageConfig.enableBlobVersioning) {
        Write-DebugLog -Message "Enabling blob delete retention policy" -Context "Deploy-StorageAccount"
        Enable-AzStorageBlobDeleteRetentionPolicy `
            -ResourceGroupName $ResourceGroupName `
            -StorageAccountName $storageAccountName `
            -RetentionDays 7 `
            -ErrorAction SilentlyContinue
    }

    if ($storageConfig.enableBlobChangeFeed) {
        Write-DebugLog -Message "Enabling blob change feed" -Context "Deploy-StorageAccount"
        Update-AzStorageBlobServiceProperty `
            -ResourceGroupName $ResourceGroupName `
            -StorageAccountName $storageAccountName `
            -EnableChangeFeed $true `
            -ErrorAction SilentlyContinue
    }

    Stop-DebugOperation -Operation "Deploy-StorageAccount" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "Storage Account deployed successfully"
        Data = @{
            StorageAccount = $storageAccount
            Name = $storageAccountName
        }
    }

} catch {
    Write-ToLog -Message "Storage Account deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Deploy-StorageAccount"
    Stop-DebugOperation -Operation "Deploy-StorageAccount" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}

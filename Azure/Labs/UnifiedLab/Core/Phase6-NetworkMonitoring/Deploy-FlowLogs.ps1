# Deploy-FlowLogs.ps1
# Phase 6, SubPhase 6.1: Deploy Azure Network Flow Logs
# Dependencies: VNet (Phase 3.1), Storage Account (Phase 2.1)

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
    [object]$VNet = $null,

    [Parameter(Mandatory=$false)]
    [object]$StorageAccount = $null
)

# Early exit check - skip before any debug logging to reduce noise
if (-not $OperationParams.deployment.monitoring.deployFlowLogs -or -not $AzureParams.monitoring.flowLogging.enabled) {
    return @{
        Status = "Skipped"
        Message = "Flow Logs deployment disabled"
        Data = $null
    }
}

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    VNetProvided = ($null -ne $VNet)
    StorageAccountProvided = ($null -ne $StorageAccount)
    DeployFlowLogs = $OperationParams.deployment.monitoring.deployFlowLogs
    FlowLoggingEnabled = $AzureParams.monitoring.flowLogging.enabled
} -Context "Deploy-FlowLogs"

$mainSw = Start-DebugOperation -Operation "Deploy-FlowLogs"

try {
    Write-DebugLog -Message "Starting Flow Logs deployment..." -Context "Deploy-FlowLogs"

    # Get VNet if not provided
    if ($null -eq $VNet) {
        Write-DebugLog -Message "VNet not provided, looking up: $($ResourceNames.VNet)" -Context "Deploy-FlowLogs"
        Write-DebugAzureCall -Cmdlet "Get-AzVirtualNetwork" -Parameters @{
            ResourceGroupName = $ResourceGroupName
            Name = $ResourceNames.VNet
        } -Context "Deploy-FlowLogs"
        $VNet = Get-AzVirtualNetwork -ResourceGroupName $ResourceGroupName -Name $ResourceNames.VNet -ErrorAction SilentlyContinue
    }

    if ($null -eq $VNet) {
        Write-DebugLog -Message "SKIP REASON: VNet not found" -Context "Deploy-FlowLogs"
        Write-ToLog -Message "VNet not found, cannot deploy Flow Logs" -Level "WARNING"
        Stop-DebugOperation -Operation "Deploy-FlowLogs" -Stopwatch $mainSw -Success $true
        return @{
            Status = "Skipped"
            Message = "VNet not available"
            Data = $null
        }
    }
    Write-DebugLog -Message "VNet found: $($VNet.Name)" -Context "Deploy-FlowLogs"

    # Get Storage Account - use passed object if available, otherwise lookup
    if ($null -eq $StorageAccount) {
        Write-DebugLog -Message "StorageAccount not provided, looking up: $($ResourceNames.StorageAccount)" -Context "Deploy-FlowLogs"
        Write-DebugAzureCall -Cmdlet "Get-AzStorageAccount" -Parameters @{
            ResourceGroupName = $ResourceGroupName
            Name = $ResourceNames.StorageAccount
        } -Context "Deploy-FlowLogs"
        $StorageAccount = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $ResourceNames.StorageAccount -ErrorAction SilentlyContinue

        # If named lookup fails, try to find any storage account in the resource group
        if ($null -eq $StorageAccount) {
            Write-DebugLog -Message "Named storage account not found, looking for any storage account in resource group..." -Context "Deploy-FlowLogs"
            Write-DebugAzureCall -Cmdlet "Get-AzStorageAccount" -Parameters @{
                ResourceGroupName = $ResourceGroupName
            } -Context "Deploy-FlowLogs"
            $StorageAccount = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue | Select-Object -First 1
        }
    }

    if ($null -eq $StorageAccount) {
        Write-DebugLog -Message "SKIP REASON: Storage Account not found" -Context "Deploy-FlowLogs"
        Write-ToLog -Message "Storage Account not found, cannot deploy Flow Logs" -Level "WARNING"
        Stop-DebugOperation -Operation "Deploy-FlowLogs" -Stopwatch $mainSw -Success $true
        return @{
            Status = "Skipped"
            Message = "Storage Account not available"
            Data = $null
        }
    }
    Write-DebugLog -Message "Storage Account found: $($StorageAccount.StorageAccountName)" -Context "Deploy-FlowLogs"

    # Get or create Network Watcher
    $networkWatcherName = $ResourceNames.NetworkWatcher
    Write-DebugLog -Message "Looking for Network Watcher: $networkWatcherName" -Context "Deploy-FlowLogs"

    Write-DebugAzureCall -Cmdlet "Get-AzNetworkWatcher" -Parameters @{
        ResourceGroupName = $ResourceGroupName
        Name = $networkWatcherName
    } -Context "Deploy-FlowLogs"
    $networkWatcher = Get-AzNetworkWatcher -ResourceGroupName $ResourceGroupName -Name $networkWatcherName -ErrorAction SilentlyContinue

    if ($null -eq $networkWatcher) {
        Write-DebugLog -Message "Network Watcher not found in RG, checking default location..." -Context "Deploy-FlowLogs"
        $nwRG = "NetworkWatcherRG"
        $nwName = "NetworkWatcher_$Location"

        Write-DebugAzureCall -Cmdlet "Get-AzNetworkWatcher" -Parameters @{
            ResourceGroupName = $nwRG
            Name = $nwName
        } -Context "Deploy-FlowLogs"
        $networkWatcher = Get-AzNetworkWatcher -ResourceGroupName $nwRG -Name $nwName -ErrorAction SilentlyContinue

        if ($null -eq $networkWatcher) {
            Write-DebugLog -Message "Creating new Network Watcher: $networkWatcherName" -Context "Deploy-FlowLogs"
            $networkWatcher = New-AzNetworkWatcher `
                -ResourceGroupName $ResourceGroupName `
                -Name $networkWatcherName `
                -Location $Location `
                -ErrorAction Stop
            Write-ToLog -Message "Network Watcher created: $networkWatcherName" -Level "SUCCESS"
        } else {
            Write-DebugLog -Message "Using existing Network Watcher: $nwName in $nwRG" -Context "Deploy-FlowLogs"
        }
    } else {
        Write-DebugLog -Message "Using existing Network Watcher: $networkWatcherName" -Context "Deploy-FlowLogs"
    }

    $vnetName = $VNet.Name
    $flowLogResults = @{
        VNetLevel = $null
        SubnetLevel = @()
    }

    # Deploy vNet-level flow log
    if ($AzureParams.monitoring.flowLogging.vnetLevel.enabled) {
        Write-DebugLog -Message "Deploying VNet-level Flow Log..." -Context "Deploy-FlowLogs"
        Write-DebugLog -Message "  Retention Days: $($AzureParams.monitoring.flowLogging.vnetLevel.retentionDays)" -Context "Deploy-FlowLogs"

        try {
            $flowLogConfig = @{
                TargetResourceId = $VNet.Id
                StorageId = $StorageAccount.Id
                Enabled = $true
                RetentionPolicyDays = $AzureParams.monitoring.flowLogging.vnetLevel.retentionDays
            }

            Write-DebugAzureCall -Cmdlet "Set-AzNetworkWatcherFlowLog" -Parameters @{
                Name = "FlowLog-$vnetName"
                TargetResourceId = $VNet.Id
                StorageId = $StorageAccount.Id
            } -Context "Deploy-FlowLogs"

            $flowLogResults.VNetLevel = Set-AzNetworkWatcherFlowLog `
                -NetworkWatcher $networkWatcher `
                -Name "FlowLog-$vnetName" `
                @flowLogConfig `
                -Force `
                -ErrorAction Stop

            Write-ToLog -Message "VNet-level Flow Log configured: $vnetName" -Level "SUCCESS"
            Write-DebugLog -Message "VNet-level Flow Log created successfully" -Context "Deploy-FlowLogs"

        } catch {
            if ($_.Exception.Message -notlike "*CannotCreateMoreThanOneFlowLogPerTargetResource*") {
                Write-ToLog -Message "Failed to configure VNet-level Flow Log: $($_.Exception.Message)" -Level "ERROR"
                Write-DebugException -Exception $_.Exception -Context "Deploy-FlowLogs"
            } else {
                Write-DebugLog -Message "Flow Log already exists for this VNet (acceptable)" -Context "Deploy-FlowLogs"
                Write-ToLog -Message "VNet-level Flow Log already exists: $vnetName" -Level "INFO"
            }
        }
    } else {
        Write-DebugLog -Message "VNet-level Flow Log disabled in configuration" -Context "Deploy-FlowLogs"
    }

    # Deploy subnet-level flow logs
    Write-DebugLog -Message "Processing subnet-level Flow Logs..." -Context "Deploy-FlowLogs"
    foreach ($subnetKey in $AzureParams.infrastructure.subnets.PSObject.Properties.Name) {
        $subnetDef = $AzureParams.infrastructure.subnets.$subnetKey
        $subnetFlowConfig = $AzureParams.monitoring.flowLogging.subnetLevel.$subnetKey

        if ($null -eq $subnetFlowConfig -or -not $subnetFlowConfig.enabled) {
            Write-DebugLog -Message "  Subnet $($subnetDef.name): Flow Log disabled or not configured" -Context "Deploy-FlowLogs"
            continue
        }

        Write-DebugLog -Message "  Subnet $($subnetDef.name): Configuring Flow Log" -Context "Deploy-FlowLogs"

        $subnet = Get-AzVirtualNetworkSubnetConfig -Name $subnetDef.name -VirtualNetwork $VNet -ErrorAction SilentlyContinue

        if ($null -eq $subnet) {
            Write-DebugLog -Message "  Subnet $($subnetDef.name): Not found in VNet, skipping" -Context "Deploy-FlowLogs"
            continue
        }

        try {
            $flowLogConfig = @{
                TargetResourceId = $subnet.Id
                StorageId = $StorageAccount.Id
                Enabled = $true
                RetentionPolicyDays = $subnetFlowConfig.retentionDays
            }

            $flowLogName = "FlowLog-$vnetName-$($subnetDef.name)"

            Write-DebugAzureCall -Cmdlet "Set-AzNetworkWatcherFlowLog" -Parameters @{
                Name = $flowLogName
                TargetResourceId = $subnet.Id
                StorageId = $StorageAccount.Id
            } -Context "Deploy-FlowLogs"

            $subnetFlowLog = Set-AzNetworkWatcherFlowLog `
                -NetworkWatcher $networkWatcher `
                -Name $flowLogName `
                @flowLogConfig `
                -Force `
                -ErrorAction Stop

            $flowLogResults.SubnetLevel += $subnetFlowLog
            Write-ToLog -Message "Subnet-level Flow Log configured: $($subnetDef.name)" -Level "SUCCESS"
            Write-DebugLog -Message "  Subnet $($subnetDef.name): Flow Log created successfully" -Context "Deploy-FlowLogs"

        } catch {
            if ($_.Exception.Message -notlike "*CannotCreateMoreThanOneFlowLogPerTargetResource*") {
                Write-ToLog -Message "Failed to configure subnet-level Flow Log for $($subnetDef.name): $($_.Exception.Message)" -Level "WARNING"
                Write-DebugException -Exception $_.Exception -Context "Deploy-FlowLogs" -AdditionalInfo @{
                    Subnet = $subnetDef.name
                }
            } else {
                Write-DebugLog -Message "  Subnet $($subnetDef.name): Flow Log already exists (acceptable)" -Context "Deploy-FlowLogs"
            }
        }
    }

    Write-ToLog -Message "Flow Logs deployment completed" -Level "SUCCESS"
    Write-DebugLog -Message "Flow Logs deployment completed successfully" -Context "Deploy-FlowLogs"
    Stop-DebugOperation -Operation "Deploy-FlowLogs" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "Flow Logs deployed successfully"
        Data = $flowLogResults
    }

} catch {
    Write-ToLog -Message "Flow Logs deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Deploy-FlowLogs"
    Stop-DebugOperation -Operation "Deploy-FlowLogs" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}

# Deploy-LogAnalytics.ps1
# Phase 4, SubPhase 4.1: Deploy Log Analytics Workspace
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

$SkipExisting = $OperationParams.validation.skipExistingResources

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    SkipExisting = $SkipExisting
    DeployLogAnalytics = $OperationParams.deployment.monitoring.deployLogAnalytics
    WorkspaceName = $ResourceNames.LogAnalytics
} -Context "Deploy-LogAnalytics"

$mainSw = Start-DebugOperation -Operation "Deploy-LogAnalytics"

try {
    Write-DebugLog -Message "Starting Log Analytics Workspace deployment..." -Context "Deploy-LogAnalytics"

    if (-not $OperationParams.deployment.monitoring.deployLogAnalytics) {
        Write-DebugLog -Message "SKIP REASON: deployLogAnalytics is false in operation parameters" -Context "Deploy-LogAnalytics"
        Stop-DebugOperation -Operation "Deploy-LogAnalytics" -Stopwatch $mainSw -Success $true
        return @{
            Status = "Skipped"
            Message = "Log Analytics deployment disabled"
            Data = $null
        }
    }

    $lawName = $ResourceNames.LogAnalytics
    $lawConfig = $AzureParams.monitoring.logAnalyticsWorkspace

    Write-DebugLog -Message "Log Analytics Workspace Name: $lawName" -Context "Deploy-LogAnalytics"
    Write-DebugLog -Message "SKU: $($lawConfig.sku)" -Context "Deploy-LogAnalytics"
    Write-DebugLog -Message "Retention Days: $($lawConfig.retentionInDays)" -Context "Deploy-LogAnalytics"

    Write-DebugAzureCall -Cmdlet "Get-AzOperationalInsightsWorkspace" -Parameters @{
        ResourceGroupName = $ResourceGroupName
        Name = $lawName
    } -Context "Deploy-LogAnalytics"

    $existingWorkspace = Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -Name $lawName -ErrorAction SilentlyContinue

    if ($null -ne $existingWorkspace) {
        Write-DebugLog -Message "Existing Log Analytics Workspace found" -Context "Deploy-LogAnalytics"
        Write-DebugResource -ResourceType "OperationalInsightsWorkspace" -ResourceName $lawName -ResourceId $existingWorkspace.ResourceId -Properties @{
            Sku = $existingWorkspace.Sku
            RetentionInDays = $existingWorkspace.RetentionInDays
            CustomerId = $existingWorkspace.CustomerId
        } -Context "Deploy-LogAnalytics"

        if ($SkipExisting) {
            Write-ToLog -Message "Log Analytics Workspace exists: $lawName" -Level "SUCCESS"
            Stop-DebugOperation -Operation "Deploy-LogAnalytics" -Stopwatch $mainSw -Success $true
            return @{
                Status = "Success"
                Message = "Log Analytics Workspace already exists"
                Data = @{
                    Workspace = $existingWorkspace
                    Name = $lawName
                }
            }
        } else {
            Write-DebugLog -Message "ERROR: Workspace exists and SkipExisting is false" -Context "Deploy-LogAnalytics"
            Stop-DebugOperation -Operation "Deploy-LogAnalytics" -Stopwatch $mainSw -Success $false
            throw "Log Analytics Workspace already exists"
        }
    }

    # Create new workspace
    Write-DebugLog -Message "Creating new Log Analytics Workspace..." -Context "Deploy-LogAnalytics"
    Write-DebugAzureCall -Cmdlet "New-AzOperationalInsightsWorkspace" -Parameters @{
        ResourceGroupName = $ResourceGroupName
        Name = $lawName
        Location = $Location
        Sku = $lawConfig.sku
        RetentionInDays = $lawConfig.retentionInDays
    } -Context "Deploy-LogAnalytics"

    $workspace = New-AzOperationalInsightsWorkspace `
        -ResourceGroupName $ResourceGroupName `
        -Name $lawName `
        -Location $Location `
        -Sku $lawConfig.sku `
        -RetentionInDays $lawConfig.retentionInDays `
        -ErrorAction Stop

    Write-ToLog -Message "Log Analytics Workspace created: $lawName" -Level "SUCCESS"
    Write-DebugResource -ResourceType "OperationalInsightsWorkspace" -ResourceName $lawName -ResourceId $workspace.ResourceId -Properties @{
        Sku = $workspace.Sku
        RetentionInDays = $workspace.RetentionInDays
        CustomerId = $workspace.CustomerId
    } -Context "Deploy-LogAnalytics"

    Stop-DebugOperation -Operation "Deploy-LogAnalytics" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "Log Analytics Workspace deployed successfully"
        Data = @{
            Workspace = $workspace
            Name = $lawName
        }
    }

} catch {
    Write-ToLog -Message "Log Analytics Workspace deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Deploy-LogAnalytics"
    Stop-DebugOperation -Operation "Deploy-LogAnalytics" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}

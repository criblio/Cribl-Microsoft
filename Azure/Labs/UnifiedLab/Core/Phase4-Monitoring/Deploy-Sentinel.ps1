# Deploy-Sentinel.ps1
# Phase 4, SubPhase 4.2: Deploy Microsoft Sentinel
# Dependencies: Log Analytics Workspace (Phase 4.1)

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
    [object]$Workspace = $null
)

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    DeploySentinel = $OperationParams.deployment.monitoring.deploySentinel
    SentinelEnabled = $AzureParams.monitoring.sentinel.enabled
    WorkspaceProvided = ($null -ne $Workspace)
} -Context "Deploy-Sentinel"

$mainSw = Start-DebugOperation -Operation "Deploy-Sentinel"

try {
    Write-DebugLog -Message "Starting Microsoft Sentinel deployment..." -Context "Deploy-Sentinel"

    if (-not $OperationParams.deployment.monitoring.deploySentinel -or -not $AzureParams.monitoring.sentinel.enabled) {
        if (-not $OperationParams.deployment.monitoring.deploySentinel) {
            Write-DebugLog -Message "SKIP REASON: deploySentinel is false in operation parameters" -Context "Deploy-Sentinel"
        }
        if (-not $AzureParams.monitoring.sentinel.enabled) {
            Write-DebugLog -Message "SKIP REASON: sentinel.enabled is false in azure parameters" -Context "Deploy-Sentinel"
        }
        Stop-DebugOperation -Operation "Deploy-Sentinel" -Stopwatch $mainSw -Success $true
        return @{
            Status = "Skipped"
            Message = "Sentinel deployment disabled"
            Data = $null
        }
    }

    # Get Workspace if not provided
    if ($null -eq $Workspace) {
        Write-DebugLog -Message "Workspace not provided, looking up: $($ResourceNames.LogAnalytics)" -Context "Deploy-Sentinel"
        Write-DebugAzureCall -Cmdlet "Get-AzOperationalInsightsWorkspace" -Parameters @{
            ResourceGroupName = $ResourceGroupName
            Name = $ResourceNames.LogAnalytics
        } -Context "Deploy-Sentinel"
        $Workspace = Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -Name $ResourceNames.LogAnalytics -ErrorAction SilentlyContinue

        if ($null -eq $Workspace) {
            Write-DebugLog -Message "SKIP REASON: Log Analytics Workspace not found" -Context "Deploy-Sentinel"
            Stop-DebugOperation -Operation "Deploy-Sentinel" -Stopwatch $mainSw -Success $true
            return @{
                Status = "Skipped"
                Message = "Log Analytics Workspace not available"
                Data = $null
            }
        }
    }

    $lawName = $ResourceNames.LogAnalytics
    $solutionName = "SecurityInsights($lawName)"

    Write-DebugLog -Message "Target workspace: $lawName" -Context "Deploy-Sentinel"
    Write-DebugLog -Message "Checking for existing Sentinel solution: $solutionName" -Context "Deploy-Sentinel"

    Write-DebugAzureCall -Cmdlet "Get-AzResource" -Parameters @{
        ResourceGroupName = $ResourceGroupName
        ResourceType = "Microsoft.OperationsManagement/solutions"
        ResourceName = $solutionName
    } -Context "Deploy-Sentinel"

    $existingSolution = Get-AzResource `
        -ResourceGroupName $ResourceGroupName `
        -ResourceType "Microsoft.OperationsManagement/solutions" `
        -ResourceName $solutionName `
        -ErrorAction SilentlyContinue

    if ($null -ne $existingSolution) {
        Write-DebugLog -Message "Sentinel solution already exists" -Context "Deploy-Sentinel"
        Write-DebugResource -ResourceType "SecurityInsightsSolution" -ResourceName $solutionName -ResourceId $existingSolution.ResourceId -Context "Deploy-Sentinel"
        Write-ToLog -Message "Microsoft Sentinel already enabled: $lawName" -Level "SUCCESS"
        Stop-DebugOperation -Operation "Deploy-Sentinel" -Stopwatch $mainSw -Success $true
        return @{
            Status = "Success"
            Message = "Microsoft Sentinel already exists"
            Data = @{
                Solution = $existingSolution
                WorkspaceName = $lawName
            }
        }
    }

    # Create Sentinel solution via ARM deployment
    Write-DebugLog -Message "Creating Sentinel solution via ARM deployment..." -Context "Deploy-Sentinel"
    $deploymentName = "sentinel-$(Get-Date -Format 'yyyyMMddHHmmss')"
    Write-DebugLog -Message "Deployment name: $deploymentName" -Context "Deploy-Sentinel"

    $template = @{
        '$schema' = "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"
        contentVersion = "1.0.0.0"
        resources = @(
            @{
                type = "Microsoft.OperationsManagement/solutions"
                apiVersion = "2015-11-01-preview"
                name = "SecurityInsights($lawName)"
                location = $Location
                plan = @{
                    name = "SecurityInsights($lawName)"
                    publisher = "Microsoft"
                    product = "OMSGallery/SecurityInsights"
                    promotionCode = ""
                }
                properties = @{
                    workspaceResourceId = $Workspace.ResourceId
                }
            }
        )
    }

    Write-DebugAzureCall -Cmdlet "New-AzResourceGroupDeployment" -Parameters @{
        ResourceGroupName = $ResourceGroupName
        Name = $deploymentName
        TemplateType = "SecurityInsights"
    } -Context "Deploy-Sentinel"

    $solution = New-AzResourceGroupDeployment `
        -ResourceGroupName $ResourceGroupName `
        -Name $deploymentName `
        -TemplateObject $template `
        -ErrorAction Stop

    Write-ToLog -Message "Microsoft Sentinel enabled: $lawName" -Level "SUCCESS"
    Write-DebugLog -Message "Sentinel deployment completed successfully" -Context "Deploy-Sentinel"
    Stop-DebugOperation -Operation "Deploy-Sentinel" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "Microsoft Sentinel deployed successfully"
        Data = @{
            Solution = $solution
            WorkspaceName = $lawName
        }
    }

} catch {
    Write-ToLog -Message "Microsoft Sentinel deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Deploy-Sentinel"
    Stop-DebugOperation -Operation "Deploy-Sentinel" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}

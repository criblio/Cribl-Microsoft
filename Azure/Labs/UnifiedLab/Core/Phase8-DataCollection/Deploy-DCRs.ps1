# Deploy-DCRs.ps1
# Phase 8, SubPhase 8.1: Deploy Data Collection Rules for Cribl Integration
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
    [string]$LabMode = "public"
)

# Early exit check - skip before any debug logging to reduce noise
if (-not $OperationParams.deployment.monitoring.deployDCRs) {
    return @{
        Status = "Skipped"
        Message = "DCR deployment disabled"
        Data = $null
    }
}

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    LabMode = $LabMode
    DeployDCRs = $OperationParams.deployment.monitoring.deployDCRs
    LogAnalyticsName = $ResourceNames.LogAnalytics
} -Context "Deploy-DCRs"

$mainSw = Start-DebugOperation -Operation "Deploy-DCRs"

try {
    Write-DebugLog -Message "Starting DCR deployment..." -Context "Deploy-DCRs"

    # Get Log Analytics Workspace
    $workspace = $null
    Write-DebugLog -Message "LogAnalytics resource name: $($ResourceNames.LogAnalytics)" -Context "Deploy-DCRs"

    if ($ResourceNames.LogAnalytics) {
        Write-DebugAzureCall -Cmdlet "Get-AzOperationalInsightsWorkspace" -Parameters @{
            ResourceGroupName = $ResourceGroupName
            Name = $ResourceNames.LogAnalytics
        } -Context "Deploy-DCRs"

        $workspace = Get-AzOperationalInsightsWorkspace `
            -ResourceGroupName $ResourceGroupName `
            -Name $ResourceNames.LogAnalytics `
            -ErrorAction SilentlyContinue
    }

    Write-DebugLog -Message "Workspace lookup result: $($null -ne $workspace)" -Context "Deploy-DCRs"

    if ($null -eq $workspace) {
        Write-DebugLog -Message "SKIP REASON: Log Analytics Workspace not available" -Context "Deploy-DCRs"
        Stop-DebugOperation -Operation "Deploy-DCRs" -Stopwatch $mainSw -Success $true
        return @{
            Status = "Skipped"
            Message = "Log Analytics Workspace not available"
            Data = $null
        }
    }

    Write-DebugResource -ResourceType "LogAnalyticsWorkspace" -ResourceName $workspace.Name -Properties @{
        Id = $workspace.ResourceId
        Location = $workspace.Location
        Sku = $workspace.Sku
    } -Context "Deploy-DCRs"

    # Wait for Sentinel native tables to be provisioned
    # When Sentinel is enabled on a workspace, Azure needs time to provision native tables
    # (CommonSecurityLog, SecurityEvent, WindowsEvent, Syslog, etc.)
    $sentinelWaitSeconds = 60
    Write-DebugLog -Message "Waiting $sentinelWaitSeconds seconds for Sentinel native tables to be provisioned..." -Context "Deploy-DCRs"
    Write-ToLog -Message "Waiting for Sentinel native tables to be provisioned ($sentinelWaitSeconds seconds)..." -Level "INFO"
    Start-Sleep -Seconds $sentinelWaitSeconds
    Write-DebugLog -Message "Wait complete, proceeding with DCR deployment" -Context "Deploy-DCRs"

    $isPrivateMode = ($LabMode -eq "private")
    $dcrMode = if ($isPrivateMode) { "DCENative" } else { "DirectNative" }

    Write-DebugLog -Message "LabMode: $LabMode, isPrivateMode: $isPrivateMode" -Context "Deploy-DCRs"
    Write-DebugLog -Message "DCR deployment mode: $dcrMode" -Context "Deploy-DCRs"

    # Find DCR-Automation by first locating UnifiedLab root (Run-AzureUnifiedLab.ps1)
    # Then search upward for the Azure directory and look for DCR-Automation within it
    $dcrAutomationRoot = $null
    $dcrAutomationScript = $null
    $unifiedLabRoot = $null
    $azureRoot = $null

    # Find UnifiedLab root by searching upward for Run-AzureUnifiedLab.ps1
    $searchPath = $PSScriptRoot
    $maxLevels = 5
    $level = 0
    while ($searchPath -and $level -lt $maxLevels) {
        if (Test-Path (Join-Path $searchPath "Run-AzureUnifiedLab.ps1")) {
            $unifiedLabRoot = $searchPath
            Write-DebugLog -Message "Found UnifiedLab root: $unifiedLabRoot" -Context "Deploy-DCRs"
            break
        }
        $searchPath = Split-Path $searchPath -Parent
        $level++
    }

    # From UnifiedLab root, search upward for the Azure directory (contains CustomDeploymentTemplates)
    if ($unifiedLabRoot) {
        $searchPath = $unifiedLabRoot
        $maxLevels = 5
        $level = 0
        while ($searchPath -and $level -lt $maxLevels) {
            $potentialDcrPath = Join-Path $searchPath "CustomDeploymentTemplates\DCR-Automation"
            if (Test-Path (Join-Path $potentialDcrPath "Run-DCRAutomation.ps1")) {
                $azureRoot = $searchPath
                $dcrAutomationRoot = (Resolve-Path $potentialDcrPath).Path
                Write-DebugLog -Message "Found Azure root: $azureRoot" -Context "Deploy-DCRs"
                Write-DebugLog -Message "Found DCR-Automation at: $dcrAutomationRoot" -Context "Deploy-DCRs"
                break
            }
            $searchPath = Split-Path $searchPath -Parent
            $level++
        }
    }

    if ($dcrAutomationRoot) {
        $dcrAutomationScript = Join-Path $dcrAutomationRoot "Run-DCRAutomation.ps1"
    }

    Write-DebugLog -Message "DCR-Automation root: $dcrAutomationRoot" -Context "Deploy-DCRs"
    Write-DebugLog -Message "DCR-Automation script: $dcrAutomationScript" -Context "Deploy-DCRs"

    if (-not $dcrAutomationScript -or -not (Test-Path $dcrAutomationScript)) {
        Write-DebugLog -Message "SKIP REASON: DCR-Automation script not found" -Context "Deploy-DCRs"
        Write-ToLog -Message "DCR-Automation script not found. UnifiedLab root: $unifiedLabRoot" -Level "ERROR"
        Stop-DebugOperation -Operation "Deploy-DCRs" -Stopwatch $mainSw -Success $false
        return @{
            Status = "Failed"
            Message = "DCR-Automation script not found"
            Data = $null
        }
    }

    # Find configuration directory
    $dcrCoreDir = Join-Path $dcrAutomationRoot "core"
    $dcrProdDir = Join-Path $dcrAutomationRoot "prod"

    Write-DebugLog -Message "Checking for config in core dir: $dcrCoreDir" -Context "Deploy-DCRs"
    Write-DebugLog -Message "Checking for config in prod dir: $dcrProdDir" -Context "Deploy-DCRs"

    $dcrConfigDir = if (Test-Path (Join-Path $dcrCoreDir "azure-parameters.json")) {
        Write-DebugLog -Message "Found azure-parameters.json in core directory" -Context "Deploy-DCRs"
        $dcrCoreDir
    } elseif (Test-Path (Join-Path $dcrProdDir "azure-parameters.json")) {
        Write-DebugLog -Message "Found azure-parameters.json in prod directory" -Context "Deploy-DCRs"
        $dcrProdDir
    } else {
        Write-DebugLog -Message "SKIP REASON: azure-parameters.json not found in core or prod directories" -Context "Deploy-DCRs"
        $null
    }

    if ($null -eq $dcrConfigDir) {
        Write-ToLog -Message "DCR-Automation configuration not found" -Level "ERROR"
        Stop-DebugOperation -Operation "Deploy-DCRs" -Stopwatch $mainSw -Success $false
        return @{
            Status = "Failed"
            Message = "DCR-Automation configuration not found"
            Data = $null
        }
    }

    Write-DebugLog -Message "Using DCR config directory: $dcrConfigDir" -Context "Deploy-DCRs"

    $dcrAzureParamsPath = Join-Path $dcrConfigDir "azure-parameters.json"
    $dcrOperationParamsPath = Join-Path $dcrConfigDir "operation-parameters.json"

    Write-DebugLog -Message "Loading DCR azure-parameters.json from: $dcrAzureParamsPath" -Context "Deploy-DCRs"
    Write-DebugLog -Message "Loading DCR operation-parameters.json from: $dcrOperationParamsPath" -Context "Deploy-DCRs"

    $dcrAzureParams = Get-Content $dcrAzureParamsPath | ConvertFrom-Json
    $dcrOperationParams = Get-Content $dcrOperationParamsPath | ConvertFrom-Json

    # Override with UnifiedLab deployment values
    Write-DebugLog -Message "Overriding DCR parameters with UnifiedLab values" -Context "Deploy-DCRs"
    Write-DebugLog -Message "  ResourceGroupName: $ResourceGroupName" -Context "Deploy-DCRs"
    Write-DebugLog -Message "  WorkspaceName: $($workspace.Name)" -Context "Deploy-DCRs"
    Write-DebugLog -Message "  Location: $Location" -Context "Deploy-DCRs"
    Write-DebugLog -Message "  SubscriptionId: $($AzureParams.subscriptionId)" -Context "Deploy-DCRs"

    $dcrAzureParams.resourceGroupName = $ResourceGroupName
    $dcrAzureParams.workspaceName = $workspace.Name
    $dcrAzureParams.location = $Location
    $dcrAzureParams.subscriptionId = $AzureParams.subscriptionId

    if ($AzureParams.tenantId) {
        Write-DebugLog -Message "  TenantId: $($AzureParams.tenantId)" -Context "Deploy-DCRs"
        $dcrAzureParams.tenantId = $AzureParams.tenantId
    }
    if ($AzureParams.clientId) {
        Write-DebugLog -Message "  ClientId: $($AzureParams.clientId)" -Context "Deploy-DCRs"
        $dcrAzureParams.clientId = $AzureParams.clientId
    }
    if ($AzureParams.ownerTag) {
        Write-DebugLog -Message "  OwnerTag: $($AzureParams.ownerTag)" -Context "Deploy-DCRs"
        $dcrAzureParams.ownerTag = $AzureParams.ownerTag
    }

    $dcrOperationParams.deployment.createDCE = $isPrivateMode
    Write-DebugLog -Message "  createDCE: $isPrivateMode" -Context "Deploy-DCRs"

    # Create backups
    $azureBackupPath = "$dcrAzureParamsPath.backup"
    $operationBackupPath = "$dcrOperationParamsPath.backup"

    Write-DebugLog -Message "Creating backup files" -Context "Deploy-DCRs"
    Copy-Item -Path $dcrAzureParamsPath -Destination $azureBackupPath -Force
    Copy-Item -Path $dcrOperationParamsPath -Destination $operationBackupPath -Force

    try {
        Write-DebugLog -Message "Writing modified parameters to config files" -Context "Deploy-DCRs"
        $dcrAzureParams | ConvertTo-Json -Depth 10 | Set-Content $dcrAzureParamsPath -Force
        $dcrOperationParams | ConvertTo-Json -Depth 10 | Set-Content $dcrOperationParamsPath -Force

        Write-DebugLog -Message "Executing DCR-Automation script" -Context "Deploy-DCRs"

        # Determine log path - if UnifiedLab log is available, use it; otherwise let DCR-Automation use its default
        $dcrLogPath = $null
        if ($global:LabLogFilePath) {
            $dcrLogPath = $global:LabLogFilePath
            Write-DebugLog -Message "  Using UnifiedLab log file for DCR-Automation: $dcrLogPath" -Context "Deploy-DCRs"
        }

        Write-DebugLog -Message "  Command: & $dcrAutomationScript -NonInteractive -Mode $dcrMode -ExportCriblConfig -Quiet -LogPath $dcrLogPath" -Context "Deploy-DCRs"

        # Run DCR-Automation in Quiet mode to suppress console output
        # When LogPath is provided, DCR-Automation logs are written to the UnifiedLab log file
        if ($dcrLogPath) {
            $dcrOutput = & $dcrAutomationScript `
                -NonInteractive `
                -Mode $dcrMode `
                -ExportCriblConfig `
                -Quiet `
                -LogPath $dcrLogPath 2>&1
        } else {
            $dcrOutput = & $dcrAutomationScript `
                -NonInteractive `
                -Mode $dcrMode `
                -ExportCriblConfig `
                -Quiet 2>&1
        }

        # Log summary instead of full output
        $dcrResult = $dcrOutput | Select-Object -Last 10
        Write-DebugLog -Message "DCR-Automation output summary (last 10 lines):" -Context "Deploy-DCRs"
        $dcrResult | ForEach-Object { Write-DebugLog -Message "  $_" -Context "Deploy-DCRs" }

        Write-DebugLog -Message "DCR-Automation LASTEXITCODE: $LASTEXITCODE" -Context "Deploy-DCRs"

        if ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE) {
            Write-ToLog -Message "DCR-Automation completed successfully" -Level "SUCCESS"
            Write-DebugLog -Message "DCR-Automation completed successfully" -Context "Deploy-DCRs"

            # Copy configurations to UnifiedLab output directory
            try {
                # Cribl-Configs is at UnifiedLab root level
                $criblConfigsRoot = Join-Path $unifiedLabRoot "Cribl-Configs"
                $sentinelDestDir = Join-Path $criblConfigsRoot "destinations\sentinel"
                $adxDestDir = Join-Path $criblConfigsRoot "destinations\adx"
                $sourcesDir = Join-Path $criblConfigsRoot "sources"

                Write-DebugLog -Message "Cribl configs root: $criblConfigsRoot" -Context "Deploy-DCRs"

                @($sentinelDestDir, $adxDestDir, $sourcesDir) | ForEach-Object {
                    if (-not (Test-Path $_)) {
                        Write-DebugLog -Message "Creating directory: $_" -Context "Deploy-DCRs"
                        New-Item -ItemType Directory -Path $_ -Force | Out-Null
                    }
                }

                $configDirLeaf = Split-Path -Leaf $dcrConfigDir
                $sourceConfigDir = Join-Path $dcrAutomationRoot "$configDirLeaf\cribl-dcr-configs\destinations"

                Write-DebugLog -Message "Source config directory: $sourceConfigDir" -Context "Deploy-DCRs"

                if (Test-Path $sourceConfigDir) {
                    Write-DebugLog -Message "Copying configurations from $sourceConfigDir to $sentinelDestDir" -Context "Deploy-DCRs"
                    Copy-Item -Path "$sourceConfigDir\*" -Destination $sentinelDestDir -Recurse -Force -ErrorAction Stop
                    $fileCount = (Get-ChildItem -Path $sentinelDestDir -Recurse -File).Count
                    Write-ToLog -Message "Sentinel configurations copied: $fileCount files" -Level "SUCCESS"
                }

                Stop-DebugOperation -Operation "Deploy-DCRs" -Stopwatch $mainSw -Success $true
                return @{
                    Status = "Success"
                    Message = "DCRs deployed successfully"
                    Data = @{
                        ConfigDirectory = $criblConfigsRoot
                        SentinelDestinations = $sentinelDestDir
                        ADXDestinations = $adxDestDir
                        Sources = $sourcesDir
                        Mode = $dcrMode
                        Result = $dcrResult
                    }
                }

            } catch {
                Write-DebugException -Exception $_.Exception -Context "Deploy-DCRs" -AdditionalInfo @{
                    Operation = "PostProcessing"
                }
                Stop-DebugOperation -Operation "Deploy-DCRs" -Stopwatch $mainSw -Success $true
                return @{
                    Status = "Success"
                    Message = "DCR-Automation succeeded but post-processing had errors"
                    Data = @{
                        Mode = $dcrMode
                    }
                }
            }

        } else {
            Write-DebugLog -Message "DCR-Automation encountered errors (LASTEXITCODE: $LASTEXITCODE)" -Context "Deploy-DCRs"
            Write-ToLog -Message "DCR-Automation encountered errors (LASTEXITCODE: $LASTEXITCODE)" -Level "WARNING"
            Stop-DebugOperation -Operation "Deploy-DCRs" -Stopwatch $mainSw -Success $false
            return @{
                Status = "Failed"
                Message = "DCR-Automation encountered errors"
                Data = @{
                    Mode = $dcrMode
                }
            }
        }

    } catch {
        Write-DebugException -Exception $_.Exception -Context "Deploy-DCRs"
        Write-ToLog -Message "Failed to execute DCR-Automation: $($_.Exception.Message)" -Level "ERROR"
        Stop-DebugOperation -Operation "Deploy-DCRs" -Stopwatch $mainSw -Success $false
        return @{
            Status = "Failed"
            Message = $_.Exception.Message
            Data = $null
        }
    } finally {
        Write-DebugLog -Message "Restoring original configuration files from backups" -Context "Deploy-DCRs"
        if (Test-Path $azureBackupPath) {
            Move-Item -Path $azureBackupPath -Destination $dcrAzureParamsPath -Force
        }
        if (Test-Path $operationBackupPath) {
            Move-Item -Path $operationBackupPath -Destination $dcrOperationParamsPath -Force
        }

        # Always cleanup DCR-Automation output directories (regardless of success/failure)
        if ($dcrAutomationRoot -and $dcrConfigDir) {
            $configDirLeaf = Split-Path -Leaf $dcrConfigDir
            $criblConfigsDir = Join-Path $dcrAutomationRoot "$configDirLeaf\cribl-dcr-configs"
            $generatedTemplatesDir = Join-Path $dcrAutomationRoot "$configDirLeaf\generated-templates"

            if (Test-Path $criblConfigsDir) {
                Write-DebugLog -Message "Cleaning up: $criblConfigsDir" -Context "Deploy-DCRs"
                Remove-Item -Path $criblConfigsDir -Recurse -Force -ErrorAction SilentlyContinue
            }

            if (Test-Path $generatedTemplatesDir) {
                Write-DebugLog -Message "Cleaning up: $generatedTemplatesDir" -Context "Deploy-DCRs"
                Remove-Item -Path $generatedTemplatesDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }

} catch {
    Write-DebugException -Exception $_.Exception -Context "Deploy-DCRs"
    Write-ToLog -Message "DCR deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Stop-DebugOperation -Operation "Deploy-DCRs" -Stopwatch $mainSw -Success $false
    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}

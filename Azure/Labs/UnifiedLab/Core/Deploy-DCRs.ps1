# Deploy Data Collection Rules for Cribl Integration
# This module integrates with the DCR-Automation toolkit

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

function Deploy-DataCollectionRules {
    param(
        [Parameter(Mandatory=$true)]
        [object]$Workspace
    )

    if ($null -eq $Workspace) {
        return $null
    }

    $isPrivateMode = ($LabMode -eq "private")
    $dcrMode = if ($isPrivateMode) { "DCENative" } else { "DirectNative" }

    $dcrAutomationRoot = Join-Path (Split-Path $PSScriptRoot -Parent) "..\\..\\..\\CustomDeploymentTemplates\\DCR-Automation"
    $dcrAutomationScript = Join-Path $dcrAutomationRoot "Run-DCRAutomation.ps1"

    if (-not (Test-Path $dcrAutomationScript)) {
        Write-ToLog -Message "DCR-Automation script not found at: $dcrAutomationScript" -Level "ERROR"
        return $null
    }

    $dcrCoreDir = Join-Path $dcrAutomationRoot "core"
    $dcrProdDir = Join-Path $dcrAutomationRoot "prod"

    $dcrConfigDir = if (Test-Path (Join-Path $dcrCoreDir "azure-parameters.json")) {
        $dcrCoreDir
    } elseif (Test-Path (Join-Path $dcrProdDir "azure-parameters.json")) {
        $dcrProdDir
    } else {
        $null
    }

    if ($null -eq $dcrConfigDir) {
        Write-ToLog -Message "DCR-Automation configuration not found" -Level "ERROR"
        return $null
    }

    $dcrAzureParamsPath = Join-Path $dcrConfigDir "azure-parameters.json"
    $dcrOperationParamsPath = Join-Path $dcrConfigDir "operation-parameters.json"

    $dcrAzureParams = Get-Content $dcrAzureParamsPath | ConvertFrom-Json
    $dcrOperationParams = Get-Content $dcrOperationParamsPath | ConvertFrom-Json

    # Override with UnifiedLab deployment values
    $dcrAzureParams.resourceGroupName = $ResourceGroupName
    $dcrAzureParams.workspaceName = $Workspace.Name
    $dcrAzureParams.location = $Location
    $dcrAzureParams.subscriptionId = $AzureParams.subscriptionId

    if ($AzureParams.tenantId) {
        $dcrAzureParams.tenantId = $AzureParams.tenantId
    }
    if ($AzureParams.clientId) {
        $dcrAzureParams.clientId = $AzureParams.clientId
    }
    if ($AzureParams.ownerTag) {
        $dcrAzureParams.ownerTag = $AzureParams.ownerTag
    }

    $dcrOperationParams.deployment.createDCE = $isPrivateMode

    # Create backups
    $azureBackupPath = "$dcrAzureParamsPath.backup"
    $operationBackupPath = "$dcrOperationParamsPath.backup"
    Copy-Item -Path $dcrAzureParamsPath -Destination $azureBackupPath -Force
    Copy-Item -Path $dcrOperationParamsPath -Destination $operationBackupPath -Force

    try {
        $dcrAzureParams | ConvertTo-Json -Depth 10 | Set-Content $dcrAzureParamsPath -Force
        $dcrOperationParams | ConvertTo-Json -Depth 10 | Set-Content $dcrOperationParamsPath -Force

        $dcrResult = & $dcrAutomationScript `
            -NonInteractive `
            -Mode $dcrMode `
            -ExportCriblConfig

        if ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE) {
            Write-ToLog -Message "DCR-Automation completed successfully" -Level "SUCCESS"

            try {
                $criblConfigsRoot = Join-Path (Split-Path $PSScriptRoot -Parent) "Cribl-Configs"
                $sentinelDestDir = Join-Path $criblConfigsRoot "destinations\sentinel"
                $adxDestDir = Join-Path $criblConfigsRoot "destinations\adx"
                $sourcesDir = Join-Path $criblConfigsRoot "sources"

                @($sentinelDestDir, $adxDestDir, $sourcesDir) | ForEach-Object {
                    if (-not (Test-Path $_)) {
                        New-Item -ItemType Directory -Path $_ -Force | Out-Null
                    }
                }

                $configDirLeaf = Split-Path -Leaf $dcrConfigDir
                $sourceConfigDir = Join-Path $dcrAutomationRoot "$configDirLeaf\cribl-dcr-configs\destinations"

                if (Test-Path $sourceConfigDir) {
                    try {
                        Copy-Item -Path "$sourceConfigDir\*" -Destination $sentinelDestDir -Recurse -Force -ErrorAction Stop
                        $fileCount = (Get-ChildItem -Path $sentinelDestDir -Recurse -File).Count
                        Write-ToLog -Message "Sentinel configurations copied: $fileCount files" -Level "SUCCESS"
                    } catch {
                        Write-ToLog -Message "Error copying configurations: $($_.Exception.Message)" -Level "WARNING"
                    }

                    # Clean up DCR-Automation output directory
                    try {
                        $criblConfigsDir = Join-Path $dcrAutomationRoot "$configDirLeaf\cribl-dcr-configs"
                        if (Test-Path $criblConfigsDir) {
                            Remove-Item -Path $criblConfigsDir -Recurse -Force -ErrorAction Stop
                        }

                        $generatedTemplatesDir = Join-Path $dcrAutomationRoot "$configDirLeaf\generated-templates"
                        if (Test-Path $generatedTemplatesDir) {
                            Remove-Item -Path $generatedTemplatesDir -Recurse -Force -ErrorAction SilentlyContinue
                        }
                    } catch {
                        Write-ToLog -Message "Failed to clean up DCR-Automation directory: $($_.Exception.Message)" -Level "WARNING"
                    }
                }

                return @{
                    Status = "Success"
                    ConfigDirectory = $criblConfigsRoot
                    SentinelDestinations = $sentinelDestDir
                    ADXDestinations = $adxDestDir
                    Sources = $sourcesDir
                    Mode = $dcrMode
                    Result = $dcrResult
                }

            } catch {
                return @{
                    Status = "PartialSuccess"
                    Message = "DCR-Automation succeeded but post-processing had errors"
                    Mode = $dcrMode
                }
            }

        } else {
            Write-ToLog -Message "DCR-Automation encountered errors (LASTEXITCODE: $LASTEXITCODE)" -Level "WARNING"
            return @{
                Status = "Failed"
                Mode = $dcrMode
            }
        }

    } catch {
        Write-ToLog -Message "Failed to execute DCR-Automation: $($_.Exception.Message)" -Level "ERROR"
        return $null
    } finally {
        if (Test-Path $azureBackupPath) {
            Move-Item -Path $azureBackupPath -Destination $dcrAzureParamsPath -Force
        }
        if (Test-Path $operationBackupPath) {
            Move-Item -Path $operationBackupPath -Destination $dcrOperationParamsPath -Force
        }
    }
}

# Main execution
try {
    if (-not $OperationParams.deployment.monitoring.deployDCRs) {
        return @{
            Status = "Skipped"
            Message = "DCR deployment disabled"
        }
    }

    $workspace = $null
    if ($ResourceNames.LogAnalytics) {
        $workspace = Get-AzOperationalInsightsWorkspace `
            -ResourceGroupName $ResourceGroupName `
            -Name $ResourceNames.LogAnalytics `
            -ErrorAction SilentlyContinue
    }

    if ($null -eq $workspace) {
        return @{
            Status = "Skipped"
            Message = "Log Analytics Workspace not available"
        }
    }

    $dcrResult = Deploy-DataCollectionRules -Workspace $workspace

    Write-ToLog -Message "DCR deployment completed" -Level "SUCCESS"

    return @{
        Status = "Success"
        Message = "DCRs deployed successfully"
        Data = $dcrResult
    }

} catch {
    Write-ToLog -Message "DCR deployment failed: $($_.Exception.Message)" -Level "ERROR"
    return @{
        Status = "Failed"
        Message = $_.Exception.Message
    }
}

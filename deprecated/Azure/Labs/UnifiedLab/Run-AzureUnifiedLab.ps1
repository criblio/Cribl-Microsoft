# Run-AzureUnifiedLab.ps1
# Main entry point for Unified Azure Lab deployment
# Combines interactive menu with phase-based deployment architecture

<#
.SYNOPSIS
    Unified Azure Lab deployment system for Cribl integration testing

.DESCRIPTION
    Deploy a comprehensive Azure lab environment with modular component selection:
    - Phase 1: Foundation (Resource Group, TTL)
    - Phase 2: Storage (Storage Account, Containers, Queues, EventGrid) - before Networking for Flow Logs dependency
    - Phase 3: Networking (VNet, NSGs)
    - Phase 4: Monitoring (Log Analytics, Sentinel, Private Link)
    - Phase 5: Analytics (Event Hub, ADX)
    - Phase 6: Network Monitoring (Flow Logs) - requires Storage and VNet
    - Phase 7: Compute (VMs)
    - Phase 8: Data Collection (DCRs)
    - Phase 9: Integration (Cribl Configs)
    - Phase 10: Gateway (VPN Gateway, VPN Connection)

    Supports multiple lab deployment options:
    - Complete Lab, Sentinel Lab, ADX Lab, Flow Log Lab, Event Hub Lab, etc.
    - Public or Private deployment modes

.PARAMETER Mode
    Deployment mode for non-interactive use:
    - Full: Deploy all enabled components
    - Infrastructure: VNet and networking only
    - Monitoring: Log Analytics and monitoring only
    - Analytics: Event Hub and ADX only
    - Storage: Storage Account and Event Grid only

.PARAMETER NonInteractive
    Run in non-interactive mode (no menus)

.PARAMETER EnableDebug
    Enable debug-level logging to log file

.PARAMETER Phase
    Run a specific phase only (1-10)

.EXAMPLE
    .\Run-AzureUnifiedLab.ps1
    # Interactive mode with menu

.EXAMPLE
    .\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Full
    # Deploy all enabled components without prompts

.EXAMPLE
    .\Run-AzureUnifiedLab.ps1 -NonInteractive -Phase 4
    # Run only Phase 4 (Monitoring)
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [ValidateSet("Full", "Infrastructure", "Monitoring", "Analytics", "Storage", "Custom", "Status", "Validate")]
    [string]$Mode = "",

    [Parameter(Mandatory=$false)]
    [switch]$NonInteractive,

    [Parameter(Mandatory=$false)]
    [switch]$EnableDebug,

    [Parameter(Mandatory=$false)]
    [ValidateRange(1,10)]
    [int]$Phase = 0
)

$ErrorActionPreference = "Stop"
$ScriptRoot = $PSScriptRoot
$CorePath = Join-Path $ScriptRoot "Core"

# Phase directories - logical execution order (Storage before Networking for Flow Logs dependency)
$FoundationPath = Join-Path $CorePath "Phase1-Foundation"
$StoragePath = Join-Path $CorePath "Phase3-Storage"
$NetworkingPath = Join-Path $CorePath "Phase2-Networking"
$MonitoringPath = Join-Path $CorePath "Phase4-Monitoring"
$AnalyticsPath = Join-Path $CorePath "Phase5-Analytics"
$NetworkMonitoringPath = Join-Path $CorePath "Phase6-NetworkMonitoring"
$ComputePath = Join-Path $CorePath "Phase7-Compute"
$DataCollectionPath = Join-Path $CorePath "Phase8-DataCollection"
$IntegrationPath = Join-Path $CorePath "Phase9-Integration"
$GatewayPath = Join-Path $CorePath "Phase10-Gateway"

# Import core modules
Write-Host "`nLoading core modules..." -ForegroundColor Cyan

try {
    . (Join-Path $CorePath "Output-Helper.ps1")
    . (Join-Path $CorePath "Validation-Module.ps1")
    . (Join-Path $CorePath "Naming-Engine.ps1")
    . (Join-Path $CorePath "Menu-Framework.ps1")

    # Initialize logging
    $timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
    $logFileName = "UnifiedLab_$timestamp.log"
    $logFilePath = Join-Path $PSScriptRoot "logs\$logFileName"
    $enableDebugLogging = $EnableDebug.IsPresent
    Initialize-LabLogging -LogPath $logFilePath -EnableDebug $enableDebugLogging

    Write-Host "  Core modules loaded" -ForegroundColor Green
    Write-Host "  Log file: $logFileName" -ForegroundColor Cyan
    if ($enableDebugLogging) {
        Write-Host "  Debug logging: ENABLED" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  Failed to load core modules: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Load configuration files
Write-Host "`nLoading configuration..." -ForegroundColor Cyan

$azureParamsPath = Join-Path $ScriptRoot "azure-parameters.json"
$operationParamsPath = Join-Path $ScriptRoot "operation-parameters.json"

if (-not (Test-Path $azureParamsPath) -or -not (Test-Path $operationParamsPath)) {
    Write-Host "  Configuration files not found" -ForegroundColor Red
    exit 1
}

try {
    $script:azureParams = Get-Content $azureParamsPath -Raw | ConvertFrom-Json
    $script:operationParams = Get-Content $operationParamsPath -Raw | ConvertFrom-Json

    # Load on-premises connection parameters if available
    $onPremParamsPath = Join-Path $ScriptRoot "onprem-connection-parameters.json"
    if (Test-Path $onPremParamsPath) {
        $onPremParams = Get-Content $onPremParamsPath -Raw | ConvertFrom-Json
        $script:azureParams.infrastructure | Add-Member -NotePropertyName "onPremises" -NotePropertyValue @{
            enabled = $true
            localNetworkGateway = @{
                name = $onPremParams.localNetworkGateway.name
                gatewayIpAddress = $onPremParams.localNetworkGateway.gatewayIpAddress
                addressPrefixes = $onPremParams.localNetworkGateway.addressSpace
            }
            vpnConnection = @{
                name = $onPremParams.vpnConnection.name
                connectionType = $onPremParams.vpnConnection.connectionType
                sharedKey = $onPremParams.vpnConnection.sharedKey
                enableBgp = $onPremParams.vpnConnection.enableBgp
                usePolicyBasedTrafficSelectors = $onPremParams.vpnConnection.usePolicyBasedTrafficSelectors
                ipsecPolicies = $onPremParams.vpnConnection.ipsecPolicies
            }
        } -Force
        Write-Host "  On-premises connection parameters loaded" -ForegroundColor Green
    } else {
        $script:azureParams.infrastructure | Add-Member -NotePropertyName "onPremises" -NotePropertyValue @{
            enabled = $false
        } -Force
    }

    # Update naming suffixes
    $script:azureParams = Update-NamingSuffixes -AzureParams $script:azureParams

    Write-Host "  Configuration loaded" -ForegroundColor Green
} catch {
    Write-Host "  Failed to load configuration: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Generate resource names
$script:resourceNames = Get-AllResourceNames -AzureParams $script:azureParams

# Extract common parameters
$script:resourceGroupNamePrefix = $script:azureParams.resourceGroupNamePrefix
$script:location = $script:azureParams.location
# Resource group name is built dynamically per lab type: prefix + "-" + suffix
# Default to prefix only until a lab type is selected
$script:resourceGroupName = $script:resourceGroupNamePrefix

# Helper function to build resource group name from prefix and lab config suffix
function Get-ResourceGroupName {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Prefix,

        [Parameter(Mandatory=$false)]
        [string]$Suffix
    )

    if ([string]::IsNullOrWhiteSpace($Suffix)) {
        return $Prefix
    }
    return "$Prefix-$Suffix"
}

# Azure authentication check
function Test-AzureAuthentication {
    Write-Host "`nChecking Azure authentication..." -ForegroundColor Cyan
    try {
        $context = Get-AzContext -ErrorAction Stop
        if ($null -eq $context) {
            Write-Host "  Not authenticated to Azure. Run: Connect-AzAccount" -ForegroundColor Red
            return $false
        }
        Write-Host "  Authenticated as: $($context.Account.Id)" -ForegroundColor Green

        if ($context.Subscription.Id -ne $script:azureParams.subscriptionId) {
            Write-Host "  Switching to configured subscription..." -ForegroundColor Yellow
            Set-AzContext -SubscriptionId $script:azureParams.subscriptionId -ErrorAction Stop | Out-Null
        }
        return $true
    } catch {
        Write-Host "  Azure authentication check failed: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

# Phase execution function
function Invoke-PhaseScript {
    param(
        [string]$ScriptPath,
        [string]$PhaseName,
        [string]$DisplayName,
        [hashtable]$AdditionalParams = @{}
    )

    $scriptFileName = Split-Path $ScriptPath -Leaf
    $scriptStartTime = Get-Date

    if (-not (Test-Path $ScriptPath)) {
        Write-ToLog -Message "[$PhaseName] Script not found: $scriptFileName" -Level "ERROR"
        Write-DebugLog -Message "Script not found: $ScriptPath" -Context $PhaseName
        return @{ Status = "Failed"; Message = "Script not found: $scriptFileName"; Data = $null }
    }

    # Log script initiation
    Write-ToLog -Message "[$PhaseName] STARTED: $scriptFileName" -Level "INFO"
    Write-DebugLog -Message "Executing script: $scriptFileName" -Context $PhaseName
    Write-DebugLog -Message "Full path: $ScriptPath" -Context $PhaseName

    $params = @{
        AzureParams = $script:azureParams
        OperationParams = $script:operationParams
        ResourceGroupName = $script:resourceGroupName
        Location = $script:location
        ResourceNames = $script:resourceNames
    }

    # Merge additional parameters
    foreach ($key in $AdditionalParams.Keys) {
        $params[$key] = $AdditionalParams[$key]
    }

    try {
        $result = & $ScriptPath @params
        $scriptDuration = (Get-Date) - $scriptStartTime
        $durationStr = "{0:N2}s" -f $scriptDuration.TotalSeconds

        # Log script completion with status
        if ($result.Status -eq "Success") {
            Write-ToLog -Message "[$PhaseName] COMPLETED: $scriptFileName - Status: SUCCESS ($durationStr)" -Level "SUCCESS"
        } elseif ($result.Status -eq "Skipped") {
            Write-ToLog -Message "[$PhaseName] COMPLETED: $scriptFileName - Status: SKIPPED - $($result.Message) ($durationStr)" -Level "INFO"
        } else {
            Write-ToLog -Message "[$PhaseName] COMPLETED: $scriptFileName - Status: FAILED - $($result.Message) ($durationStr)" -Level "ERROR"
        }

        return $result
    } catch {
        $scriptDuration = (Get-Date) - $scriptStartTime
        $durationStr = "{0:N2}s" -f $scriptDuration.TotalSeconds
        $errorMessage = $_.Exception.Message

        Write-ToLog -Message "[$PhaseName] FAILED: $scriptFileName - Error: $errorMessage ($durationStr)" -Level "ERROR"
        Write-DebugException -Exception $_.Exception -Context $PhaseName
        return @{ Status = "Failed"; Message = $errorMessage; Data = $null }
    }
}

# Apply lab configuration to operation parameters
function Set-LabConfiguration {
    param(
        [hashtable]$LabConfig,
        [string]$LabMode
    )

    # Create a deep copy of operationParams to avoid modifying the original
    $operationParamsOverride = $script:operationParams | ConvertTo-Json -Depth 10 | ConvertFrom-Json

    # Override Infrastructure settings
    if ($LabConfig.Infrastructure) {
        if ($null -ne $LabConfig.Infrastructure.DeployVNet) {
            $operationParamsOverride.deployment.infrastructure.deployVNet = $LabConfig.Infrastructure.DeployVNet
            $operationParamsOverride.deployment.infrastructure.deploySubnets = $LabConfig.Infrastructure.DeployVNet
        }
        if ($null -ne $LabConfig.Infrastructure.DeployNSGs) {
            $operationParamsOverride.deployment.infrastructure.deployNSGs = $LabConfig.Infrastructure.DeployNSGs
        }
        if ($null -ne $LabConfig.Infrastructure.DeployVPN) {
            $operationParamsOverride.deployment.infrastructure.deployVPNGateway = $LabConfig.Infrastructure.DeployVPN
        }
    }

    # Override Monitoring settings
    if ($LabConfig.Monitoring) {
        if ($null -ne $LabConfig.Monitoring.DeployLogAnalytics) {
            $operationParamsOverride.deployment.monitoring.deployLogAnalytics = $LabConfig.Monitoring.DeployLogAnalytics
        }
        if ($null -ne $LabConfig.Monitoring.DeploySentinel) {
            $operationParamsOverride.deployment.monitoring.deploySentinel = $LabConfig.Monitoring.DeploySentinel
        }
        if ($null -ne $LabConfig.Monitoring.DeployFlowLogs) {
            $operationParamsOverride.deployment.monitoring.deployFlowLogs = $LabConfig.Monitoring.DeployFlowLogs
        }
        if ($null -ne $LabConfig.Monitoring.DeployPrivateLink) {
            $operationParamsOverride.deployment.monitoring.deployPrivateLink = $LabConfig.Monitoring.DeployPrivateLink
        }
    }

    # Override Analytics settings
    if ($LabConfig.Analytics) {
        if ($null -ne $LabConfig.Analytics.DeployEventHub) {
            $operationParamsOverride.deployment.analytics.deployEventHub = $LabConfig.Analytics.DeployEventHub
        }
        if ($null -ne $LabConfig.Analytics.DeployADX) {
            $operationParamsOverride.deployment.analytics.deployADX = $LabConfig.Analytics.DeployADX
        }
    }

    # Override Storage settings
    if ($LabConfig.Storage) {
        $storageValue = if ($null -ne $LabConfig.Storage.Deploy) { $LabConfig.Storage.Deploy } else { $LabConfig.Storage.DeployStorage }
        if ($null -ne $storageValue) {
            $operationParamsOverride.deployment.storage.deployStorageAccount = $storageValue
        }
        if ($null -ne $LabConfig.Storage.DeployContainers) {
            $operationParamsOverride.deployment.storage.deployContainers = $LabConfig.Storage.DeployContainers
        }
        if ($null -ne $LabConfig.Storage.DeployQueues) {
            $operationParamsOverride.deployment.storage.deployQueues = $LabConfig.Storage.DeployQueues
        }
        if ($null -ne $LabConfig.Storage.DeployEventGrid) {
            $operationParamsOverride.deployment.storage.deployEventGrid = $LabConfig.Storage.DeployEventGrid
        }
    }

    # Override VirtualMachines settings
    # Explicitly set deployVMs based on lab config - if not specified, default to false
    if ($LabConfig.VirtualMachines -and $null -ne $LabConfig.VirtualMachines.DeployVMs) {
        $operationParamsOverride.deployment.virtualMachines.deployVMs = $LabConfig.VirtualMachines.DeployVMs
    } else {
        # Lab config doesn't specify VMs, explicitly disable
        $operationParamsOverride.deployment.virtualMachines.deployVMs = $false
    }

    return $operationParamsOverride
}

# Helper function to prompt for VM password if VMs will be deployed
function Get-VMPasswordIfNeeded {
    param(
        [hashtable]$LabConfig
    )

    # Check if VMs will be deployed based on lab config
    $deployVMs = $false
    if ($null -ne $LabConfig -and $null -ne $LabConfig.VirtualMachines) {
        $deployVMs = $LabConfig.VirtualMachines.DeployVMs -eq $true
    }

    if (-not $deployVMs) {
        return $null
    }

    # Check if password authentication is configured
    if ($script:azureParams.virtualMachines.enabled -and $script:azureParams.virtualMachines.configuration.authenticationType -eq "password") {
        Write-Host ""
        Write-Host "   VM Password Required" -ForegroundColor Yellow
        Write-Host "   VMs will be deployed as part of this lab." -ForegroundColor Gray
        $vmPassword = Read-Host "   Enter Password for VMs" -AsSecureString
        return $vmPassword
    }

    return $null
}

# Helper function to determine if a phase should be invoked based on lab config
function Test-PhaseRequired {
    param(
        [int]$Phase,
        [hashtable]$LabConfig,
        [int]$SpecificPhase
    )

    # If a specific phase is requested, only run that phase
    if ($SpecificPhase -gt 0) {
        return ($Phase -eq $SpecificPhase)
    }

    # If no lab config provided, run all phases (non-interactive mode fallback)
    if ($null -eq $LabConfig) {
        return $true
    }

    # Phase 1 (Foundation) is always required
    if ($Phase -eq 1) {
        return $true
    }

    # Determine phase requirements based on lab config
    # Note: Execution order is Phase 2=Storage, Phase 3=Networking for Flow Logs dependency
    switch ($Phase) {
        2 { # Storage (executes second, before Networking)
            return ($LabConfig.Storage -and $LabConfig.Storage.Deploy)
        }
        3 { # Networking - VNet and NSGs (executes third, after Storage)
            return ($LabConfig.Infrastructure -and $LabConfig.Infrastructure.DeployVNet)
        }
        4 { # Monitoring - Log Analytics, Sentinel, Private Link
            return ($LabConfig.Monitoring -and ($LabConfig.Monitoring.DeployLogAnalytics -or $LabConfig.Monitoring.DeploySentinel -or $LabConfig.Monitoring.DeployPrivateLink))
        }
        5 { # Analytics - Event Hub, ADX
            return ($LabConfig.Analytics -and ($LabConfig.Analytics.DeployEventHub -or $LabConfig.Analytics.DeployADX))
        }
        6 { # Network Monitoring - Flow Logs
            return ($LabConfig.Monitoring -and $LabConfig.Monitoring.DeployFlowLogs)
        }
        7 { # Compute - VMs
            return ($LabConfig.VirtualMachines -and $LabConfig.VirtualMachines.DeployVMs)
        }
        8 { # Data Collection - DCRs
            return ($LabConfig.Monitoring -and $LabConfig.Monitoring.DeployDCRs)
        }
        9 { # Integration - Cribl Configs (run if any resource deployment occurred)
            $hasResources = ($LabConfig.Storage -and $LabConfig.Storage.Deploy) -or
                           ($LabConfig.Monitoring -and ($LabConfig.Monitoring.DeployLogAnalytics -or $LabConfig.Monitoring.DeploySentinel)) -or
                           ($LabConfig.Analytics -and ($LabConfig.Analytics.DeployEventHub -or $LabConfig.Analytics.DeployADX))
            return $hasResources
        }
        10 { # Gateway - VPN
            return ($LabConfig.Infrastructure -and $LabConfig.Infrastructure.DeployVPN)
        }
        default {
            return $true
        }
    }
}

# Main deployment function
function Start-PhaseDeployment {
    param(
        [hashtable]$LabConfig = $null,
        [string]$LabMode = "public",
        [int]$SpecificPhase = 0,
        [SecureString]$VMPassword = $null
    )

    $startTime = Get-Date
    $results = @{}

    # Apply lab configuration if provided
    if ($null -ne $LabConfig) {
        $script:operationParams = Set-LabConfiguration -LabConfig $LabConfig -LabMode $LabMode

        # Build lab-type-specific resource group name from prefix + suffix
        if ($LabConfig.ResourceGroupSuffix) {
            $script:resourceGroupName = Get-ResourceGroupName -Prefix $script:resourceGroupNamePrefix -Suffix $LabConfig.ResourceGroupSuffix
        }
    }

    # Store VM password for Phase 7
    $script:vmPasswordForDeployment = $VMPassword

    Write-Host "`n$('='*70)" -ForegroundColor Cyan
    Write-Host "UNIFIED LAB PHASE DEPLOYMENT" -ForegroundColor White
    Write-Host "$('='*70)" -ForegroundColor Cyan
    Write-Host "Resource Group: $script:resourceGroupName" -ForegroundColor Gray
    Write-Host "Location: $script:location" -ForegroundColor Gray
    Write-Host "Lab Mode: $LabMode" -ForegroundColor $(if ($LabMode -eq "private") { "Magenta" } else { "Green" })
    Write-Host ""

    Write-ToLog -Message "Phase deployment started" -Level "INFO"
    Write-ToLog -Message "Resource Group: $script:resourceGroupName" -Level "INFO"
    Write-ToLog -Message "Location: $script:location" -Level "INFO"
    Write-ToLog -Message "Lab Mode: $LabMode" -Level "INFO"

    # ============================================================================
    # PHASE 1: Foundation (Always required)
    # ============================================================================
    if (Test-PhaseRequired -Phase 1 -LabConfig $LabConfig -SpecificPhase $SpecificPhase) {
        Write-Host "PHASE 1: Foundation" -ForegroundColor Yellow
        Write-Host "  1.1 Resource Group (Deploy-ResourceGroup.ps1)..." -NoNewline
        $results["ResourceGroup"] = Invoke-PhaseScript -ScriptPath (Join-Path $FoundationPath "Deploy-ResourceGroup.ps1") -PhaseName "Phase1.1"
        Write-Host $(if ($results["ResourceGroup"].Status -eq "Success") { " [OK]" } elseif ($results["ResourceGroup"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["ResourceGroup"].Status -eq "Success") { "Green" } elseif ($results["ResourceGroup"].Status -eq "Skipped") { "DarkGray" } else { "Red" })

        Write-Host "  1.2 TTL Cleanup (Deploy-TTL.ps1)..." -NoNewline
        $results["TTL"] = Invoke-PhaseScript -ScriptPath (Join-Path $FoundationPath "Deploy-TTL.ps1") -PhaseName "Phase1.2"
        Write-Host $(if ($results["TTL"].Status -eq "Success") { " [OK]" } elseif ($results["TTL"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["TTL"].Status -eq "Success") { "Green" } elseif ($results["TTL"].Status -eq "Skipped") { "DarkGray" } else { "Red" })
    }

    # Abort if Resource Group failed
    if ($results["ResourceGroup"] -and $results["ResourceGroup"].Status -eq "Failed") {
        Write-Host "`nDeployment aborted: Resource Group creation failed" -ForegroundColor Red
        return $results
    }

    # ============================================================================
    # PHASE 2: Storage (deployed before Networking - required for Flow Logs)
    # ============================================================================
    if (Test-PhaseRequired -Phase 2 -LabConfig $LabConfig -SpecificPhase $SpecificPhase) {
        Write-Host "`nPHASE 2: Storage" -ForegroundColor Yellow
        Write-Host "  2.1 Storage Account (Deploy-StorageAccount.ps1)..." -NoNewline
        $results["StorageAccount"] = Invoke-PhaseScript -ScriptPath (Join-Path $StoragePath "Deploy-StorageAccount.ps1") -PhaseName "Phase2.1"
        Write-Host $(if ($results["StorageAccount"].Status -eq "Success") { " [OK]" } elseif ($results["StorageAccount"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["StorageAccount"].Status -eq "Success") { "Green" } elseif ($results["StorageAccount"].Status -eq "Skipped") { "DarkGray" } else { "Red" })

        Write-Host "  2.2 Blob Containers (Deploy-BlobContainers.ps1)..." -NoNewline
        $results["BlobContainers"] = Invoke-PhaseScript -ScriptPath (Join-Path $StoragePath "Deploy-BlobContainers.ps1") -PhaseName "Phase2.2" -AdditionalParams @{ StorageAccount = $results["StorageAccount"].Data.StorageAccount }
        Write-Host $(if ($results["BlobContainers"].Status -eq "Success") { " [OK]" } elseif ($results["BlobContainers"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["BlobContainers"].Status -eq "Success") { "Green" } elseif ($results["BlobContainers"].Status -eq "Skipped") { "DarkGray" } else { "Red" })

        Write-Host "  2.3 Storage Queues (Deploy-StorageQueues.ps1)..." -NoNewline
        $results["StorageQueues"] = Invoke-PhaseScript -ScriptPath (Join-Path $StoragePath "Deploy-StorageQueues.ps1") -PhaseName "Phase2.3" -AdditionalParams @{ StorageAccount = $results["StorageAccount"].Data.StorageAccount }
        Write-Host $(if ($results["StorageQueues"].Status -eq "Success") { " [OK]" } elseif ($results["StorageQueues"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["StorageQueues"].Status -eq "Success") { "Green" } elseif ($results["StorageQueues"].Status -eq "Skipped") { "DarkGray" } else { "Red" })

        Write-Host "  2.4 Event Grid (Deploy-EventGrid.ps1)..." -NoNewline
        $results["EventGrid"] = Invoke-PhaseScript -ScriptPath (Join-Path $StoragePath "Deploy-EventGrid.ps1") -PhaseName "Phase2.4" -AdditionalParams @{ StorageAccount = $results["StorageAccount"].Data.StorageAccount }
        Write-Host $(if ($results["EventGrid"].Status -eq "Success") { " [OK]" } elseif ($results["EventGrid"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["EventGrid"].Status -eq "Success") { "Green" } elseif ($results["EventGrid"].Status -eq "Skipped") { "DarkGray" } else { "Red" })
    }

    # ============================================================================
    # PHASE 3: Networking
    # ============================================================================
    if (Test-PhaseRequired -Phase 3 -LabConfig $LabConfig -SpecificPhase $SpecificPhase) {
        Write-Host "`nPHASE 3: Networking" -ForegroundColor Yellow
        Write-Host "  3.1 Virtual Network (Deploy-VNet.ps1)..." -NoNewline
        $results["VNet"] = Invoke-PhaseScript -ScriptPath (Join-Path $NetworkingPath "Deploy-VNet.ps1") -PhaseName "Phase3.1"
        Write-Host $(if ($results["VNet"].Status -eq "Success") { " [OK]" } elseif ($results["VNet"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["VNet"].Status -eq "Success") { "Green" } elseif ($results["VNet"].Status -eq "Skipped") { "DarkGray" } else { "Red" })

        Write-Host "  3.2 Network Security Groups (Deploy-NSGs.ps1)..." -NoNewline
        $results["NSGs"] = Invoke-PhaseScript -ScriptPath (Join-Path $NetworkingPath "Deploy-NSGs.ps1") -PhaseName "Phase3.2" -AdditionalParams @{ VNet = $results["VNet"].Data.VNet }
        Write-Host $(if ($results["NSGs"].Status -eq "Success") { " [OK]" } elseif ($results["NSGs"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["NSGs"].Status -eq "Success") { "Green" } elseif ($results["NSGs"].Status -eq "Skipped") { "DarkGray" } else { "Red" })

    }

    # ============================================================================
    # PHASE 4: Monitoring
    # ============================================================================
    if (Test-PhaseRequired -Phase 4 -LabConfig $LabConfig -SpecificPhase $SpecificPhase) {
        Write-Host "`nPHASE 4: Monitoring" -ForegroundColor Yellow
        Write-Host "  4.1 Log Analytics (Deploy-LogAnalytics.ps1)..." -NoNewline
        $results["LogAnalytics"] = Invoke-PhaseScript -ScriptPath (Join-Path $MonitoringPath "Deploy-LogAnalytics.ps1") -PhaseName "Phase4.1"
        Write-Host $(if ($results["LogAnalytics"].Status -eq "Success") { " [OK]" } elseif ($results["LogAnalytics"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["LogAnalytics"].Status -eq "Success") { "Green" } elseif ($results["LogAnalytics"].Status -eq "Skipped") { "DarkGray" } else { "Red" })

        Write-Host "  4.2 Microsoft Sentinel (Deploy-Sentinel.ps1)..." -NoNewline
        $results["Sentinel"] = Invoke-PhaseScript -ScriptPath (Join-Path $MonitoringPath "Deploy-Sentinel.ps1") -PhaseName "Phase4.2" -AdditionalParams @{ Workspace = $results["LogAnalytics"].Data.Workspace }
        Write-Host $(if ($results["Sentinel"].Status -eq "Success") { " [OK]" } elseif ($results["Sentinel"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["Sentinel"].Status -eq "Success") { "Green" } elseif ($results["Sentinel"].Status -eq "Skipped") { "DarkGray" } else { "Red" })

        Write-Host "  4.3 Private Link (Deploy-PrivateLink.ps1)..." -NoNewline
        $vnet = if ($results["VNet"]) { $results["VNet"].Data.VNet } else { $null }
        $results["PrivateLink"] = Invoke-PhaseScript -ScriptPath (Join-Path $MonitoringPath "Deploy-PrivateLink.ps1") -PhaseName "Phase4.3" -AdditionalParams @{ Workspace = $results["LogAnalytics"].Data.Workspace; VNet = $vnet }
        Write-Host $(if ($results["PrivateLink"].Status -eq "Success") { " [OK]" } elseif ($results["PrivateLink"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["PrivateLink"].Status -eq "Success") { "Green" } elseif ($results["PrivateLink"].Status -eq "Skipped") { "DarkGray" } else { "Red" })
    }

    # ============================================================================
    # PHASE 5: Analytics
    # ============================================================================
    if (Test-PhaseRequired -Phase 5 -LabConfig $LabConfig -SpecificPhase $SpecificPhase) {
        Write-Host "`nPHASE 5: Analytics" -ForegroundColor Yellow
        Write-Host "  5.1 Event Hub (Deploy-EventHub.ps1)..." -NoNewline
        $results["EventHub"] = Invoke-PhaseScript -ScriptPath (Join-Path $AnalyticsPath "Deploy-EventHub.ps1") -PhaseName "Phase5.1"
        Write-Host $(if ($results["EventHub"].Status -eq "Success") { " [OK]" } elseif ($results["EventHub"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["EventHub"].Status -eq "Success") { "Green" } elseif ($results["EventHub"].Status -eq "Skipped") { "DarkGray" } else { "Red" })

        Write-Host "  5.2 Azure Data Explorer (Deploy-ADX.ps1)..." -NoNewline
        $results["ADX"] = Invoke-PhaseScript -ScriptPath (Join-Path $AnalyticsPath "Deploy-ADX.ps1") -PhaseName "Phase5.2"
        Write-Host $(if ($results["ADX"].Status -eq "Success") { " [OK]" } elseif ($results["ADX"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["ADX"].Status -eq "Success") { "Green" } elseif ($results["ADX"].Status -eq "Skipped") { "DarkGray" } else { "Red" })
    }

    # ============================================================================
    # PHASE 6: Network Monitoring (requires Storage from Phase 2 and VNet from Phase 3)
    # ============================================================================
    if (Test-PhaseRequired -Phase 6 -LabConfig $LabConfig -SpecificPhase $SpecificPhase) {
        Write-Host "`nPHASE 6: Network Monitoring" -ForegroundColor Yellow
        Write-Host "  6.1 Flow Logs (Deploy-FlowLogs.ps1)..." -NoNewline
        $vnet = if ($results["VNet"]) { $results["VNet"].Data.VNet } else { $null }
        $storageAccount = if ($results["StorageAccount"]) { $results["StorageAccount"].Data.StorageAccount } else { $null }
        $results["FlowLogs"] = Invoke-PhaseScript -ScriptPath (Join-Path $NetworkMonitoringPath "Deploy-FlowLogs.ps1") -PhaseName "Phase6.1" -AdditionalParams @{ VNet = $vnet; StorageAccount = $storageAccount }
        Write-Host $(if ($results["FlowLogs"].Status -eq "Success") { " [OK]" } elseif ($results["FlowLogs"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["FlowLogs"].Status -eq "Success") { "Green" } elseif ($results["FlowLogs"].Status -eq "Skipped") { "DarkGray" } else { "Red" })
    }

    # ============================================================================
    # PHASE 7: Compute
    # ============================================================================
    if (Test-PhaseRequired -Phase 7 -LabConfig $LabConfig -SpecificPhase $SpecificPhase) {
        Write-Host "`nPHASE 7: Compute" -ForegroundColor Yellow
        Write-Host "  7.1 Virtual Machines (Deploy-VMs.ps1)..." -NoNewline

        # Use pre-captured VM password from deployment start
        $results["VMs"] = Invoke-PhaseScript -ScriptPath (Join-Path $ComputePath "Deploy-VMs.ps1") -PhaseName "Phase7.1" -AdditionalParams @{ VMPassword = $script:vmPasswordForDeployment }
        Write-Host $(if ($results["VMs"].Status -eq "Success") { " [OK]" } elseif ($results["VMs"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["VMs"].Status -eq "Success") { "Green" } elseif ($results["VMs"].Status -eq "Skipped") { "DarkGray" } else { "Red" })
    }

    # ============================================================================
    # PHASE 8: Data Collection
    # ============================================================================
    if (Test-PhaseRequired -Phase 8 -LabConfig $LabConfig -SpecificPhase $SpecificPhase) {
        Write-Host "`nPHASE 8: Data Collection" -ForegroundColor Yellow
        Write-Host "  8.1 Data Collection Rules (Deploy-DCRs.ps1)..." -NoNewline
        $results["DCRs"] = Invoke-PhaseScript -ScriptPath (Join-Path $DataCollectionPath "Deploy-DCRs.ps1") -PhaseName "Phase8.1" -AdditionalParams @{ LabMode = $LabMode }
        Write-Host $(if ($results["DCRs"].Status -eq "Success") { " [OK]" } elseif ($results["DCRs"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["DCRs"].Status -eq "Success") { "Green" } elseif ($results["DCRs"].Status -eq "Skipped") { "DarkGray" } else { "Red" })
    }

    # ============================================================================
    # PHASE 9: Integration
    # ============================================================================
    if (Test-PhaseRequired -Phase 9 -LabConfig $LabConfig -SpecificPhase $SpecificPhase) {
        Write-Host "`nPHASE 9: Integration" -ForegroundColor Yellow
        Write-Host "  9.1 Cribl Configurations (Generate-CriblConfigs.ps1)..." -NoNewline
        $outputDir = Join-Path $ScriptRoot "Cribl-Configs"
        $results["CriblConfigs"] = Invoke-PhaseScript -ScriptPath (Join-Path $IntegrationPath "Generate-CriblConfigs.ps1") -PhaseName "Phase9.1" -AdditionalParams @{ OutputDirectory = $outputDir }
        Write-Host $(if ($results["CriblConfigs"].Status -eq "Success") { " [OK]" } elseif ($results["CriblConfigs"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["CriblConfigs"].Status -eq "Success") { "Green" } elseif ($results["CriblConfigs"].Status -eq "Skipped") { "DarkGray" } else { "Red" })
    }

    # ============================================================================
    # PHASE 10: Gateway
    # ============================================================================
    if (Test-PhaseRequired -Phase 10 -LabConfig $LabConfig -SpecificPhase $SpecificPhase) {
        Write-Host "`nPHASE 10: Gateway" -ForegroundColor Yellow
        Write-Host "  10.1 VPN Gateway (Deploy-VPNGateway.ps1) (~30-45 min)..." -NoNewline
        $vnet = if ($results["VNet"]) { $results["VNet"].Data.VNet } else { $null }
        $results["VPNGateway"] = Invoke-PhaseScript -ScriptPath (Join-Path $GatewayPath "Deploy-VPNGateway.ps1") -PhaseName "Phase10.1" -AdditionalParams @{ VNet = $vnet }
        Write-Host $(if ($results["VPNGateway"].Status -eq "Success") { " [OK]" } elseif ($results["VPNGateway"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["VPNGateway"].Status -eq "Success") { "Green" } elseif ($results["VPNGateway"].Status -eq "Skipped") { "DarkGray" } else { "Red" })

        Write-Host "  10.2 VPN Connection (Deploy-VPNConnection.ps1)..." -NoNewline
        $vpnGw = if ($results["VPNGateway"]) { $results["VPNGateway"].Data.VPNGateway } else { $null }
        $results["VPNConnection"] = Invoke-PhaseScript -ScriptPath (Join-Path $GatewayPath "Deploy-VPNConnection.ps1") -PhaseName "Phase10.2" -AdditionalParams @{ VPNGateway = $vpnGw }
        Write-Host $(if ($results["VPNConnection"].Status -eq "Success") { " [OK]" } elseif ($results["VPNConnection"].Status -eq "Skipped") { " [SKIP]" } else { " [FAIL]" }) -ForegroundColor $(if ($results["VPNConnection"].Status -eq "Success") { "Green" } elseif ($results["VPNConnection"].Status -eq "Skipped") { "DarkGray" } else { "Red" })
    }

    # ============================================================================
    # Summary
    # ============================================================================
    $endTime = Get-Date
    $duration = $endTime - $startTime

    Write-Host "`n$('='*70)" -ForegroundColor Green
    Write-Host "DEPLOYMENT COMPLETE" -ForegroundColor White
    Write-Host "$('='*70)" -ForegroundColor Green

    Write-Host "`nDuration: $([math]::Round($duration.TotalMinutes, 2)) minutes" -ForegroundColor Cyan
    Write-Host "Log file: $logFilePath" -ForegroundColor Gray

    # Count results
    $successCount = ($results.Values | Where-Object { $_.Status -eq "Success" }).Count
    $failedCount = ($results.Values | Where-Object { $_.Status -eq "Failed" }).Count
    $skippedCount = ($results.Values | Where-Object { $_.Status -eq "Skipped" }).Count

    Write-Host "`nResults: $successCount succeeded, $failedCount failed, $skippedCount skipped" -ForegroundColor $(if ($failedCount -eq 0) { "Green" } else { "Yellow" })

    Write-ToLog -Message "Deployment completed in $([math]::Round($duration.TotalMinutes, 2)) minutes" -Level "INFO"
    Write-ToLog -Message "Results: $successCount succeeded, $failedCount failed, $skippedCount skipped" -Level "INFO"

    return $results
}

# Show status function
function Show-Status {
    Show-MenuHeader -Title "AZURE UNIFIED LAB - STATUS"
    Show-ConfigurationSummary -AzureParams $script:azureParams -OperationParams $script:operationParams

    Write-Host "`n Checking deployed resources..." -ForegroundColor Cyan
    Write-Host " Resource Group Prefix: $script:resourceGroupNamePrefix" -ForegroundColor Gray

    # Check all possible lab-type resource groups
    $labSuffixes = @("CompleteLab", "SentinelLab", "ADXLab", "FlowLogLab", "EventHubLab", "BlobQueueLab", "BlobCollectorLab", "BasicInfrastructure")
    $foundAny = $false

    foreach ($suffix in $labSuffixes) {
        $rgName = Get-ResourceGroupName -Prefix $script:resourceGroupNamePrefix -Suffix $suffix
        $rg = Get-AzResourceGroup -Name $rgName -ErrorAction SilentlyContinue
        if ($null -ne $rg) {
            $foundAny = $true
            $resources = Get-AzResource -ResourceGroupName $rgName
            Write-Host "`n Resource Group: $rgName ($($resources.Count) resources)" -ForegroundColor Green

            foreach ($resource in $resources | Sort-Object ResourceType) {
                Write-Host "   $($resource.ResourceType): $($resource.Name)" -ForegroundColor White
            }
        }
    }

    if (-not $foundAny) {
        Write-Host "`n No lab resource groups found with prefix: $script:resourceGroupNamePrefix" -ForegroundColor Yellow
        Write-Host "   Run a deployment to create resources" -ForegroundColor Gray
    }
}

# Main function
function Main {
    # Check Azure authentication
    if (-not (Test-AzureAuthentication)) {
        exit 1
    }

    # Non-interactive mode
    if ($NonInteractive -or $Phase -gt 0) {
        if ($Phase -gt 0) {
            # Single-phase mode uses the prefix as-is (caller must know what RG they target)
            Start-PhaseDeployment -SpecificPhase $Phase -LabMode $script:azureParams.labMode
        } elseif ([string]::IsNullOrWhiteSpace($Mode)) {
            Write-Host "  Mode parameter is required in non-interactive mode" -ForegroundColor Red
            Write-Host "  Use: -Mode Full|Infrastructure|Monitoring|Analytics|Storage|Validate" -ForegroundColor Yellow
            exit 1
        } elseif ($Mode -eq "Status") {
            Show-Status
        } elseif ($Mode -eq "Validate") {
            Write-Host "`n Configuration validation passed!" -ForegroundColor Green
        } else {
            # Map non-interactive modes to lab configs with proper RG suffixes
            $modeLabTypeMap = @{
                "Full"           = "CompleteLab"
                "Infrastructure" = "BasicInfrastructure"
                "Monitoring"     = "SentinelLab"
                "Analytics"      = "ADXLab"
                "Storage"        = "BlobQueueLab"
            }
            $labType = $modeLabTypeMap[$Mode]
            if ($labType) {
                $labConfig = Get-LabDeploymentConfig -LabType $labType -LabMode $script:azureParams.labMode
                Start-PhaseDeployment -LabConfig $labConfig -LabMode $script:azureParams.labMode
            } else {
                Start-PhaseDeployment -LabMode $script:azureParams.labMode
            }
        }
        exit 0
    }

    # Interactive mode - Start with lab mode selection
    $labMode = Get-LabMode -AzureParams $script:azureParams

    # Update azure-parameters.json if mode changed
    if ($labMode -ne $script:azureParams.labMode) {
        $script:azureParams.labMode = $labMode
        Write-Host "`n Lab mode updated to: $labMode" -ForegroundColor Cyan

        # Auto-enable/disable private endpoints based on mode
        if ($labMode -eq "private") {
            Write-Host "   Private endpoints enabled for all resources" -ForegroundColor Green
        } else {
            Write-Host "   Public endpoints will be used" -ForegroundColor Green
        }
    }

    # Interactive menu loop
    $continue = $true

    while ($continue) {
        Show-MenuHeader
        Show-ConfigurationSummary -AzureParams $script:azureParams -OperationParams $script:operationParams
        Show-DeploymentMenu -LabMode $labMode

        $choice = Read-Host "`nSelect option"

        switch ($choice.ToUpper()) {
            "1" {
                # Complete Lab Deployment
                $labConfig = Get-LabDeploymentConfig -LabType "CompleteLab" -LabMode $labMode
                $targetRG = Get-ResourceGroupName -Prefix $script:resourceGroupNamePrefix -Suffix $labConfig.ResourceGroupSuffix

                if (Confirm-Deployment -Mode "Complete Lab Deployment" -Components $labConfig -EstimatedMinutes 45 -ResourceGroupName $targetRG) {
                    $vmPassword = Get-VMPasswordIfNeeded -LabConfig $labConfig
                    Start-PhaseDeployment -LabConfig $labConfig -LabMode $labMode -VMPassword $vmPassword
                    Wait-ForUser
                }
            }
            "2" {
                # Sentinel Lab Deployment
                $labConfig = Get-LabDeploymentConfig -LabType "SentinelLab" -LabMode $labMode
                $targetRG = Get-ResourceGroupName -Prefix $script:resourceGroupNamePrefix -Suffix $labConfig.ResourceGroupSuffix

                if (Confirm-Deployment -Mode "Sentinel Lab" -Components $labConfig -EstimatedMinutes 20 -ResourceGroupName $targetRG) {
                    Start-PhaseDeployment -LabConfig $labConfig -LabMode $labMode
                    Wait-ForUser
                }
            }
            "3" {
                # ADX Lab Deployment
                Write-Host ""
                Write-Host "   WARNING: Azure Data Explorer Cluster Costs" -ForegroundColor Yellow
                Write-Host "   Minimum cost: ~`$8/day (Dev SKU)" -ForegroundColor Yellow
                Write-Host "   Deployment time: 25-30 minutes" -ForegroundColor Yellow
                Write-Host ""
                $confirmADX = Read-Host "Continue with ADX Lab deployment? [y/N]"

                if ($confirmADX -eq "y" -or $confirmADX -eq "Y") {
                    $labConfig = Get-LabDeploymentConfig -LabType "ADXLab" -LabMode $labMode
                    $targetRG = Get-ResourceGroupName -Prefix $script:resourceGroupNamePrefix -Suffix $labConfig.ResourceGroupSuffix

                    if (Confirm-Deployment -Mode "ADX Lab" -Components $labConfig -EstimatedMinutes 30 -ResourceGroupName $targetRG) {
                        Start-PhaseDeployment -LabConfig $labConfig -LabMode $labMode
                        Wait-ForUser
                    }
                }
            }
            "4" {
                # vNet Flow Log Lab
                $labConfig = Get-LabDeploymentConfig -LabType "FlowLogLab" -LabMode $labMode
                $targetRG = Get-ResourceGroupName -Prefix $script:resourceGroupNamePrefix -Suffix $labConfig.ResourceGroupSuffix

                if (Confirm-Deployment -Mode "vNet Flow Log Lab" -Components $labConfig -EstimatedMinutes 20 -ResourceGroupName $targetRG) {
                    $vmPassword = Get-VMPasswordIfNeeded -LabConfig $labConfig
                    Start-PhaseDeployment -LabConfig $labConfig -LabMode $labMode -VMPassword $vmPassword
                    Wait-ForUser
                }
            }
            "5" {
                # Event Hub Lab
                $labConfig = Get-LabDeploymentConfig -LabType "EventHubLab" -LabMode $labMode
                $targetRG = Get-ResourceGroupName -Prefix $script:resourceGroupNamePrefix -Suffix $labConfig.ResourceGroupSuffix

                if (Confirm-Deployment -Mode "Event Hub Lab" -Components $labConfig -EstimatedMinutes 15 -ResourceGroupName $targetRG) {
                    Start-PhaseDeployment -LabConfig $labConfig -LabMode $labMode
                    Wait-ForUser
                }
            }
            "6" {
                # Blob Queue Lab
                $labConfig = Get-LabDeploymentConfig -LabType "BlobQueueLab" -LabMode $labMode
                $targetRG = Get-ResourceGroupName -Prefix $script:resourceGroupNamePrefix -Suffix $labConfig.ResourceGroupSuffix

                if (Confirm-Deployment -Mode "Blob Queue Lab" -Components $labConfig -EstimatedMinutes 12 -ResourceGroupName $targetRG) {
                    Start-PhaseDeployment -LabConfig $labConfig -LabMode $labMode
                    Wait-ForUser
                }
            }
            "7" {
                # Blob Collector Lab
                $labConfig = Get-LabDeploymentConfig -LabType "BlobCollectorLab" -LabMode $labMode
                $targetRG = Get-ResourceGroupName -Prefix $script:resourceGroupNamePrefix -Suffix $labConfig.ResourceGroupSuffix

                if (Confirm-Deployment -Mode "Blob Collector Lab" -Components $labConfig -EstimatedMinutes 12 -ResourceGroupName $targetRG) {
                    Start-PhaseDeployment -LabConfig $labConfig -LabMode $labMode
                    Wait-ForUser
                }
            }
            "8" {
                # Basic Infrastructure
                $labConfig = Get-LabDeploymentConfig -LabType "BasicInfrastructure" -LabMode $labMode
                $targetRG = Get-ResourceGroupName -Prefix $script:resourceGroupNamePrefix -Suffix $labConfig.ResourceGroupSuffix

                if (Confirm-Deployment -Mode "Basic Infrastructure" -Components $labConfig -EstimatedMinutes 10 -ResourceGroupName $targetRG) {
                    Start-PhaseDeployment -LabConfig $labConfig -LabMode $labMode
                    Wait-ForUser
                }
            }
            "Q" {
                Write-Host "`n Exiting..." -ForegroundColor Cyan
                $continue = $false
            }
            default {
                Write-Host "`n Invalid option. Please try again." -ForegroundColor Yellow
                Start-Sleep -Seconds 1
            }
        }
    }
}

# Execute main function
Main

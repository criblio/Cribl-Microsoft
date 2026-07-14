# Azure Log Collection - Interactive Menu
# This script provides an interactive menu-based interface for:
# 1. Deploying Event Hub Namespaces for Azure diagnostic logs
# 2. Assigning Microsoft's built-in diagnostic settings policy initiatives
# 3. Microsoft Defender XDR Streaming API setup
#
# Deployment Modes:
# - CENTRALIZED: Single Event Hub Namespace, all logs to one location
# - MULTI-REGION: Per-region namespaces, logs stay in their source region

param(
    [Parameter(Mandatory=$false)]
    [switch]$NonInteractive,

    [Parameter(Mandatory=$false)]
    [ValidateSet(
        "DeployAll",
        "Inventory",
        "GapAnalysis",
        "RemoveDiagnosticSettings",
        "DefenderXDR",
        "DefenderXDRValidateOnly",
        "GenerateCriblSources"
    )]
    [string]$Mode = "",

    [Parameter(Mandatory=$false)]
    [switch]$DebugLogging
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Check for dev mode flag file
$DevModeFlag = Join-Path $PSScriptRoot ".dev-mode"
$Environment = if (Test-Path $DevModeFlag) { "dev" } else { "core" }

#region Centralized Path Configuration
# All file and directory names are defined here for easy maintenance
# These are referenced throughout the solution - change here to update everywhere

$script:PathConfig = @{
    # Configuration files
    AzureParametersFile     = "azure-parameters.json"
    ResourceCoverageFile    = "resource-coverage.json"

    # Directory names
    RegionInventoryDir      = "region-inventory"
    CriblConfigsDir         = "cribl-configs"
    LogsDir                 = "logs"
    ReportsDir              = "reports"

    # Inventory files
    InventoryLatestFile     = "inventory-latest.json"

    # Script files
    NamespaceScript         = "Deploy-EventHubNamespaces.ps1"
    PolicyScript            = "Deploy-BuiltInPolicyInitiatives.ps1"
    CommunityInitiativeScript = "Deploy-CommunityPolicyInitiative.ps1"
    SupplementalScript      = "Deploy-SupplementalPolicies.ps1"
    EntraIDScript           = "Deploy-EntraIDDiagnostics.ps1"
    DefenderExportScript    = "Deploy-DefenderExport.ps1"
    DefenderXDRScript       = "Deploy-DefenderXDRStreaming.ps1"
    GapAnalysisScript       = "Analyze-ComplianceGaps.ps1"
    CriblSourcesScript      = "Generate-CriblEventHubSources.ps1"
    OutputHelperScript      = "Output-Helper.ps1"

    # Solution identifier (used for tagging resources)
    SolutionName            = "Azure-LogCollection"
}

# Build full paths from configuration
$EnvironmentPath = Join-Path $PSScriptRoot $Environment
$NamespaceScript = Join-Path $EnvironmentPath $script:PathConfig.NamespaceScript
$PolicyScript = Join-Path $EnvironmentPath $script:PathConfig.PolicyScript
$CommunityInitiativeScript = Join-Path $EnvironmentPath $script:PathConfig.CommunityInitiativeScript
$SupplementalScript = Join-Path $EnvironmentPath $script:PathConfig.SupplementalScript

#endregion Centralized Path Configuration

# Import logging helper
$OutputHelperPath = Join-Path $EnvironmentPath $script:PathConfig.OutputHelperScript
if (Test-Path $OutputHelperPath) {
    . $OutputHelperPath
}

# Logs directory
$LogsDirectory = Join-Path $EnvironmentPath $script:PathConfig.LogsDir

# Session override variables - these override azure-parameters.json settings
$script:SessionOverrides = @{
    UseExistingNamespaces = $null    # null = use config file value
    CentralizedNamespace = $null     # null = use config file value
    RegionNamespaces = @{}           # region -> namespace name mapping
}

# Default deployment mode for menu display
$script:SelectedDeploymentMode = "Centralized"


#region Helper Functions

function Initialize-RequiredModules {
    <#
    .SYNOPSIS
        Checks for and installs required PowerShell modules for the solution.
    .DESCRIPTION
        Verifies that all required modules are installed and imports them.
        Automatically installs missing modules with user confirmation.
        Required modules:
        - Az.Accounts: Azure authentication
        - Az.Resources: Resource management
        - Az.EventHub: Event Hub operations
        - Az.ResourceGraph: Efficient resource queries (optional but recommended)
        - Microsoft.Graph: Microsoft Graph API for Defender XDR validation
    #>
    param(
        [switch]$Silent = $false
    )

    # Define required modules with their purposes
    $requiredModules = @(
        @{ Name = "Az.Accounts"; Purpose = "Azure authentication"; Required = $true }
        @{ Name = "Az.Resources"; Purpose = "Resource management"; Required = $true }
        @{ Name = "Az.EventHub"; Purpose = "Event Hub operations"; Required = $true }
        @{ Name = "Az.ResourceGraph"; Purpose = "Efficient resource queries"; Required = $false }
        @{ Name = "Microsoft.Graph.Authentication"; Purpose = "Microsoft Graph authentication"; Required = $false }
        @{ Name = "Microsoft.Graph.Identity.DirectoryManagement"; Purpose = "License and directory queries"; Required = $false }
    )

    if (-not $Silent) {
        Write-Host "`n  Checking required PowerShell modules..." -ForegroundColor Cyan
    }

    $missingRequired = @()
    $missingOptional = @()

    foreach ($module in $requiredModules) {
        $installed = Get-Module -ListAvailable -Name $module.Name -ErrorAction SilentlyContinue
        if (-not $installed) {
            if ($module.Required) {
                $missingRequired += $module
            } else {
                $missingOptional += $module
            }
        } else {
            if (-not $Silent) {
                Write-Host "    [OK] $($module.Name)" -ForegroundColor Green
            }
        }
    }

    # Handle missing required modules
    if ($missingRequired.Count -gt 0) {
        Write-Host "`n  Missing required modules:" -ForegroundColor Red
        foreach ($module in $missingRequired) {
            Write-Host "    - $($module.Name): $($module.Purpose)" -ForegroundColor Yellow
        }

        Write-Host "`n  Would you like to install missing required modules? (Y/N): " -ForegroundColor Cyan -NoNewline
        $response = Read-Host

        if ($response -eq 'Y' -or $response -eq 'y') {
            foreach ($module in $missingRequired) {
                Write-Host "  Installing $($module.Name)..." -ForegroundColor Cyan
                try {
                    Install-Module -Name $module.Name -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop
                    Write-Host "    [OK] $($module.Name) installed" -ForegroundColor Green
                } catch {
                    Write-Host "    [ERROR] Failed to install $($module.Name): $_" -ForegroundColor Red
                    return $false
                }
            }
        } else {
            Write-Host "`n  Cannot proceed without required modules." -ForegroundColor Red
            Write-Host "  Install manually with:" -ForegroundColor Yellow
            foreach ($module in $missingRequired) {
                Write-Host "    Install-Module -Name $($module.Name) -Scope CurrentUser" -ForegroundColor Gray
            }
            return $false
        }
    }

    # Handle missing optional modules (for Defender XDR features)
    if ($missingOptional.Count -gt 0) {
        if (-not $Silent) {
            Write-Host "`n  Optional modules (for Defender XDR validation):" -ForegroundColor Yellow
            foreach ($module in $missingOptional) {
                Write-Host "    - $($module.Name): $($module.Purpose)" -ForegroundColor DarkYellow
            }
        }

        Write-Host "`n  Install optional modules for full Defender XDR support? (Y/N): " -ForegroundColor Cyan -NoNewline
        $response = Read-Host

        if ($response -eq 'Y' -or $response -eq 'y') {
            foreach ($module in $missingOptional) {
                Write-Host "  Installing $($module.Name)..." -ForegroundColor Cyan
                try {
                    Install-Module -Name $module.Name -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop
                    Write-Host "    [OK] $($module.Name) installed" -ForegroundColor Green
                } catch {
                    Write-Host "    [WARN] Failed to install $($module.Name): $_" -ForegroundColor Yellow
                    Write-Host "    Defender XDR license validation will be limited." -ForegroundColor DarkYellow
                }
            }
        } else {
            Write-Host "  Skipping optional modules. Defender XDR license validation will be limited." -ForegroundColor DarkYellow
        }
    }

    # Import required modules
    if (-not $Silent) {
        Write-Host "`n  Importing modules..." -ForegroundColor Cyan
    }

    foreach ($module in $requiredModules) {
        if ($module.Required -or (Get-Module -ListAvailable -Name $module.Name -ErrorAction SilentlyContinue)) {
            try {
                Import-Module $module.Name -ErrorAction SilentlyContinue
            } catch {
                if ($module.Required) {
                    Write-Host "    [ERROR] Failed to import $($module.Name)" -ForegroundColor Red
                    return $false
                }
            }
        }
    }

    if (-not $Silent) {
        Write-Host "  Module initialization complete" -ForegroundColor Green
    }

    return $true
}

function Get-SolutionPath {
    <#
    .SYNOPSIS
        Returns full path for solution files and directories using centralized configuration.
    .DESCRIPTION
        Uses the PathConfig hashtable to build consistent paths throughout the solution.
        This ensures all path references are centralized and easily maintainable.
    .PARAMETER PathKey
        The key from PathConfig (e.g., 'AzureParametersFile', 'RegionInventoryDir')
    .PARAMETER ChildPath
        Optional additional path segment to append (e.g., filename within a directory)
    .EXAMPLE
        Get-SolutionPath -PathKey 'AzureParametersFile'
        # Returns: C:\...\core\azure-parameters.json
    .EXAMPLE
        Get-SolutionPath -PathKey 'RegionInventoryDir' -ChildPath 'inventory-latest.json'
        # Returns: C:\...\core\region-inventory\inventory-latest.json
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$PathKey,

        [Parameter(Mandatory=$false)]
        [string]$ChildPath = ""
    )

    if (-not $script:PathConfig.ContainsKey($PathKey)) {
        throw "Unknown path key: $PathKey. Valid keys: $($script:PathConfig.Keys -join ', ')"
    }

    $basePath = Join-Path $EnvironmentPath $script:PathConfig[$PathKey]

    if ($ChildPath) {
        return Join-Path $basePath $ChildPath
    }

    return $basePath
}

function Ensure-AzureConnection {
    <#
    .SYNOPSIS
        Verifies Azure connection and automatically refreshes token if expired.
    .DESCRIPTION
        Checks for an existing Azure context, validates the token is still valid,
        verifies the correct tenant is connected (if tenantId is configured),
        and attempts automatic refresh if the token has expired.
        Matches the authentication pattern used in DCR Automation.
    #>
    param(
        [switch]$Silent = $false
    )

    try {
        # Load azure-parameters.json to check for tenantId
        $azureParamsFile = Get-SolutionPath -PathKey 'AzureParametersFile'
        $configuredTenantId = $null
        if (Test-Path $azureParamsFile) {
            try {
                $azParams = Get-Content $azureParamsFile -Raw | ConvertFrom-Json
                if ($azParams.tenantId -and -not [string]::IsNullOrWhiteSpace($azParams.tenantId)) {
                    $configuredTenantId = $azParams.tenantId
                }
            } catch {
                # Ignore JSON parse errors here - will be caught in config validation
            }
        }

        # Get current context
        $context = Get-AzContext -ErrorAction SilentlyContinue

        if (-not $context) {
            if (-not $Silent) {
                Write-Host "`n  No Azure context found." -ForegroundColor Red
                if ($configuredTenantId) {
                    Write-Host "  Please run 'Connect-AzAccount -TenantId $configuredTenantId' first." -ForegroundColor Yellow
                } else {
                    Write-Host "  Please run 'Connect-AzAccount' first." -ForegroundColor Yellow
                }
            }
            return $false
        }

        # Validate tenant ID if configured
        if ($configuredTenantId) {
            $currentTenantId = $context.Tenant.Id
            if ($currentTenantId -ne $configuredTenantId) {
                if (-not $Silent) {
                    Write-Host "`n  Wrong Azure tenant connected!" -ForegroundColor Red
                    Write-Host "  Current tenant:    $currentTenantId" -ForegroundColor Yellow
                    Write-Host "  Configured tenant: $configuredTenantId" -ForegroundColor Yellow
                    Write-Host "`n  Please run: Connect-AzAccount -TenantId $configuredTenantId" -ForegroundColor Cyan
                }
                return $false
            }
        }

        # Test if the token is still valid by making a simple API call
        try {
            Get-AzSubscription -SubscriptionId $context.Subscription.Id -ErrorAction Stop -WarningAction SilentlyContinue 2>$null | Out-Null

            if (-not $Silent) {
                Write-Host "  Azure connection verified" -ForegroundColor Green -NoNewline
                Write-Host " (Tenant: $($context.Tenant.Id.Substring(0,8))...)" -ForegroundColor DarkGray
            }
            return $true
        }
        catch {
            # Token is expired or invalid - try to refresh it
            if (-not $Silent) {
                Write-Host "  Token expired. Attempting automatic refresh..." -ForegroundColor Yellow
            }

            try {
                # Try to refresh using existing context info without interactive prompts
                if ($context -and $context.Account -and $context.Account.Id) {
                    # For user accounts, try silent refresh
                    if ($context.Account.Type -ne 'ServicePrincipal') {
                        try {
                            # Try to get a new access token using the existing context
                            $token = Get-AzAccessToken -ResourceUrl "https://management.azure.com/" -ErrorAction Stop
                            if ($token -and $token.Token) {
                                if (-not $Silent) {
                                    Write-Host "  Token refreshed successfully" -ForegroundColor Green
                                }
                                return $true
                            }
                        }
                        catch {
                            # Try Connect-AzAccount with account ID (should use cached credentials)
                            try {
                                $connectResult = Connect-AzAccount -AccountId $context.Account.Id -TenantId $context.Tenant.Id -Force -ErrorAction Stop -WarningAction SilentlyContinue
                                if ($connectResult) {
                                    # Ensure we're in the right subscription
                                    if ($context.Subscription.Id) {
                                        Set-AzContext -SubscriptionId $context.Subscription.Id -ErrorAction SilentlyContinue | Out-Null
                                    }
                                    if (-not $Silent) {
                                        Write-Host "  Azure connection refreshed successfully" -ForegroundColor Green
                                    }
                                    return $true
                                }
                            }
                            catch {
                                if (-not $Silent) {
                                    Write-Host "  Failed to refresh token automatically" -ForegroundColor Red
                                    Write-Host "  Please run 'Connect-AzAccount' to refresh your session" -ForegroundColor Yellow
                                }
                                return $false
                            }
                        }
                    } else {
                        # Service Principal - cannot refresh automatically
                        if (-not $Silent) {
                            Write-Host "  Service Principal session expired. Please re-authenticate." -ForegroundColor Red
                        }
                        return $false
                    }
                } else {
                    if (-not $Silent) {
                        Write-Host "  Cannot refresh - insufficient context information" -ForegroundColor Red
                    }
                    return $false
                }
            }
            catch {
                if (-not $Silent) {
                    Write-Host "  Token refresh failed: $($_.Exception.Message)" -ForegroundColor Red
                    Write-Host "  Please run 'Connect-AzAccount' to refresh your session" -ForegroundColor Yellow
                }
                return $false
            }
        }

    } catch {
        # General error with Azure connection
        if (-not $Silent) {
            Write-Host "  Failed to verify Azure connection: $($_.Exception.Message)" -ForegroundColor Red
        }
        return $false
    }
}

function Test-ManagementGroupExists {
    <#
    .SYNOPSIS
        Validates that a management group exists and is accessible.
    .DESCRIPTION
        Checks if the specified management group exists in Azure and the current
        user/service principal has access to it. This is critical for policy
        assignments since they are scoped to the management group.
    .PARAMETER ManagementGroupId
        The ID of the management group to validate
    .OUTPUTS
        Boolean indicating if the management group exists and is accessible
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$ManagementGroupId
    )

    try {
        $mg = Get-AzManagementGroup -GroupId $ManagementGroupId -ErrorAction Stop
        if ($mg) {
            Write-Host "  Management Group validated: $ManagementGroupId" -ForegroundColor Green
            return $true
        }
        return $false
    } catch {
        $errorMessage = $_.Exception.Message
        if ($errorMessage -match "NotFound|does not exist") {
            Write-Host "  Management Group '$ManagementGroupId' does not exist" -ForegroundColor Red
        } elseif ($errorMessage -match "Forbidden|Authorization") {
            Write-Host "  No access to Management Group '$ManagementGroupId'" -ForegroundColor Red
            Write-Host "  Ensure you have Reader or higher role on this Management Group" -ForegroundColor Yellow
        } else {
            Write-Host "  Failed to validate Management Group: $errorMessage" -ForegroundColor Red
        }
        return $false
    }
}

function Initialize-DeploymentLogging {
    <#
    .SYNOPSIS
        Initializes logging for a deployment operation.
    .DESCRIPTION
        Creates a timestamped log file in the logs directory and initializes
        the logging helper. Call this before starting deployment operations.
    .PARAMETER OperationType
        Type of deployment operation (e.g., "DeployAll", "Inventory")
    .PARAMETER EnableDebug
        Whether to enable debug-level logging
    .OUTPUTS
        Returns the path to the log file, or $null if logging initialization failed
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$OperationType,

        [Parameter(Mandatory=$false)]
        [bool]$EnableDebug = $false
    )

    # Only initialize if the logging helper is available
    if (-not (Get-Command Initialize-PolicyLogging -ErrorAction SilentlyContinue)) {
        return $null
    }

    try {
        # Create logs directory if it doesn't exist
        if (-not (Test-Path $LogsDirectory)) {
            New-Item -ItemType Directory -Path $LogsDirectory -Force | Out-Null
        }

        # Create timestamped log file name
        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $logFileName = "deploy-$OperationType-$timestamp.log"
        $logFilePath = Join-Path $LogsDirectory $logFileName

        # Initialize logging
        $result = Initialize-PolicyLogging -LogPath $logFilePath -Append $false -EnableDebug $EnableDebug

        if ($result) {
            Write-ToLog -Message "Deployment started: $OperationType" -Level "INFO"
            return $logFilePath
        }
    } catch {
        # Silently fail if logging initialization fails
    }

    return $null
}

function Get-EffectiveUseExistingNamespaces {
    <#
    .SYNOPSIS
        Returns the effective useExistingNamespaces value, with session override taking precedence.
    #>
    $azureParamsFile = Join-Path $PSScriptRoot $Environment "azure-parameters.json"
    $azParams = Get-Content $azureParamsFile | ConvertFrom-Json

    if ($null -ne $script:SessionOverrides.UseExistingNamespaces) {
        return $script:SessionOverrides.UseExistingNamespaces
    }
    return ($azParams.useExistingNamespaces -eq $true)
}

function Get-EffectiveNamespaceName {
    <#
    .SYNOPSIS
        Returns the effective namespace name for a region, with session override taking precedence.
    #>
    param(
        [string]$Region,
        [string]$Mode
    )

    $azureParamsFile = Join-Path $PSScriptRoot $Environment "azure-parameters.json"
    $azParams = Get-Content $azureParamsFile | ConvertFrom-Json
    $subIdShort = $azParams.eventHubSubscriptionId.Substring(0, 8).ToLower()

    if ($Mode -eq "Centralized") {
        # Check session override first
        if (-not [string]::IsNullOrWhiteSpace($script:SessionOverrides.CentralizedNamespace)) {
            return $script:SessionOverrides.CentralizedNamespace
        }
        # Check config file
        if ((Get-EffectiveUseExistingNamespaces) -and -not [string]::IsNullOrWhiteSpace($azParams.centralizedNamespace)) {
            return $azParams.centralizedNamespace
        }
        # Auto-generated
        return "$($azParams.eventHubNamespacePrefix)-$subIdShort"
    } else {
        # Multi-region mode
        # Check session override first
        if ($script:SessionOverrides.RegionNamespaces.ContainsKey($Region)) {
            $name = $script:SessionOverrides.RegionNamespaces[$Region]
            if (-not [string]::IsNullOrWhiteSpace($name)) {
                return $name
            }
        }
        # Note: Regions now come from inventory, not config file
        # Custom namespace names for existing namespaces are set via session overrides
        # Auto-generated
        return "$($azParams.eventHubNamespacePrefix)-$subIdShort-$Region"
    }
}

function Select-NamespaceMode {
    <#
    .SYNOPSIS
        Interactive menu to toggle between creating new namespaces or using existing ones.
    #>

    $currentValue = Get-EffectiveUseExistingNamespaces

    Write-Host "`n$('='*80)" -ForegroundColor Cyan
    Write-Host "  EVENT HUB NAMESPACE MODE" -ForegroundColor Cyan
    Write-Host "$('='*80)" -ForegroundColor Cyan

    Write-Host "`n  Current setting: " -NoNewline
    if ($currentValue) {
        Write-Host "USE EXISTING NAMESPACES" -ForegroundColor Yellow
    } else {
        Write-Host "CREATE NEW NAMESPACES" -ForegroundColor Green
    }

    if ($null -ne $script:SessionOverrides.UseExistingNamespaces) {
        Write-Host "  (Session override active - different from config file)" -ForegroundColor DarkGray
    }

    Write-Host "`n  [1] CREATE NEW NAMESPACES" -ForegroundColor Green
    Write-Host "      Script will create Event Hub Namespace(s) in Azure" -ForegroundColor Gray
    Write-Host "      Names auto-generated based on prefix and subscription ID" -ForegroundColor DarkGray

    Write-Host "`n  [2] USE EXISTING NAMESPACES" -ForegroundColor Yellow
    Write-Host "      Use pre-existing Event Hub Namespace(s)" -ForegroundColor Gray
    Write-Host "      You will need to specify namespace names" -ForegroundColor DarkGray

    Write-Host "`n  [B] Back to main menu" -ForegroundColor White
    Write-Host "$('='*80)" -ForegroundColor Cyan

    $selection = Read-Host "`n  Select option"

    switch ($selection) {
        '1' {
            $script:SessionOverrides.UseExistingNamespaces = $false
            $script:SessionOverrides.CentralizedNamespace = $null
            $script:SessionOverrides.RegionNamespaces = @{}
            Write-Host "`n  Mode changed to: CREATE NEW NAMESPACES" -ForegroundColor Green
            return $true
        }
        '2' {
            $script:SessionOverrides.UseExistingNamespaces = $true
            Write-Host "`n  Mode changed to: USE EXISTING NAMESPACES" -ForegroundColor Yellow
            Write-Host "  Use [N] Configure Namespace Names to specify your namespace names" -ForegroundColor Cyan
            return $true
        }
        'B' { return $false }
        'b' { return $false }
        default {
            Write-Host "  Invalid selection." -ForegroundColor Red
            return $false
        }
    }
}

function Configure-NamespaceNames {
    <#
    .SYNOPSIS
        Interactive menu to configure namespace names for existing namespaces.
    #>

    $azureParamsFile = Join-Path $PSScriptRoot $Environment "azure-parameters.json"
    $azParams = Get-Content $azureParamsFile | ConvertFrom-Json

    Write-Host "`n$('='*80)" -ForegroundColor Cyan
    Write-Host "  CONFIGURE NAMESPACE NAMES" -ForegroundColor Cyan
    Write-Host "$('='*80)" -ForegroundColor Cyan

    $useExisting = Get-EffectiveUseExistingNamespaces

    if (-not $useExisting) {
        Write-Host "`n  NOTE: You are currently in CREATE NEW mode." -ForegroundColor Yellow
        Write-Host "  Namespace names will be auto-generated." -ForegroundColor Gray
        Write-Host "  Use [E] to switch to USE EXISTING mode first." -ForegroundColor Cyan
        return
    }

    # Ask user which deployment type to configure
    Write-Host "`n  Which deployment type do you want to configure?" -ForegroundColor White
    Write-Host "  [1] Centralized - Single namespace for all regions" -ForegroundColor Yellow
    Write-Host "  [2] Multi-Region - Per-region namespaces" -ForegroundColor Green
    Write-Host "  [B] Back to main menu" -ForegroundColor Gray

    $modeSelection = Read-Host "`n  Select"

    switch ($modeSelection) {
        '1' {
            # Centralized configuration
            Write-Host "`n  Deployment Mode: CENTRALIZED" -ForegroundColor Yellow
            Write-Host "  Region: $($azParams.centralizedRegion)" -ForegroundColor Gray

            $currentName = Get-EffectiveNamespaceName -Region $azParams.centralizedRegion -Mode "Centralized"
            Write-Host "`n  Current namespace: " -NoNewline
            Write-Host $currentName -ForegroundColor Cyan

            if (-not [string]::IsNullOrWhiteSpace($script:SessionOverrides.CentralizedNamespace)) {
                Write-Host "  (Session override)" -ForegroundColor DarkGray
            }

            Write-Host "`n  Enter the name of your existing Event Hub Namespace"
            Write-Host "  (Press Enter to keep current value, or type 'auto' for auto-generated name)"
            $newName = Read-Host "`n  Namespace name"

            if (-not [string]::IsNullOrWhiteSpace($newName)) {
                if ($newName.ToLower() -eq 'auto') {
                    $script:SessionOverrides.CentralizedNamespace = $null
                    Write-Host "`n  Namespace will use auto-generated name" -ForegroundColor Green
                } else {
                    $script:SessionOverrides.CentralizedNamespace = $newName
                    Write-Host "`n  Namespace set to: $newName" -ForegroundColor Green
                }
            } else {
                Write-Host "`n  Keeping current value: $currentName" -ForegroundColor Gray
            }
        }
        '2' {
            # Multi-Region configuration
            Write-Host "`n  Deployment Mode: MULTI-REGION" -ForegroundColor Green

            # Get regions from inventory instead of config
            $inventory = Get-InventoryData -Silent
            if (-not $inventory -or -not $inventory.Regions -or $inventory.Regions.Count -eq 0) {
                Write-Host "`n  No inventory found!" -ForegroundColor Red
                Write-Host "  Run [I] Inventory first to discover which regions have resources." -ForegroundColor Yellow
                return
            }

            $inventoryRegions = $inventory.Regions
            Write-Host "  Discovered regions: $($inventoryRegions.Count)" -ForegroundColor Gray
            Write-Host "`n  Configure namespace name for each region:"
            Write-Host "  (Press Enter to keep current value, or type 'auto' for auto-generated name)"

            foreach ($region in $inventoryRegions) {
                $regionLocation = $region.Location
                $currentName = Get-EffectiveNamespaceName -Region $regionLocation -Mode "MultiRegion"
                $isOverride = $script:SessionOverrides.RegionNamespaces.ContainsKey($regionLocation)

                Write-Host "`n  $('-'*60)" -ForegroundColor DarkGray
                Write-Host "  Region: " -NoNewline
                Write-Host $regionLocation -ForegroundColor Cyan
                Write-Host "  Resources: $($region.ResourceCount)" -ForegroundColor Gray
                Write-Host "  Current namespace: $currentName" -ForegroundColor Gray
                if ($isOverride) {
                    Write-Host "  (Session override)" -ForegroundColor DarkGray
                }

                $newName = Read-Host "  Namespace name"

                if (-not [string]::IsNullOrWhiteSpace($newName)) {
                    if ($newName.ToLower() -eq 'auto') {
                        $script:SessionOverrides.RegionNamespaces.Remove($regionLocation)
                        Write-Host "  Will use auto-generated name" -ForegroundColor Green
                    } else {
                        $script:SessionOverrides.RegionNamespaces[$regionLocation] = $newName
                        Write-Host "  Set to: $newName" -ForegroundColor Green
                    }
                }
            }
        }
        'B' { return }
        'b' { return }
        default {
            Write-Host "  Invalid selection." -ForegroundColor Red
            return
        }
    }

    Write-Host "`n$('='*80)" -ForegroundColor Cyan
    Write-Host "  Namespace configuration complete!" -ForegroundColor Green
}

function Get-OverrideParameters {
    <#
    .SYNOPSIS
        Builds a hashtable of override parameters to pass to deployment scripts.
    #>
    $overrides = @{}

    # Only pass override if session has modified the value
    if ($null -ne $script:SessionOverrides.UseExistingNamespaces) {
        $overrides['UseExistingNamespaces'] = $script:SessionOverrides.UseExistingNamespaces
    }

    if (-not [string]::IsNullOrWhiteSpace($script:SessionOverrides.CentralizedNamespace)) {
        $overrides['CentralizedNamespaceOverride'] = $script:SessionOverrides.CentralizedNamespace
    }

    if ($script:SessionOverrides.RegionNamespaces.Count -gt 0) {
        $overrides['RegionNamespacesOverride'] = $script:SessionOverrides.RegionNamespaces
    }

    return $overrides
}

function Test-AzureParametersConfiguration {
    $azureParamsFile = Get-SolutionPath -PathKey 'AzureParametersFile'

    if (-not (Test-Path $azureParamsFile)) {
        Write-Host "`n  ERROR: $($script:PathConfig.AzureParametersFile) not found!" -ForegroundColor Red
        return $false
    }

    try {
        $azParams = Get-Content $azureParamsFile | ConvertFrom-Json
    } catch {
        Write-Host "`n  ERROR: $($script:PathConfig.AzureParametersFile) is not valid JSON!" -ForegroundColor Red
        return $false
    }

    # Check required fields (regions no longer required - comes from inventory)
    $requiredFields = @{
        "managementGroupId" = @("<YOUR-MANAGEMENT-GROUP-ID-HERE>", "")
        "eventHubSubscriptionId" = @("<YOUR-EVENTHUB-SUBSCRIPTION-ID-HERE>", "")
        "eventHubResourceGroup" = @("<YOUR-EVENTHUB-RG-NAME-HERE>", "")
    }

    $missingFields = @()
    $placeholderFields = @()

    foreach ($field in $requiredFields.Keys) {
        $value = $azParams.$field
        if (-not $value -or [string]::IsNullOrWhiteSpace($value)) {
            $missingFields += $field
        } elseif ($requiredFields[$field] -contains $value) {
            $placeholderFields += $field
        }
    }

    if ($missingFields.Count -gt 0 -or $placeholderFields.Count -gt 0) {
        Write-Host "`n  ERROR: $($script:PathConfig.AzureParametersFile) needs configuration!" -ForegroundColor Red

        if ($missingFields.Count -gt 0) {
            Write-Host "`n  Missing fields:" -ForegroundColor Yellow
            foreach ($field in $missingFields) {
                Write-Host "    - $field" -ForegroundColor Yellow
            }
        }

        if ($placeholderFields.Count -gt 0) {
            Write-Host "`n  Fields with placeholder values:" -ForegroundColor Yellow
            foreach ($field in $placeholderFields) {
                Write-Host "    - $field" -ForegroundColor Yellow
            }
        }

        Write-Host "`n  Please update: $azureParamsFile" -ForegroundColor Cyan
        return $false
    }

    return $true
}

function Show-CurrentConfiguration {
    param([string]$SelectedDeploymentMode)

    $azureParamsFile = Join-Path $PSScriptRoot $Environment "azure-parameters.json"
    $azParams = Get-Content $azureParamsFile | ConvertFrom-Json

    Write-Host "`n  Current Configuration:" -ForegroundColor Cyan
    if ($azParams.tenantId -and -not [string]::IsNullOrWhiteSpace($azParams.tenantId)) {
        Write-Host "    Tenant ID:              $($azParams.tenantId)" -ForegroundColor White
    }
    Write-Host "    Management Group:       $($azParams.managementGroupId)" -ForegroundColor White
    Write-Host "    Event Hub Subscription: $($azParams.eventHubSubscriptionId)" -ForegroundColor White
    Write-Host "    Event Hub RG:           $($azParams.eventHubResourceGroup)" -ForegroundColor White

    # Show existing namespace mode (with session override indicator)
    $useExisting = Get-EffectiveUseExistingNamespaces
    $hasOverride = $null -ne $script:SessionOverrides.UseExistingNamespaces

    Write-Host "    Namespace Mode:         " -NoNewline -ForegroundColor White
    if ($useExisting) {
        Write-Host "USE EXISTING" -NoNewline -ForegroundColor Yellow
        if ($hasOverride) {
            Write-Host " (session)" -ForegroundColor DarkGray
        } else {
            Write-Host ""
        }
    } else {
        Write-Host "CREATE NEW" -NoNewline -ForegroundColor Green
        if ($hasOverride) {
            Write-Host " (session)" -ForegroundColor DarkGray
        } else {
            Write-Host ""
        }
    }

    # Show inventory status
    $inventory = Get-InventoryData -Silent
    $hasInventory = ($null -ne $inventory -and $inventory.Regions -and $inventory.Regions.Count -gt 0)

    Write-Host "    Inventory Status:       " -NoNewline -ForegroundColor White
    if ($hasInventory) {
        Write-Host "$($inventory.Regions.Count) regions discovered" -NoNewline -ForegroundColor Green
        Write-Host " ($($inventory.GeneratedAt))" -ForegroundColor DarkGray

        # Show policy conflict status if available
        if ($inventory.PSObject.Properties.Name -contains 'PolicyConflicts' -and $null -ne $inventory.PolicyConflicts) {
            Write-Host "    Policy Conflicts:       " -NoNewline -ForegroundColor White
            if ($inventory.PolicyConflicts.HasConflicts) {
                Write-Host "$($inventory.PolicyConflicts.TotalConflicts) CONFLICT(S) DETECTED" -ForegroundColor Red
            } else {
                Write-Host "None detected" -ForegroundColor Green
            }
        }

        # Show diagnostic setting collision status if available
        if ($inventory.PSObject.Properties.Name -contains 'DiagnosticSettingCollisions' -and $null -ne $inventory.DiagnosticSettingCollisions) {
            Write-Host "    Existing Settings:      " -NoNewline -ForegroundColor White
            if ($inventory.DiagnosticSettingCollisions.HasCollisions) {
                Write-Host "$($inventory.DiagnosticSettingCollisions.TotalCollisions) resource(s) already configured" -ForegroundColor Yellow
            } else {
                Write-Host "None found" -ForegroundColor Green
            }
        }
    } else {
        Write-Host "NOT RUN" -NoNewline -ForegroundColor Red
        Write-Host " - Run [I] Inventory first!" -ForegroundColor Yellow
    }

    Write-Host "`n  Deployment Mode:          " -NoNewline -ForegroundColor Cyan
    if ($SelectedDeploymentMode -eq "Centralized") {
        Write-Host "CENTRALIZED" -ForegroundColor Yellow
        Write-Host "    Centralized Region:     $($azParams.centralizedRegion)" -ForegroundColor White

        # Show effective namespace name
        $namespaceName = Get-EffectiveNamespaceName -Region $azParams.centralizedRegion -Mode "Centralized"
        $hasNameOverride = -not [string]::IsNullOrWhiteSpace($script:SessionOverrides.CentralizedNamespace)

        Write-Host "    Namespace Name:         " -NoNewline -ForegroundColor White
        Write-Host $namespaceName -NoNewline -ForegroundColor $(if ($useExisting) { "Yellow" } else { "Gray" })
        if ($hasNameOverride) {
            Write-Host " (session)" -ForegroundColor DarkGray
        } else {
            Write-Host ""
        }

        if ($useExisting) {
            Write-Host "    (Will validate existing namespace)" -ForegroundColor DarkGray
        }
        Write-Host "    (All logs to one location - simpler, cross-region egress)" -ForegroundColor DarkGray
    } else {
        Write-Host "MULTI-REGION" -ForegroundColor Green

        # Get regions from inventory instead of config
        if ($hasInventory) {
            $inventoryRegions = $inventory.Regions
            Write-Host "    Regions (from inventory): $($inventoryRegions.Location -join ', ')" -ForegroundColor White

            # Show namespace names for each region
            Write-Host "    Namespaces:" -ForegroundColor White
            foreach ($region in $inventoryRegions) {
                $namespaceName = Get-EffectiveNamespaceName -Region $region.Location -Mode "MultiRegion"
                $hasRegionOverride = $script:SessionOverrides.RegionNamespaces.ContainsKey($region.Location)

                Write-Host "      $($region.Location): " -NoNewline -ForegroundColor Gray
                Write-Host $namespaceName -NoNewline -ForegroundColor $(if ($useExisting) { "Yellow" } else { "Gray" })
                if ($hasRegionOverride) {
                    Write-Host " (session)" -ForegroundColor DarkGray
                } else {
                    Write-Host ""
                }
            }
        } else {
            Write-Host "    Regions:                " -NoNewline -ForegroundColor White
            Write-Host "Run [I] Inventory to discover regions" -ForegroundColor Yellow
        }

        if ($useExisting) {
            Write-Host "    (Will validate existing namespaces)" -ForegroundColor DarkGray
        }
        Write-Host "    (Logs stay in region - data residency, no egress)" -ForegroundColor DarkGray
    }
}

function Get-InventoryData {
    <#
    .SYNOPSIS
        Loads the latest region inventory from the JSON file.
    .DESCRIPTION
        Reads the inventory-latest.json file from the region-inventory directory.
        Returns $null if no inventory exists.
    #>
    param(
        [switch]$Silent
    )

    $latestFile = Get-SolutionPath -PathKey 'RegionInventoryDir' -ChildPath $script:PathConfig.InventoryLatestFile

    if (-not (Test-Path $latestFile)) {
        if (-not $Silent) {
            Write-Host "`n  No inventory found." -ForegroundColor Yellow
            Write-Host "  Run [I] Inventory first to discover resources by region." -ForegroundColor Yellow
        }
        return $null
    }

    try {
        $inventory = Get-Content $latestFile -Raw | ConvertFrom-Json
        return $inventory
    } catch {
        if (-not $Silent) {
            Write-Host "`n  ERROR: Failed to read inventory file: $_" -ForegroundColor Red
        }
        return $null
    }
}

function Test-InventoryExists {
    <#
    .SYNOPSIS
        Checks if a valid inventory file exists.
    .DESCRIPTION
        Returns $true if inventory-latest.json exists and can be parsed.
    #>
    $inventory = Get-InventoryData -Silent
    return ($null -ne $inventory -and $inventory.Regions -and $inventory.Regions.Count -gt 0)
}

function Get-InventoryRegions {
    <#
    .SYNOPSIS
        Returns the list of regions from the inventory for deployment scripts.
    .DESCRIPTION
        Converts inventory data into the format expected by deployment scripts.
    #>
    $inventory = Get-InventoryData -Silent
    if (-not $inventory -or -not $inventory.Regions) {
        return @()
    }

    # Convert inventory regions to the format expected by deployment scripts
    return @($inventory.Regions | ForEach-Object {
        @{
            location = $_.Location
            enabled = $true
            resourceCount = $_.ResourceCount
        }
    })
}

function Save-RegionInventory {
    <#
    .SYNOPSIS
        Saves the region inventory results to a JSON file for reference.
    .DESCRIPTION
        Exports the discovered regions and resource counts to a timestamped JSON file
        in the core/region-inventory/ directory.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [array]$RegionData,

        [Parameter(Mandatory=$true)]
        [string]$ManagementGroupId,

        [Parameter(Mandatory=$true)]
        [int]$TotalResources,

        [Parameter(Mandatory=$false)]
        [PSCustomObject]$ConflictData = $null,

        [Parameter(Mandatory=$false)]
        [PSCustomObject]$CollisionData = $null
    )

    # Create inventory directory if it doesn't exist
    $inventoryDir = Get-SolutionPath -PathKey 'RegionInventoryDir'
    if (-not (Test-Path $inventoryDir)) {
        New-Item -ItemType Directory -Path $inventoryDir -Force | Out-Null
    }

    # Build inventory object
    $inventory = @{
        GeneratedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        ManagementGroupId = $ManagementGroupId
        TotalResources = $TotalResources
        TotalRegions = $RegionData.Count
        Regions = @($RegionData | ForEach-Object {
            @{
                Location = $_.Location
                ResourceCount = $_.ResourceCount
            }
        })
    }

    # Add conflict data if provided
    if ($ConflictData) {
        $inventory.PolicyConflicts = @{
            CheckedAt = $ConflictData.CheckedAt
            HasConflicts = $ConflictData.HasConflicts
            TotalConflicts = $ConflictData.TotalConflicts
            AllLogsConflicts = @($ConflictData.AllLogsConflicts | ForEach-Object {
                @{
                    AssignmentName = $_.AssignmentName
                    DisplayName = $_.DisplayName
                    Scope = $_.Scope
                    ScopeType = $_.ScopeType
                    IsOurAssignment = $_.IsOurAssignment
                }
            })
            AuditConflicts = @($ConflictData.AuditConflicts | ForEach-Object {
                @{
                    AssignmentName = $_.AssignmentName
                    DisplayName = $_.DisplayName
                    Scope = $_.Scope
                    ScopeType = $_.ScopeType
                    IsOurAssignment = $_.IsOurAssignment
                }
            })
        }
    }

    # Add collision data if provided
    if ($CollisionData) {
        $inventory.DiagnosticSettingCollisions = @{
            CheckedAt = $CollisionData.CheckedAt
            DiagnosticSettingName = $CollisionData.DiagnosticSettingName
            HasCollisions = $CollisionData.HasCollisions
            TotalCollisions = $CollisionData.TotalCollisions
            ResourcesScanned = $CollisionData.ResourcesScanned
            SubscriptionsScanned = $CollisionData.SubscriptionsScanned
            # Store summary by resource type (not full list to keep file size manageable)
            CollisionsByType = @($CollisionData.Collisions | Group-Object -Property ResourceType | ForEach-Object {
                @{
                    ResourceType = $_.Name
                    Count = $_.Count
                }
            })
            CollisionsByNamespace = @($CollisionData.Collisions | Group-Object -Property EventHubNamespace | ForEach-Object {
                @{
                    EventHubNamespace = $_.Name
                    Count = $_.Count
                }
            })
        }
    }

    # Save to timestamped file
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $inventoryFile = Join-Path $inventoryDir "inventory-$timestamp.json"
    $inventory | ConvertTo-Json -Depth 5 | Set-Content $inventoryFile -Encoding UTF8

    # Also save as "latest" for easy reference
    $latestFile = Join-Path $inventoryDir "inventory-latest.json"
    $inventory | ConvertTo-Json -Depth 5 | Set-Content $latestFile -Encoding UTF8

    Write-Host "`n  Inventory saved to:" -ForegroundColor Cyan
    Write-Host "    $inventoryFile" -ForegroundColor Gray
    Write-Host "    $latestFile (latest)" -ForegroundColor Gray

    return $inventoryFile
}

function Get-RegionInventory {
    <#
    .SYNOPSIS
        Discovers which Azure regions contain resources under the Management Group.
    .DESCRIPTION
        Uses Azure Resource Graph to efficiently query all resources under the
        configured Management Group and groups them by region with resource counts.
        Results are automatically saved to core/region-inventory/ for reference.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$ManagementGroupId,

        [Parameter(Mandatory=$false)]
        [switch]$UpdateConfiguration
    )

    Write-Host "`n$('='*80)" -ForegroundColor Cyan
    Write-Host "  REGION INVENTORY - Discovering Azure Resources by Region" -ForegroundColor Cyan
    Write-Host "$('='*80)" -ForegroundColor Cyan
    Write-Host "`n  Management Group: $ManagementGroupId" -ForegroundColor White

    # Check if Az.ResourceGraph module is available
    if (-not (Get-Module -ListAvailable -Name Az.ResourceGraph)) {
        Write-Host "`n  WARNING: Az.ResourceGraph module not installed." -ForegroundColor Yellow
        Write-Host "  Install it with: Install-Module -Name Az.ResourceGraph -Scope CurrentUser" -ForegroundColor Yellow
        Write-Host "`n  Falling back to Az.Resources (slower for large environments)..." -ForegroundColor Yellow

        # Fallback to Az.Resources
        return Get-RegionInventoryFallback -ManagementGroupId $ManagementGroupId -UpdateConfiguration:$UpdateConfiguration
    }

    Write-Host "`n  Querying Azure Resource Graph..." -ForegroundColor Gray

    try {
        # Query resources grouped by location using Resource Graph
        $query = @"
resources
| where location != 'global'
| summarize ResourceCount = count() by location
| order by ResourceCount desc
"@

        $results = Search-AzGraph -Query $query -ManagementGroup $ManagementGroupId -First 1000

        if ($results.Count -eq 0) {
            Write-Host "`n  No resources found under Management Group: $ManagementGroupId" -ForegroundColor Yellow
            return @()
        }

        # Display results
        Write-Host "`n  Discovered Resources by Region:" -ForegroundColor Cyan
        Write-Host "  $('-'*50)" -ForegroundColor DarkGray

        $totalResources = 0
        $regionData = @()

        foreach ($row in $results) {
            $location = $row.location
            $count = $row.ResourceCount
            $totalResources += $count

            $regionData += [PSCustomObject]@{
                Location = $location
                ResourceCount = $count
            }

            # Format output with alignment
            $locationPadded = $location.PadRight(25)
            Write-Host "    $locationPadded $count resources" -ForegroundColor White
        }

        Write-Host "  $('-'*50)" -ForegroundColor DarkGray
        Write-Host "    TOTAL:                    $totalResources resources in $($results.Count) regions" -ForegroundColor Green

        # Check for conflicting policy assignments
        $conflictResult = Get-ConflictingPolicyAssignments -ManagementGroupId $ManagementGroupId

        # Check for existing diagnostic settings with the same name (collisions)
        $collisionResult = Get-ExistingDiagnosticSettingsCollisions -ManagementGroupId $ManagementGroupId

        # Save inventory to file (including conflict and collision data)
        Save-RegionInventory -RegionData $regionData -ManagementGroupId $ManagementGroupId -TotalResources $totalResources -ConflictData $conflictResult -CollisionData $collisionResult

        # Offer to update configuration
        if ($UpdateConfiguration) {
            Update-RegionConfiguration -RegionData $regionData
        }

        return $regionData

    } catch {
        Write-Host "`n  ERROR: Failed to query Azure Resource Graph" -ForegroundColor Red
        Write-Host "  $($_.Exception.Message)" -ForegroundColor Red

        # Check for common issues
        if ($_.Exception.Message -like "*AuthorizationFailed*") {
            Write-Host "`n  Ensure you have Reader access to the Management Group." -ForegroundColor Yellow
        }

        return @()
    }
}

function Get-RegionInventoryFallback {
    <#
    .SYNOPSIS
        Fallback method using Az.Resources when Az.ResourceGraph is not available.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$ManagementGroupId,

        [Parameter(Mandatory=$false)]
        [switch]$UpdateConfiguration
    )

    Write-Host "`n  Enumerating subscriptions under Management Group..." -ForegroundColor Gray

    try {
        # Get all subscriptions under the management group
        $mgHierarchy = Get-AzManagementGroup -GroupName $ManagementGroupId -Expand -Recurse -ErrorAction Stop

        # Collect subscription IDs recursively using script scope
        $script:collectedSubscriptionIds = @()

        function Get-SubscriptionsRecursive {
            param($MgGroup)
            if ($MgGroup.Children) {
                foreach ($child in $MgGroup.Children) {
                    if ($child.Type -eq "/subscriptions") {
                        $script:collectedSubscriptionIds += $child.Name
                    } elseif ($child.Type -eq "/providers/Microsoft.Management/managementGroups") {
                        $childMg = Get-AzManagementGroup -GroupName $child.Name -Expand -Recurse
                        Get-SubscriptionsRecursive -MgGroup $childMg
                    }
                }
            }
        }

        Get-SubscriptionsRecursive -MgGroup $mgHierarchy
        $subscriptionIds = $script:collectedSubscriptionIds

        if ($subscriptionIds.Count -eq 0) {
            Write-Host "`n  No subscriptions found under Management Group." -ForegroundColor Yellow
            return @()
        }

        Write-Host "  Found $($subscriptionIds.Count) subscription(s). Querying resources..." -ForegroundColor Gray

        $locationCounts = @{}

        foreach ($subId in $subscriptionIds) {
            try {
                $resources = Get-AzResource -DefaultProfile (Set-AzContext -Subscription $subId -WarningAction SilentlyContinue) -ErrorAction SilentlyContinue

                foreach ($resource in $resources) {
                    if ($resource.Location -and $resource.Location -ne 'global') {
                        if (-not $locationCounts.ContainsKey($resource.Location)) {
                            $locationCounts[$resource.Location] = 0
                        }
                        $locationCounts[$resource.Location]++
                    }
                }
            } catch {
                Write-Host "    Skipping subscription $subId (access denied or error)" -ForegroundColor DarkGray
            }
        }

        # Display results
        Write-Host "`n  Discovered Resources by Region:" -ForegroundColor Cyan
        Write-Host "  $('-'*50)" -ForegroundColor DarkGray

        $totalResources = 0
        $regionData = @()

        $sortedLocations = $locationCounts.GetEnumerator() | Sort-Object -Property Value -Descending

        foreach ($entry in $sortedLocations) {
            $location = $entry.Key
            $count = $entry.Value
            $totalResources += $count

            $regionData += [PSCustomObject]@{
                Location = $location
                ResourceCount = $count
            }

            $locationPadded = $location.PadRight(25)
            Write-Host "    $locationPadded $count resources" -ForegroundColor White
        }

        Write-Host "  $('-'*50)" -ForegroundColor DarkGray
        Write-Host "    TOTAL:                    $totalResources resources in $($locationCounts.Count) regions" -ForegroundColor Green

        # Check for conflicting policy assignments
        $conflictResult = Get-ConflictingPolicyAssignments -ManagementGroupId $ManagementGroupId

        # Check for existing diagnostic settings with the same name (collisions)
        $collisionResult = Get-ExistingDiagnosticSettingsCollisions -ManagementGroupId $ManagementGroupId

        # Save inventory to file (including conflict and collision data)
        Save-RegionInventory -RegionData $regionData -ManagementGroupId $ManagementGroupId -TotalResources $totalResources -ConflictData $conflictResult -CollisionData $collisionResult

        if ($UpdateConfiguration) {
            Update-RegionConfiguration -RegionData $regionData
        }

        return $regionData

    } catch {
        Write-Host "`n  ERROR: Failed to enumerate Management Group" -ForegroundColor Red
        Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
        return @()
    }
}

function Update-RegionConfiguration {
    <#
    .SYNOPSIS
        Legacy function - no longer updates azure-parameters.json.
        Regions are now sourced from inventory results, not config file.
    .DESCRIPTION
        This function previously updated the regions array in azure-parameters.json.
        The solution now uses inventory-driven deployments, so this function
        simply displays the inventory results summary.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [array]$RegionData
    )

    # No longer update config - regions come from inventory
    Write-Host "`n  $('-'*50)" -ForegroundColor DarkGray
    Write-Host "  Inventory Summary:" -ForegroundColor Cyan

    Write-Host "`n  Discovered $($RegionData.Count) regions with resources:" -ForegroundColor Green
    foreach ($region in $RegionData) {
        Write-Host "    - $($region.Location): $($region.ResourceCount) resources" -ForegroundColor White
    }

    Write-Host "`n  NOTE: Regions for deployment are now sourced from inventory results." -ForegroundColor Yellow
    Write-Host "  The inventory file (inventory-latest.json) will be used for:" -ForegroundColor Gray
    Write-Host "    - Multi-Region Event Hub Namespace deployment" -ForegroundColor Gray
    Write-Host "    - Multi-Region Policy assignment deployment" -ForegroundColor Gray
}

function Get-ConflictingPolicyAssignments {
    <#
    .SYNOPSIS
        Detects existing policy initiatives that may conflict with this solution.
    .DESCRIPTION
        Queries Azure Policy assignments at the management group scope and identifies
        any existing assignments using the same built-in diagnostic settings policy
        initiatives that this solution uses:
        - AllLogs: 0884adba-2312-4468-abeb-5422caed1038
        - Audit: 2b00397d-c309-49c4-aa5a-f0b2c5bc6321

        Conflicts occur when another assignment of the same initiative exists in an
        overlapping scope (parent, same level, or child management groups/subscriptions).
        Since diagnostic settings use predictable names based on policy definition,
        the first policy to create the setting wins.
    .PARAMETER ManagementGroupId
        The management group ID to check for conflicts.
    .PARAMETER Silent
        If specified, suppresses output and only returns the conflict data.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$ManagementGroupId,

        [Parameter(Mandatory=$false)]
        [switch]$Silent
    )

    # Built-in policy initiative IDs used by this solution
    $policyInitiatives = @{
        # IMPORTANT: These are Event Hub-specific initiatives (not Log Analytics or AMA)
        # Reference: https://www.azadvertizer.net/azpolicyinitiativesadvertizer_all.html
        "AllLogs" = @{
            Id = "85175a36-2f12-419a-96b4-18d5b0096531"
            FullId = "/providers/Microsoft.Authorization/policySetDefinitions/85175a36-2f12-419a-96b4-18d5b0096531"
            Name = "Enable allLogs category group resource logging to Event Hub"
            Description = "Comprehensive logging for 140 resource types"
        }
        "Audit" = @{
            Id = "1020d527-2764-4230-92cc-7035e4fcf8a7"
            FullId = "/providers/Microsoft.Authorization/policySetDefinitions/1020d527-2764-4230-92cc-7035e4fcf8a7"
            Name = "Enable audit category group resource logging to Event Hub"
            Description = "Audit logging for 69 resource types"
        }
    }

    if (-not $Silent) {
        Write-Host "`n  $('-'*50)" -ForegroundColor DarkGray
        Write-Host "  POLICY CONFLICT CHECK" -ForegroundColor Cyan
        Write-Host "  $('-'*50)" -ForegroundColor DarkGray
        Write-Host "  Checking for conflicting policy assignments..." -ForegroundColor Gray
    }

    $conflicts = @{
        AllLogs = @()
        Audit = @()
    }

    $totalConflicts = 0

    try {
        # Get all policy assignments at the management group scope
        $mgScope = "/providers/Microsoft.Management/managementGroups/$ManagementGroupId"

        # Query assignments at the management group level
        $assignments = Get-AzPolicyAssignment -Scope $mgScope -ErrorAction SilentlyContinue

        # Also check parent management groups (hierarchy above our target)
        # These could have policies that cascade down to our scope
        try {
            $mgHierarchy = Get-AzManagementGroup -GroupName $ManagementGroupId -Expand -ErrorAction SilentlyContinue
            if ($mgHierarchy.ParentId) {
                # Extract parent MG name from ID
                $parentMgName = $mgHierarchy.ParentId -replace '.*/managementGroups/', ''
                if ($parentMgName -and $parentMgName -ne "root") {
                    $parentScope = "/providers/Microsoft.Management/managementGroups/$parentMgName"
                    $parentAssignments = Get-AzPolicyAssignment -Scope $parentScope -ErrorAction SilentlyContinue
                    if ($parentAssignments) {
                        $assignments = @($assignments) + @($parentAssignments)
                    }
                }
            }
        } catch {
            # Ignore errors reading parent hierarchy
        }

        # Check each assignment for conflicts
        foreach ($assignment in $assignments) {
            if (-not $assignment.PolicyDefinitionId) { continue }

            # Check if this assignment uses one of our target initiatives
            foreach ($initiative in $policyInitiatives.Keys) {
                $targetId = $policyInitiatives[$initiative].FullId

                if ($assignment.PolicyDefinitionId -eq $targetId) {
                    # Found a potential conflict
                    $conflictInfo = [PSCustomObject]@{
                        AssignmentName = $assignment.Name
                        DisplayName = $assignment.DisplayName
                        Scope = $assignment.Scope
                        ScopeType = if ($assignment.Scope -match '/managementGroups/') { "Management Group" }
                                    elseif ($assignment.Scope -match '/subscriptions/') { "Subscription" }
                                    else { "Unknown" }
                        CreatedOn = $assignment.Metadata.createdOn
                        CreatedBy = $assignment.Metadata.createdBy
                        EnforcementMode = $assignment.EnforcementMode
                        Parameters = $assignment.Parameters
                    }

                    # Check if this is our own assignment (created by this solution)
                    # Our assignments use a predictable naming pattern
                    $isOurAssignment = $false
                    if ($assignment.Name -match "^(allLogs|audit)-(centralized|multiregion)") {
                        $isOurAssignment = $true
                    }
                    if ($assignment.DisplayName -and $assignment.DisplayName -match "Cribl|cribl-diag") {
                        $isOurAssignment = $true
                    }

                    $conflictInfo | Add-Member -NotePropertyName "IsOurAssignment" -NotePropertyValue $isOurAssignment

                    $conflicts[$initiative] += $conflictInfo
                    if (-not $isOurAssignment) {
                        $totalConflicts++
                    }
                }
            }
        }

        # Build result object
        $result = [PSCustomObject]@{
            CheckedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
            ManagementGroupId = $ManagementGroupId
            TotalConflicts = $totalConflicts
            AllLogsConflicts = $conflicts.AllLogs
            AuditConflicts = $conflicts.Audit
            HasConflicts = ($totalConflicts -gt 0)
        }

        if (-not $Silent) {
            if ($totalConflicts -eq 0) {
                Write-Host "`n  Result: " -NoNewline -ForegroundColor White
                Write-Host "NO CONFLICTS DETECTED" -ForegroundColor Green
                Write-Host "  No existing policy assignments found using the same diagnostic" -ForegroundColor Gray
                Write-Host "  settings initiatives (allLogs or audit) in this scope." -ForegroundColor Gray
            } else {
                Write-Host "`n  Result: " -NoNewline -ForegroundColor White
                Write-Host "$totalConflicts CONFLICT(S) DETECTED" -ForegroundColor Red
                Write-Host "`n  $('-'*76)" -ForegroundColor Yellow
                Write-Host "  WARNING: Conflicting policy assignments found!" -ForegroundColor Yellow
                Write-Host "  $('-'*76)" -ForegroundColor Yellow

                Write-Host "`n  Conflicting policies use the same built-in diagnostic settings initiatives." -ForegroundColor White
                Write-Host "  Two constraints apply:" -ForegroundColor White
                Write-Host "`n  1. NAME CONSTRAINT: Diagnostic setting names are determined by the policy" -ForegroundColor Gray
                Write-Host "     definition. The FIRST policy to create a setting wins; later policies skip." -ForegroundColor Gray
                Write-Host "`n  2. CATEGORY/SINK CONSTRAINT (Critical): Azure does NOT allow the same log" -ForegroundColor Yellow
                Write-Host "     category to be sent to two different Event Hubs. Even with different" -ForegroundColor Yellow
                Write-Host "     diagnostic setting names, Azure will reject the second setting." -ForegroundColor Yellow
                Write-Host "     Error: 'Data sinks can't be reused in different settings on the same" -ForegroundColor DarkGray
                Write-Host "     category for the same resource.'" -ForegroundColor DarkGray

                foreach ($initiative in @("AllLogs", "Audit")) {
                    $initiativeConflicts = $conflicts[$initiative] | Where-Object { -not $_.IsOurAssignment }
                    if ($initiativeConflicts.Count -gt 0) {
                        Write-Host "`n  $initiative Initiative Conflicts:" -ForegroundColor Cyan
                        Write-Host "  Initiative: $($policyInitiatives[$initiative].Name)" -ForegroundColor Gray

                        foreach ($conflict in $initiativeConflicts) {
                            Write-Host "`n    Assignment: " -NoNewline -ForegroundColor White
                            Write-Host $conflict.DisplayName -ForegroundColor Yellow
                            Write-Host "      Scope: $($conflict.Scope)" -ForegroundColor Gray
                            Write-Host "      Scope Type: $($conflict.ScopeType)" -ForegroundColor Gray
                            if ($conflict.CreatedOn) {
                                Write-Host "      Created: $($conflict.CreatedOn)" -ForegroundColor DarkGray
                            }

                            # Extract Event Hub info from parameters if available
                            if ($conflict.Parameters -and $conflict.Parameters.eventHubAuthorizationRuleId) {
                                $ehParam = $conflict.Parameters.eventHubAuthorizationRuleId.Value
                                if ($ehParam -match '/namespaces/([^/]+)/') {
                                    Write-Host "      Target Event Hub: $($Matches[1])" -ForegroundColor DarkGray
                                }
                            }
                        }
                    }
                }

                Write-Host "`n  $('-'*76)" -ForegroundColor Yellow
                Write-Host "  IMPACT ASSESSMENT:" -ForegroundColor Yellow

                # Determine overlap type
                $sameScope = $conflicts.AllLogs + $conflicts.Audit | Where-Object {
                    $_.Scope -eq $mgScope -and -not $_.IsOurAssignment
                }
                $parentScope = $conflicts.AllLogs + $conflicts.Audit | Where-Object {
                    $_.Scope -ne $mgScope -and $_.ScopeType -eq "Management Group" -and -not $_.IsOurAssignment
                }

                if ($sameScope.Count -gt 0) {
                    Write-Host "  - SAME SCOPE: $($sameScope.Count) assignment(s) at your target management group" -ForegroundColor Red
                    Write-Host "    These will process resources BEFORE your new assignments" -ForegroundColor Red
                }

                if ($parentScope.Count -gt 0) {
                    Write-Host "  - PARENT SCOPE: $($parentScope.Count) assignment(s) at parent management group(s)" -ForegroundColor Red
                    Write-Host "    These cascade down and will process resources BEFORE your assignments" -ForegroundColor Red
                }

                # Analyze Event Hub targets to determine severity
                $conflictingEventHubs = @()
                $allConflicts = $conflicts.AllLogs + $conflicts.Audit | Where-Object { -not $_.IsOurAssignment }
                foreach ($conflict in $allConflicts) {
                    if ($conflict.Parameters) {
                        # Try different parameter names used by different policy versions
                        $ehParam = $null
                        if ($conflict.Parameters.eventHubAuthorizationRuleId) {
                            $ehParam = $conflict.Parameters.eventHubAuthorizationRuleId.Value
                        } elseif ($conflict.Parameters.resourceLocationEventHubAuthorizationRuleId) {
                            $ehParam = $conflict.Parameters.resourceLocationEventHubAuthorizationRuleId.Value
                        }
                        if ($ehParam -and $ehParam -match '/namespaces/([^/]+)/') {
                            $conflictingEventHubs += $Matches[1]
                        }
                    }
                }
                $conflictingEventHubs = $conflictingEventHubs | Select-Object -Unique

                if ($conflictingEventHubs.Count -gt 0) {
                    Write-Host "`n  - EVENT HUB TARGETS DETECTED:" -ForegroundColor Yellow
                    foreach ($eh in $conflictingEventHubs) {
                        Write-Host "      $eh" -ForegroundColor White
                    }

                    # Load our config to compare
                    $azureParamsFile = Join-Path $PSScriptRoot $Environment "azure-parameters.json"
                    $azParams = Get-Content $azureParamsFile | ConvertFrom-Json
                    $ourPrefix = $azParams.eventHubNamespacePrefix

                    $matchesOurPrefix = $conflictingEventHubs | Where-Object { $_ -like "$ourPrefix*" }
                    if ($matchesOurPrefix.Count -gt 0) {
                        Write-Host "    Some conflict(s) target YOUR Event Hub prefix ($ourPrefix)" -ForegroundColor Green
                        Write-Host "    This likely means you previously deployed this solution." -ForegroundColor Gray
                    } else {
                        Write-Host "    Conflicts target DIFFERENT Event Hubs than yours ($ourPrefix*)" -ForegroundColor Red
                        Write-Host "    WARNING: Azure will reject your diagnostic settings due to" -ForegroundColor Red
                        Write-Host "    category/sink constraint. See recommendations below." -ForegroundColor Red
                    }
                }

                Write-Host "`n  RECOMMENDATIONS:" -ForegroundColor Cyan
                Write-Host "  1. SAME Event Hub target: First policy wins, your deployment will be skipped" -ForegroundColor White
                Write-Host "     for resources already configured. This is usually acceptable." -ForegroundColor Gray
                Write-Host "  2. DIFFERENT Event Hub target: This is problematic. Azure will reject new" -ForegroundColor White
                Write-Host "     settings due to category/sink constraint. Options:" -ForegroundColor Gray
                Write-Host "       a) Remove conflicting policy assignments first" -ForegroundColor Gray
                Write-Host "       b) Use the same Event Hub as the existing policy" -ForegroundColor Gray
                Write-Host "       c) Use Event Hub routing to forward from existing EH to your destination" -ForegroundColor Gray
                Write-Host "  3. Contact owners of existing assignments before making changes" -ForegroundColor White
                Write-Host "  4. Note: Each resource supports max 5 diagnostic settings total" -ForegroundColor DarkGray

                # Show existing assignments that ARE ours
                $ourAssignments = $conflicts.AllLogs + $conflicts.Audit | Where-Object { $_.IsOurAssignment }
                if ($ourAssignments.Count -gt 0) {
                    Write-Host "`n  NOTE: Found $($ourAssignments.Count) assignment(s) likely created by this solution:" -ForegroundColor DarkGray
                    foreach ($ours in $ourAssignments) {
                        Write-Host "    - $($ours.DisplayName) at $($ours.ScopeType)" -ForegroundColor DarkGray
                    }
                }
            }
        }

        return $result

    } catch {
        if (-not $Silent) {
            Write-Host "`n  Result: " -NoNewline -ForegroundColor White
            Write-Host "CHECK FAILED" -ForegroundColor Yellow
            Write-Host "  Could not complete policy conflict check: $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "  Proceeding without conflict data." -ForegroundColor Gray
        }
        return [PSCustomObject]@{
            CheckedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
            ManagementGroupId = $ManagementGroupId
            TotalConflicts = 0
            AllLogsConflicts = @()
            AuditConflicts = @()
            HasConflicts = $false
            Error = $_.Exception.Message
        }
    }
}

function Get-ExistingDiagnosticSettingsCollisions {
    <#
    .SYNOPSIS
        Detects existing diagnostic settings that use the same name as this solution.
    .DESCRIPTION
        Scans resources under the configured management group and identifies any
        diagnostic settings that already use the configured diagnostic setting name
        (default: setbycriblpolicy). This helps identify:
        - Resources already configured by a previous deployment of this solution
        - Resources that would be skipped by the policy (setting already exists)
        - Potential naming collisions with other tools using the same name
    .PARAMETER ManagementGroupId
        The management group ID to scan for diagnostic settings.
    .PARAMETER Silent
        If specified, suppresses output and only returns the collision data.
    .PARAMETER SampleSize
        Maximum number of resources to scan per subscription (default: 100).
        Set to 0 for unlimited (may be slow for large environments).
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$ManagementGroupId,

        [Parameter(Mandatory=$false)]
        [switch]$Silent,

        [Parameter(Mandatory=$false)]
        [int]$SampleSize = 100
    )

    # Load configuration
    $azureParamsFile = Join-Path $PSScriptRoot $Environment "azure-parameters.json"
    $azParams = Get-Content $azureParamsFile | ConvertFrom-Json

    # Get the diagnostic setting name to search for
    $diagSettingName = if ($azParams.diagnosticSettingName) { $azParams.diagnosticSettingName } else { "setbycriblpolicy" }

    if (-not $Silent) {
        Write-Host "`n  $('-'*50)" -ForegroundColor DarkGray
        Write-Host "  DIAGNOSTIC SETTING COLLISION CHECK" -ForegroundColor Cyan
        Write-Host "  $('-'*50)" -ForegroundColor DarkGray
        Write-Host "  Scanning for existing settings named: '$diagSettingName'" -ForegroundColor Gray
    }

    $collisions = @()
    $resourcesScanned = 0
    $subscriptionsProcessed = 0

    try {
        # Get subscriptions under management group
        $mgHierarchy = Get-AzManagementGroup -GroupName $ManagementGroupId -Expand -Recurse -ErrorAction Stop

        $script:collectedSubIds = @()
        function Get-SubsRecursiveForCollision {
            param($MgGroup)
            if ($MgGroup.Children) {
                foreach ($child in $MgGroup.Children) {
                    if ($child.Type -eq "/subscriptions") {
                        $script:collectedSubIds += $child.Name
                    } elseif ($child.Type -eq "/providers/Microsoft.Management/managementGroups") {
                        $childMg = Get-AzManagementGroup -GroupName $child.Name -Expand -Recurse -ErrorAction SilentlyContinue
                        if ($childMg) {
                            Get-SubsRecursiveForCollision -MgGroup $childMg
                        }
                    }
                }
            }
        }

        Get-SubsRecursiveForCollision -MgGroup $mgHierarchy
        $subscriptionIds = $script:collectedSubIds

        if ($subscriptionIds.Count -eq 0) {
            if (-not $Silent) {
                Write-Host "`n  No subscriptions found under Management Group." -ForegroundColor Yellow
            }
            return [PSCustomObject]@{
                CheckedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
                DiagnosticSettingName = $diagSettingName
                TotalCollisions = 0
                ResourcesScanned = 0
                SubscriptionsScanned = 0
                HasCollisions = $false
                Collisions = @()
            }
        }

        if (-not $Silent) {
            Write-Host "  Found $($subscriptionIds.Count) subscription(s) to scan..." -ForegroundColor Gray
        }

        # Scan each subscription for diagnostic settings
        foreach ($subId in $subscriptionIds) {
            $subscriptionsProcessed++
            if (-not $Silent) {
                Write-Host "`r  Scanning subscription $subscriptionsProcessed of $($subscriptionIds.Count)..." -NoNewline -ForegroundColor Gray
            }

            try {
                Set-AzContext -SubscriptionId $subId -WarningAction SilentlyContinue | Out-Null
                $resources = Get-AzResource -ErrorAction SilentlyContinue

                # Apply sample size limit if specified
                if ($SampleSize -gt 0 -and $resources.Count -gt $SampleSize) {
                    $resources = $resources | Select-Object -First $SampleSize
                }

                foreach ($resource in $resources) {
                    $resourcesScanned++

                    try {
                        $diagSettings = Get-AzDiagnosticSetting -ResourceId $resource.ResourceId -ErrorAction SilentlyContinue

                        foreach ($setting in $diagSettings) {
                            if ($setting.Name -eq $diagSettingName) {
                                # Extract Event Hub namespace if configured
                                $eventHubNamespace = "N/A"
                                if ($setting.EventHubAuthorizationRuleId -match "/namespaces/([^/]+)/") {
                                    $eventHubNamespace = $Matches[1]
                                }

                                $collisions += [PSCustomObject]@{
                                    SubscriptionId = $subId
                                    ResourceId = $resource.ResourceId
                                    ResourceName = $resource.Name
                                    ResourceType = $resource.ResourceType
                                    Location = $resource.Location
                                    SettingName = $setting.Name
                                    EventHubNamespace = $eventHubNamespace
                                }
                            }
                        }
                    } catch {
                        # Silently skip resources that don't support diagnostic settings
                    }
                }
            } catch {
                # Silently skip subscriptions with access errors
            }
        }

        if (-not $Silent) {
            Write-Host "`r  Scanned $resourcesScanned resources across $subscriptionsProcessed subscriptions    " -ForegroundColor Gray
        }

        # Build result object
        $result = [PSCustomObject]@{
            CheckedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
            DiagnosticSettingName = $diagSettingName
            TotalCollisions = $collisions.Count
            ResourcesScanned = $resourcesScanned
            SubscriptionsScanned = $subscriptionsProcessed
            HasCollisions = ($collisions.Count -gt 0)
            Collisions = $collisions
        }

        # Group collisions by type for summary
        $byType = $collisions | Group-Object -Property ResourceType

        if (-not $Silent) {
            if ($collisions.Count -eq 0) {
                Write-Host "`n  Result: " -NoNewline -ForegroundColor White
                Write-Host "NO COLLISIONS DETECTED" -ForegroundColor Green
                Write-Host "  No existing diagnostic settings found with name '$diagSettingName'" -ForegroundColor Gray
            } else {
                Write-Host "`n  Result: " -NoNewline -ForegroundColor White
                Write-Host "$($collisions.Count) EXISTING SETTING(S) FOUND" -ForegroundColor Yellow

                Write-Host "`n  $('-'*76)" -ForegroundColor Yellow
                Write-Host "  EXISTING DIAGNOSTIC SETTINGS DETECTED" -ForegroundColor Yellow
                Write-Host "  $('-'*76)" -ForegroundColor Yellow

                Write-Host "`n  Found $($collisions.Count) resource(s) with diagnostic setting '$diagSettingName'" -ForegroundColor White
                Write-Host "  These were likely created by a previous deployment of this solution." -ForegroundColor Gray

                # Show breakdown by resource type
                Write-Host "`n  By Resource Type:" -ForegroundColor Cyan
                foreach ($group in ($byType | Sort-Object -Property Count -Descending)) {
                    Write-Host "    $($group.Name): $($group.Count)" -ForegroundColor White
                }

                # Show breakdown by Event Hub namespace
                $byNamespace = $collisions | Group-Object -Property EventHubNamespace
                Write-Host "`n  By Event Hub Namespace:" -ForegroundColor Cyan
                foreach ($group in ($byNamespace | Sort-Object -Property Count -Descending)) {
                    $nsName = if ($group.Name -eq "N/A") { "(no Event Hub)" } else { $group.Name }
                    Write-Host "    $nsName : $($group.Count)" -ForegroundColor White
                }

                # Show sample resources
                $sampleCount = [Math]::Min(5, $collisions.Count)
                Write-Host "`n  Sample resources with existing settings:" -ForegroundColor Cyan
                for ($i = 0; $i -lt $sampleCount; $i++) {
                    $col = $collisions[$i]
                    Write-Host "    - $($col.ResourceName) ($($col.ResourceType))" -ForegroundColor Gray
                }
                if ($collisions.Count -gt 5) {
                    Write-Host "    ... and $($collisions.Count - 5) more" -ForegroundColor DarkGray
                }

                Write-Host "`n  IMPLICATIONS:" -ForegroundColor Cyan
                Write-Host "  - Policy deployments will SKIP these resources (setting already exists)" -ForegroundColor White
                Write-Host "  - This is expected if you've previously deployed this solution" -ForegroundColor Gray
                Write-Host "  - To re-deploy to these resources, run [R] Remove Settings first" -ForegroundColor Gray
            }
        }

        return $result

    } catch {
        if (-not $Silent) {
            Write-Host "`n  Result: " -NoNewline -ForegroundColor White
            Write-Host "CHECK FAILED" -ForegroundColor Yellow
            Write-Host "  Could not complete collision check: $($_.Exception.Message)" -ForegroundColor Yellow
        }
        return [PSCustomObject]@{
            CheckedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
            DiagnosticSettingName = $diagSettingName
            TotalCollisions = 0
            ResourcesScanned = $resourcesScanned
            SubscriptionsScanned = $subscriptionsProcessed
            HasCollisions = $false
            Collisions = @()
            Error = $_.Exception.Message
        }
    }
}

function Start-AllPolicyRemediation {
    <#
    .SYNOPSIS
        Creates remediation tasks for all policies deployed by this solution.
    .DESCRIPTION
        Discovers all policy assignments created by this solution (matching 'Cribl-*' pattern)
        and creates remediation tasks to apply policies to existing non-compliant resources.

        IMPORTANT: Azure Policy's DeployIfNotExists effect only applies automatically to NEW
        resources. Existing resources require explicit remediation tasks.

        For initiative assignments (policy sets), this function creates separate remediation
        tasks for each policy definition within the initiative that has non-compliant resources.
    .PARAMETER Force
        Skips confirmation prompt (for non-interactive mode).
    .PARAMETER PreviewOnly
        Shows what would be remediated without creating tasks.
    #>
    param(
        [Parameter(Mandatory=$false)]
        [switch]$Force,

        [Parameter(Mandatory=$false)]
        [switch]$PreviewOnly
    )

    Write-Host "`n$('='*80)" -ForegroundColor Cyan
    Write-Host "  POLICY REMEDIATION" -ForegroundColor Cyan
    Write-Host "$('='*80)" -ForegroundColor Cyan

    # Display Microsoft best practices warning
    Write-Host "`n  WARNING: Remediation modifies existing Azure resources" -ForegroundColor Yellow
    Write-Host "  $('-'*76)" -ForegroundColor DarkGray
    Write-Host "  Microsoft Best Practices:" -ForegroundColor White
    Write-Host "  - Remediation creates diagnostic settings on existing resources" -ForegroundColor Gray
    Write-Host "  - Test in a non-production environment first" -ForegroundColor Gray
    Write-Host "  - Review compliance reports before proceeding" -ForegroundColor Gray
    Write-Host "  - Remediation tasks can be cancelled in Azure Portal if needed" -ForegroundColor Gray
    Write-Host "  - Large environments may take time to complete" -ForegroundColor Gray
    Write-Host "  $('-'*76)" -ForegroundColor DarkGray

    # Load configuration
    $azureParamsFile = Join-Path $PSScriptRoot $Environment "azure-parameters.json"
    $azParams = Get-Content $azureParamsFile | ConvertFrom-Json
    $managementGroupId = $azParams.managementGroupId
    $mgScope = "/providers/Microsoft.Management/managementGroups/$managementGroupId"

    Write-Host "`n  Discovering Cribl policy assignments..." -ForegroundColor Cyan
    Write-Host "    Scope: $managementGroupId" -ForegroundColor Gray

    # Get all policy assignments at the management group scope (with retry for transient errors)
    try {
        $allAssignments = @(Invoke-WithRetry -ScriptBlock {
            Get-AzPolicyAssignment -Scope $mgScope -ErrorAction Stop
        } -OperationName "Get policy assignments" -MaxRetries 3 -RetryDelaySeconds 5)
    }
    catch {
        $errorMsg = $_.Exception.Message
        Write-Host "`n  ERROR: Failed to get policy assignments after multiple retries" -ForegroundColor Red
        Write-Host "    $errorMsg" -ForegroundColor Gray

        # Check if this looks like a session expiration
        if ($errorMsg -match "error occurred while sending the request|connection was closed") {
            Write-Host "`n  This may be due to Azure session expiration. Try:" -ForegroundColor Yellow
            Write-Host "    1. Run 'Connect-AzAccount' to re-authenticate" -ForegroundColor Gray
            Write-Host "    2. Then run the remediation again" -ForegroundColor Gray
        }
        return
    }

    # Filter to Cribl assignments
    $criblAssignments = @($allAssignments | Where-Object { $_.Name -like "Cribl-*" })

    if ($criblAssignments.Count -eq 0) {
        Write-Host "`n  No Cribl policy assignments found." -ForegroundColor Yellow
        Write-Host "  Run [1] Deploy All Logging first to create policy assignments." -ForegroundColor Gray
        return
    }

    Write-Host "`n  Found $($criblAssignments.Count) Cribl policy assignment(s)" -ForegroundColor Green
    Write-Host "`n  Querying compliance state (this may take a moment)..." -ForegroundColor Gray

    # Get compliance summary at management group level (includes all assignments)
    $mgSummary = $null
    try {
        $mgSummary = Invoke-WithRetry -ScriptBlock {
            Get-AzPolicyStateSummary -ManagementGroupName $managementGroupId -ErrorAction Stop
        } -OperationName "Get compliance summary" -MaxRetries 3 -RetryDelaySeconds 5
    }
    catch {
        Write-Host "`n  NOTE: Could not get compliance summary: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "  Trying alternative method..." -ForegroundColor Gray
    }

    # Collect all policies needing remediation (including those within initiatives)
    $policiesToRemediate = @()
    $totalNonCompliant = 0

    foreach ($assignment in $criblAssignments) {
        $assignmentId = "$mgScope/providers/Microsoft.Authorization/policyAssignments/$($assignment.Name)"
        $isInitiative = $assignment.PolicyDefinitionId -like "*policySetDefinitions*"

        Write-Host "`n  Assignment: $($assignment.Name)" -ForegroundColor White
        Write-Host "    Type: $(if ($isInitiative) { 'Initiative (Policy Set)' } else { 'Single Policy' })" -ForegroundColor Gray

        # Get compliance summary for this assignment from the management group summary
        try {
            $assignmentSummary = $null

            if ($mgSummary -and $mgSummary.PolicyAssignments) {
                # Find this assignment in the management group summary
                $assignmentSummary = $mgSummary.PolicyAssignments | Where-Object {
                    $_.PolicyAssignmentId -eq $assignmentId
                }
            }

            if (-not $assignmentSummary) {
                # Fallback: Query directly using subscription scope with filter (with retry)
                # Get all policy states for this assignment
                $assignmentName = $assignment.Name
                $states = @(Invoke-WithRetry -ScriptBlock {
                    Get-AzPolicyState -ManagementGroupName $managementGroupId `
                        -Filter "policyAssignmentName eq '$assignmentName' and complianceState eq 'NonCompliant'" `
                        -ErrorAction Stop
                } -OperationName "Get policy states for $assignmentName" -MaxRetries 3 -RetryDelaySeconds 5)

                if ($states.Count -gt 0) {
                    # Group by policy definition for initiatives
                    if ($isInitiative) {
                        $groupedStates = $states | Group-Object PolicyDefinitionReferenceId

                        Write-Host "    Policies with non-compliant resources: $($groupedStates.Count)" -ForegroundColor Yellow

                        foreach ($group in $groupedStates) {
                            $resourceCount = $group.Count
                            $firstState = $group.Group[0]
                            $policyName = if ($firstState.PolicyDefinitionName) {
                                $firstState.PolicyDefinitionName
                            } else {
                                ($firstState.PolicyDefinitionId -split '/')[-1]
                            }
                            $policyRefId = $group.Name

                            Write-Host "      - $policyName : " -NoNewline -ForegroundColor Gray
                            Write-Host "$resourceCount resources" -ForegroundColor Red

                            $policiesToRemediate += @{
                                AssignmentName = $assignment.Name
                                AssignmentId = $assignmentId
                                PolicyDefinitionReferenceId = $policyRefId
                                PolicyDefinitionId = $firstState.PolicyDefinitionId
                                PolicyName = $policyName
                                NonCompliantResources = $resourceCount
                                IsInitiative = $true
                            }
                            $totalNonCompliant += $resourceCount
                        }
                    }
                    else {
                        # Single policy
                        $resourceCount = $states.Count
                        Write-Host "    Non-compliant resources: " -NoNewline -ForegroundColor Gray
                        Write-Host "$resourceCount" -ForegroundColor Red

                        $policiesToRemediate += @{
                            AssignmentName = $assignment.Name
                            AssignmentId = $assignmentId
                            PolicyDefinitionReferenceId = $null
                            PolicyDefinitionId = $assignment.PolicyDefinitionId
                            PolicyName = $assignment.Name
                            NonCompliantResources = $resourceCount
                            IsInitiative = $false
                        }
                        $totalNonCompliant += $resourceCount
                    }
                }
                else {
                    Write-Host "    Status: " -NoNewline -ForegroundColor Gray
                    Write-Host "Compliant or not yet evaluated" -ForegroundColor Green
                }
            }
            else {
                # Use the summary data
                if ($isInitiative -and $assignmentSummary.PolicyDefinitions) {
                    $nonCompliantPolicies = @($assignmentSummary.PolicyDefinitions | Where-Object {
                        $_.Results.NonCompliantResources -gt 0
                    })

                    if ($nonCompliantPolicies.Count -gt 0) {
                        Write-Host "    Policies with non-compliant resources: $($nonCompliantPolicies.Count)" -ForegroundColor Yellow

                        foreach ($policyDef in $nonCompliantPolicies) {
                            $resourceCount = $policyDef.Results.NonCompliantResources
                            $policyName = ($policyDef.PolicyDefinitionId -split '/')[-1]

                            Write-Host "      - $policyName : " -NoNewline -ForegroundColor Gray
                            Write-Host "$resourceCount resources" -ForegroundColor Red

                            $policiesToRemediate += @{
                                AssignmentName = $assignment.Name
                                AssignmentId = $assignmentId
                                PolicyDefinitionReferenceId = $policyDef.PolicyDefinitionReferenceId
                                PolicyDefinitionId = $policyDef.PolicyDefinitionId
                                PolicyName = $policyName
                                NonCompliantResources = $resourceCount
                                IsInitiative = $true
                            }
                            $totalNonCompliant += $resourceCount
                        }
                    }
                    else {
                        Write-Host "    All policies compliant or not yet evaluated" -ForegroundColor Green
                    }
                }
                else {
                    # Single policy assignment from summary
                    $nonCompliant = if ($assignmentSummary.Results) { $assignmentSummary.Results.NonCompliantResources } else { 0 }

                    if ($nonCompliant -gt 0) {
                        Write-Host "    Non-compliant resources: " -NoNewline -ForegroundColor Gray
                        Write-Host "$nonCompliant" -ForegroundColor Red

                        $policiesToRemediate += @{
                            AssignmentName = $assignment.Name
                            AssignmentId = $assignmentId
                            PolicyDefinitionReferenceId = $null
                            PolicyDefinitionId = $assignment.PolicyDefinitionId
                            PolicyName = $assignment.Name
                            NonCompliantResources = $nonCompliant
                            IsInitiative = $false
                        }
                        $totalNonCompliant += $nonCompliant
                    }
                    else {
                        Write-Host "    Status: " -NoNewline -ForegroundColor Gray
                        Write-Host "Compliant or not yet evaluated" -ForegroundColor Green
                    }
                }
            }
        }
        catch {
            $errMsg = $_.Exception.Message
            Write-Host "    ERROR getting compliance: $errMsg" -ForegroundColor Red
            if ($errMsg -match "error occurred while sending the request|connection was closed") {
                Write-Host "    (Connection issue - will continue with other assignments)" -ForegroundColor Yellow
            }
        }
    }

    # Summary
    Write-Host "`n  $('-'*76)" -ForegroundColor DarkGray
    Write-Host "  Summary:" -ForegroundColor Cyan
    Write-Host "    Policies requiring remediation: $($policiesToRemediate.Count)" -ForegroundColor White
    Write-Host "    Total non-compliant resources:  $totalNonCompliant" -ForegroundColor White

    if ($policiesToRemediate.Count -eq 0) {
        Write-Host "`n  All resources are compliant or compliance not yet evaluated." -ForegroundColor Green
        Write-Host "  Note: Compliance evaluation can take 15-30 minutes after policy assignment." -ForegroundColor Gray
        return
    }

    if ($PreviewOnly) {
        Write-Host "`n  PREVIEW MODE - No changes will be made" -ForegroundColor Yellow
        Write-Host "`n  Would create $($policiesToRemediate.Count) remediation task(s):" -ForegroundColor Cyan
        foreach ($policy in $policiesToRemediate) {
            if ($policy.IsInitiative) {
                Write-Host "    - $($policy.AssignmentName) / $($policy.PolicyName) ($($policy.NonCompliantResources) resources)" -ForegroundColor White
            }
            else {
                Write-Host "    - $($policy.PolicyName) ($($policy.NonCompliantResources) resources)" -ForegroundColor White
            }
        }
        return
    }

    # Confirmation prompt
    if (-not $Force) {
        Write-Host "`n  This will create $($policiesToRemediate.Count) remediation task(s)." -ForegroundColor Yellow
        Write-Host "  Remediation will modify existing Azure resources to add diagnostic settings." -ForegroundColor Yellow
        $confirm = Read-Host "`n  Do you want to proceed? (Y/N)"
        if ($confirm -ne 'Y') {
            Write-Host "`n  Remediation cancelled." -ForegroundColor Gray
            return
        }
    }

    # Create remediation tasks
    Write-Host "`n  Creating remediation tasks..." -ForegroundColor Cyan
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $successCount = 0
    $failCount = 0

    foreach ($policy in $policiesToRemediate) {
        # Generate unique remediation name (max 64 chars)
        $shortPolicyName = if ($policy.PolicyName.Length -gt 20) {
            $policy.PolicyName.Substring(0, 20)
        } else {
            $policy.PolicyName
        }
        $remediationName = "Rem-$shortPolicyName-$timestamp"
        if ($remediationName.Length -gt 64) {
            $remediationName = $remediationName.Substring(0, 64)
        }

        Write-Host "`n    Policy: $($policy.PolicyName)" -ForegroundColor White
        Write-Host "      Assignment: $($policy.AssignmentName)" -ForegroundColor Gray
        Write-Host "      Resources to remediate: $($policy.NonCompliantResources)" -ForegroundColor Gray

        try {
            # Note: At management group scope, only "ExistingNonCompliant" mode is supported
            # "ReEvaluateCompliance" is only available at subscription scope and below
            $remediationParams = @{
                Name = $remediationName
                PolicyAssignmentId = $policy.AssignmentId
                Scope = $mgScope
                ResourceDiscoveryMode = "ExistingNonCompliant"
                ErrorAction = "Stop"
            }

            # For initiatives, specify the policy definition reference ID
            if ($policy.IsInitiative -and $policy.PolicyDefinitionReferenceId) {
                $remediationParams.PolicyDefinitionReferenceId = $policy.PolicyDefinitionReferenceId
            }

            # Create remediation task with retry for transient errors
            $remediation = Invoke-WithRetry -ScriptBlock {
                Start-AzPolicyRemediation @remediationParams
            } -OperationName "Create remediation for $($policy.PolicyName)" -MaxRetries 3 -RetryDelaySeconds 5

            Write-Host "      Task created: $remediationName" -ForegroundColor Green
            Write-Host "      Status: $($remediation.ProvisioningState)" -ForegroundColor Gray
            $successCount++
        }
        catch {
            if ($_.Exception.Message -like "*no resources*" -or $_.Exception.Message -like "*nothing to remediate*") {
                Write-Host "      No resources require remediation" -ForegroundColor DarkGray
            }
            elseif ($_.Exception.Message -match "error occurred while sending the request|connection was closed") {
                Write-Host "      ERROR: Connection error after retries - $($_.Exception.Message)" -ForegroundColor Red
                Write-Host "      Try re-running after: Connect-AzAccount" -ForegroundColor Yellow
                $failCount++
            }
            else {
                Write-Host "      ERROR: $($_.Exception.Message)" -ForegroundColor Red
                $failCount++
            }
        }
    }

    # Final summary
    Write-Host "`n  $('='*76)" -ForegroundColor Green
    Write-Host "  REMEDIATION COMPLETE" -ForegroundColor Green
    Write-Host "  $('='*76)" -ForegroundColor Green
    Write-Host "`n  Results:" -ForegroundColor White
    Write-Host "    Tasks created: $successCount" -ForegroundColor Green
    if ($failCount -gt 0) {
        Write-Host "    Tasks failed:  $failCount" -ForegroundColor Red
    }

    Write-Host "`n  Next Steps:" -ForegroundColor Yellow
    Write-Host "    1. Monitor progress: Azure Portal > Policy > Remediation > Remediation tasks" -ForegroundColor Gray
    Write-Host "    2. Large environments may take several hours to complete" -ForegroundColor Gray
    Write-Host "    3. Re-run this option to check for remaining non-compliant resources" -ForegroundColor Gray
}

function Remove-DiagnosticSettings {
    <#
    .SYNOPSIS
        Removes diagnostic settings created by this solution.
    .DESCRIPTION
        Scans all resources under the configured management group and removes
        diagnostic settings created by this solution.

        Matching is done by diagnostic setting NAME (configured in azure-parameters.json
        as 'diagnosticSettingName', default: setbycriblpolicy). This unique name ensures
        only settings created by this solution are affected.

        Settings from other Azure Policy assignments (which use different names like
        'setbypolicy' or 'setByPolicy-EventHub') are NOT affected.
    .PARAMETER PreviewOnly
        If specified, only shows what would be deleted without making changes.
    .PARAMETER Force
        If specified, skips confirmation prompt (for non-interactive mode).
    #>
    param(
        [Parameter(Mandatory=$false)]
        [switch]$PreviewOnly,

        [Parameter(Mandatory=$false)]
        [switch]$Force
    )

    Write-Host "`n$('='*80)" -ForegroundColor Red
    Write-Host "  REMOVE DIAGNOSTIC SETTINGS" -ForegroundColor Red
    Write-Host "$('='*80)" -ForegroundColor Red

    # Load configuration
    $azureParamsFile = Join-Path $PSScriptRoot $Environment "azure-parameters.json"
    $azParams = Get-Content $azureParamsFile | ConvertFrom-Json

    $managementGroupId = $azParams.managementGroupId

    # Get the diagnostic setting name from config (this is the matching criteria)
    $diagSettingName = if ($azParams.diagnosticSettingName) { $azParams.diagnosticSettingName } else { "setbycriblpolicy" }

    Write-Host "`n  Configuration:" -ForegroundColor Cyan
    Write-Host "    Management Group: $managementGroupId" -ForegroundColor White
    Write-Host "    Diagnostic Setting Name: $diagSettingName" -ForegroundColor Green

    Write-Host "`n  Matching Criteria:" -ForegroundColor Cyan
    Write-Host "    Diagnostic setting name = '$diagSettingName'" -ForegroundColor Green

    Write-Host "`n  This matching ensures:" -ForegroundColor Green
    Write-Host "    - Only diagnostic settings created by THIS solution are affected" -ForegroundColor Green
    Write-Host "    - Settings from other Azure Policy assignments are NOT affected" -ForegroundColor Green
    Write-Host "    - Settings with names like 'setbypolicy' or 'setByPolicy-EventHub' are NOT affected" -ForegroundColor Green

    # Get subscriptions under management group
    Write-Host "`n  Enumerating subscriptions under Management Group..." -ForegroundColor Gray

    try {
        $mgHierarchy = Get-AzManagementGroup -GroupName $managementGroupId -Expand -Recurse -ErrorAction Stop

        $script:collectedSubIds = @()
        function Get-SubsRecursive {
            param($MgGroup)
            if ($MgGroup.Children) {
                foreach ($child in $MgGroup.Children) {
                    if ($child.Type -eq "/subscriptions") {
                        $script:collectedSubIds += $child.Name
                    } elseif ($child.Type -eq "/providers/Microsoft.Management/managementGroups") {
                        $childMg = Get-AzManagementGroup -GroupName $child.Name -Expand -Recurse
                        Get-SubsRecursive -MgGroup $childMg
                    }
                }
            }
        }

        Get-SubsRecursive -MgGroup $mgHierarchy
        $subscriptionIds = $script:collectedSubIds

        if ($subscriptionIds.Count -eq 0) {
            Write-Host "`n  No subscriptions found under Management Group." -ForegroundColor Yellow
            return
        }

        Write-Host "  Found $($subscriptionIds.Count) subscription(s)" -ForegroundColor Green

    } catch {
        Write-Host "`n  ERROR: Failed to enumerate Management Group: $($_.Exception.Message)" -ForegroundColor Red
        return
    }

    # Scan for diagnostic settings
    Write-Host "`n  Scanning resources for diagnostic settings..." -ForegroundColor Cyan
    Write-Host "  (This may take several minutes for large environments)" -ForegroundColor Gray

    $diagnosticSettingsToRemove = @()
    $resourcesScanned = 0
    $subscriptionsProcessed = 0

    foreach ($subId in $subscriptionIds) {
        $subscriptionsProcessed++
        Write-Host "`r  Processing subscription $subscriptionsProcessed of $($subscriptionIds.Count)..." -NoNewline -ForegroundColor Gray

        try {
            Set-AzContext -SubscriptionId $subId -WarningAction SilentlyContinue | Out-Null
            $resources = Get-AzResource -ErrorAction SilentlyContinue

            foreach ($resource in $resources) {
                $resourcesScanned++

                try {
                    $diagSettings = Get-AzDiagnosticSetting -ResourceId $resource.ResourceId -ErrorAction SilentlyContinue

                    foreach ($setting in $diagSettings) {
                        # Match by diagnostic setting name
                        if ($setting.Name -eq $diagSettingName) {
                            # Extract Event Hub namespace if configured (for display)
                            $matchedNamespace = "N/A"
                            if ($setting.EventHubAuthorizationRuleId -match "/namespaces/([^/]+)/") {
                                $matchedNamespace = $Matches[1]
                            }

                            $diagnosticSettingsToRemove += [PSCustomObject]@{
                                SubscriptionId = $subId
                                ResourceId = $resource.ResourceId
                                ResourceName = $resource.Name
                                ResourceType = $resource.ResourceType
                                SettingName = $setting.Name
                                EventHubNamespace = $matchedNamespace
                            }
                        }
                    }
                } catch {
                    # Silently skip resources that don't support diagnostic settings
                }
            }
        } catch {
            Write-Host "`n    Skipping subscription $subId (access denied or error)" -ForegroundColor DarkGray
        }
    }

    Write-Host "`r  Scanned $resourcesScanned resources across $($subscriptionIds.Count) subscriptions    " -ForegroundColor Green

    # Display results
    if ($diagnosticSettingsToRemove.Count -eq 0) {
        Write-Host "`n  No diagnostic settings found matching this solution's criteria:" -ForegroundColor Green
        Write-Host "    Diagnostic Setting Name: $diagSettingName" -ForegroundColor Gray
        Write-Host "`n  Nothing to remove." -ForegroundColor Gray
        return
    }

    Write-Host "`n  Found $($diagnosticSettingsToRemove.Count) diagnostic settings to remove:" -ForegroundColor Yellow
    Write-Host "  $('-'*76)" -ForegroundColor DarkGray

    # Group by resource type for summary
    $byType = $diagnosticSettingsToRemove | Group-Object -Property ResourceType
    foreach ($group in $byType) {
        Write-Host "    $($group.Name): $($group.Count) settings" -ForegroundColor White
    }

    Write-Host "  $('-'*76)" -ForegroundColor DarkGray

    # Show detailed list (first 20)
    $showCount = [Math]::Min(20, $diagnosticSettingsToRemove.Count)
    Write-Host "`n  First $showCount diagnostic settings:" -ForegroundColor Cyan

    for ($i = 0; $i -lt $showCount; $i++) {
        $ds = $diagnosticSettingsToRemove[$i]
        Write-Host "    [$($i+1)] $($ds.ResourceName) ($($ds.ResourceType))" -ForegroundColor White
        Write-Host "        Setting: $($ds.SettingName) | Event Hub: $($ds.EventHubNamespace)" -ForegroundColor Gray
    }

    if ($diagnosticSettingsToRemove.Count -gt 20) {
        Write-Host "    ... and $($diagnosticSettingsToRemove.Count - 20) more" -ForegroundColor DarkGray
    }

    if ($PreviewOnly) {
        Write-Host "`n  PREVIEW MODE - No changes made" -ForegroundColor Yellow
        return
    }

    # Confirmation
    if (-not $Force) {
        Write-Host "`n$('='*80)" -ForegroundColor Red
        Write-Host "  WARNING: This action cannot be undone!" -ForegroundColor Red
        Write-Host "  Resources will stop sending logs to Event Hub immediately." -ForegroundColor Red
        Write-Host "$('='*80)" -ForegroundColor Red

        $response = Read-Host "`n  Type 'DELETE' to confirm removal of $($diagnosticSettingsToRemove.Count) diagnostic settings"
        if ($response -ne 'DELETE') {
            Write-Host "`n  Operation cancelled." -ForegroundColor Yellow
            return
        }
    }

    # Remove diagnostic settings
    Write-Host "`n  Removing diagnostic settings..." -ForegroundColor Cyan

    $removed = 0
    $failed = 0
    $currentSub = ""

    foreach ($ds in $diagnosticSettingsToRemove) {
        if ($ds.SubscriptionId -ne $currentSub) {
            Set-AzContext -SubscriptionId $ds.SubscriptionId -WarningAction SilentlyContinue | Out-Null
            $currentSub = $ds.SubscriptionId
        }

        try {
            Remove-AzDiagnosticSetting -ResourceId $ds.ResourceId -Name $ds.SettingName -ErrorAction Stop
            $removed++
            Write-Host "    Removed: $($ds.ResourceName) / $($ds.SettingName)" -ForegroundColor Green
        } catch {
            $failed++
            Write-Host "    FAILED: $($ds.ResourceName) / $($ds.SettingName) - $($_.Exception.Message)" -ForegroundColor Red
        }
    }

    # Summary
    Write-Host "`n$('='*80)" -ForegroundColor Cyan
    Write-Host "  REMOVAL SUMMARY" -ForegroundColor Cyan
    Write-Host "$('='*80)" -ForegroundColor Cyan
    Write-Host "    Diagnostic settings removed: $removed" -ForegroundColor Green
    if ($failed -gt 0) {
        Write-Host "    Failed to remove: $failed" -ForegroundColor Red
    }
    Write-Host "`n  NOTE: Policy assignments are not removed. Resources may get new diagnostic" -ForegroundColor Yellow
    Write-Host "  settings if policies are still assigned. Use Azure Portal or CLI to remove" -ForegroundColor Yellow
    Write-Host "  policy assignments if you want to prevent recreation." -ForegroundColor Yellow
}

function Show-DeploymentConfirmation {
    param(
        [string]$Action,
        [string]$Description,
        [string]$SelectedDeploymentMode
    )

    # Validate Azure connection before showing confirmation
    Write-Host "`n  Validating Azure connection..." -ForegroundColor Gray
    if (-not (Ensure-AzureConnection -Environment $Environment)) {
        Write-Host "`n  ERROR: Azure connection validation failed!" -ForegroundColor Red
        Write-Host "  Cannot proceed with deployment." -ForegroundColor Yellow
        return $false
    }

    $azureParamsFile = Join-Path $PSScriptRoot $Environment "azure-parameters.json"
    $azParams = Get-Content $azureParamsFile | ConvertFrom-Json

    # Validate management group exists
    Write-Host "  Validating management group..." -ForegroundColor Gray
    if (-not (Test-ManagementGroupExists -ManagementGroupId $azParams.managementGroupId)) {
        Write-Host "`n  ERROR: Management group validation failed!" -ForegroundColor Red
        Write-Host "  Cannot proceed with deployment." -ForegroundColor Yellow
        return $false
    }

    Write-Host "`n$('='*80)" -ForegroundColor Yellow
    Write-Host "  DEPLOYMENT CONFIRMATION" -ForegroundColor Yellow
    Write-Host "$('='*80)" -ForegroundColor Yellow
    Write-Host "`n  Action: $Action" -ForegroundColor Cyan
    Write-Host "  $Description" -ForegroundColor White

    # Show namespace mode
    $useExisting = Get-EffectiveUseExistingNamespaces
    Write-Host "`n  Namespace Mode: " -NoNewline -ForegroundColor Cyan
    if ($useExisting) {
        Write-Host "USE EXISTING" -ForegroundColor Yellow
    } else {
        Write-Host "CREATE NEW" -ForegroundColor Green
    }

    Write-Host "  Deployment Mode: $SelectedDeploymentMode" -ForegroundColor Cyan

    Write-Host "`n  Target:" -ForegroundColor Cyan
    Write-Host "    Management Group: $($azParams.managementGroupId)" -ForegroundColor White

    if ($SelectedDeploymentMode -eq "Centralized") {
        Write-Host "    Centralized Region: $($azParams.centralizedRegion)" -ForegroundColor White
        $namespaceName = Get-EffectiveNamespaceName -Region $azParams.centralizedRegion -Mode "Centralized"
        Write-Host "    Namespace: $namespaceName" -ForegroundColor White
    } else {
        # Get regions from inventory
        $inventory = Get-InventoryData -Silent
        if ($inventory -and $inventory.Regions) {
            $inventoryRegions = $inventory.Regions
            Write-Host "    Regions (from inventory): $($inventoryRegions.Location -join ', ')" -ForegroundColor White
            Write-Host "    Namespaces:" -ForegroundColor White
            foreach ($region in $inventoryRegions) {
                $namespaceName = Get-EffectiveNamespaceName -Region $region.Location -Mode "MultiRegion"
                Write-Host "      $($region.Location): $namespaceName" -ForegroundColor Gray
            }
        } else {
            Write-Host "    Regions: (no inventory - run [I] first)" -ForegroundColor Red
        }
    }

    # Check for policy conflicts and warn user
    $inventory = Get-InventoryData -Silent
    if ($inventory -and $inventory.PSObject.Properties.Name -contains 'PolicyConflicts' -and $null -ne $inventory.PolicyConflicts -and $inventory.PolicyConflicts.HasConflicts) {
        Write-Host "`n$('='*80)" -ForegroundColor Red
        Write-Host "  POLICY CONFLICT WARNING" -ForegroundColor Red
        Write-Host "$('='*80)" -ForegroundColor Red
        Write-Host "  $($inventory.PolicyConflicts.TotalConflicts) conflicting policy assignment(s) detected!" -ForegroundColor Red
        Write-Host "  Some resources may already have diagnostic settings from other policies." -ForegroundColor Yellow
        Write-Host "  Re-run [I] Inventory to see conflict details." -ForegroundColor Yellow
    }

    Write-Host "$('='*80)" -ForegroundColor Yellow

    $response = Read-Host "`n  Do you want to proceed? (Y/N)"
    return ($response -eq 'Y' -or $response -eq 'y')
}

#region Resource Coverage Configuration

function Get-ResourceCoverage {
    <#
    .SYNOPSIS
        Loads the resource coverage configuration from resource-coverage.json.
    .DESCRIPTION
        Reads the resource-coverage.json file which defines which resources
        should have logging enabled and what method to use for each.
    #>
    param(
        [switch]$Silent
    )

    $coverageFile = Get-SolutionPath -PathKey 'ResourceCoverageFile'

    if (-not (Test-Path $coverageFile)) {
        if (-not $Silent) {
            Write-Host "  WARNING: $($script:PathConfig.ResourceCoverageFile) not found at: $coverageFile" -ForegroundColor Yellow
            Write-Host "  Using default configuration (all logging enabled)." -ForegroundColor Gray
        }
        return $null
    }

    try {
        $coverage = Get-Content $coverageFile -Raw | ConvertFrom-Json
        return $coverage
    } catch {
        if (-not $Silent) {
            Write-Host "  ERROR: Failed to parse $($script:PathConfig.ResourceCoverageFile): $($_.Exception.Message)" -ForegroundColor Red
        }
        return $null
    }
}

function Show-ResourceCoverageStatus {
    <#
    .SYNOPSIS
        Displays the current resource coverage configuration status.
    #>
    $coverage = Get-ResourceCoverage -Silent

    if (-not $coverage) {
        Write-Host "  Resource Coverage: Default (all enabled)" -ForegroundColor Yellow
        return
    }

    Write-Host "`n  RESOURCE COVERAGE CONFIGURATION" -ForegroundColor Cyan
    Write-Host "  $('-'*50)" -ForegroundColor DarkGray

    # Deployment settings
    $mode = $coverage.deploymentSettings.mode
    Write-Host "  Mode: $mode | Initiative: Audit (69 resource types)" -ForegroundColor White

    # Count enabled vs disabled
    $enabledCount = 0
    $disabledCount = 0

    # Built-in policies
    if ($coverage.builtInPolicies.diagnosticSettingsInitiative.enabled) {
        $enabledCount++
        Write-Host "  [X] Built-in Audit Initiative (69 types)" -ForegroundColor Green
    } else {
        $disabledCount++
        Write-Host "  [ ] Built-in Audit Initiative (69 types)" -ForegroundColor DarkGray
    }

    # Community Policy Initiative
    if ($coverage.communityPolicyInitiative -and $coverage.communityPolicyInitiative.enabled) {
        $enabledCount++
        $tiers = if ($coverage.communityPolicyInitiative.tiers.selected -contains "All") { "All tiers" } else { $coverage.communityPolicyInitiative.tiers.selected -join ", " }
        Write-Host "  [X] Community Initiative (44 types - $tiers)" -ForegroundColor Green
    } elseif ($coverage.communityPolicyInitiative) {
        $disabledCount++
        Write-Host "  [ ] Community Initiative (44 types)" -ForegroundColor DarkGray
    }

    # Supplemental policies (Activity Log only - Storage is in Community Initiative)
    foreach ($prop in $coverage.supplementalPolicies.PSObject.Properties) {
        if ($prop.Name -notlike "_*") {
            if ($prop.Value.enabled) {
                $enabledCount++
                Write-Host "  [X] $($prop.Name)" -ForegroundColor Green
            } else {
                $disabledCount++
                Write-Host "  [ ] $($prop.Name)" -ForegroundColor DarkGray
            }
        }
    }

    # Script-based
    foreach ($prop in $coverage.scriptBasedDeployment.PSObject.Properties) {
        if ($prop.Name -notlike "_*") {
            if ($prop.Value.enabled) {
                $enabledCount++
                Write-Host "  [X] $($prop.Name) (script)" -ForegroundColor Green
            } else {
                $disabledCount++
                Write-Host "  [ ] $($prop.Name) (script)" -ForegroundColor DarkGray
            }
        }
    }

    # Defender XDR Streaming
    if ($coverage.defenderXDR -and $coverage.defenderXDR.xdrStreaming) {
        if ($coverage.defenderXDR.xdrStreaming.enabled) {
            $enabledCount++
            Write-Host "  [X] xdrStreaming (guided-portal)" -ForegroundColor Green
        } else {
            $disabledCount++
            Write-Host "  [ ] xdrStreaming (guided-portal)" -ForegroundColor DarkGray
        }
    }

    Write-Host "  $('-'*50)" -ForegroundColor DarkGray
    Write-Host "  Enabled: $enabledCount | Disabled: $disabledCount" -ForegroundColor White
}

function Deploy-AllEnabledLogging {
    <#
    .SYNOPSIS
        Deploys all logging components that are enabled in resource-coverage.json.
    .DESCRIPTION
        Reads resource-coverage.json and deploys:
        - Event Hub infrastructure
        - Built-in policy initiatives (if enabled)
        - Supplemental policies (Storage, Activity Log)
        - Custom policies (Table Services)
        - Script-based deployments (Entra ID, Defender)
    #>
    param(
        [switch]$Force
    )

    $coverage = Get-ResourceCoverage

    if (-not $coverage) {
        Write-Host "  No resource-coverage.json found. Please configure first." -ForegroundColor Red
        return $false
    }

    # Get deployment settings
    $mode = $coverage.deploymentSettings.mode

    Write-Host "`n$('='*80)" -ForegroundColor Cyan
    Write-Host "  DEPLOYING ALL ENABLED LOGGING COMPONENTS" -ForegroundColor Cyan
    Write-Host "$('='*80)" -ForegroundColor Cyan

    # Check for multi-region inventory requirement
    if ($mode -eq "MultiRegion" -and -not (Test-InventoryExists)) {
        Write-Host "`n  ERROR: Multi-Region mode requires inventory!" -ForegroundColor Red
        Write-Host "  Please run Inventory first to discover regions with resources." -ForegroundColor Yellow
        return $false
    }

    # Show what will be deployed
    Show-ResourceCoverageStatus

    if (-not $Force) {
        $response = Read-Host "`n  Deploy all enabled components? (Y/N)"
        if ($response -ne 'Y' -and $response -ne 'y') {
            Write-Host "  Deployment cancelled." -ForegroundColor Yellow
            return $false
        }
    }

    $stepNumber = 1
    $totalSteps = 0
    $overrides = Get-OverrideParameters

    # Count total steps
    if ($coverage.builtInPolicies.diagnosticSettingsInitiative.enabled) { $totalSteps += 2 }  # Namespace + Policy
    if ($coverage.communityPolicyInitiative -and $coverage.communityPolicyInitiative.enabled) { $totalSteps++ }  # Community Initiative
    if ($coverage.supplementalPolicies.activityLog.enabled) { $totalSteps++ }  # Activity Log
    if ($coverage.scriptBasedDeployment.entraId.enabled) { $totalSteps++ }
    if ($coverage.scriptBasedDeployment.defenderExport.enabled) { $totalSteps++ }
    if ($coverage.defenderXDR.xdrStreaming.enabled) { $totalSteps++ }

    $logFile = Initialize-DeploymentLogging -OperationType "DeployAll"
    if ($logFile) {
        Write-Host "`n  Log file: $logFile" -ForegroundColor DarkGray
    }

    # Step 1: Deploy Event Hub infrastructure (if built-in initiative is enabled)
    if ($coverage.builtInPolicies.diagnosticSettingsInitiative.enabled) {
        Write-Host "`n  Step $stepNumber/$totalSteps`: Deploying Event Hub Namespace(s) ($mode)..." -ForegroundColor Magenta
        & $NamespaceScript -DeploymentMode $mode @overrides
        $stepNumber++

        # Step 2: Deploy built-in Audit initiative
        Write-Host "`n  Step $stepNumber/$totalSteps`: Deploying Built-in Audit initiative (69 types)..." -ForegroundColor Green
        & $PolicyScript -LoggingMode "Audit" -DeploymentMode $mode @overrides
        $stepNumber++
    }

    # Step 3: Deploy Community Policy Initiative (44 policies total)
    if ($coverage.communityPolicyInitiative -and $coverage.communityPolicyInitiative.enabled) {
        Write-Host "`n  Step $stepNumber/$totalSteps`: Deploying Community Policy Initiative (44 types)..." -ForegroundColor Cyan
        $CommunityScript = Get-SolutionPath -PathKey 'CommunityInitiativeScript'
        if (Test-Path $CommunityScript) {
            # Get selected tiers
            $selectedTiers = $coverage.communityPolicyInitiative.tiers.selected
            if ($selectedTiers -contains "All") {
                & $CommunityScript -DeploymentMode $mode -DebugLogging:$DebugLogging.IsPresent
            } else {
                & $CommunityScript -DeploymentMode $mode -PolicyTiers $selectedTiers -DebugLogging:$DebugLogging.IsPresent
            }
        } else {
            Write-Host "  WARNING: $($script:PathConfig.CommunityInitiativeScript) not found - skipping" -ForegroundColor Yellow
        }
        $stepNumber++
    }

    # Step 4: Deploy Activity Log policy (subscription-level, separate from initiatives)
    if ($coverage.supplementalPolicies.activityLog.enabled) {
        Write-Host "`n  Step $stepNumber/$totalSteps`: Deploying Activity Log policy..." -ForegroundColor Magenta
        & $SupplementalScript -DeploymentMode $mode -ActivityLogOnly -DebugLogging:$DebugLogging.IsPresent @overrides
        $stepNumber++
    }

    # Step 5: Deploy Entra ID diagnostics
    if ($coverage.scriptBasedDeployment.entraId.enabled) {
        Write-Host "`n  Step $stepNumber/$totalSteps`: Deploying Entra ID diagnostic settings..." -ForegroundColor Blue
        $EntraIDScript = Get-SolutionPath -PathKey 'EntraIDScript'

        $profile = $coverage.scriptBasedDeployment.entraId.profile
        if ($profile -eq "HighVolume") {
            & $EntraIDScript -IncludeHighVolume @overrides
        } else {
            & $EntraIDScript @overrides
        }
        $stepNumber++
    }

    # Step 6: Deploy Defender for Cloud export
    if ($coverage.scriptBasedDeployment.defenderExport.enabled) {
        Write-Host "`n  Step $stepNumber/$totalSteps`: Configuring Defender for Cloud export..." -ForegroundColor Red
        $DefenderScript = Get-SolutionPath -PathKey 'DefenderExportScript'
        & $DefenderScript @overrides
        $stepNumber++
    }

    # Step 7: Deploy Defender XDR Streaming API setup
    if ($coverage.defenderXDR.xdrStreaming.enabled) {
        Write-Host "`n  Step $stepNumber/$totalSteps`: Setting up Defender XDR Streaming API..." -ForegroundColor Red
        $XDRScript = Get-SolutionPath -PathKey 'DefenderXDRScript'
        if (Test-Path $XDRScript) {
            & $XDRScript @overrides
        } else {
            Write-Host "  WARNING: $($script:PathConfig.DefenderXDRScript) not found - skipping XDR setup" -ForegroundColor Yellow
        }
        $stepNumber++
    }

    Write-Host "`n$('='*80)" -ForegroundColor Green
    Write-Host "  DEPLOYMENT COMPLETE" -ForegroundColor Green
    Write-Host "$('='*80)" -ForegroundColor Green

    return $true
}

function Open-ResourceCoverageConfig {
    <#
    .SYNOPSIS
        Opens the resource-coverage.json file for editing.
    #>
    $coverageFile = Get-SolutionPath -PathKey 'ResourceCoverageFile'

    if (-not (Test-Path $coverageFile)) {
        Write-Host "  ERROR: $($script:PathConfig.ResourceCoverageFile) not found at: $coverageFile" -ForegroundColor Red
        return
    }

    Write-Host "`n  Opening $($script:PathConfig.ResourceCoverageFile) for editing..." -ForegroundColor Cyan
    Write-Host "  File: $coverageFile" -ForegroundColor Gray

    # Try to open in VS Code, fall back to notepad
    # Note: Use -ArgumentList with quoted path to handle spaces in paths
    try {
        if (Get-Command code -ErrorAction SilentlyContinue) {
            Start-Process -FilePath "code" -ArgumentList "`"$coverageFile`""
            Write-Host "  Opened in VS Code" -ForegroundColor Green
        } elseif (Get-Command notepad -ErrorAction SilentlyContinue) {
            Start-Process -FilePath "notepad" -ArgumentList "`"$coverageFile`""
            Write-Host "  Opened in Notepad" -ForegroundColor Green
        } else {
            Write-Host "  Path to file: $coverageFile" -ForegroundColor White
            Write-Host "  Please open this file in your preferred editor." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  Could not open editor. File path: $coverageFile" -ForegroundColor Yellow
    }
}

#endregion Resource Coverage Configuration

function Show-Menu {
    Clear-Host

    Write-Host "`n$('='*80)" -ForegroundColor Cyan
    Write-Host "  AZURE LOG COLLECTION FOR CRIBL STREAM" -ForegroundColor Cyan
    Write-Host "  Send Azure diagnostic logs and Defender XDR telemetry to Event Hub" -ForegroundColor Gray
    Write-Host "$('='*80)" -ForegroundColor Cyan

    # Show current resource coverage configuration
    Show-ResourceCoverageStatus

    # Check if inventory exists (required for Multi-Region deployments)
    $hasInventory = Test-InventoryExists
    $coverage = Get-ResourceCoverage -Silent
    $mode = if ($coverage) { $coverage.deploymentSettings.mode } else { "Centralized" }

    Write-Host "`n  $('-'*76)" -ForegroundColor DarkGray
    Write-Host "  AZURE CONFIGURATION" -ForegroundColor Cyan
    Write-Host "  [1] Deploy All Logging - Deploy all enabled components from configuration" -ForegroundColor Green
    if ($mode -eq "MultiRegion" -and -not $hasInventory) {
        Write-Host "      " -NoNewline
        Write-Host "(Requires inventory - run [I] first)" -ForegroundColor Yellow
    }
    Write-Host "  [2] Configure Coverage - Edit resource-coverage.json to enable/disable sources" -ForegroundColor Yellow
    Write-Host "  [D] Defender XDR Streaming - Setup XDR Streaming API (Endpoint/Identity/O365/CloudApps)" -ForegroundColor Red

    Write-Host "`n  $('-'*76)" -ForegroundColor DarkGray
    Write-Host "  CRIBL STREAM INTEGRATION" -ForegroundColor Magenta
    Write-Host "  [C] Generate Cribl Sources - Discover Event Hubs and create Cribl source configs" -ForegroundColor Magenta
    Write-Host "      Creates source configs with secret references (secrets created manually in Cribl)" -ForegroundColor DarkGray

    Write-Host "`n  $('-'*76)" -ForegroundColor DarkGray
    Write-Host "  DISCOVERY & ANALYSIS" -ForegroundColor Blue
    Write-Host "  [I] Inventory - " -NoNewline -ForegroundColor Blue
    if ($hasInventory) {
        $inventory = Get-InventoryData -Silent
        Write-Host "$($inventory.Regions.Count) regions discovered ($($inventory.GeneratedAt))" -ForegroundColor Green

        # Show conflict warning in menu if detected
        if ($inventory.PSObject.Properties.Name -contains 'PolicyConflicts' -and $null -ne $inventory.PolicyConflicts -and $inventory.PolicyConflicts.HasConflicts) {
            Write-Host "      " -NoNewline
            Write-Host "WARNING: $($inventory.PolicyConflicts.TotalConflicts) conflicting policy assignment(s) detected!" -ForegroundColor Red
        }
    } else {
        Write-Host "NOT RUN - Required for Multi-Region mode" -ForegroundColor Yellow
    }
    Write-Host "  [G] Gap Analysis - Identify resources not covered by policies" -ForegroundColor Blue
    Write-Host "  [P] Remediate Policies - Create remediation tasks for non-compliant resources" -ForegroundColor Blue

    Write-Host "`n  $('-'*76)" -ForegroundColor DarkGray
    Write-Host "  CLEANUP" -ForegroundColor Red
    Write-Host "  [R] Remove Diagnostic Settings - Delete settings created by this solution" -ForegroundColor Red

    Write-Host "`n  $('-'*76)" -ForegroundColor DarkGray
    Write-Host "  [Q] Quit" -ForegroundColor DarkGray
    Write-Host "$('='*80)" -ForegroundColor Cyan
}

#endregion

#region Main Execution

if (-not $NonInteractive) {
    # Interactive mode

    # Initialize required PowerShell modules
    if (-not (Initialize-RequiredModules)) {
        Write-Host "`n  Cannot proceed without required modules. Exiting..." -ForegroundColor Red
        exit 1
    }

    if (-not (Test-AzureParametersConfiguration)) {
        Write-Host "`n  Cannot proceed without valid configuration. Exiting..." -ForegroundColor Red
        exit 1
    }

    # Verify Azure connection with automatic token refresh
    Write-Host "`n  Checking Azure connection..." -ForegroundColor Cyan
    if (-not (Ensure-AzureConnection)) {
        Write-Host "`n  Cannot proceed without Azure connection. Exiting..." -ForegroundColor Red
        exit 1
    }

    while ($true) {
        Show-Menu
        $selection = (Read-Host "`n  Select an option").ToUpper()

        switch ($selection) {
            '1' {
                # Deploy All Logging from resource-coverage.json
                Deploy-AllEnabledLogging
                Read-Host "`n  Press Enter to continue"
            }
            '2' {
                # Configure Coverage - open resource-coverage.json
                Open-ResourceCoverageConfig
                Write-Host "`n  After editing, save the file and return to this menu." -ForegroundColor Cyan
                Write-Host "  Then select [1] to deploy with your new configuration." -ForegroundColor Gray
                Read-Host "`n  Press Enter to continue"
            }
            'I' {
                $azureParamsFile = Get-SolutionPath -PathKey 'AzureParametersFile'
                $azParams = Get-Content $azureParamsFile | ConvertFrom-Json
                Get-RegionInventory -ManagementGroupId $azParams.managementGroupId -UpdateConfiguration
                Read-Host "`n  Press Enter to continue"
            }
            'G' {
                # Gap Analysis
                Write-Host "`n$('='*80)" -ForegroundColor Magenta
                Write-Host "  COMPLIANCE GAP ANALYSIS" -ForegroundColor Magenta
                Write-Host "$('='*80)" -ForegroundColor Magenta
                Write-Host "`n  Analyzing resources to identify coverage gaps..." -ForegroundColor White

                $GapAnalysisScript = Get-SolutionPath -PathKey 'GapAnalysisScript'
                if (Test-Path $GapAnalysisScript) {
                    & $GapAnalysisScript -ExportReport
                } else {
                    Write-Host "  ERROR: $($script:PathConfig.GapAnalysisScript) not found!" -ForegroundColor Red
                    Write-Host "  Expected at: $GapAnalysisScript" -ForegroundColor Yellow
                }
                Read-Host "`n  Press Enter to continue"
            }
            'P' {
                # Policy Remediation - create remediation tasks
                Write-Host "`n  Select remediation mode:" -ForegroundColor Cyan
                Write-Host "  [P] Preview - Show policies and non-compliant resources (no changes)" -ForegroundColor Cyan
                Write-Host "  [R] Remediate - Create remediation tasks for non-compliant resources" -ForegroundColor Yellow
                Write-Host "  [C] Cancel - Return to main menu" -ForegroundColor DarkGray

                $remediateChoice = (Read-Host "`n  Select an option").ToUpper()

                switch ($remediateChoice) {
                    'P' {
                        Start-AllPolicyRemediation -PreviewOnly
                    }
                    'R' {
                        Start-AllPolicyRemediation
                    }
                    'C' {
                        Write-Host "`n  Returning to main menu..." -ForegroundColor Gray
                    }
                    default {
                        Write-Host "`n  Invalid selection. Returning to main menu." -ForegroundColor Red
                    }
                }
                Read-Host "`n  Press Enter to continue"
            }
            'D' {
                # Defender XDR Streaming Setup
                $XDRScript = Get-SolutionPath -PathKey 'DefenderXDRScript'
                if (Test-Path $XDRScript) {
                    $overrides = Get-OverrideParameters
                    & $XDRScript @overrides
                } else {
                    Write-Host "`n  ERROR: $($script:PathConfig.DefenderXDRScript) not found!" -ForegroundColor Red
                    Write-Host "  Expected at: $XDRScript" -ForegroundColor Yellow
                }
                Read-Host "`n  Press Enter to continue"
            }
            'C' {
                # Generate Cribl Event Hub Sources
                $CriblSourcesScript = Get-SolutionPath -PathKey 'CriblSourcesScript'
                if (Test-Path $CriblSourcesScript) {
                    & $CriblSourcesScript
                } else {
                    Write-Host "`n  ERROR: $($script:PathConfig.CriblSourcesScript) not found!" -ForegroundColor Red
                    Write-Host "  Expected at: $CriblSourcesScript" -ForegroundColor Yellow
                }
                Read-Host "`n  Press Enter to continue"
            }
            'R' {
                # Remove diagnostic settings - offer preview or execute
                Write-Host "`n$('='*80)" -ForegroundColor Red
                Write-Host "  REMOVE DIAGNOSTIC SETTINGS" -ForegroundColor Red
                Write-Host "$('='*80)" -ForegroundColor Red
                Write-Host "`n  This will remove diagnostic settings pointing to Event Hubs managed by this solution." -ForegroundColor Yellow
                Write-Host "  Settings are matched precisely by subscription, resource group, and namespace prefix." -ForegroundColor Gray
                Write-Host "`n  Select an option:" -ForegroundColor Cyan
                Write-Host "  [P] Preview - Show what would be deleted (no changes)" -ForegroundColor Cyan
                Write-Host "  [R] Remove - Scan and remove matching diagnostic settings" -ForegroundColor Red
                Write-Host "  [C] Cancel - Return to main menu" -ForegroundColor DarkGray

                $removeChoice = (Read-Host "`n  Select an option").ToUpper()

                switch ($removeChoice) {
                    'P' {
                        Remove-DiagnosticSettings -PreviewOnly
                    }
                    'R' {
                        Remove-DiagnosticSettings
                    }
                    'C' {
                        Write-Host "`n  Returning to main menu..." -ForegroundColor Gray
                    }
                    default {
                        Write-Host "`n  Invalid selection. Returning to main menu." -ForegroundColor Red
                    }
                }
                Read-Host "`n  Press Enter to continue"
            }
            'Q' {
                Write-Host "`n  Exiting Azure Log Collection. Goodbye!" -ForegroundColor Cyan
                exit 0
            }
            default {
                Write-Host "`n  Invalid selection. Please try again." -ForegroundColor Red
                Start-Sleep -Seconds 2
            }
        }
    }
} else {
    # Non-interactive mode
    if (-not (Test-AzureParametersConfiguration)) {
        Write-Host "`n  Cannot proceed without valid configuration. Exiting..." -ForegroundColor Red
        exit 1
    }

    # Verify Azure connection with automatic token refresh
    Write-Host "`n  Checking Azure connection..." -ForegroundColor Cyan
    if (-not (Ensure-AzureConnection)) {
        Write-Host "`n  Cannot proceed without Azure connection. Exiting..." -ForegroundColor Red
        exit 1
    }

    if ([string]::IsNullOrEmpty($Mode)) {
        Write-Host "`n  ERROR: Mode parameter is required in non-interactive mode!" -ForegroundColor Red
        Write-Host "  Valid modes:" -ForegroundColor Yellow
        Write-Host "    DeployAll                 - Deploy all enabled sources from resource-coverage.json" -ForegroundColor Green
        Write-Host "    Inventory                 - Discover resources by region (run first for MultiRegion)" -ForegroundColor Gray
        Write-Host "    GapAnalysis               - Analyze coverage gaps" -ForegroundColor Gray
        Write-Host "    Remediate                 - Create remediation tasks for non-compliant resources" -ForegroundColor Gray
        Write-Host "    RemoveDiagnosticSettings  - Remove diagnostic settings created by this solution" -ForegroundColor Gray
        Write-Host "    DefenderXDR               - Setup Defender XDR Streaming (creates Event Hub, shows portal steps)" -ForegroundColor Red
        Write-Host "    DefenderXDRValidateOnly   - Validate Defender licenses/usage only (no changes)" -ForegroundColor Red
        exit 1
    }

    Write-Host "`n  Running in non-interactive mode" -ForegroundColor Cyan
    Write-Host "    Mode: $Mode" -ForegroundColor White

    # Validate Azure connection (tenant ID must match config)
    if (-not (Ensure-AzureConnection -Environment $Environment)) {
        Write-Host "`n  ERROR: Azure connection validation failed!" -ForegroundColor Red
        exit 1
    }

    # For DeployAll mode, check if resource-coverage.json specifies MultiRegion mode
    if ($Mode -eq "DeployAll") {
        $coverage = Get-ResourceCoverage -Silent
        if ($coverage -and $coverage.deploymentSettings.mode -eq "MultiRegion" -and -not (Test-InventoryExists)) {
            Write-Host "`n  ERROR: Inventory required! Your resource-coverage.json specifies MultiRegion mode." -ForegroundColor Red
            Write-Host "  Run with -Mode Inventory first to discover regions with resources." -ForegroundColor Yellow
            Write-Host "`n  Example: .\Run-AzureLogCollection.ps1 -NonInteractive -Mode Inventory" -ForegroundColor Cyan
            exit 1
        }
    }

    # Validate management group exists (for deployment modes)
    if ($Mode -eq "DeployAll") {
        $azureParamsFile = Join-Path $PSScriptRoot $Environment "azure-parameters.json"
        $azParams = Get-Content $azureParamsFile | ConvertFrom-Json
        if (-not (Test-ManagementGroupExists -ManagementGroupId $azParams.managementGroupId)) {
            Write-Host "`n  ERROR: Management Group '$($azParams.managementGroupId)' not found!" -ForegroundColor Red
            Write-Host "  Verify the managementGroupId in azure-parameters.json is correct." -ForegroundColor Yellow
            Write-Host "  Also ensure you have access to this Management Group." -ForegroundColor Yellow
            exit 1
        }
    }

    switch ($Mode) {
        "DeployAll" {
            # Deploy all enabled sources from resource-coverage.json
            Write-Host "`n  Deploying all enabled logging sources from $($script:PathConfig.ResourceCoverageFile)..." -ForegroundColor Cyan
            Deploy-AllEnabledLogging -Force
        }
        "Inventory" {
            $azureParamsFile = Get-SolutionPath -PathKey 'AzureParametersFile'
            $azParams = Get-Content $azureParamsFile | ConvertFrom-Json
            Get-RegionInventory -ManagementGroupId $azParams.managementGroupId
        }
        "GapAnalysis" {
            Write-Host "`n  Running compliance gap analysis..." -ForegroundColor Magenta
            $GapAnalysisScript = Get-SolutionPath -PathKey 'GapAnalysisScript'
            & $GapAnalysisScript -ExportReport
        }
        "Remediate" {
            Write-Host "`n  Creating remediation tasks for non-compliant resources..." -ForegroundColor Cyan
            Start-AllPolicyRemediation -Force
        }
        "RemoveDiagnosticSettings" {
            Write-Host "`n  Removing diagnostic settings created by this solution..." -ForegroundColor Red
            Remove-DiagnosticSettings -Force
        }
        "DefenderXDR" {
            Write-Host "`n  Running Defender XDR Streaming API setup..." -ForegroundColor Red
            $XDRScript = Get-SolutionPath -PathKey 'DefenderXDRScript'
            if (Test-Path $XDRScript) {
                & $XDRScript
            } else {
                Write-Host "  ERROR: $($script:PathConfig.DefenderXDRScript) not found!" -ForegroundColor Red
                exit 1
            }
        }
        "DefenderXDRValidateOnly" {
            Write-Host "`n  Validating Defender XDR licenses and usage..." -ForegroundColor Red
            $XDRScript = Get-SolutionPath -PathKey 'DefenderXDRScript'
            if (Test-Path $XDRScript) {
                & $XDRScript -ValidateOnly
            } else {
                Write-Host "  ERROR: $($script:PathConfig.DefenderXDRScript) not found!" -ForegroundColor Red
                exit 1
            }
        }
        "GenerateCriblSources" {
            Write-Host "`n  Generating Cribl Event Hub source configurations..." -ForegroundColor Magenta
            $CriblSourcesScript = Get-SolutionPath -PathKey 'CriblSourcesScript'
            if (Test-Path $CriblSourcesScript) {
                & $CriblSourcesScript
            } else {
                Write-Host "  ERROR: $($script:PathConfig.CriblSourcesScript) not found!" -ForegroundColor Red
                exit 1
            }
        }
        default {
            Write-Host "`n  ERROR: Unknown mode '$Mode'" -ForegroundColor Red
            exit 1
        }
    }
}

#endregion
